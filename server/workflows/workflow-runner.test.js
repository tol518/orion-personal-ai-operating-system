import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import { WorkflowRunner, buildStepPrompt, findRefByText, isBrowserStep } from "./workflow-runner.js";
import { fillVariables, normalizeLearnedWorkflow } from "./learned-workflow.js";
import { mockBrowser, mockGateway } from "./test-support.js";

// The accessibility snapshot the deterministic path reads, in the shape /snapshot?format=ai emits:
// a YAML-ish tree where each interactive node carries its role, its visible label, and a ref.
const PAGE = `
- generic:
  - heading "Invoices" [ref=e1]
  - button "New invoice" [ref=e2]
  - textbox "Client name" [ref=e3]
  - button "Send invoice" [ref=e9]
  - button "Delete draft" [disabled] [ref=e10]
`;

function freshStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-workflow-runs-"));
  return new WorkflowStore(path.join(directory, "jarvis.sqlite"));
}

// A workflow shaped like the demo one but scoped to the mock page, so these tests exercise the
// runner rather than the demo fixture's anchors. The last step is the gate.
const SPEC = normalizeLearnedWorkflow({
  id: "runner-invoice",
  name: "Submit monthly invoice",
  description: "Raise the monthly invoice for one client and stop before sending it.",
  variables: [{ name: "clientName", description: "Client", required: true }],
  steps: [
    { id: "open", instruction: "Open the invoices page", actionType: "navigate", url: "https://app.ledgerly.example/invoices", successCheck: "Invoices" },
    { id: "new-invoice", instruction: "Start a new invoice", actionType: "click", target: { text: "New invoice" }, successCheck: "Client name" },
    { id: "fill-client", instruction: "Set the client to {{clientName}}", actionType: "type", target: { text: "Client name" }, input: "{{clientName}}" },
    { id: "send-invoice", instruction: "Send the invoice to {{clientName}}", actionType: "confirm", target: { text: "Send invoice" } },
  ],
  safety: { riskLevel: "medium", requiresConfirmationBeforeRun: true, blockedActions: [] },
});
const VALUES = { clientName: "Northwind Trading" };

function setup({ snapshot = PAGE, replies = null, spec = SPEC } = {}) {
  const store = freshStore();
  store.saveWorkflow(spec);
  const browser = mockBrowser({ snapshot });
  const gateway = mockGateway({ replies: replies ?? ['{"status":"done","detail":"did the step"}'] });
  const runner = new WorkflowRunner({ browser, gateway, store, agentStepTimeoutMs: 5_000 });
  const steps = fillVariables(spec, VALUES).steps;
  return { store, browser, gateway, runner, steps, spec };
}

test("a text anchor resolves to a ref, and a disabled control is never chosen", () => {
  assert.deepEqual(findRefByText(PAGE, "New invoice"), { role: "button", label: "New invoice", ref: "e2" });
  assert.equal(findRefByText(PAGE, "client name").ref, "e3", "matching is case-insensitive");
  assert.equal(findRefByText(PAGE, "Delete draft"), null, "a disabled control is not a target");
  assert.equal(findRefByText(PAGE, "Nonexistent button"), null);
  assert.equal(findRefByText("", "New invoice"), null);
});

test("a step is routed by where it happens, not by what it is called", () => {
  assert.equal(isBrowserStep({ url: "https://example.com" }), true);
  assert.equal(isBrowserStep({ app: "Google Chrome" }), true);
  // "Ledgerly" contains "edge"; an unanchored pattern would send a desktop step to the browser.
  assert.equal(isBrowserStep({ app: "Ledgerly Desktop" }), false);
  assert.equal(isBrowserStep({ app: "Microsoft Edge" }), true);
  // No app named: stay in the tab the run already owns, otherwise delegate.
  assert.equal(isBrowserStep({ instruction: "click Save" }, { hasTab: true }), true);
  assert.equal(isBrowserStep({ instruction: "click Save" }, { hasTab: false }), false);
});

test("a workflow that requires pre-run confirmation does not touch anything until approved", async () => {
  const { runner, browser, steps, spec } = setup();
  const run = await runner.start({ workflow: spec, steps, values: VALUES });
  assert.equal(run.status, "awaiting_confirmation");
  assert.match(run.detail, /About to run "Submit monthly invoice" — 4 steps, risk medium\./);
  assert.match(run.detail, /1 step will stop and ask you before acting\./);
  assert.deepEqual(browser.calls, [], "not one browser call before the user said yes");
});

test("the run stops at the sending step and never clicks it on its own", async () => {
  const { runner, browser, store, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  const resumed = await runner.resume({ runId: started.id, workflow: spec, steps, approved: true });

  assert.equal(resumed.status, "awaiting_confirmation");
  const waiting = resumed.results.at(-1);
  assert.equal(waiting.status, "awaiting_confirmation");
  assert.equal(waiting.id, "send-invoice");
  assert.match(resumed.detail, /Step "send-invoice" needs your approval/);
  // Every earlier step ran; the gated one did not.
  assert.deepEqual(
    resumed.results.slice(0, -1).map((result) => [result.id, result.status]),
    [
      ["open", "ok"],
      ["new-invoice", "ok"],
      ["fill-client", "ok"],
    ],
  );
  assert.ok(
    !browser.calls.some((call) => call.body?.ref === "e9"),
    "the Send invoice control must not be clicked before approval",
  );
  assert.equal(store.getRun(started.id).status, "awaiting_confirmation");
});

test("declining a checkpoint cancels the run instead of skipping the step", async () => {
  const { runner, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  const declined = await runner.resume({
    runId: started.id,
    workflow: spec,
    steps,
    approved: false,
    guidance: "not this month",
  });
  assert.equal(declined.status, "cancelled");
  assert.match(declined.detail, /Declined by the user: not this month/);
  assert.ok(declined.finishedAt);
  // The slot is released, so the next workflow can run.
  assert.equal(runner.activeRunId, null);
});

test("an approved checkpoint runs that step exactly once and completes the run", async () => {
  const { runner, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  await runner.resume({ runId: started.id, workflow: spec, steps, approved: true });
  const finished = await runner.resume({ runId: started.id, workflow: spec, steps, approved: true });

  assert.equal(finished.status, "completed");
  assert.equal(finished.results.length, 4, "four steps, four results, no duplicates");
  const send = finished.results.at(-1);
  assert.equal(send.id, "send-invoice");
  assert.equal(send.status, "ok");
  assert.equal(send.approved, true);
});

test("approving the pre-run gate is not approving the first step", async () => {
  // Two gates back to back is the case that breaks a naive resume: "yes, start this workflow" must
  // not be counted as "yes, delete the draft".
  const spec = normalizeLearnedWorkflow({
    name: "Gated first step",
    steps: [
      { id: "delete-draft", instruction: "Delete the existing draft", actionType: "click", target: { text: "New invoice" } },
      { id: "open", instruction: "Open the invoices page", actionType: "navigate", url: "https://app.ledgerly.example/invoices" },
    ],
    safety: { requiresConfirmationBeforeRun: true },
  });
  const { runner, browser, steps } = setup({ spec });
  const started = await runner.start({ workflow: spec, steps, values: {} });
  const afterPreRun = await runner.resume({ runId: started.id, workflow: spec, steps, approved: true });

  assert.equal(afterPreRun.status, "awaiting_confirmation");
  assert.equal(afterPreRun.results.at(-1).id, "delete-draft");
  assert.deepEqual(browser.calls, [], "the deleting step must not have run on the pre-run yes");

  const finished = await runner.resume({ runId: started.id, workflow: spec, steps, approved: true });
  assert.equal(finished.status, "completed");
  assert.equal(finished.results.length, 2);
});

test("a filled variable reaches the page, and the value typed is the user's, not the recording's", async () => {
  const { runner, browser, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  await runner.resume({ runId: started.id, workflow: spec, steps, approved: true });

  const typed = browser.calls.find((call) => call.body?.kind === "type" && call.body?.ref === "e3");
  assert.equal(typed.body.text, "Northwind Trading");
  assert.equal(typed.body.submit, false, "a workflow type step never submits the form as a side effect");
});

test("a step with no anchor and no selector fails instead of clicking something plausible", async () => {
  const spec = normalizeLearnedWorkflow({
    name: "Blind click",
    steps: [
      { id: "open", instruction: "Open the app", actionType: "navigate", url: "https://app.ledgerly.example/invoices" },
      { id: "blind", instruction: "Click the third icon", actionType: "click" },
    ],
    safety: { requiresConfirmationBeforeRun: false },
  });
  const { runner, steps } = setup({ spec });
  const run = await runner.start({ workflow: spec, steps, values: {} });
  assert.equal(run.status, "failed");
  assert.match(run.detail, /nothing stable to click/);
});

test("a success check is read from the live page; a missing one is reported, not assumed", async () => {
  const spec = normalizeLearnedWorkflow({
    name: "Checked click",
    steps: [
      { id: "open", instruction: "Open", actionType: "navigate", url: "https://app.ledgerly.example/invoices" },
      { id: "checked", instruction: "Start a new invoice", actionType: "click", target: { text: "New invoice" }, successCheck: "Client name" },
      { id: "wrong", instruction: "Start a new invoice", actionType: "click", target: { text: "New invoice" }, successCheck: "Payment received" },
    ],
    safety: { requiresConfirmationBeforeRun: false },
  });
  const { runner, steps } = setup({ spec });
  const run = await runner.start({ workflow: spec, steps, values: {} });
  assert.equal(run.status, "failed");
  assert.match(run.results[1].detail, /The page shows "Client name"/);
  assert.match(run.results[2].detail, /does not show "Payment received"/);
});

test("the fallback is actually tried when the direct attempt cannot find its anchor", async () => {
  const spec = normalizeLearnedWorkflow({
    name: "Redesigned page",
    steps: [
      { id: "open", instruction: "Open", actionType: "navigate", url: "https://app.ledgerly.example/invoices" },
      {
        id: "moved",
        instruction: "Start a new invoice",
        actionType: "click",
        target: { text: "Create invoice" },
        fallback: "Look for a plus control in the invoices toolbar.",
      },
    ],
    safety: { requiresConfirmationBeforeRun: false },
  });
  const { runner, gateway, steps } = setup({ spec, replies: ['{"status":"done","detail":"used the plus control"}'] });
  const run = await runner.start({ workflow: spec, steps, values: {} });

  assert.equal(run.status, "completed");
  const moved = run.results.at(-1);
  assert.equal(moved.usedFallback, true);
  assert.equal(moved.detail, "used the plus control");
  const sent = gateway.requests.find((request) => request.method === "chat.send");
  assert.match(sent.params.message, /The direct attempt failed .* Follow this fallback instead: Look for a plus control/s);
});

test("a delegated step that cannot say it finished is a failure", async () => {
  const spec = normalizeLearnedWorkflow({
    name: "Desktop step",
    steps: [{ id: "desktop", instruction: "Export the ledger from the desktop app", actionType: "custom", app: "Ledgerly Desktop" }],
    safety: { requiresConfirmationBeforeRun: false },
  });
  const { runner, steps } = setup({ spec, replies: ['{"status":"blocked","detail":"the export dialog never opened"}'] });
  const run = await runner.start({ workflow: spec, steps, values: {} });
  assert.equal(run.status, "failed");
  assert.match(run.detail, /the export dialog never opened/);
});

test("a delegated step prompt carries the blocked actions and refuses to run ahead", () => {
  const prompt = buildStepPrompt({ workflow: SPEC, step: SPEC.steps[2], index: 2, guidance: "" });
  assert.match(prompt, /This is step 3\. Do only this step and then stop\./);
  assert.match(prompt, /entering a password, passcode, one-time code, or 2FA response/);
  assert.match(prompt, /do not send, submit, publish, pay, or delete anything unless/);
  assert.match(prompt, /Prefer stable text and accessibility anchors over screen coordinates/);
});

test("two workflows cannot run at once over the same browser", async () => {
  const { runner, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  await assert.rejects(
    () => runner.start({ workflow: spec, steps, values: VALUES }),
    (error) => error.statusCode === 409 && error.activeRunId === started.id,
  );
});

test("cancelling mid-run stops it and records why", async () => {
  const { runner, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  const cancelled = runner.cancel(started.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.detail, "Cancelled by the user.");
  assert.equal(runner.activeRunId, null);
});

test("resuming a run that is not waiting is refused", async () => {
  const { runner, steps, spec } = setup();
  const started = await runner.start({ workflow: spec, steps, values: VALUES });
  runner.cancel(started.id);
  await assert.rejects(
    () => runner.resume({ runId: started.id, workflow: spec, steps, approved: true }),
    /this run is cancelled, not waiting for a decision/,
  );
});

test("a browser that will not open a tab fails the run with the browser's own reason", async () => {
  const store = freshStore();
  store.saveWorkflow(SPEC);
  const runner = new WorkflowRunner({
    browser: mockBrowser({ snapshot: PAGE, failOpen: true }),
    gateway: mockGateway({ reply: "{}" }),
    store,
    agentStepTimeoutMs: 5_000,
  });
  const steps = fillVariables(SPEC, VALUES).steps;
  const started = await runner.start({ workflow: SPEC, steps, values: VALUES });
  const run = await runner.resume({ runId: started.id, workflow: SPEC, steps, approved: true });
  assert.equal(run.status, "failed");
  assert.match(run.detail, /no browser/);
});
