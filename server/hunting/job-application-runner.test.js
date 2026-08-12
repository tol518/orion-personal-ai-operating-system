import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildFillFieldsPrompt,
  buildApplicationGuidanceLesson,
  applicationSessionLabel,
  buildOpenFormPrompt,
  collectMemoryRetryFields,
  describeUploadForPrompt,
  JobApplicationRunner,
  normalizeApplicationGuidance,
  parseFillFieldsResult,
  parseOpenFormResult,
  selectRelatedApplicantMemories,
} from "./job-application-runner.js";
import { resolveSiteAdapter } from "./site-adapters.js";
import { describeConsentForPrompt } from "./consent-policy.js";

const JOB = { id: "job-1", title: "Engineer", company: "Example", url: "https://www.linkedin.com/jobs/view/1" };
const LINKEDIN = resolveSiteAdapter(JOB.url);
const OWNED_TAB = { targetId: "SERVER-TARGET", currentUrl: JOB.url };

test("application session labels remain distinct for duplicate company and role listings", () => {
  const duplicate = { ...JOB, id: "job-2" };
  assert.equal(applicationSessionLabel(JOB), "Hunting · Example · Engineer · job-1");
  assert.equal(applicationSessionLabel(duplicate), "Hunting · Example · Engineer · job-2");
});

test("the form-opening phase forbids data entry, uploads, credentials, and the final submit", () => {
  const prompt = buildOpenFormPrompt({ job: JOB, adapter: LINKEDIN, ownedTab: OWNED_TAB, resume: false });
  assert.match(prompt, /Do not type into any field, click any file chooser, upload, replace, clear, or re-select any file/);
  assert.match(prompt, /File controls are exclusively owned by the server/);
  assert.match(prompt, /visible but unclicked final Submit control is normal/i);
  assert.match(prompt, /Never enter a password, passcode, one-time code, or 2FA response/);
  assert.match(prompt, /Credentials are never supplied to you/);
  assert.match(prompt, /Never solve, click, delegate, or attempt to bypass a CAPTCHA/);
  assert.match(prompt, /Never click the final apply, submit, confirm, or send control/);
  assert.match(prompt, /Controls you must never click: submit application/);
  assert.match(prompt, /server already opened.*SERVER-TARGET/i);
  assert.match(prompt, /target="node"/);
  assert.match(prompt, /target="host".*forbidden/);
  assert.match(prompt, /Never use exec, node_exec, shell, computer control, AppleScript, or Safari/);
  assert.match(prompt, /Do not call browser tabs, open, or navigate/);
  assert.match(prompt, /LinkedIn and Indeed can send Apply to an employer-hosted form/i);
  assert.match(prompt, /never ask the user to provide a target ID/i);
  // No upload path is handed to the model any more: the BFF owns the attachment.
  assert.doesNotMatch(prompt, /media:\/\/inbound|\/tmp\/openclaw\/uploads/);
});

test("a reusable field that already admits a verified answer gets one automatic memory retry", () => {
  const fields = collectMemoryRetryFields({
    unresolvedFields: [
      { field: "Visa sponsorship", reason: "Verified No answer needs a confirmed selection." },
      { field: "Preferred pronouns", reason: "No verified pronoun preference." },
      { field: "Government work", reason: "Required personal preference is not verified." },
    ],
  });
  assert.deepEqual(fields, ["Visa sponsorship"]);

  const prompt = buildFillFieldsPrompt({
    job: JOB,
    cv: "Verified CV",
    identityMemory: { id: "identity", body: "Identity facts" },
    applicationMemory: { id: "application", body: "Does not require visa sponsorship." },
    adapter: LINKEDIN,
    targetId: "T1",
    uploadSummary: "The CV is attached.",
    memoryRetryFields: fields,
  });
  assert.match(prompt, /AUTOMATIC VERIFIED-MEMORY RETRY/);
  assert.match(prompt, /Do not ask the user for those answers again/);
  assert.match(prompt, /Visa sponsorship/);
});

test("the first pass includes approved general memories linked to the user", () => {
  const identityMemory = { id: "identity", body: "the user lives in London.", links: ["application", "work", "project"] };
  const applicationMemory = { id: "application", body: "Application facts.", links: ["identity"] };
  const relatedMemories = selectRelatedApplicantMemories(
    [
      { id: "work", title: "Example Company", body: "the user works as a software developer.", status: "approved", memoryType: "general" },
      { id: "project", title: "JARVIS", body: "Project facts.", status: "approved", memoryType: "project" },
      { id: "draft", title: "Draft", body: "Unapproved.", status: "pending", memoryType: "general" },
    ],
    { identityMemory, applicationMemory },
  );
  assert.deepEqual(relatedMemories.map((memory) => memory.id), ["work"]);

  const prompt = buildFillFieldsPrompt({
    job: JOB,
    cv: "Verified CV",
    identityMemory,
    applicationMemory,
    relatedMemories,
    adapter: LINKEDIN,
    targetId: "T1",
    uploadSummary: "The CV is attached.",
  });
  assert.match(prompt, /RELATED APPROVED PERSONAL MEMORIES/);
  assert.match(prompt, /MEMORY work — Example Company/);
  assert.match(prompt, /A fact about another named person or organisation is not the user's fact/);
});

test("a submit-only review reply is normalized to an open form", () => {
  const result = parseOpenFormResult(
    JSON.stringify({
      status: "needs_human_action",
      currentUrl: JOB.url,
      cvRequired: true,
      cvAttached: true,
      humanActionKind: "other",
      humanAction: "Review and click Submit application personally.",
      notes: "The application is open and ready for your final review. I cannot submit it on your behalf.",
    }),
  );
  assert.equal(result.status, "form_open");
});

test("the field-filling phase requires a source per field and repeats the safety rules", () => {
  const prompt = buildFillFieldsPrompt({
    job: JOB,
    cv: "Verified CV",
    identityMemory: { id: "identity", body: "Identity facts" },
    applicationMemory: { id: "application", body: "Application facts" },
    adapter: LINKEDIN,
    targetId: "T1",
    uploadSummary: describeUploadForPrompt({
      outcome: "uploaded",
      evidence: { filename: "cv.pdf" },
      cvRequired: true,
    }),
    coverLetter: "Dear Goodlord hiring team,",
  });
  assert.match(prompt, /Work only in browser tab targetId T1/);
  assert.match(prompt, /already attached cv\.pdf to this form and verified it on the page/);
  assert.match(prompt, /Do not upload, replace, or re-select any file/);
  assert.match(prompt, /must name the source you used/);
  assert.match(prompt, /APPROVED SECOND BRAIN SOURCE OF TRUTH/);
  assert.match(prompt, /Read these memories before inspecting or filling any field/);
  assert.match(prompt, /On the first pass, answer every work-authorisation/);
  assert.ok(prompt.indexOf("VERIFIED APPLICATION MEMORY") < prompt.indexOf("FIELD POLICY"));
  assert.match(prompt, /Leave voluntary demographic, disability, veteran, and diversity questions blank/);
  // A dropdown whose wording differs from the memory's wording is the case that failed live.
  assert.match(prompt, /including when the form asks it as a dropdown whose wording differs/);
  assert.match(prompt, /Never leave a combobox holding typed text with no option selected/);
  assert.match(prompt, /Custom Yes\/No button groups/);
  assert.match(prompt, /COVER LETTER WRITTEN FOR THIS ROLE/);
  assert.match(prompt, /Dear Goodlord hiring team/);
});

test("an authorised acceptance reaches both phases, and an unauthorised one is refused", () => {
  // The refusal this replaces stalled a three-step form at step 1 over a privacy-policy
  // acknowledgement the user had already told it to accept.
  const consent = describeConsentForPrompt({ host: "bendingspoons.com", gates: ["privacy_policy"] });
  const prompts = [
    buildOpenFormPrompt({ job: JOB, adapter: LINKEDIN, ownedTab: OWNED_TAB, resume: true, consent }),
    buildFillFieldsPrompt({
      job: JOB,
      cv: "Verified CV",
      identityMemory: { id: "identity", body: "Identity facts" },
      applicationMemory: { id: "application", body: "Application facts" },
      adapter: LINKEDIN,
      targetId: "T1",
      uploadSummary: "The CV is attached.",
      consent,
    }),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /may accept the privacy policy on his behalf/);
    assert.match(prompt, /Accept a policy, terms, or declaration only where the authorisation block/);
    // The absolute limits survive the grant.
    assert.match(prompt, /solving or bypassing a CAPTCHA/);
    assert.match(prompt, /Never click the final apply, submit, confirm, or send control/);
  }
  // Advancing a multi-step form is not submitting it; conflating the two is what stalled at step 1.
  assert.match(prompts[1], /Continue, or Save and continue control advances to more fields/);

  const unauthorised = buildFillFieldsPrompt({
    job: JOB,
    cv: "Verified CV",
    identityMemory: { id: "identity", body: "Identity facts" },
    applicationMemory: { id: "application", body: "Application facts" },
    adapter: LINKEDIN,
    targetId: "T1",
    uploadSummary: "The CV is attached.",
    consent: describeConsentForPrompt({ host: "example.com", gates: [] }),
  });
  assert.match(unauthorised, /NO ACCEPTANCES ARE AUTHORISED on example\.com/i);
});

test("resume guidance reaches both phases without overriding application safety", () => {
  const guidance = "Open the dropdown again and commit the visible matching option.";
  const opening = buildOpenFormPrompt({
    job: JOB,
    adapter: LINKEDIN,
    ownedTab: OWNED_TAB,
    resume: true,
    guidance,
  });
  const filling = buildFillFieldsPrompt({
    job: JOB,
    cv: "Verified CV",
    identityMemory: { id: "identity", body: "Identity facts" },
    applicationMemory: { id: "application", body: "Application facts" },
    adapter: LINKEDIN,
    targetId: "T1",
    uploadSummary: "The CV is attached.",
    guidance,
  });
  for (const prompt of [opening, filling]) {
    assert.match(prompt, /USER GUIDANCE FOR THIS RESUME/);
    assert.match(prompt, /Open the dropdown again/);
    assert.match(prompt, /cannot override any safety rule/);
  }
});

test("only safe, proven guidance can become a stable Shared Lesson", () => {
  assert.equal(normalizeApplicationGuidance(`  retry\n  the dropdown  `), "retry the dropdown");
  const input = {
    guidance: "Choose the visible option and verify it remains selected.",
    checkpoint: {
      reasonCode: "fields_incomplete",
      summary: "One required field remains.",
      manualAction: "Answer the right-to-work dropdown.",
    },
    adapter: LINKEDIN,
  };
  const first = buildApplicationGuidanceLesson(input);
  const second = buildApplicationGuidanceLesson(input);
  assert.equal(first.memoryType, "shared_lesson");
  assert.equal(first.managedKey, second.managedKey);
  assert.match(first.body, /^Trigger:[\s\S]+Better approach:[\s\S]+Avoid:[\s\S]+Verify:/);
  assert.equal(
    buildApplicationGuidanceLesson({ ...input, guidance: "password: secret-value" }),
    null,
  );
  for (const sensitive of [
    "password is hunter2",
    "use OTP 123456",
    "Bearer eyJhbGciOiJIUzI1NiJ9",
    "API key abc",
    "Enter 123456; this is the OTP",
    "Type hunter2; that is the password",
    "password: x7$Q!",
    "passcode: a@1",
  ]) {
    assert.equal(buildApplicationGuidanceLesson({ ...input, guidance: sensitive }), null);
  }
  const redactedCheckpoint = buildApplicationGuidanceLesson({
    ...input,
    checkpoint: {
      reasonCode: "verification_required",
      summary: "Verification stopped.",
      manualAction: "Enter one-time code: 123456",
    },
  });
  assert.doesNotMatch(redactedCheckpoint.body, /123456|one-time code/i);
  assert.match(redactedCheckpoint.body, /Trigger: verification_required/);
});

test("the upload sentence never implies an attachment that was not verified", () => {
  assert.match(describeUploadForPrompt({ outcome: "input_not_found", cvRequired: true }), /application already holds/);
  assert.match(
    describeUploadForPrompt({ outcome: "not_required", cvRequired: false }),
    /asks for no CV/,
  );
});

test("form-opening results default to needing a CV and reject unknown statuses", () => {
  const parsed = parseOpenFormResult(`{
    "status":"form_open",
    "targetId":"T1",
    "currentUrl":"https://www.linkedin.com/jobs/view/1",
    "cvAttached":true,
    "uploadInputRef":"e12",
    "uploadControlRef":"e11",
    "humanActionKind":null,
    "notes":"Easy Apply modal is open"
  }`);
  assert.equal(parsed.status, "form_open");
  assert.equal(parsed.uploadInputRef, "e12");
  assert.equal(parsed.cvRequired, true);
  assert.equal(parsed.cvAttached, true);
  assert.equal(parseOpenFormResult('{"status":"halfway"}').status, "failed");
  assert.equal(parseOpenFormResult('{"status":"form_open","cvRequired":false}').cvRequired, false);
  // A sign-in wall comes back as a typed human action, not a generic failure.
  const blocked = parseOpenFormResult(
    '{"status":"needs_human_action","humanActionKind":"sign_in","humanAction":"Sign in to LinkedIn","notes":"Auth wall"}',
  );
  assert.equal(blocked.humanActionKind, "sign_in");
  assert.equal(blocked.humanAction, "Sign in to LinkedIn");
});

test("field results keep a bounded audit with a source and the option committed", () => {
  const result = parseFillFieldsResult(`{
    "status":"needs_human_action",
    "summary":"One question needs your decision",
    "currentUrl":"https://www.linkedin.com/jobs/view/1",
    "filledFields":[
      {"field":"First name","source":"identity-memory"},
      {"field":"Right to work in the UK","source":"application-memory","sourceFact":"Authorized to work in the UK with pre-settled status","selectedOption":"Yes - Settled/pre-settled status"},
      {"field":"Invented field","source":"guess"}
    ],
    "unresolvedFields":[{"field":"Salary expectation","reason":"no verified figure","required":true}],
    "skippedFields":[{"field":"Cover note","reason":"optional and unanswerable"}],
    "humanActionKind":"answer_question",
    "humanAction":"Answer the salary question yourself",
    "usedMemoryIds":["identity","application"]
  }`);
  assert.equal(result.status, "needs_human_action");
  assert.deepEqual(result.filledFields, [
    { field: "First name", source: "identity-memory" },
    // The committed option is recorded so a dropdown answer is reviewable.
    {
      field: "Right to work in the UK",
      source: "application-memory",
      sourceFact: "Authorized to work in the UK with pre-settled status",
      selectedOption: "Yes - Settled/pre-settled status",
    },
    // An unrecognised source is recorded as unstated rather than trusted.
    { field: "Invented field", source: "unstated" },
  ]);
  assert.deepEqual(result.unresolvedFields, [
    { field: "Salary expectation", reason: "no verified figure", required: true },
  ]);
  assert.deepEqual(result.skippedFields, [
    { field: "Cover note", reason: "optional and unanswerable", required: false },
  ]);
  assert.equal(result.humanActionKind, "answer_question");
  assert.equal(parseFillFieldsResult("not json").status, "failed");
});

test("terse string field notes are accepted in the same shape", () => {
  // Models drift between "field: reason" strings and objects; both must land normalized.
  const result = parseFillFieldsResult(
    '{"status":"needs_human_action","summary":"s","unresolvedFields":["Salary expectation: no verified figure"],"skippedFields":["Cover note"]}',
  );
  assert.deepEqual(result.unresolvedFields, [
    { field: "Salary expectation", reason: "no verified figure", required: true },
  ]);
  assert.deepEqual(result.skippedFields, [{ field: "Cover note", reason: "no reason given", required: false }]);
});

test("one application initializes its session once across opening, filling, and resume", async () => {
  // The gateway owns session initialization for every chat turn. Repeating sessions.create/patch
  // after the first reset raced that commit, so answering a form question could fail with
  // "reply session initialization conflicted" before the model saw the user's answer.
  const calls = [];
  const gateway = new EventEmitter();
  gateway.request = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "chat.abort") return { aborted: false };
    if (method !== "chat.send") return {};
    const message = String(payload.message);
    const reply = message.includes("completing the supported fields")
      ? JSON.stringify({ status: "ready_for_review", summary: "filled", filledFields: [] })
      : JSON.stringify({ status: "form_open", currentUrl: JOB.url, cvRequired: true, cvAttached: false, notes: "open" });
    queueMicrotask(() => gateway.emit("event", "chat", { sessionKey: payload.sessionKey, state: "final", message: reply }));
    return {};
  };
  const runner = new JobApplicationRunner({ gateway });

  await runner.openForm({ job: JOB, adapter: LINKEDIN, ownedTab: OWNED_TAB });
  await runner.fillFields({
    job: JOB,
    cv: "CV",
    identityMemory: { id: "identity", body: "Identity" },
    applicationMemory: { id: "application", body: "Application" },
    adapter: LINKEDIN,
    targetId: OWNED_TAB.targetId,
    uploadSummary: "CV attached",
  });
  await runner.openForm({ job: JOB, adapter: LINKEDIN, ownedTab: OWNED_TAB, resume: true, guidance: "Continue" });

  assert.equal(calls.filter((call) => call.method === "sessions.create").length, 1);
  assert.equal(calls.filter((call) => call.method === "sessions.reset").length, 1);
  assert.equal(calls.filter((call) => call.method === "sessions.patch").length, 1);
  assert.equal(calls.filter((call) => call.method === "chat.send").length, 3);
});

test("cancelling aborts every owned turn and prevents later phase writes", async () => {
  const calls = [];
  const gateway = {
    request: async (method, payload) => {
      calls.push({ method, payload });
      return { ok: true, aborted: true };
    },
  };
  const runner = new JobApplicationRunner({ gateway });
  const release = runner.claim(JOB.id);
  assert.throws(() => runner.claim("job-2"), /already working on an application/);
  const result = await runner.cancel(JOB.id, { sessionKeys: ["cv-session", "letter-session"] });
  assert.equal(result.cancelled, true);
  assert.equal(runner.isCancelled(JOB.id), true);
  assert.deepEqual(
    calls.map((call) => call.payload.sessionKey),
    [runner.sessionKey(JOB.id), "cv-session", "letter-session"],
  );
  assert.throws(() => runner.assertActive(JOB.id), { code: "application_cancelled" });
  const stopped = runner.waitForStop(JOB.id);
  release();
  assert.equal(await stopped, true);
});

test("cancelling an already-untracked job still aborts its gateway sessions", async () => {
  const calls = [];
  const gateway = {
    request: async (method, payload) => {
      calls.push({ method, payload });
      return { ok: true, aborted: true };
    },
  };
  const runner = new JobApplicationRunner({ gateway });

  const result = await runner.cancel(JOB.id, { sessionKeys: ["cv-session"] });

  assert.equal(result.cancelled, false);
  assert.deepEqual(
    calls.map((call) => call.payload.sessionKey),
    [runner.sessionKey(JOB.id), "cv-session"],
  );
});

test("cancellation becomes active before slow abort cleanup completes", async () => {
  let completeAbort;
  const runner = new JobApplicationRunner({
    gateway: {
      request: () =>
        new Promise((resolve) => {
          completeAbort = () => resolve({ ok: true, aborted: true });
        }),
    },
  });
  const release = runner.claim(JOB.id);
  const aborting = runner.cancel(JOB.id);

  assert.equal(runner.isCancelled(JOB.id), true);
  assert.throws(() => runner.assertActive(JOB.id), { code: "application_cancelled" });

  completeAbort();
  await aborting;
  release();
});

test("only one application runs at a time, and the refusal names the job holding the slot", async () => {
  // A bare "already working" refusal is unactionable: the UI needs to know which job to offer
  // to cancel.
  const runner = new JobApplicationRunner({ gateway: {} });
  const release = runner.claim("job-y");
  assert.equal(runner.activeJobId(), "job-y");

  const conflict = (jobId) => {
    try {
      runner.claim(jobId);
      return null;
    } catch (error) {
      return error;
    }
  };

  const other = conflict("job-x");
  assert.equal(other.statusCode, 409);
  assert.equal(other.code, "another_application_running");
  assert.equal(other.activeJobId, "job-y");

  const same = conflict("job-y");
  assert.equal(same.code, "application_already_running");
  assert.equal(same.activeJobId, "job-y");

  // Releasing frees the slot for the next job.
  release();
  assert.equal(runner.activeJobId(), null);
  const next = runner.claim("job-x");
  assert.equal(runner.activeJobId(), "job-x");
  next();
});
