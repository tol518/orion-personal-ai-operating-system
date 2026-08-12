// What each application site actually does, learned from runs rather than assumed.
//
// One memory node per website, keyed by host, so lessons accumulate where they apply: Reed's
// sign-in wall belongs to Reed, Ashby's file-only cover letter belongs to Ashby. Every line is
// derived from the structured attempt records the run already wrote — phases, outcomes, reason
// codes, committed dropdown options — so the playbook cannot drift into invention.
//
// It records the failure *and* what worked instead, because "the CV field empties after filling,
// re-attaching fixes it" is the useful shape; "upload failed" is not.
//
// Field values are never written here. Labels and the option text a form offers are page
// structure and safe to keep; what was typed into a field is personal data and stays out.
const MAX_LESSONS_PER_SECTION = 20;
// The canonical Shared Lesson shape the rest of the app already uses and validates
// (isStructuredLesson in managed-memory.js). Sections map onto it so a site playbook is
// procedural memory like any other lesson, not a parallel format only Hunting understands.
const SECTIONS = [
  ["works", "Better approach"],
  ["fails", "Avoid"],
  ["answers", "Verify"],
];
// Defensive: a run should never surface a secret, but a playbook is written to the vault.
const CREDENTIAL_HINT = /\b(password|passcode|otp|one-time code|secret|api[_ -]?key|token)\b/i;
// Phases where a failure followed by a success is a reusable recovery rather than noise.
const RECOVERABLE_PHASES = [
  ["uploading_cv", new Set(["uploaded"])],
  ["opening_form", new Set(["form_open", "redirect_followed", "redirect_recovered"])],
  ["filling_verified_fields", new Set(["ready_for_review"])],
];

/** Normalized host, which is the identity of a playbook. */
export function siteHost(url) {
  try {
    return new URL(String(url ?? "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Stable class-level key, one per site, normalized the way lessonKey() will store it. */
export function playbookKey(host) {
  return `job-application-site-${host}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function playbookTitle(host) {
  return `${host} application playbook`.slice(0, 120);
}

/** Tags mirror the existing application-recovery lessons so retrieval treats them alike. */
export function playbookTags(host) {
  return ["job-hunting", "site-playbook", host];
}

/**
 * Turn one run into durable, site-level lessons.
 *
 * Keys are stable so the same observation seen twice updates a line instead of adding one.
 */
export function deriveLessons({ adapter, host = "", attempts = [], application = {} }) {
  // Name the site, not the adapter: a generic adapter would otherwise read "Employer form".
  const siteName = host || adapter?.label || "this site";
  const lessons = [];
  const add = (section, key, text) => {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean || CREDENTIAL_HINT.test(clean)) return;
    lessons.push({ section, key, text: clean });
  };
  const byPhase = (phase) => attempts.filter((attempt) => attempt.phase === phase);

  // Human checkpoints: the most valuable thing to know before starting a site at all.
  if (application.manualActionKind === "sign_in" || byPhase("opening_form").some((a) => a.reasonCode === "sign_in")) {
    add(
      "fails",
      "sign_in_wall",
      `The application form is hidden behind sign-in. Sign in once by hand in the browser profile; it persists, so later applications on ${siteName} skip this.`,
    );
  }
  if (application.manualActionKind === "captcha" || byPhase("opening_form").some((a) => a.reasonCode === "captcha")) {
    add("fails", "captcha", "Shows an anti-bot challenge that a human has to clear in the browser takeover.");
  }

  if (
    byPhase("opening_form").some(
      (attempt) => attempt.outcome === "redirect_followed" || attempt.outcome === "redirect_recovered",
    )
  ) {
    add(
      "works",
      "external_application_redirect",
      "Apply can open an employer-hosted form in a new tab. Continue in the server-owned redirected tab and use the destination form's controls.",
    );
  }

  // CV upload: record the method that worked, and the repair when the first attempt did not.
  const upload = byPhase("uploading_cv").at(-1);
  if (upload?.outcome === "uploaded") {
    const method = upload.evidence?.method ?? "file input";
    add("works", `cv_upload:${method}`, `The CV attaches through the page's file input (verified by ${method}).`);
  } else if (upload) {
    add("fails", `cv_upload:${upload.reasonCode ?? upload.outcome}`, `CV upload ended as ${upload.outcome}: ${upload.detail ?? "no detail"}.`);
  }

  // The attachment repair is exactly the "one way failed, another worked" case.
  const filling = byPhase("filling_verified_fields").at(-1);
  const repair = filling?.evidence?.attachments;
  if (repair?.cv?.outcome === "uploaded") {
    add(
      "works",
      "cv_reattach_after_fill",
      "The CV field empties while the form is filled; re-attaching it after the fill step fixes it.",
    );
  }
  if (repair?.coverLetter?.outcome === "uploaded" && repair.coverLetter.format) {
    add(
      "works",
      `cover_letter_format:${repair.coverLetter.format}`,
      `The cover letter field takes a file, and a .${repair.coverLetter.format} upload is accepted.`,
    );
    for (const attempt of repair.coverLetter.attempts ?? []) {
      if (attempt.outcome !== "uploaded" && attempt.format) {
        add("fails", `cover_letter_rejected:${attempt.format}`, `A .${attempt.format} cover letter is not accepted here (${attempt.outcome}).`);
      }
    }
  } else if (repair?.coverLetter?.outcome === "skipped") {
    add("fails", "cover_letter_unattachable", "The cover letter field could not be filled as text or as a file; it was left blank.");
  }

  // A CV field that only exists on a later step is a property of the form, not a fault.
  if (byPhase("uploading_cv").some((attempt) => attempt.outcome === "deferred_to_later_step")) {
    add(
      "works",
      "cv_field_on_later_step",
      "The first step exposes no CV field. Continue through the form's steps and attach the CV when the field appears; a missing file input on step one is not a failure here.",
    );
  }

  // An error that was solved mid-application is the most valuable note there is: it is the
  // difference between hitting the same wall again and walking straight past it. Recorded per
  // phase, so the recovery is attached to the step that needed it.
  for (const [phase, successes] of RECOVERABLE_PHASES) {
    const attempts = byPhase(phase);
    const failedAt = attempts.findIndex((attempt) => !successes.has(attempt.outcome));
    if (failedAt < 0) continue;
    const recovery = attempts.slice(failedAt + 1).find((attempt) => successes.has(attempt.outcome));
    if (!recovery) continue;
    const failure = attempts[failedAt];
    add(
      "works",
      `recovered:${phase}:${failure.reasonCode ?? failure.outcome}`,
      `${phase.replace(/_/g, " ")} first failed as ${failure.outcome}${failure.reasonCode ? ` (${failure.reasonCode})` : ""}, then succeeded as ${recovery.outcome}${recovery.reasonCode ? ` (${recovery.reasonCode})` : ""}. Expect the first attempt to fail here and carry on to the step that worked.`,
    );
  }

  // Option wording is reusable: the same question is asked the same way next time.
  for (const field of application.filledFields ?? []) {
    if (!field.selectedOption) continue;
    add("answers", `option:${field.field}`.toLowerCase(), `"${field.field}" → committed option "${field.selectedOption}".`);
  }
  for (const field of application.unresolvedFields ?? []) {
    add("answers", `unresolved:${field.field}`.toLowerCase(), `"${field.field}" needs a human decision (${field.reason}).`);
  }

  // Submission outcomes, including a rejection that should change how the site is used.
  const submitted = byPhase("submitted").at(-1);
  if (submitted?.reasonCode === "submission_spam_flagged") {
    add(
      "fails",
      "submission_spam_flagged",
      "Rejects automated submissions as spam. Use prepare-only for this host: prepare everything, then fill and submit by hand.",
    );
  } else if (submitted?.outcome === "user_confirmed") {
    add("works", "submission_accepted", "A submission completed from this site after review.");
  }
  return lessons;
}

/**
 * Merge new lessons into the existing note.
 *
 * A repeated observation refreshes its "last confirmed" date rather than duplicating, so the
 * playbook stays readable however many times a site is applied to.
 */
export function mergePlaybook({ host, existingBody = "", lessons, now = new Date() }) {
  const today = now.toISOString().slice(0, 10);
  const existing = parsePlaybook(existingBody);
  for (const lesson of lessons) {
    const section = existing.get(lesson.section) ?? new Map();
    const previous = section.get(lesson.key);
    section.set(lesson.key, {
      text: lesson.text,
      firstSeen: previous?.firstSeen ?? today,
      lastConfirmed: today,
    });
    existing.set(lesson.section, section);
  }

  const render = (name) => {
    const entries = [...(existing.get(name) ?? new Map()).entries()].slice(-MAX_LESSONS_PER_SECTION);
    return entries.map(([key, entry]) => {
      const seen = entry.firstSeen === entry.lastConfirmed
        ? `first seen ${entry.firstSeen}`
        : `first seen ${entry.firstSeen}, last confirmed ${entry.lastConfirmed}`;
      // The key rides in an HTML comment: invisible when rendered, but it keeps the round-trip
      // stable when a lesson's wording changes between runs.
      return `- ${entry.text} _(${seen})_ <!-- ${key} -->`;
    });
  };
  const works = render("works");
  const fails = render("fails");
  const answers = render("answers");

  // Every section must be non-empty for the shared-lesson validator to accept the body.
  const body = [
    `Trigger: Applying to a job on ${host}. Observed from verified application attempts; no answer values are recorded here.`,
    ["Better approach:", ...(works.length ? works : [`- No confirmed working step recorded for ${host} yet.`])].join("\n"),
    ["Avoid:", ...(fails.length ? fails : ["- Repeating a step the live form has not confirmed, and overriding sign-in, CAPTCHA, declaration, or final-submit boundaries."])].join("\n"),
    [
      "Verify:",
      ...(answers.length ? answers : []),
      "- Re-read the live form and confirm every required field is answered before ready for review; final submission stays user-controlled.",
    ].join("\n"),
  ].join("\n\n");
  return body.slice(0, 8_000);
}

/** Read an existing note back into keyed entries so merging is idempotent. */
function parsePlaybook(body) {
  const sections = new Map();
  let current = null;
  for (const line of String(body ?? "").split("\n")) {
    const heading = /^(Better approach|Avoid|Verify):\s*$/.exec(line.trim());
    if (heading) {
      current = SECTIONS.find(([, label]) => label === heading[1])?.[0] ?? null;
      continue;
    }
    if (/^(Trigger):/.test(line.trim())) {
      current = null;
      continue;
    }
    const item =
      /^-\s+(.*?)\s*_\((?:first seen ([\d-]+))(?:, last confirmed ([\d-]+))?\)_(?:\s*<!--\s*(.*?)\s*-->)?\s*$/.exec(
        line.trim(),
      );
    if (!current || !item) continue;
    const text = item[1];
    const entries = sections.get(current) ?? new Map();
    // Fall back to the text as key for lines written before keys were stored.
    entries.set(item[4] || text, { text, firstSeen: item[2], lastConfirmed: item[3] ?? item[2] });
    sections.set(current, entries);
  }
  return sections;
}
