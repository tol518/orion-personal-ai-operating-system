import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowStore } from "./workflow-store.js";
import { normalizeLearnedWorkflow } from "./learned-workflow.js";
import { DEMO_WORKFLOW } from "./test-support.js";

function freshStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-workflows-"));
  return new WorkflowStore(path.join(directory, "jarvis.sqlite"));
}

const SPEC = normalizeLearnedWorkflow(DEMO_WORKFLOW, { id: DEMO_WORKFLOW.id });

test("a learning session is a bookmark that carries its own privacy choice", () => {
  const store = freshStore();
  const session = store.startSession({ title: "Monthly invoice", includeAudio: true });
  assert.equal(session.status, "recording");
  assert.equal(session.includeAudio, true);
  assert.equal(session.endedAt, null);
  assert.deepEqual(store.activeSession().id, session.id);

  const stopped = store.updateSession(session.id, {
    status: "captured",
    endedAt: "2026-07-29T09:05:00Z",
    digest: { segments: [{ index: 1 }] },
  });
  assert.equal(stopped.status, "captured");
  assert.equal(stopped.digest.segments.length, 1);
  assert.equal(store.activeSession(), null, "a stopped session no longer holds the recording slot");
});

test("a failed extract keeps the capture, so the user can retry instead of re-recording", () => {
  const store = freshStore();
  const session = store.startSession({ title: "Invoice" });
  store.updateSession(session.id, { status: "captured", digest: { segments: [{ index: 1 }] } });
  const failed = store.updateSession(session.id, { error: "model returned invalid JSON" });
  assert.equal(failed.error, "model returned invalid JSON");
  assert.equal(failed.digest.segments.length, 1);
  assert.equal(failed.status, "captured");
});

test("re-learning the same task updates one workflow instead of leaving two", () => {
  const store = freshStore();
  const first = store.saveWorkflow(SPEC);
  const relearned = store.saveWorkflow({ ...SPEC, id: "a-different-id", description: "Improved second pass." });
  assert.equal(store.listWorkflows().length, 1);
  assert.equal(relearned.id, first.id, "the name is the identity, so the id is preserved");
  assert.equal(relearned.spec.description, "Improved second pass.");
});

test("a memory id links the executable spec to its readable note", () => {
  const store = freshStore();
  const saved = store.saveWorkflow(SPEC, { sessionId: "session-1" });
  assert.equal(saved.memoryId, null);
  const linked = store.setWorkflowMemory(saved.id, "memory-42");
  assert.equal(linked.memoryId, "memory-42");
  assert.equal(linked.sessionId, "session-1");
  // A later save must not orphan the note.
  const resaved = store.saveWorkflow(SPEC, { sessionId: "session-1" });
  assert.equal(resaved.memoryId, "memory-42");
});

test("a run records its variables and every step result as history", () => {
  const store = freshStore();
  const workflow = store.saveWorkflow(SPEC);
  const run = store.startRun({ workflowId: workflow.id, variables: { clientName: "Northwind Trading" } });
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, null);

  const waiting = store.updateRun(run.id, {
    status: "awaiting_confirmation",
    results: [{ index: 0, id: "open-ledgerly", status: "ok", detail: "Opened" }],
    detail: "Step send-invoice needs your approval",
  });
  assert.equal(waiting.finishedAt, null, "a waiting run is not finished");

  const done = store.updateRun(run.id, { status: "completed", results: waiting.results, detail: "All 7 steps completed." });
  assert.ok(done.finishedAt, "a terminal run is stamped");
  assert.deepEqual(store.listRuns(workflow.id).map((entry) => entry.status), ["completed"]);
  assert.deepEqual(store.getRun(run.id).variables, { clientName: "Northwind Trading" });
});

test("invalid states are refused rather than stored", () => {
  const store = freshStore();
  const workflow = store.saveWorkflow(SPEC);
  const run = store.startRun({ workflowId: workflow.id, variables: {} });
  assert.throws(() => store.updateRun(run.id, { status: "sort-of-done" }), /invalid run status/);
  assert.throws(() => store.updateSession(store.startSession({ title: "x" }).id, { status: "vibing" }), /invalid session status/);
  assert.throws(() => store.deleteWorkflow("nope"), /workflow not found/);
});

test("deleting a workflow takes its run history with it", () => {
  const store = freshStore();
  const workflow = store.saveWorkflow(SPEC);
  store.startRun({ workflowId: workflow.id, variables: {} });
  store.deleteWorkflow(workflow.id);
  assert.equal(store.getWorkflow(workflow.id), null);
  assert.deepEqual(store.listRuns(workflow.id), []);
});
