import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  abortSessionRun,
  isSessionInitConflict,
  runSessionTurn,
  SessionTurnTimeoutError,
} from "./session-turn.js";

test("a completed turn resolves with the assistant's final text", async () => {
  const gateway = fakeGateway({ reply: "final answer" });
  const text = await runSessionTurn({
    gateway,
    sessionKey: "agent:main:dashboard:probe",
    message: "hello",
    timeoutMs: 1_000,
    label: "Probe",
  });
  assert.equal(text, "final answer");
  assert.deepEqual(gateway.calls.map((call) => call.method), ["chat.send"]);
});

test("attachments are forwarded through the native chat.send contract", async () => {
  const gateway = fakeGateway({ reply: "seen" });
  const attachments = [{ type: "image", mimeType: "image/png", fileName: "screen.png", content: "aW1hZ2U=" }];
  await runSessionTurn({ gateway, sessionKey: "s", message: "inspect", attachments, timeoutMs: 1_000 });
  const send = gateway.calls.find((call) => call.method === "chat.send");
  assert.deepEqual(send.params.attachments, attachments);
});

test("a timed-out turn is aborted, not abandoned", async () => {
  // Abandoning the run is what left the gateway busy and made the next attempt queue behind
  // a run nobody was waiting for.
  const gateway = fakeGateway({ reply: null });
  await assert.rejects(
    () =>
      runSessionTurn({
        gateway,
        sessionKey: "agent:main:dashboard:probe",
        message: "hello",
        timeoutMs: 20,
        label: "Job discovery",
      }),
    (error) => {
      assert.ok(error instanceof SessionTurnTimeoutError);
      assert.equal(error.code, "session_turn_timeout");
      assert.equal(error.aborted, true);
      assert.equal(error.statusCode, 504);
      assert.match(error.message, /Job discovery did not finish within 0s and was aborted/);
      return true;
    },
  );
  assert.equal(gateway.calls.filter((call) => call.method === "chat.abort").length, 1);
  const abort = gateway.calls.find((call) => call.method === "chat.abort");
  assert.deepEqual(abort?.params, { sessionKey: "agent:main:dashboard:probe", agentId: "main" });
});

test("the timeout reports honestly when the abort call fails", async () => {
  const gateway = fakeGateway({ reply: null, failAbort: true });
  await assert.rejects(
    () => runSessionTurn({ gateway, sessionKey: "s", message: "m", timeoutMs: 20, label: "Run" }),
    /left running because the abort call failed/,
  );
});

test("a run that ended without answering is not described as aborted", async () => {
  // The gateway answers { ok: true, aborted: false, runIds: [] } when nothing is running.
  const gateway = fakeGateway({ reply: null, abortFindsNothing: true });
  await assert.rejects(
    () => runSessionTurn({ gateway, sessionKey: "s", message: "m", timeoutMs: 20, label: "Run" }),
    (error) => {
      assert.equal(error.aborted, false);
      assert.match(error.message, /had already finished without reporting a result/);
      return true;
    },
  );
});

test("an agent error surfaces as itself rather than a timeout", async () => {
  const gateway = fakeGateway({ error: "model provider refused" });
  await assert.rejects(
    () => runSessionTurn({ gateway, sessionKey: "s", message: "m", timeoutMs: 1_000, label: "Run" }),
    /model provider refused/,
  );
  assert.equal(gateway.calls.some((call) => call.method === "chat.abort"), false);
});

test("events for other sessions never settle this turn", async () => {
  const gateway = fakeGateway({ reply: null });
  const pending = runSessionTurn({
    gateway,
    sessionKey: "agent:main:dashboard:mine",
    message: "m",
    timeoutMs: 60,
    label: "Run",
  });
  gateway.emit("event", "chat", { sessionKey: "agent:main:dashboard:other", state: "final", message: "not mine" });
  await assert.rejects(() => pending, SessionTurnTimeoutError);
});

test("aborting a session distinguishes stopped, nothing-to-stop, and failure", async () => {
  assert.deepEqual(await abortSessionRun({ gateway: fakeGateway({}), sessionKey: "s" }), {
    ok: true,
    aborted: true,
  });
  assert.deepEqual(
    await abortSessionRun({ gateway: fakeGateway({ abortFindsNothing: true }), sessionKey: "s" }),
    { ok: true, aborted: false },
  );
  const failed = await abortSessionRun({ gateway: fakeGateway({ failAbort: true }), sessionKey: "s" });
  assert.equal(failed.ok, false);
});

function fakeGateway({ reply, error, failAbort = false, abortFindsNothing = false }) {
  const gateway = new EventEmitter();
  gateway.calls = [];
  gateway.request = async (method, params) => {
    gateway.calls.push({ method, params });
    if (method === "chat.abort" && failAbort) throw new Error("abort refused");
    if (method === "chat.abort") {
      return abortFindsNothing ? { ok: true, aborted: false, runIds: [] } : { ok: true, aborted: true };
    }
    if (method !== "chat.send") return {};
    queueMicrotask(() => {
      if (error) {
        gateway.emit("event", "chat", { sessionKey: params.sessionKey, state: "error", errorMessage: error });
        return;
      }
      if (reply === null) return; // Silence: the turn keeps running until the deadline.
      gateway.emit("event", "chat", { sessionKey: params.sessionKey, state: "final", message: reply });
    });
    return {};
  };
  return gateway;
}

test("a session initialization conflict is retried, not surfaced as a failed application", async () => {
  // Live failure: "reply session initialization conflicted for agent:main:dashboard:hunting-
  // application-247ecb27..." ended the run with nothing attached. The gateway commits session
  // state optimistically and gives up after one internal retry; losing that race says nothing
  // about the prompt.
  const sends = [];
  const cachedFailures = new Set();
  const gateway = new EventEmitter();
  gateway.request = async (method, params) => {
    if (method !== "chat.send") return {};
    sends.push(params.idempotencyKey);
    if (cachedFailures.has(params.idempotencyKey)) {
      throw new Error("reply session initialization conflicted for agent:main:dashboard:hunting-application-1");
    }
    if (cachedFailures.size < 3) {
      cachedFailures.add(params.idempotencyKey);
      throw new Error("reply session initialization conflicted for agent:main:dashboard:hunting-application-1");
    }
    queueMicrotask(() =>
      gateway.emit("event", "chat", { sessionKey: params.sessionKey, state: "final", message: "done" }),
    );
    return {};
  };
  const text = await runSessionTurn({
    gateway,
    sessionKey: "s1",
    message: "go",
    timeoutMs: 5_000,
    conflictBackoffMs: 0,
  });
  assert.equal(text, "done");
  assert.equal(sends.length, 4, "the send survives several consecutive store conflicts");
  assert.notEqual(sends[0], sends[1], "the retry does not replay OpenClaw's cached conflict");
});

test("an error that is not a session conflict is not retried", async () => {
  let sends = 0;
  const gateway = new EventEmitter();
  gateway.request = async () => {
    sends += 1;
    throw new Error("model refused the request");
  };
  await assert.rejects(() => runSessionTurn({ gateway, sessionKey: "s1", message: "go", timeoutMs: 5_000 }), /refused/);
  assert.equal(sends, 1);
});

test("conflict detection is narrow", () => {
  assert.equal(isSessionInitConflict(new Error("reply session initialization conflicted for x")), true);
  assert.equal(isSessionInitConflict(new Error("stale session snapshot")), true);
  assert.equal(isSessionInitConflict(new Error("gateway not connected")), false);
  assert.equal(isSessionInitConflict(new Error("model overloaded")), false);
});
