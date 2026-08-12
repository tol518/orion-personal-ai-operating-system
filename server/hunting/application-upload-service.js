// Deterministic CV attachment, below the model.
//
// The previous design asked the model to "arm" an upload and then click something, with no
// proof that the file was ever bound to a file input — which is how an Ashby run reported
// progress while zero fields and zero uploads had actually happened. Here the BFF picks the
// input, binds the file through the browser's own setInputFiles primitive, and only reports
// success when the page itself says the file is attached.
// Closed outcome set. Anything that is not `uploaded` keeps the checkpoint human-owned.
export const UPLOAD_OUTCOMES = new Set([
  "uploaded",
  "input_not_found",
  "artifact_unavailable",
  "tool_unavailable",
  "rejected",
  "verification_failed",
]);
// Only these can be worth one more try; everything else is a standing condition that a
// retry would just repeat (and re-uploading is how duplicate attachments happen).
const TRANSIENT_OUTCOMES = new Set(["tool_unavailable", "verification_failed"]);
const MARKER_ATTRIBUTE = "data-jarvis-upload-target";
const MAX_SELECTOR_CANDIDATES = 4;
const FINAL_REVIEW_SNAPSHOT_MAX_CHARS = 30_000;

export class ApplicationUploadService {
  constructor({ browser, maxAttempts = 2 }) {
    this.browser = browser;
    this.maxAttempts = Math.max(1, Math.min(3, maxAttempts));
  }

  /**
   * Attach `artifact` to the form in `targetId`. `inputRef` is an optional snapshot ref the
   * form-opening phase already identified; `chooserRef` is the visible control to click for
   * forms that only create their input on demand.
   */
  async attach({ targetId, artifact, adapter, inputRef = null, chooserRef = null, purpose = "resume" }) {
    const executionHost = await this.#describeExecutionHost();
    let attempts = 0;
    let result;
    while (attempts < this.maxAttempts) {
      attempts += 1;
      result = await this.#attemptAttach({ targetId, artifact, adapter, inputRef, chooserRef, purpose });
      if (result.outcome === "uploaded" || !TRANSIENT_OUTCOMES.has(result.outcome)) break;
    }
    return {
      ...result,
      attempts,
      evidence: {
        ...result.evidence,
        artifactName: artifact.name,
        artifactSha256: artifact.sha256,
        artifactBytes: artifact.bytes,
        browserRef: artifact.browserRef,
        targetId,
        siteAdapter: adapter.id,
        executionHost,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  async #attemptAttach({ targetId, artifact, adapter, inputRef, chooserRef, purpose }) {
    const inputs = await this.#awaitFileInputs(targetId);

    // A resumed run must not re-upload something the form already holds.
    const alreadyAttached = findAttachedInput(inputs.list, artifact);
    if (alreadyAttached) {
      return {
        outcome: "uploaded",
        reasonCode: "already_attached",
        detail: `The form already holds ${alreadyAttached.fileName}.`,
        evidence: { method: "file-input-read", verifiedAt: new Date().toISOString(), ...attachedEvidence(alreadyAttached) },
      };
    }

    const targets = this.#resolveTargets({ inputs, adapter, inputRef, chooserRef, purpose });
    if (!targets.length) {
      // Greenhouse can keep the actual file input inside a component boundary. Its accessible
      // filename is still page evidence, even though document.querySelectorAll cannot see it.
      const snapshotAttachment = await this.#verifySnapshotAttachment({ targetId, artifact, adapter });
      if (snapshotAttachment.ok) {
        return {
          outcome: "uploaded",
          reasonCode: "already_attached_in_snapshot",
          detail:
            snapshotAttachment.method === "site-review-controls"
              ? `${adapter.label}'s final review shows an attached resume document.`
              : `The form visibly holds ${artifact.name}.`,
          evidence: {
            method: snapshotAttachment.method,
            verifiedAt: new Date().toISOString(),
            ...snapshotAttachment.evidence,
          },
        };
      }
      return {
        outcome: "input_not_found",
        reasonCode: inputs.available ? "no_file_input_on_page" : "no_upload_target_available",
        detail: inputs.available
          ? "The current page exposes no file input. An embedded (iframe) or not-yet-opened form needs the user to open it."
          : `Page evaluation is unavailable (${inputs.error ?? "unknown reason"}) and no upload target was supplied.`,
        evidence: { fileInputsSeen: inputs.list.length, evaluateAvailable: inputs.available },
      };
    }

    let lastFailure = null;
    for (let target of targets) {
      const marked = target.markIndex === undefined ? { ok: true } : await this.#markInput(targetId, target.markIndex, target.token);
      if (!marked.ok) {
        lastFailure = { outcome: "input_not_found", reasonCode: "marker_failed", detail: marked.detail, evidence: {} };
        continue;
      }
      // A chooser ref was read from an older snapshot; re-find it now or the click hits nothing.
      if (target.kind === "chooser") {
        const fresh = await this.#freshChooserRef({ targetId, chooserRef: target.ref, purpose });
        if (!fresh.ref) {
          lastFailure = {
            outcome: "input_not_found",
            reasonCode: "chooser_ref_stale",
            detail: `${describeTarget(target)}: ${fresh.reason}`,
            evidence: { method: "chooser", selector: target.ref },
          };
          continue;
        }
        target = { ...target, ref: fresh.ref, refReason: fresh.reason };
      }
      const call =
        target.kind === "chooser"
          ? await this.browser.armFileChooserAndClick({ targetId, ref: target.ref, paths: [artifact.browserRef] })
          : await this.browser.setInputFiles({
              targetId,
              inputRef: target.inputRef,
              element: target.element,
              paths: [artifact.browserRef],
            });
      if (!call.ok) {
        const classified = classifyUploadError(call.error);
        lastFailure = {
          ...classified,
          detail: `${describeTarget(target)}: ${call.error}`,
          evidence: { method: target.kind, selector: target.element ?? target.inputRef ?? target.ref },
        };
        // Only a missing element is worth trying the next candidate for.
        if (classified.outcome !== "input_not_found") return lastFailure;
        continue;
      }
      const verification = await this.#verifyAttached({ targetId, artifact, adapter });
      if (verification.ok) {
        return {
          outcome: "uploaded",
          reasonCode: "verified",
          detail: `Attached ${artifact.name} via ${describeTarget(target)}.`,
          evidence: {
            method: verification.method,
            selector: target.element ?? target.inputRef ?? target.ref,
            verifiedAt: new Date().toISOString(),
            ...verification.evidence,
          },
        };
      }
      lastFailure = {
        outcome: "verification_failed",
        reasonCode: verification.reasonCode,
        detail: `${describeTarget(target)}: ${verification.detail}`,
        evidence: { method: target.kind, selector: target.element ?? target.inputRef ?? target.ref },
      };
    }
    return lastFailure;
  }

  /**
   * Prefer an input the page actually has (marked with our own attribute so the selector is
   * unambiguous), then a ref the form-opening phase reported, then adapter candidates, then
   * the visible chooser control. Ordering matters: the first two are provable, the rest are
   * guesses that only survive because the postcondition is checked.
   */
  #resolveTargets({ inputs, adapter, inputRef, chooserRef, purpose }) {
    const targets = [];
    if (inputs.available && inputs.list.length) {
      const chosen = chooseFileInput(inputs.list, purpose);
      // No safe match (a cover letter with nowhere but the CV field to go) means no attempt.
      if (chosen) {
        const token = `t${Date.now().toString(36)}`;
        targets.push({
          kind: "element",
          element: `[${MARKER_ATTRIBUTE}="${token}"]`,
          markIndex: chosen.index,
          token,
        });
      }
    }
    if (inputRef) targets.push({ kind: "inputRef", inputRef });
    if (!inputs.available) {
      for (const element of adapter.fileInputSelectors.slice(0, MAX_SELECTOR_CANDIDATES)) {
        targets.push({ kind: "element", element });
      }
    }
    if (chooserRef) targets.push({ kind: "chooser", ref: chooserRef });
    return targets;
  }

  /**
   * `document.readyState` goes complete long before a client-rendered application form mounts.
   * A Greenhouse run read zero file inputs on a page that held 121 fields twenty seconds later,
   * reported "no reachable CV upload control", and never retried — `input_not_found` is a
   * standing condition, so the one honest fix is to not ask until the form exists.
   *
   * Polling stops as soon as a file input appears, or once the form has mounted and its control
   * count has held still for several reads — a form that finished rendering without a file input
   * genuinely has nowhere to put the CV, and waiting the full timeout for it helps nobody.
   */
  async #awaitFileInputs(targetId, { timeoutMs = 15_000, pollMs = 500, stableReads = 3 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let previousControls = -1;
    let stable = 0;
    let inputs = await this.#describeFileInputs(targetId);
    while (inputs.available && inputs.list.length === 0 && Date.now() < deadline) {
      const controls = await this.#countFormControls(targetId);
      stable = controls > 0 && controls === previousControls ? stable + 1 : 0;
      if (stable >= stableReads) break;
      previousControls = controls;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      inputs = await this.#describeFileInputs(targetId);
    }
    return inputs;
  }

  async #countFormControls(targetId) {
    const result = await this.browser.evaluate({
      targetId,
      fn: "() => document.querySelectorAll('input, textarea, select, [role=\"combobox\"]').length",
    });
    return result.ok ? Number(result.payload?.result ?? 0) : 0;
  }

  /** Re-read the page and resolve the chooser control against a snapshot taken right now. */
  async #freshChooserRef({ targetId, chooserRef, purpose }) {
    const snapshot = await this.browser.snapshot({ targetId, maxChars: 12_000, interactive: true });
    if (!snapshot.ok) {
      // Without a fresh snapshot the reported ref is all there is; try it rather than give up.
      return { ref: chooserRef, reason: `snapshot unavailable (${snapshot.error}), using the reported ref` };
    }
    return chooseChooserRef({ snapshot: String(snapshot.payload?.snapshot ?? ""), chooserRef, purpose });
  }

  async #describeFileInputs(targetId) {
    const result = await this.browser.evaluate({
      targetId,
      fn: `() => Array.from(document.querySelectorAll('input[type=file]')).map((el, index) => ({
        index,
        id: el.id || null,
        name: el.getAttribute('name') || null,
        accept: el.getAttribute('accept') || null,
        multiple: el.multiple === true,
        visible: Boolean(el.offsetParent) || el.getClientRects().length > 0,
        label: (el.labels && el.labels[0] ? el.labels[0].textContent : null) || el.getAttribute('aria-label') || null,
        fileName: el.files && el.files[0] ? el.files[0].name : null,
        fileSize: el.files && el.files[0] ? el.files[0].size : null
      }))`,
    });
    if (!result.ok) return { available: false, list: [], error: result.error };
    const list = Array.isArray(result.payload?.result) ? result.payload.result : [];
    return { available: true, list, error: null };
  }

  async #markInput(targetId, index, token) {
    const result = await this.browser.evaluate({
      targetId,
      fn: `() => {
        const inputs = Array.from(document.querySelectorAll('input[type=file]'));
        const target = inputs[${Number(index)}];
        if (!target) return { marked: false };
        for (const previous of Array.from(document.querySelectorAll('[${MARKER_ATTRIBUTE}]'))) {
          previous.removeAttribute('${MARKER_ATTRIBUTE}');
        }
        target.setAttribute('${MARKER_ATTRIBUTE}', ${JSON.stringify(token)});
        return { marked: true };
      }`,
    });
    if (!result.ok) return { ok: false, detail: `could not mark the file input: ${result.error}` };
    return result.payload?.result?.marked
      ? { ok: true }
      : { ok: false, detail: "the file input disappeared before it could be marked" };
  }

  /**
   * Postcondition proof. Reading the input's FileList is the strong signal; when page
   * evaluation is switched off, a rendered filename in a fresh snapshot is accepted instead.
   */
  async #verifyAttached({ targetId, artifact, adapter }) {
    const inputs = await this.#describeFileInputs(targetId);
    if (inputs.available && inputs.list.length) {
      const match = findAttachedInput(inputs.list, artifact);
      if (match) {
        return { ok: true, method: "file-input-read", evidence: attachedEvidence(match) };
      }
      const anyFile = inputs.list.find((input) => input.fileName);
      return {
        ok: false,
        reasonCode: anyFile ? "attached_file_mismatch" : "no_file_attached",
        detail: anyFile
          ? `the form reports "${anyFile.fileName}" (${anyFile.fileSize} bytes) instead of the prepared CV`
          : "no file input reports an attached file after the upload call",
      };
    }
    // Multi-step forms can remove their file input as soon as they advance to review. A fresh
    // accessibility snapshot is then the only browser-owned evidence left to inspect.
    const snapshot = await this.#verifySnapshotAttachment({ targetId, artifact, adapter });
    if (snapshot.ok) {
      return { ok: true, method: snapshot.method, evidence: snapshot.evidence };
    }
    return {
      ok: false,
      reasonCode: "no_observable_evidence",
      detail: snapshot.detail,
    };
  }

  async #verifySnapshotAttachment({ targetId, artifact, adapter }) {
    // LinkedIn's Easy Apply accessibility tree can exceed 20k characters before the final
    // Resume and Submit controls. This read is bounded, but large enough to include that review.
    const snapshot = await this.browser.snapshot({
      targetId,
      maxChars: FINAL_REVIEW_SNAPSHOT_MAX_CHARS,
      interactive: true,
    });
    const text = snapshot.ok ? String(snapshot.payload?.snapshot ?? "") : "";
    const evidence = snapshot.ok ? findSnapshotAttachmentEvidence({ snapshot: text, artifact, adapter }) : null;
    if (evidence) {
      return {
        ok: true,
        method: evidence.method,
        evidence: evidence.evidence,
      };
    }
    return {
      ok: false,
      detail: snapshot.ok
        ? "the fresh snapshot does not show the expected resume attachment evidence"
        : `page evaluation is unavailable and the snapshot failed: ${snapshot.error}`,
    };
  }

  /** Which host owns the browser profile — recorded so a path/locality failure is obvious. */
  async #describeExecutionHost() {
    const doctor = await this.browser.status();
    if (!doctor.ok) return { available: false, error: doctor.error };
    const status = doctor.payload?.status ?? {};
    return {
      available: true,
      profile: doctor.payload?.profile ?? null,
      transport: doctor.payload?.transport ?? null,
      userDataDir: status.userDataDir ?? null,
      executablePath: status.detectedExecutablePath ?? status.executablePath ?? null,
      headless: status.headless ?? null,
    };
  }
}

/**
 * Snapshot refs die when the page re-renders.
 *
 * The form-opening phase reports a ref like `e204`, then the CV is prepared and the page re-renders
 * before the chooser is clicked, and the upload fails with `Unknown ref "ax56"` or `Element "e204"
 * not found or not visible`. Three of the last four upload failures were this. A ref is only valid
 * for the snapshot it came from, so the fix is to re-read the page and re-find the control rather
 * than replay a stale identifier.
 */
export function parseSnapshotControls(snapshot) {
  const controls = [];
  for (const line of String(snapshot ?? "").split("\n")) {
    const match = /^\s*-\s*(\w+)\s+"([^"]*)"\s*\[ref=([^\]]+)\]/.exec(line);
    if (match) controls.push({ role: match[1], name: match[2], ref: match[3] });
  }
  return controls;
}

/**
 * Accept either the exact staged filename or a site-specific final-review contract.
 *
 * LinkedIn removes the native file input and filename from Easy Apply's last step, but exposes
 * Edit Resume, View document, and Submit application together. Requiring the complete adapter
 * contract avoids treating an ordinary listing or an earlier modal step as attachment proof.
 */
export function findSnapshotAttachmentEvidence({ snapshot, artifact, adapter }) {
  const text = String(snapshot ?? "");
  if (artifact?.name && text.includes(artifact.name)) {
    return {
      method: "snapshot-filename",
      evidence: { filename: artifact.name, snapshotExcerpt: excerptAround(text, artifact.name) },
    };
  }

  const review = adapter?.resumeReviewEvidence;
  if (!review) return null;
  const labels = parseSnapshotControls(text).map((control) => control.name.trim().toLowerCase());
  const hasDocumentControls = review.documentControls.every((wanted) => labels.includes(wanted));
  const submitControl = review.submitControls.find((wanted) => labels.includes(wanted));
  if (!hasDocumentControls || !submitControl) return null;
  return {
    method: "site-review-controls",
    evidence: {
      site: adapter.id,
      controls: [...review.documentControls, submitControl],
    },
  };
}

/**
 * Pick the control to open a file chooser from, in a snapshot taken now.
 *
 * Ambiguity is dangerous here rather than merely unhelpful: a form usually has a CV chooser and a
 * cover-letter chooser side by side, both labelled "Attach". Attaching the CV to the wrong one
 * would still pass the postcondition check, because a file with the right name and size is present
 * somewhere on the page. So a purpose-specific label wins outright, and an unlabelled pair is only
 * resolved by document order when neither names the other purpose.
 */
export function chooseChooserRef({ snapshot, chooserRef, purpose = "resume" }) {
  const controls = parseSnapshotControls(snapshot);
  if (!controls.length) return { ref: null, reason: "the fresh snapshot exposed no controls" };
  if (chooserRef && controls.some((control) => control.ref === chooserRef)) {
    return { ref: chooserRef, reason: "reported ref still present" };
  }
  const rules = CHOOSER_LABELS[purpose] ?? CHOOSER_LABELS.resume;
  const scored = controls
    .map((control, index) => {
      let score = 0;
      if (rules.wanted.test(control.name)) score += 4;
      if (rules.generic.test(control.name)) score += 2;
      if (rules.avoided.test(control.name)) score -= 6;
      return { control, index, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (!scored.length) return { ref: null, reason: "no upload control in the fresh snapshot" };
  return {
    ref: scored[0].control.ref,
    reason: `re-found "${scored[0].control.name}" as ${scored[0].control.ref} after the reported ref went stale`,
  };
}

const CHOOSER_LABELS = {
  resume: {
    wanted: /resume|\bcv\b|curriculum/i,
    generic: /attach|upload|choose file|add file|select file/i,
    avoided: /cover|letter|photo|portfolio|transcript|certificate/i,
  },
  "cover-letter": {
    wanted: /cover|letter|motivation|supporting/i,
    generic: /attach|upload|choose file|add file|select file/i,
    avoided: /resume|\bcv\b|curriculum|photo|portfolio/i,
  },
};

const PURPOSES = {
  resume: {
    wanted: /resume|cv|curriculum/,
    avoided: /cover|photo|portfolio|transcript|certificate|passport/,
    // A form with one unlabelled file input almost always wants the CV.
    allowFallback: true,
  },
  "cover-letter": {
    wanted: /cover|letter|motivation|supporting/,
    avoided: /resume|cv|curriculum|photo|portfolio|transcript/,
    // Never fall back: attaching a letter to the CV input would overwrite the CV.
    allowFallback: false,
  },
};

/**
 * Pick the input this artifact belongs in. Returns null when nothing matches and the purpose
 * has no safe fallback, because guessing means putting the wrong document in a field.
 */
export function chooseFileInput(list, purpose = "resume") {
  const rules = PURPOSES[purpose] ?? PURPOSES.resume;
  const scored = list.map((input) => {
    const haystack = `${input.id ?? ""} ${input.name ?? ""} ${input.label ?? ""}`.toLowerCase();
    let score = 0;
    if (rules.wanted.test(haystack)) score += 4;
    if (rules.avoided.test(haystack)) score -= 4;
    if (/pdf/.test(String(input.accept ?? "").toLowerCase())) score += 1;
    if (input.visible) score += 1;
    return { input, score };
  });
  scored.sort((left, right) => right.score - left.score || left.input.index - right.input.index);
  const best = scored[0];
  if (!best) return null;
  if (best.score < 4 && !rules.allowFallback) return null;
  return best.input;
}

export function classifyUploadError(error) {
  const text = String(error ?? "");
  if (/inbound media directory|must stay within|invalid path|invalid media reference|no such file|enoent/i.test(text)) {
    return { outcome: "artifact_unavailable", reasonCode: "artifact_not_visible_to_browser" };
  }
  if (/paths are required/i.test(text)) {
    return { outcome: "artifact_unavailable", reasonCode: "artifact_missing" };
  }
  if (/waiting for locator|locator|no element|element is not|not an input|input type=file|strict mode violation/i.test(text)) {
    return { outcome: "input_not_found", reasonCode: "file_input_unreachable" };
  }
  if (/not running|not found|cdp|websocket|gateway not connected|browser plugin|timed out|timeout/i.test(text)) {
    return { outcome: "tool_unavailable", reasonCode: "browser_control_unavailable" };
  }
  return { outcome: "rejected", reasonCode: "upload_call_rejected" };
}

/**
 * An iframe-owned upload control can be unreachable to the deterministic uploader even after
 * the application flow attached the CV. On resume, continue only when the fresh form inspection
 * sees that attachment; it remains ineligible for automatic final review until re-checkable.
 */
export function canContinueAfterEmbeddedUpload({ resume, observedAttached, upload }) {
  return (
    resume === true &&
    observedAttached === true &&
    upload?.outcome === "input_not_found"
  );
}

function findAttachedInput(list, artifact) {
  return list.find(
    (input) => input.fileName === artifact.name && (!artifact.bytes || input.fileSize === artifact.bytes),
  );
}

function attachedEvidence(input) {
  return { filename: input.fileName, bytes: input.fileSize, inputIndex: input.index, inputLabel: input.label };
}

function describeTarget(target) {
  if (target.kind === "chooser") return `file chooser opened from ${target.ref}`;
  if (target.kind === "inputRef") return `file input ref ${target.inputRef}`;
  return `selector ${target.element}`;
}

function excerptAround(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return "";
  return text.slice(Math.max(0, index - 80), index + needle.length + 80);
}
