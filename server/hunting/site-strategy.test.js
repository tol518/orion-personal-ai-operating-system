import assert from "node:assert/strict";
import test from "node:test";
import {
  describeStrategyForPrompt,
  playbookLessonKeys,
  resolveSiteStrategy,
} from "./site-strategy.js";
import { deriveLessons, mergePlaybook } from "./site-playbook.js";
import { resolveSiteAdapter } from "./site-adapters.js";

const ASHBY = resolveSiteAdapter("https://jobs.ashbyhq.com/x/y");

/** A playbook written the way a real run writes it, so the round-trip is what is tested. */
function playbookFor(attempts, application = {}) {
  return mergePlaybook({
    host: "jobs.ashbyhq.com",
    existingBody: "",
    lessons: deriveLessons({ adapter: ASHBY, host: "jobs.ashbyhq.com", attempts, application }),
  });
}

test("lesson keys survive the write-then-read round trip", () => {
  const body = playbookFor([{ phase: "submitted", outcome: "rejected", reasonCode: "submission_spam_flagged" }]);
  assert.ok(playbookLessonKeys(body).has("submission_spam_flagged"));
  assert.equal(playbookLessonKeys("no lessons here").size, 0);
});

test("a site that rejected an automated submission is downgraded on the next run", () => {
  const body = playbookFor([{ phase: "submitted", outcome: "rejected", reasonCode: "submission_spam_flagged" }]);
  const strategy = resolveSiteStrategy({
    host: "jobs.ashbyhq.com",
    playbookBody: body,
    configured: { automationPolicy: "assisted", autoSubmit: true },
  });
  assert.equal(strategy.automationPolicy, "prepare_only");
  assert.equal(strategy.autoSubmit, false);
  assert.match(strategy.reasons.join("; "), /rejected an automated submission/);
  assert.match(strategy.reasons.join("; "), /auto-submit is suppressed/);
});

test("memory can withdraw automation but never grant it", () => {
  // A playbook must not be able to switch on auto-submit for a host the user never opted in for.
  const strategy = resolveSiteStrategy({
    host: "reed.co.uk",
    playbookBody: "Trigger: x\n\nBetter approach:\n- fine <!-- submission_accepted -->\n\nAvoid:\n- y\n\nVerify:\n- z",
    configured: { automationPolicy: "assisted", autoSubmit: false },
  });
  assert.equal(strategy.autoSubmit, false);
  assert.equal(strategy.automationPolicy, "assisted");
});

test("a clean site is left exactly as configured", () => {
  const strategy = resolveSiteStrategy({
    host: "reed.co.uk",
    playbookBody: "",
    configured: { automationPolicy: "assisted", autoSubmit: true },
  });
  assert.equal(strategy.automationPolicy, "assisted");
  assert.equal(strategy.autoSubmit, true);
  assert.deepEqual(strategy.reasons, []);
  assert.deepEqual(strategy.learnedFrom, []);
});

test("a headed-browser lesson is surfaced as a recommendation, not applied silently", () => {
  // Browser choice is gateway configuration, not a per-request switch, so it cannot be flipped
  // mid-run; saying so is more honest than pretending it was handled.
  const strategy = resolveSiteStrategy({
    host: "jobs.ashbyhq.com",
    playbookBody: "Trigger: x\n\nBetter approach:\n- a <!-- needs_headed_browser -->\n\nAvoid:\n- b\n\nVerify:\n- c",
    configured: {},
  });
  assert.match(strategy.reasons.join("; "), /keep gateway\.nodes\.browser routed to the desktop node/);
  assert.ok(strategy.learnedFrom.includes("needs_headed_browser"));
});

test("the prompt only carries history the run can act on", () => {
  const body = playbookFor(
    [{ phase: "opening_form", outcome: "needs_human_action", reasonCode: "sign_in" }],
    { manualActionKind: "sign_in" },
  );
  const strategy = resolveSiteStrategy({ host: "jobs.ashbyhq.com", playbookBody: body, configured: {} });
  const prompt = describeStrategyForPrompt({ host: "jobs.ashbyhq.com", strategy });
  assert.match(prompt, /WHAT PAST APPLICATIONS ON jobs\.ashbyhq\.com SHOWED/);
  assert.match(prompt, /hides the form behind sign-in/);
  // Still never an instruction to sign in itself.
  assert.match(prompt, /do not attempt to sign in/);

  const clean = resolveSiteStrategy({ host: "new.example", playbookBody: "", configured: {} });
  assert.match(describeStrategyForPrompt({ host: "new.example", strategy: clean }), /No prior application lessons/);
});

test("a recorded external-apply handoff changes the next run instead of being rediscovered", () => {
  // The lesson was written from the first LinkedIn handoff but was not actionable, so 11 later
  // runs still stopped with "no application fields are visible" after clicking Apply.
  const body = "- Apply opens the employer form in a new tab. _(first seen 2026-07-27)_ <!-- external_application_redirect -->";
  const strategy = resolveSiteStrategy({ host: "linkedin.com", playbookBody: body });
  assert.equal(strategy.expectExternalApply, true);
  assert.ok(strategy.learnedFrom.includes("external_application_redirect"));

  const prompt = describeStrategyForPrompt({ host: "linkedin.com", strategy });
  assert.match(prompt, /leaves this site for the employer'?s own form in a new tab/);
  // The model must not read "no form on the listing" as a dead end after clicking Apply.
  assert.match(prompt, /expected progress, not a failure/);

  // A site with no such lesson says nothing about it.
  const plain = resolveSiteStrategy({ host: "reed.co.uk", playbookBody: "" });
  assert.equal(plain.expectExternalApply, false);
});
