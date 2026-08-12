import assert from "node:assert/strict";
import test from "node:test";
import {
  describeConsentForPlaybook,
  describeConsentForPrompt,
  NEVER_DELEGABLE,
  parseConsentGrant,
} from "./consent-policy.js";

const PRIVACY_CHECKPOINT = {
  summary: "The form is unchanged at Step 1 of 3 with personal details completed.",
  manualAction: "Personally accept the privacy policy and click Continue to proceed beyond Step 1.",
};

test("an instruction naming the policy is a grant", () => {
  const grant = parseConsentGrant({ guidance: "Accept the privacy policy and continue" });
  assert.equal(grant.gate, "privacy_policy");
  assert.equal(grant.source, "guidance");
});

test("application consent and notification acknowledgements are one delegable gate", () => {
  const grant = parseConsentGrant({ guidance: "Accept the Application Consent and Massachusetts Notification acknowledgements" });
  assert.equal(grant?.gate, "application_declaration");
});

test("shorthand answering a checkpoint takes its gate from the checkpoint", () => {
  // What the user actually types: the gate is in the message he is replying to, not his reply.
  const grant = parseConsentGrant({ guidance: "just click continue and accept", checkpoint: PRIVACY_CHECKPOINT });
  assert.equal(grant.gate, "privacy_policy");
  assert.equal(grant.source, "checkpoint");
});

test("shorthand with nothing to scope it to is not a grant", () => {
  // No checkpoint means no named gate, and a permission with no subject is not a permission.
  assert.equal(parseConsentGrant({ guidance: "go ahead" }), null);
  assert.equal(parseConsentGrant({ guidance: "carry on", checkpoint: { summary: "Two fields are empty." } }), null);
});

test("guidance that is not about accepting anything grants nothing", () => {
  assert.equal(
    parseConsentGrant({ guidance: "Re-open the dropdown and pick the matching option", checkpoint: PRIVACY_CHECKPOINT }),
    null,
  );
  assert.equal(parseConsentGrant({ guidance: "" }), null);
});

test("a refusal is never read as a grant", () => {
  for (const guidance of [
    "do not accept the privacy policy",
    "don't agree to the terms",
    "never accept the declaration, leave it for me",
  ]) {
    assert.equal(parseConsentGrant({ guidance, checkpoint: PRIVACY_CHECKPOINT }), null, guidance);
  }
});

test("gates outside the closed set cannot be granted", () => {
  // Credentials and challenges are refused whatever the instruction says, so no gate matches.
  for (const guidance of [
    "accept the password prompt and sign in for me",
    "agree to solve the captcha",
    "accept the payment terms and enter my card",
  ]) {
    assert.equal(parseConsentGrant({ guidance }), null, guidance);
  }
});

test("the prompt states the permission and its boundary together", () => {
  const granted = describeConsentForPrompt({ host: "bendingspoons.com", gates: ["privacy_policy"] });
  assert.match(granted, /may accept the privacy policy on his behalf/);
  assert.match(granted, /do not stop to ask again/);
  // A permission list with no boundary reads as permission for everything.
  for (const forbidden of NEVER_DELEGABLE) assert.ok(granted.includes(forbidden), forbidden);

  const ungranted = describeConsentForPrompt({ host: "example.com", gates: [] });
  assert.match(ungranted, /NO ACCEPTANCES ARE AUTHORISED on example\.com/i);
  for (const forbidden of NEVER_DELEGABLE) assert.ok(ungranted.includes(forbidden), forbidden);
});

test("the playbook line records who authorised it, not just that it happened", () => {
  const line = describeConsentForPlaybook({ host: "bendingspoons.com", gate: "privacy_policy" });
  assert.match(line, /the user authorised/);
  assert.match(line, /bendingspoons\.com/);
});
