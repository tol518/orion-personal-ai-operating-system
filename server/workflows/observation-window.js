// Turn a raw Screenpipe capture into something a model can actually read.
//
// A five-minute window produces thousands of OCR rows, most of them the same screen text
// re-read every frame. Handing that to a model wastes the context on repetition and buries the
// few lines that describe intent. So the raw items are collapsed into an ordered timeline of
// app/window/url segments, each with deduplicated text and the input events that happened
// inside it. The digest is deterministic: same capture in, same bytes out, which is what makes
// the extraction step reproducible and the prompt cacheable.
//
// This is also the redaction boundary. Screenpipe sees everything on screen, including things
// the user never intended to teach: password fields, one-time codes, card numbers, whatever was
// open in another window. Text is masked here, before it is stored in a learning session and
// long before any of it could reach a model.
const MAX_SEGMENTS = 60;
const MAX_LINES_PER_SEGMENT = 25;
// Two OCR reads of the same screen are rarely byte-identical — a caret moves, a clock ticks, a
// glyph is read as `l` instead of `I` — so exact-match dedupe let near-copies of the same
// full-screen blob through and they filled the prompt.
//
// The threshold is measured, not guessed. Over 164 real capture rows (~21 words per blob): pairs
// from genuinely different screens reach 0.39 at p90, while consecutive re-reads of one screen sit
// between 0.7 and 1.0. 0.7 is inside that gap — it collapsed 164 reads to 42 distinct screens,
// where 0.6 gained only 5 more and started encroaching on the different-screen distribution.
const NEAR_DUPLICATE_OVERLAP = 0.7;
// Window management is not a task step. The recorder emits these alongside real input, and a
// timeline that lists "app_switch on shell" between every click reads as though alt-tabbing were
// part of the workflow. Denylist rather than allowlist: an unrecognised event type is more likely
// to be a real interaction (mouse_down, keypress) than more noise, and losing a real click is the
// worse error.
const NON_TASK_EVENTS = new Set(["app_switch", "window_focus", "app_launch", "app_quit", "window_open", "window_close"]);
const MAX_ACTIONS_PER_SEGMENT = 30;
const MAX_LINE_LENGTH = 220;
const DEFAULT_PROMPT_CHARS = 60_000;

// Windows whose contents are never workflow steps. Matched against app and window name.
const NEVER_OBSERVED = [
  /1password|bitwarden|lastpass|dashlane|keychain access|keeper password/i,
  /authenticator|authy|2fa/i,
  /\bkeychain\b|credential manager/i,
];

// Credential-shaped text is masked wherever it appears, not just in password fields: OCR reads
// a revealed password out of a form the same way it reads a heading.
const SECRET_PATTERNS = [
  // "password: hunter2", "api key = sk-...", "otp 123456"
  /\b(password|passcode|pass phrase|passphrase|secret|api[_ -]?key|token|otp|one[- ]time code|cvv|cvc|pin)\b\s*[:=]?\s*\S{3,}/gi,
  // Bearer/authorization headers and common key prefixes.
  /\b(bearer|authorization:)\s+\S+/gi,
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9-_]{12,}/g,
  // 12+ digit runs: card, IBAN tail, account numbers. Shorter runs stay (dates, totals, ids).
  /\b(?:\d[ -]?){12,}\b/g,
];

const REDACTED = "[redacted]";

/** Mask credential-shaped substrings. Returns the text and whether anything was masked. */
export function redactSecrets(value) {
  let text = String(value ?? "");
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      redacted = true;
      // Keep the label so a step can still say "enter the password" without carrying the value.
      const label = /^([a-z_ -]+)\s*[:=]/i.exec(match)?.[1];
      return label ? `${label}: ${REDACTED}` : REDACTED;
    });
  }
  return { text, redacted };
}

function cleanLine(value) {
  const line = String(value ?? "").replace(/\s+/g, " ").trim();
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH - 1)}…` : line;
}

/** Word set of a line, used to compare two screen reads without caring about OCR jitter. */
function wordSet(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}

/**
 * Is this line effectively a re-read of one already kept?
 *
 * Jaccard over word sets rather than string distance: OCR reorders and mis-reads individual glyphs,
 * but the vocabulary of a screen is stable, so overlap is what actually distinguishes "same screen
 * again" from "the screen changed".
 */
export function isNearDuplicate(candidate, keptSets, threshold = NEAR_DUPLICATE_OVERLAP) {
  const words = wordSet(candidate);
  if (words.size === 0) return false;
  for (const kept of keptSets) {
    let shared = 0;
    for (const word of words) if (kept.has(word)) shared += 1;
    const union = words.size + kept.size - shared;
    if (union > 0 && shared / union >= threshold) return true;
  }
  return false;
}

function isExcluded({ app, window }, excludeApps) {
  const haystack = `${app ?? ""} ${window ?? ""}`;
  if (NEVER_OBSERVED.some((pattern) => pattern.test(haystack))) return true;
  return excludeApps.some((name) => name && haystack.toLowerCase().includes(name.toLowerCase()));
}

/**
 * One raw Screenpipe item to a flat shape.
 *
 * Field names follow the documented content items (OCR: text/app_name/window_name/browser_url;
 * UI: text/app_name/window_name/browser_url; Input: event_type/window_title/element_name/x/y;
 * Audio: transcription/speaker). `file_path`, `frame`, and frame ids are dropped on purpose —
 * they point at recorded media, which never travels with a workflow.
 */
export function normalizeItem(entry) {
  const type = String(entry?.type ?? "").toLowerCase();
  const content = entry?.content ?? {};
  const base = {
    at: String(content.timestamp ?? content.start_time ?? ""),
    app: cleanLine(content.app_name),
    window: cleanLine(content.window_name ?? content.window_title),
    url: cleanLine(content.browser_url),
  };
  if (type === "ocr") return { ...base, kind: "ocr", text: cleanLine(content.text) };
  if (type === "ui") return { ...base, kind: "ui", text: cleanLine(content.text) };
  if (type === "audio") {
    return { ...base, kind: "audio", text: cleanLine(content.transcription), speaker: cleanLine(content.speaker?.name) };
  }
  if (type === "input") {
    return {
      ...base,
      kind: "input",
      eventType: cleanLine(content.event_type),
      element: cleanLine(content.element_name || content.element_role),
      text: cleanLine(content.text_content),
      // Coordinates are kept only as a last-resort hint; steps must prefer text anchors.
      hasCoords: Number.isFinite(content.x) && Number.isFinite(content.y),
    };
  }
  return null;
}

/**
 * Collapse a capture into an ordered, deduplicated, redacted timeline.
 *
 * Segments break on a change of app, window, or URL, because that is what a human would call
 * "the next part of the task" and it is the unit a replayed step needs to target.
 */
export function buildObservationDigest(capture, { excludeApps = [] } = {}) {
  const stats = { items: 0, redactions: 0, excludedItems: 0, duplicateLines: 0, skipped: 0 };
  const normalized = [];
  for (const entry of capture?.items ?? []) {
    const item = normalizeItem(entry);
    if (!item) {
      stats.skipped += 1;
      continue;
    }
    if (isExcluded(item, excludeApps)) {
      stats.excludedItems += 1;
      continue;
    }
    if (!item.text && item.kind !== "input") {
      stats.skipped += 1;
      continue;
    }
    const masked = redactSecrets(item.text);
    if (masked.redacted) stats.redactions += 1;
    normalized.push({ ...item, text: masked.text });
    stats.items += 1;
  }
  // Screenpipe returns each content type as its own page run, so the merged list has to be
  // re-sorted before it can be read as a timeline.
  normalized.sort((a, b) => a.at.localeCompare(b.at));

  const segments = [];
  for (const item of normalized) {
    const key = `${item.app} ${item.window} ${item.url}`;
    let segment = segments.at(-1);
    if (!segment || segment.key !== key) {
      segment = {
        key,
        index: segments.length + 1,
        app: item.app,
        window: item.window,
        url: item.url || null,
        startedAt: item.at,
        endedAt: item.at,
        lines: [],
        seen: new Set(),
        keptWords: [],
        actions: [],
        narration: [],
      };
      segments.push(segment);
    }
    segment.endedAt = item.at || segment.endedAt;
    if (item.kind === "input") {
      if (NON_TASK_EVENTS.has(item.eventType)) {
        // Still counted, because a segment boundary was worth deriving from it even though the
        // event itself is not a step.
        stats.skipped += 1;
        continue;
      }
      if (segment.actions.length < MAX_ACTIONS_PER_SEGMENT) {
        segment.actions.push({
          at: item.at,
          eventType: item.eventType || "unknown",
          element: item.element || null,
          text: item.text || null,
          coordinatesOnly: !item.element && item.hasCoords,
        });
      }
      continue;
    }
    if (item.kind === "audio") {
      if (segment.narration.length < MAX_ACTIONS_PER_SEGMENT) segment.narration.push(item.text);
      continue;
    }
    // OCR re-reads the same screen every frame. The exact check is cheap and catches most of it;
    // the overlap check catches the rest, which is the majority on real capture.
    const fingerprint = item.text.toLowerCase();
    if (segment.seen.has(fingerprint) || isNearDuplicate(item.text, segment.keptWords)) {
      stats.duplicateLines += 1;
      continue;
    }
    segment.seen.add(fingerprint);
    if (segment.lines.length < MAX_LINES_PER_SEGMENT) {
      segment.lines.push(item.text);
      segment.keptWords.push(wordSet(item.text));
    }
  }

  // Over the cap, keep both ends and drop the middle.
  //
  // Taking the first N silently threw away the end of the recording, which for a workflow is the
  // payoff: the review screen and the submit. A draft missing its final step looks complete and is
  // not. Both ends carry the task's shape — where it starts and what it commits — so the middle,
  // which is usually repetition, is what gives way. The gap is reported, never silent.
  const overflowed = segments.length > MAX_SEGMENTS;
  const head = Math.ceil(MAX_SEGMENTS / 2);
  const selected = overflowed
    ? [...segments.slice(0, head), ...segments.slice(segments.length - (MAX_SEGMENTS - head))]
    : segments;
  const kept = selected.map(({ key: _key, seen: _seen, keptWords: _keptWords, ...segment }) => segment);
  const apps = [...new Set(kept.map((segment) => segment.app).filter(Boolean))];
  const urls = [...new Set(kept.map((segment) => segment.url).filter(Boolean))];
  return {
    startTime: capture?.startTime ?? null,
    endTime: capture?.endTime ?? null,
    includeAudio: Boolean(capture?.includeAudio),
    apps,
    urls,
    segments: kept,
    segmentsDropped: Math.max(0, segments.length - kept.length),
    counts: capture?.counts ?? {},
    unavailable: capture?.unavailable ?? [],
    stats,
  };
}

/**
 * The digest as prompt text.
 *
 * Written as a readable timeline rather than JSON: the model has to reason about ordering and
 * intent, and a labelled timeline makes both explicit. Bounded, because a long recording must
 * degrade into fewer segments rather than an over-length turn that fails.
 */
export function digestToPromptText(digest, { maxChars = DEFAULT_PROMPT_CHARS } = {}) {
  const lines = [
    `Recorded window: ${digest.startTime ?? "unknown"} to ${digest.endTime ?? "unknown"}`,
    `Applications seen: ${digest.apps.join(", ") || "none identified"}`,
    digest.urls.length ? `URLs seen: ${digest.urls.slice(0, 20).join(", ")}` : null,
    digest.includeAudio
      ? "Audio narration was included in this capture."
      : "Audio narration was NOT captured; do not claim the user said anything.",
    digest.unavailable.length
      ? `Capture layers unavailable: ${digest.unavailable.map((entry) => `${entry.contentType} (${entry.reason})`).join("; ")}`
      : null,
    "",
    "TIMELINE",
  ].filter(Boolean);

  for (const segment of digest.segments) {
    lines.push(
      "",
      `[${segment.index}] ${segment.app || "unknown app"}${segment.window ? ` — ${segment.window}` : ""}`,
      `    when: ${segment.startedAt} → ${segment.endedAt}${segment.url ? `\n    url: ${segment.url}` : ""}`,
    );
    if (segment.lines.length) {
      lines.push("    screen text:");
      for (const line of segment.lines) lines.push(`      - ${line}`);
    }
    if (segment.actions.length) {
      lines.push("    input events:");
      for (const action of segment.actions) {
        const target = action.element ? `on "${action.element}"` : action.coordinatesOnly ? "at screen coordinates (no element name)" : "";
        const typed = action.text ? ` typed "${action.text}"` : "";
        lines.push(`      - ${action.eventType} ${target}${typed}`.replace(/\s+/g, " ").trimEnd());
      }
    }
    if (segment.narration.length) {
      lines.push("    narration:");
      for (const said of segment.narration) lines.push(`      - "${said}"`);
    }
  }
  if (digest.segmentsDropped > 0) {
    lines.push(
      "",
      `(${digest.segmentsDropped} segments from the MIDDLE of this recording were dropped; it exceeded the digest limit. The start and the end are both present, so steps are missing between them — leave a gap rather than inventing the steps that would join them.)`,
    );
  }
  if (digest.stats.redactions > 0) {
    lines.push(
      "",
      `(${digest.stats.redactions} text fragments were redacted as credentials. Where a step needs one, write the step as "the user enters their password" and never invent the value.)`,
    );
  }
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n(digest truncated)` : text;
}
