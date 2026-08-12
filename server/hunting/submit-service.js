// Submitting the application, deterministically, after the form has already been proven complete.
//
// The model never clicks submit — its prompts still forbid it. This is BFF code for the same
// reason the CV upload is: submitting is irreversible, so it must depend on checks that were
// actually made rather than on a model's account of them. By the time this runs, the assessment
// has confirmed the CV is attached and every required field the page declares is answered.
//
// Enabled by one explicit application instruction or by a proven/opted-in host. An employer that
// flags automation stays on the review path, and prepare-only hosts are excluded outright.
import { detectSubmissionRejection } from "./site-adapters.js";
import { waitForPageReady } from "./browser-control.js";

// Closed outcome set; anything other than `submitted` leaves the checkpoint human-owned.
export const SUBMIT_OUTCOMES = new Set([
  "submitted",
  "rejected",
  "blocked",
  "control_not_found",
  "verification_failed",
  "tool_unavailable",
]);
const SETTLE_MS = 4_000;
const FINAL_REVIEW_SNAPSHOT_MAX_CHARS = 30_000;
const CONFIRMATION =
  /application (has been )?(submitted|received|sent)|thank you for (applying|your application)|we have received your application|application complete/i;
const SUBMIT_NEGATION =
  /\b(?:do not|don't|dont|never|not yet|wait|stop|hold)\b[^.]{0,40}\b(?:submit|send)\b|\b(?:submit|send)\b[^.]{0,20}\bnot yet\b/i;
const DIRECT_SUBMIT_INSTRUCTION =
  /\b(?:(?:please\s+)?(?:click|press|select|choose)\s+(?:the\s+)?(?:final\s+)?submit(?:\s+application)?|(?:please\s+)?(?:go ahead\s+and\s+)?submit\s+(?:this|the|my)\s+(?:job\s+)?application|(?:please\s+)?submit\s+it(?:\s+now)?)\b/i;

/** An explicit task instruction authorizes one run; it never becomes standing host consent. */
export function parseSubmitInstruction(guidance) {
  const text = String(guidance ?? "").replace(/\s+/g, " ").trim();
  if (!text || SUBMIT_NEGATION.test(text) || !DIRECT_SUBMIT_INSTRUCTION.test(text)) return null;
  return { source: "guidance", phrase: text.slice(0, 200) };
}

/** Hosts the user has opted in for. Empty means auto-submit is off everywhere. */
export function autoSubmitHosts(raw = process.env.JARVIS_AUTO_SUBMIT_HOSTS ?? "") {
  return String(raw)
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
}

export function isAutoSubmitHost(host, hosts = autoSubmitHosts()) {
  const target = String(host ?? "").toLowerCase().replace(/^www\./, "");
  // "*" opts every host in from the start, skipping the proven-run ramp below.
  if (hosts.includes("*")) return true;
  return hosts.some((allowed) => target === allowed || target.endsWith(`.${allowed}`));
}

/**
 * Auto-submit is open to every host, but a host earns it by completing one application cleanly.
 *
 * Blanket auto-submit from the first attempt would have sent forms that the checkpoints show were
 * incomplete: unattached CVs and unanswered required fields. So the first application on a host
 * still stops for review, and once one there has reached a verified, fully answered state, later
 * applications on that host submit themselves. Submission is irreversible; the evidence that this
 * host can be driven to completion comes before it, not after.
 */
export function isProvenHost(host, provenHosts = []) {
  const target = String(host ?? "").toLowerCase().replace(/^www\./, "");
  return provenHosts.some((proven) => {
    const known = String(proven ?? "").toLowerCase().replace(/^www\./, "");
    return Boolean(known) && (target === known || target.endsWith(`.${known}`));
  });
}

/**
 * Reasons an otherwise-finished application must still not be submitted automatically.
 *
 * Stated here rather than assumed by the caller, so wiring this up somewhere else cannot
 * submit a half-finished form.
 */
export function submitBlockers({
  application,
  assessment,
  automationPolicy,
  host,
  hosts = autoSubmitHosts(),
  provenHosts = [],
}) {
  const blockers = [];
  if (!isAutoSubmitHost(host, hosts) && !isProvenHost(host, provenHosts)) {
    blockers.push(
      `${host || "this host"} has not completed an application cleanly yet, so this one stops for your review`,
    );
  }
  if (automationPolicy === "prepare_only") blockers.push("this host is prepare-only");
  if (application?.status !== "ready_for_review") blockers.push(`status is ${application?.status}`);
  if (!["uploaded", "not_required"].includes(application?.uploadOutcome)) {
    blockers.push(`CV upload is ${application?.uploadOutcome}`);
  }
  const unresolved = (application?.unresolvedFields ?? []).filter((field) => field.required !== false);
  if (unresolved.length) blockers.push(`${unresolved.length} required field(s) unanswered`);
  if (assessment?.blockingFields?.length) {
    blockers.push(`${assessment.blockingFields.length} field(s) the page still reports empty`);
  }
  return blockers;
}

export class SubmitService {
  constructor({ browser }) {
    this.browser = browser;
  }

  /**
   * Click the form's submit control once and report what the page then said. Never retries: a
   * second click is how duplicate applications and spam flags happen.
   */
  async submit({ targetId, adapter }) {
    const control = await this.#findSubmitControl({ targetId, adapter });
    if (!control.found) {
      return {
        outcome: "control_not_found",
        detail: control.detail,
        evidence: { candidates: control.candidates ?? [] },
      };
    }

    const clicked = await this.browser.request("POST", "/act", {
      body: {
        targetId,
        kind: "click",
        ...(control.ref ? { ref: control.ref } : { selector: control.selector }),
      },
    });
    if (!clicked.ok) {
      return {
        outcome: "tool_unavailable",
        detail: clicked.error,
        evidence: { selector: control.selector ?? null, ref: control.ref ?? null },
      };
    }

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    await waitForPageReady(this.browser, { targetId });
    // Confirmation often appears in LinkedIn's job-page status region after the modal closes,
    // well beyond the first 8k characters of the full accessibility tree.
    const snapshot = await this.browser.snapshot({
      targetId,
      maxChars: FINAL_REVIEW_SNAPSHOT_MAX_CHARS,
    });
    const text = snapshot.ok ? String(snapshot.payload?.snapshot ?? "") : "";
    const url = snapshot.ok ? String(snapshot.payload?.url ?? "") : "";

    // A rejection banner is not a successful submission, however the click went.
    const rejection = detectSubmissionRejection({ text });
    if (rejection) {
      return {
        outcome: "rejected",
        reasonCode: rejection.reasonCode,
        detail: rejection.detail,
        evidence: { selector: control.selector ?? null, ref: control.ref ?? null, url, marker: rejection.evidence },
      };
    }
    const confirmed = CONFIRMATION.exec(text);
    if (confirmed) {
      return {
        outcome: "submitted",
        reasonCode: "confirmed_on_page",
        detail: `The page confirms the submission ("${confirmed[0].slice(0, 80)}").`,
        evidence: {
          selector: control.selector ?? null,
          ref: control.ref ?? null,
          url,
          confirmation: confirmed[0].slice(0, 120),
        },
      };
    }
    // Clicked, and the page said neither yes nor no. Never guessed as success.
    return {
      outcome: "verification_failed",
      reasonCode: "no_confirmation_on_page",
      detail: "The submit control was clicked but the page shows neither a confirmation nor a rejection.",
      evidence: { selector: control.selector ?? null, ref: control.ref ?? null, url },
    };
  }

  /** Find the submit control by the labels the adapter already knows this site uses. */
  async #findSubmitControl({ targetId, adapter }) {
    const labels = (adapter.forbiddenControlLabels ?? []).map((label) => label.toLowerCase());
    const result = await this.browser.evaluate({
      targetId,
      fn: `() => {
        const wanted = ${JSON.stringify(labels)};
        const nodes = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]'));
        const described = nodes.map((el, index) => {
          const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
          return {
            index,
            text: text.slice(0, 80),
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            visible: Boolean(el.offsetParent) || el.getClientRects().length > 0,
          };
        }).filter((entry) => entry.text);
        const usable = described.filter((entry) => entry.visible && !entry.disabled);
        const match =
          usable.find((entry) => wanted.some((label) => entry.text.toLowerCase() === label)) ??
          usable.find((entry) => wanted.some((label) => entry.text.toLowerCase().includes(label)));
        if (match) nodes[match.index].setAttribute('data-jarvis-submit-target', '1');
        return { match: match ?? null, candidates: described.slice(0, 12).map((entry) => entry.text) };
      }`,
    });
    const match = result.ok ? result.payload?.result?.match : null;
    if (match) return { found: true, selector: "[data-jarvis-submit-target='1']", label: match.text };

    // Greenhouse can render its controls behind a component boundary that page evaluation
    // cannot traverse. A fresh accessibility snapshot supplies a stable Playwright ref.
    // LinkedIn's final Easy Apply controls sit late in a large accessibility tree. Keep the
    // fallback bounded while reading enough of the review modal to reach Submit application.
    const snapshot = await this.browser.snapshot({
      targetId,
      maxChars: FINAL_REVIEW_SNAPSHOT_MAX_CHARS,
      interactive: true,
    });
    const text = snapshot.ok ? String(snapshot.payload?.snapshot ?? "") : "";
    const refMatch = findSubmitRef(text, labels);
    if (refMatch) return { found: true, ref: refMatch.ref, label: refMatch.label };
    return {
      found: false,
      detail: result.ok
        ? "no enabled submit control matching this site's known labels is visible on the page"
        : `could not inspect the page for a submit control: ${result.error}`,
      candidates: result.ok ? result.payload?.result?.candidates ?? [] : [],
    };
  }
}

export function findSubmitRef(snapshot, labels) {
  for (const line of String(snapshot ?? "").split("\n")) {
    if (/disabled/i.test(line)) continue;
    const match = /(?:button|input)\s+"([^"]+)"[^\n]*\[ref=([^\]]+)\]/i.exec(line);
    if (!match) continue;
    const label = match[1].replace(/\s+/g, " ").trim();
    const normalized = label.toLowerCase();
    if (labels.some((wanted) => normalized === wanted || normalized.includes(wanted))) {
      return { label, ref: match[2].trim() };
    }
  }
  return null;
}
