import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_POLICIES,
  describeAdapterForPrompt,
  detectHumanCheckpoint,
  detectSubmissionRejection,
  resolveAutomationPolicy,
  resolveSiteAdapter,
} from "./site-adapters.js";

test("adapters resolve by host and fall back to the generic form profile", () => {
  assert.equal(resolveSiteAdapter("https://www.linkedin.com/jobs/view/4443869815").id, "linkedin");
  assert.equal(resolveSiteAdapter("https://uk.indeed.com/viewjob?jk=abc").id, "indeed");
  assert.equal(resolveSiteAdapter("https://jobs.ashbyhq.com/Orbital/abc").id, "ashby");
  assert.equal(resolveSiteAdapter("https://careers.acme.com/apply").id, "generic");
  assert.equal(resolveSiteAdapter("not a url").id, "generic");
});

test("every adapter keeps the final submit control off limits", () => {
  for (const url of [
    "https://www.linkedin.com/jobs/view/1",
    "https://uk.indeed.com/viewjob?jk=1",
    "https://jobs.ashbyhq.com/x/y",
    "https://careers.acme.com/apply",
  ]) {
    const adapter = resolveSiteAdapter(url);
    assert.ok(adapter.forbiddenControlLabels.some((label) => label.includes("submit")));
    assert.match(describeAdapterForPrompt(adapter), /must never click/);
  }
});

test("sign-in walls and anti-bot challenges are detected before any form work", () => {
  const linkedin = resolveSiteAdapter("https://www.linkedin.com/jobs/view/1");
  assert.equal(
    detectHumanCheckpoint({ url: "https://www.linkedin.com/authwall?trk=x", adapter: linkedin })?.kind,
    "sign_in",
  );
  assert.equal(
    detectHumanCheckpoint({
      url: "https://www.linkedin.com/checkpoint/challenge/verify",
      adapter: linkedin,
    })?.kind,
    "captcha",
  );
  const indeed = resolveSiteAdapter("https://uk.indeed.com/viewjob?jk=1");
  assert.equal(
    detectHumanCheckpoint({
      url: "https://uk.indeed.com/viewjob?jk=1",
      text: "Sign in to your Indeed account to continue",
      adapter: indeed,
    })?.kind,
    "sign_in",
  );
  assert.equal(
    detectHumanCheckpoint({
      url: "https://careers.acme.com/apply",
      text: "Please confirm you are human: I'm not a robot",
      adapter: resolveSiteAdapter("https://careers.acme.com/apply"),
    })?.kind,
    "captcha",
  );
});

test("an ordinary application page is not treated as a checkpoint", () => {
  const adapter = resolveSiteAdapter("https://jobs.ashbyhq.com/Orbital/abc");
  assert.match(describeAdapterForPrompt(adapter), /Ashby Yes\/No questions/);
  assert.match(describeAdapterForPrompt(adapter), /visibly remains selected/);
  assert.equal(
    detectHumanCheckpoint({
      url: "https://jobs.ashbyhq.com/Orbital/abc/application",
      text: "Resume Upload File Autofill with resume First name Last name",
      adapter,
    }),
    null,
  );
});

test("a spam-rejected submission is detected and never mistaken for success", () => {
  assert.deepEqual(
    detectSubmissionRejection({
      text: "We couldn't submit your application. Your application submission was flagged as possible spam.",
    }),
    {
      reasonCode: "submission_spam_flagged",
      detail: "The employer rejected the submission as possible spam.",
      evidence: "application submission was flagged as possible spam",
    },
  );
  assert.equal(detectSubmissionRejection({ text: "Thank you. Your application was submitted." }), null);
});

test("a flagging employer can be switched to prepare-only without a code change", () => {
  // The honest response to "submission flagged as possible spam" is to stop automating field
  // entry for that host, not to disguise the automation.
  const hosts = ["jobs.ashbyhq.com"];
  assert.equal(
    resolveAutomationPolicy("https://jobs.ashbyhq.com/goodlord/abc", { prepareOnlyHosts: hosts }),
    "prepare_only",
  );
  // Subdomains of a listed host are covered; unrelated employers are not.
  assert.equal(resolveAutomationPolicy("https://boards.greenhouse.io/x", { prepareOnlyHosts: hosts }), "assisted");
  assert.equal(resolveAutomationPolicy("https://jobs.ashbyhq.com/x", { prepareOnlyHosts: [] }), "assisted");
  assert.equal(resolveAutomationPolicy("not a url", { prepareOnlyHosts: hosts }), "assisted");
  assert.ok(AUTOMATION_POLICIES.has("prepare_only"));
});

test("Greenhouse URLs use the Greenhouse adapter", () => {
  assert.equal(resolveSiteAdapter("https://job-boards.greenhouse.io/figma/jobs/5551697004").id, "greenhouse");
  assert.equal(resolveSiteAdapter("https://boards.greenhouse.io/figma/jobs/5551697004").id, "greenhouse");
});

test("the spam-flag banner from a real rejection is recognised", () => {
  const rejection = detectSubmissionRejection({
    text: "We couldn't submit your application Your application submission was flagged as possible spam.",
  });
  assert.equal(rejection.reasonCode, "submission_spam_flagged");
  assert.equal(detectSubmissionRejection({ text: "Application received. Thank you." }), null);
});
