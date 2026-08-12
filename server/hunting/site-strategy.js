// Reading the site playbook back, so a lesson changes what the next run does.
//
// Writing lessons is only half of learning. This is the other half: before an application
// starts, the site's playbook memory is consulted and the run's behaviour is adjusted from what
// that site has already been observed to do. A site that rejected an automated submission stops
// being submitted for; a site that needed the headed browser says so.
//
// Lessons are matched by the stable keys the playbook writes (they ride in HTML comments), not
// by prose, so a reworded line keeps working and an unrelated sentence cannot trigger a switch.
const LESSON_KEY = /<!--\s*([a-z0-9:._-]+)\s*-->/gi;

/** Keys the playbook records that this run knows how to act on. */
export const ACTIONABLE_LESSONS = new Set([
  "submission_spam_flagged",
  "sign_in_wall",
  "captcha",
  "needs_headed_browser",
  // Recorded since the first LinkedIn handoff but never consumed, so every run rediscovered it.
  "external_application_redirect",
]);

/** Extract the lesson keys present in a playbook body. */
export function playbookLessonKeys(body) {
  const keys = new Set();
  for (const match of String(body ?? "").matchAll(LESSON_KEY)) keys.add(match[1].toLowerCase());
  return keys;
}

/**
 * Turn a site's recorded lessons into the settings this run should use.
 *
 * `configured` is what the operator set (env); memory can tighten it but never loosen it — a
 * playbook must not be able to switch auto-submit on for a host the user never opted in for.
 */
export function resolveSiteStrategy({ host, playbookBody = "", configured = {} }) {
  const keys = playbookLessonKeys(playbookBody);
  const reasons = [];
  let automationPolicy = configured.automationPolicy ?? "assisted";
  let autoSubmit = configured.autoSubmit === true;

  if (keys.has("submission_spam_flagged")) {
    // The site rejected an automated submission before; stop automating entry and submission.
    if (automationPolicy !== "prepare_only") {
      automationPolicy = "prepare_only";
      reasons.push(`${host} rejected an automated submission before, so field entry is left to you`);
    }
    if (autoSubmit) {
      autoSubmit = false;
      reasons.push(`auto-submit is suppressed on ${host} after its earlier rejection`);
    }
  }
  const expectExternalApply = keys.has("external_application_redirect");
  const expectSignIn = keys.has("sign_in_wall");
  const expectChallenge = keys.has("captcha");
  if (keys.has("needs_headed_browser")) {
    // Browser choice is gateway configuration, not a per-request switch, so this is surfaced
    // as an operator recommendation rather than silently applied.
    reasons.push(`${host} previously needed the headed browser; keep gateway.nodes.browser routed to the desktop node`);
  }

  return {
    automationPolicy,
    autoSubmit,
    expectExternalApply,
    expectSignIn,
    expectChallenge,
    learnedFrom: [...keys].filter((key) => ACTIONABLE_LESSONS.has(key)),
    reasons,
  };
}

/**
 * One line for the model's prompt. Only what changes its behaviour goes in; the full playbook
 * would crowd the brief without telling it anything it can act on.
 */
export function describeStrategyForPrompt({ host, strategy }) {
  if (!strategy.learnedFrom.length) return `No prior application lessons are recorded for ${host}.`;
  const lines = [`WHAT PAST APPLICATIONS ON ${host} SHOWED:`];
  if (strategy.expectExternalApply) {
    lines.push(
      "- Apply here leaves this site for the employer's own form in a new tab. Click Apply, then stop and report what you see: the server adopts that tab and re-runs this phase against it. Finding no form on the listing after clicking Apply is expected progress, not a failure.",
    );
  }
  if (strategy.expectSignIn) {
    lines.push("- This site hides the form behind sign-in. If you meet it, stop and hand over; do not attempt to sign in.");
  }
  if (strategy.expectChallenge) {
    lines.push("- This site has shown an anti-bot challenge. If you meet one, stop and hand over immediately.");
  }
  if (strategy.automationPolicy === "prepare_only") {
    lines.push("- This site rejects automated submissions. Do not fill fields; open the form and stop for the user.");
  }
  return lines.join("\n");
}
