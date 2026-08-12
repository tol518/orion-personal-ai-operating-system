import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveRiskLevel,
  fillVariables,
  markStepConfirmations,
  normalizeLearnedWorkflow,
  referencedVariables,
  renderWorkflowNote,
  workflowManagedKey,
} from "./learned-workflow.js";
import { NEVER_DELEGABLE } from "../hunting/consent-policy.js";
import { DEMO_WORKFLOW } from "./test-support.js";

test("the shipped demo workflow survives normalization unchanged in substance", () => {
  const workflow = normalizeLearnedWorkflow(DEMO_WORKFLOW, { id: DEMO_WORKFLOW.id });
  assert.equal(workflow.name, "Submit monthly invoice");
  assert.equal(workflow.steps.length, 7);
  assert.deepEqual(
    workflow.variables.map((variable) => variable.name),
    ["clientName", "invoiceMonth", "invoicePdfName"],
  );
  assert.equal(workflow.variables.find((v) => v.name === "invoicePdfName").required, false);
  assert.equal(workflow.safety.riskLevel, "medium");
});

test("a draft cannot mark a sending step as safe", () => {
  // The whole point of the gate: the model said false, the step sends an invoice, so it asks.
  const [step] = markStepConfirmations([
    { id: "s", instruction: "Send the invoice to the client", actionType: "click", requiresUserConfirmation: false },
  ]);
  assert.equal(step.requiresUserConfirmation, true);

  const workflow = normalizeLearnedWorkflow({
    name: "Quiet sender",
    steps: [
      { instruction: "Open the drafts list", actionType: "navigate", url: "https://mail.example/drafts" },
      { instruction: "Delete the old draft", actionType: "click", requiresUserConfirmation: false },
      { instruction: "Send it", actionType: "click", requiresUserConfirmation: false },
    ],
    safety: { riskLevel: "low", requiresConfirmationBeforeRun: false, blockedActions: [] },
  });
  assert.deepEqual(
    workflow.steps.map((step_) => step_.requiresUserConfirmation),
    [false, true, true],
  );
  // Two forced checkpoints means this is not a low-risk workflow, whatever the draft claimed.
  assert.equal(workflow.safety.riskLevel, "high");
  assert.equal(workflow.safety.requiresConfirmationBeforeRun, true);
});

test("risk can only be raised by a draft, never lowered", () => {
  const safeSteps = [{ requiresUserConfirmation: false }];
  assert.equal(deriveRiskLevel(safeSteps, "high"), "high");
  assert.equal(deriveRiskLevel([{ requiresUserConfirmation: true }], "low"), "medium");
  assert.equal(deriveRiskLevel(safeSteps, "nonsense"), "low");
});

test("the undelegable actions are always blocked, whatever the draft listed", () => {
  const workflow = normalizeLearnedWorkflow({
    name: "Permissive draft",
    steps: [{ instruction: "Open the page", actionType: "navigate", url: "https://example.com" }],
    safety: { riskLevel: "low", blockedActions: ["nothing at all"] },
  });
  for (const blocked of NEVER_DELEGABLE) assert.ok(workflow.safety.blockedActions.includes(blocked));
  assert.ok(workflow.safety.blockedActions.includes("nothing at all"));
});

test("a variable used by a step but not declared is still supplied at run time", () => {
  const workflow = normalizeLearnedWorkflow({
    name: "Undeclared",
    steps: [{ instruction: "Type the reference {{invoiceRef}}", actionType: "type", input: "{{invoiceRef}}" }],
  });
  assert.deepEqual(referencedVariables(workflow), ["invoiceRef"]);
  const declared = workflow.variables.find((variable) => variable.name === "invoiceRef");
  assert.ok(declared, "a referenced variable must be declared so the UI can ask for it");
  assert.equal(declared.required, true);
});

test("a step cannot navigate anywhere but http(s)", () => {
  const workflow = normalizeLearnedWorkflow({
    name: "Odd protocols",
    steps: [
      { instruction: "Open a local file", actionType: "navigate", url: "file:///etc/passwd" },
      { instruction: "Run a script", actionType: "navigate", url: "javascript:alert(1)" },
      { instruction: "Open the app", actionType: "navigate", url: "https://app.example/x" },
    ],
  });
  assert.equal(workflow.steps[0].url, undefined);
  assert.equal(workflow.steps[1].url, undefined);
  assert.equal(workflow.steps[2].url, "https://app.example/x");
});

test("an unknown action type degrades to custom instead of failing the workflow", () => {
  const workflow = normalizeLearnedWorkflow({
    name: "Invented action",
    steps: [{ instruction: "Do the thing", actionType: "teleport" }],
  });
  assert.equal(workflow.steps[0].actionType, "custom");
});

test("a workflow with no usable step is refused", () => {
  assert.throws(() => normalizeLearnedWorkflow({ name: "Empty", steps: [] }), /at least one step/);
  assert.throws(() => normalizeLearnedWorkflow({ steps: [{ instruction: "x", actionType: "click" }] }), /needs a name/);
});

test("filling variables reports what is missing instead of running half-configured", () => {
  const workflow = normalizeLearnedWorkflow(DEMO_WORKFLOW, { id: DEMO_WORKFLOW.id });
  const missing = fillVariables(workflow, { clientName: "Northwind Trading" });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["invoiceMonth"]);

  const filled = fillVariables(workflow, { clientName: "Northwind Trading", invoiceMonth: "July 2026" });
  assert.equal(filled.ok, true);
  const fill = filled.steps.find((step) => step.id === "fill-client");
  assert.equal(fill.instruction, "Set the client to Northwind Trading.");
  assert.equal(fill.input, "Northwind Trading");
  assert.equal(fill.successCheck, "{{clientName}}", "successCheck is compared against the live page as authored");
  // An optional variable nobody supplied stays as its placeholder rather than becoming "undefined".
  const attach = filled.steps.find((step) => step.id === "attach-pdf");
  assert.equal(attach.input, "{{invoicePdfName}}");
});

test("the memory note is a readable recipe that names the executable spec and the gates", () => {
  const workflow = normalizeLearnedWorkflow(DEMO_WORKFLOW, { id: DEMO_WORKFLOW.id });
  const note = renderWorkflowNote(workflow, {
    runHistory: [{ startedAt: "2026-07-29T10:00:00Z", status: "completed", detail: "All 7 steps completed." }],
  });
  assert.match(note, /Executable spec id: `demo-submit-monthly-invoice`/);
  assert.match(note, /- `clientName` — The client the invoice/);
  assert.match(note, /- `invoicePdfName` \(optional\)/);
  assert.match(note, /7\. Send the invoice to \{\{clientName\}\}\..*\*\*\(asks the user first\)\*\*/);
  assert.match(note, /Safety: risk medium\./);
  assert.match(note, /Execution history:/);
  assert.match(note, /2026-07-29T10:00:00Z: completed/);
  assert.equal(workflowManagedKey("Submit monthly invoice"), "workflow-submit-monthly-invoice");
});
