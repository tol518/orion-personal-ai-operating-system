import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createChatRouter,
  createChatState,
  normalizeTool,
} from "./chat-workspace.js";
import {
  createDesktopApi,
  toSessionSummary,
  desktopEventFrame,
} from "./desktop-api.js";

function request(router, method, url, body, token) {
  const path = new URL(url, "http://orion.local");
  const req = {
    method,
    url: path.pathname,
    headers: {},
    query: Object.fromEntries(path.searchParams),
    body,
    get: (key) =>
      key === "authorization" && token ? "Bearer " + token : undefined,
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        resolve({ code: this.statusCode, ...data });
      },
    };
    router.handle(req, res, (error) =>
      error ? reject(error) : resolve({ code: 404 }),
    );
  });
}

function fixture(t, handlers = {}) {
  const calls = [],
    events = [],
    turns = [];
  const gateway = {
    async request(method, params) {
      calls.push([method, params]);
      return handlers[method] ? handlers[method](params) : {};
    },
  };
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const state = createChatState({
    gateway,
    database,
    broadcast: (...args) => events.push(args),
    ownsInternalSession: (key) => key?.startsWith("internal"),
  });
  const router = createChatRouter({
    gateway,
    state,
    projectSession: toSessionSummary,
    submitChatTurn: async (input) => {
      turns.push(input);
      return { ack: { runId: "r" } };
    },
    attachmentStore: {
      get: (id) => id === "file",
      saveMany: () => [],
      gatewayPayloads: () => [{ type: "file" }],
    },
    executionTargets: new Map(),
    getExecutionDevices: async () => ({}),
    patchSessionExecutionTarget: async () => {},
    modelOptionsFromConfig: () => ({ models: [{ id: "m" }] }),
  });
  const desktop = createDesktopApi({
    gateway,
    chatRouter: router,
    access: {
      configured: true,
      verify: (token) => (token === "paired" ? { clientId: "mac" } : null),
    },
  });
  return {
    web: (...args) => request(router, ...args),
    desktop: (...args) => request(desktop, ...args),
    state,
    calls,
    events,
    turns,
  };
}
const chat = { sessionKey: "s", message: "continue", mode: "steer" };
test("abort addresses a session and optional run", async (t) => {
  const f = fixture(t);
  await f.web("POST", "/chat/abort", { sessionKey: "s", runId: "r" });
  assert.deepEqual(f.calls, [["chat.abort", { sessionKey: "s", runId: "r" }]]);
});
test("steer uses the active run and falls back to the shared turn on refusal or idle", async (t) => {
  let refused = false;
  const f = fixture(t, {
    "sessions.steer": () => {
      if (refused) throw new Error("idle");
      return { ok: true };
    },
  });
  assert.equal((await f.web("POST", "/chat", chat)).delivered, "turn");
  f.state.event("chat", { sessionKey: "s", state: "delta", runId: "r" });
  assert.equal((await f.web("POST", "/chat", chat)).delivered, "steer");
  assert.deepEqual(f.calls.at(-1), [
    "sessions.steer",
    { key: "s", message: "continue" },
  ]);
  refused = true;
  assert.equal((await f.web("POST", "/chat", chat)).delivered, "turn");
  assert.equal(f.turns.length, 2);
  assert.equal(
    f.calls.filter(([m]) => m === "sessions.messages.subscribe").length,
    1,
  );
});
test("thinking forwards the selected level and carries gateway rejection to the caller", async (t) => {
  const f = fixture(t, {
    "sessions.patch": ({ thinkingLevel }) => {
      if (thinkingLevel === "max") throw new Error("Unsupported on this model");
      return {};
    },
  });
  assert.equal(
    (await f.web("PUT", "/sessions/s/thinking", { level: "low" })).code,
    200,
  );
  assert.deepEqual(f.calls.at(-1), [
    "sessions.patch",
    { key: "s", thinkingLevel: "low" },
  ]);
  assert.deepEqual(
    await f.web("PUT", "/sessions/s/thinking", { level: "max" }),
    { code: 400, ok: false, error: "Unsupported on this model" },
  );
});
test("rename validates and trims labels", async (t) => {
  const f = fixture(t);
  for (const label of ["   ", "a".repeat(121), 42])
    assert.equal((await f.web("PATCH", "/sessions/s", { label })).code, 400);
  await f.web("PATCH", "/sessions/s", { label: "  Work  " });
  assert.deepEqual(f.calls, [["sessions.patch", { key: "s", label: "Work" }]]);
});
test("archived sessions can be restored and children inherit a visible parent", async (t) => {
  const rows = [
    { key: "s", thinkingLevel: "low" },
    { key: "internal-child", spawnedBy: "s" },
    { key: "z" },
  ];
  const f = fixture(t, {
    "sessions.list": ({ offset = 0, limit }) => ({
      sessions: rows.slice(offset, offset + limit),
    }),
  });
  await f.web("PUT", "/sessions/z/archive", { archived: true });
  assert.deepEqual((await f.web("GET", "/sessions")).sessions, [
    rows[0],
    { ...rows[1], parentKey: "s" },
  ]);
  assert.equal(f.state.internal("internal-child"), false);
  assert.deepEqual(
    (await f.web("GET", "/sessions?archived=1&limit=1")).sessions,
    [rows[2]],
  );
  assert.equal(
    (
      await f.web("PUT", "/sessions/agent:main:main/archive", {
        archived: true,
      })
    ).code,
    400,
  );
  await f.web("PUT", "/sessions/z/archive", { archived: false });
  assert.equal((await f.web("GET", "/sessions")).sessions.length, 3);
});
test("compact waits for the matching terminal event", async (t) => {
  const f = fixture(t);
  for (const [state, runId] of [
    ["delta", "r"],
    ["final", "older"],
  ])
    f.state.event("chat", { state, runId, sessionKey: "s" });
  assert.equal((await f.web("POST", "/sessions/s/compact")).code, 409);
  f.state.event("chat", { state: "aborted", runId: "r", sessionKey: "s" });
  assert.equal((await f.web("POST", "/sessions/s/compact")).code, 200);
  assert.deepEqual(f.calls.at(-1), ["sessions.compact", { key: "s" }]);
});
test("approval replay, resolve and events preserve the session and command", async (t) => {
  const pending = {
    id: "a",
    request: { sessionKey: "s", command: "pwd" },
    createdAtMs: 100,
  };
  const f = fixture(t, {
    "exec.approval.list": () => ({
      requests: [pending, { ...pending, id: "expired", expiresAtMs: 110 }],
    }),
  });
  const { approvals } = await f.web("GET", "/approvals");
  assert.deepEqual(
    approvals.map((a) => a.id),
    ["a"],
  );
  await f.web("POST", "/approvals/a", { decision: "allow-once" });
  assert.deepEqual(f.calls.at(-1), [
    "exec.approval.resolve",
    { id: "a", decision: "allow-once" },
  ]);
  f.state.event("exec.approval.resolved", { id: "a", decision: "allow-once" });
  assert.equal(f.events.at(-1)[1].command, "pwd");
  assert.equal(f.events.at(-1)[1].status, "approved");
});
test("tool events retain command, paths and start time and bound UTF-8 output", async (t) => {
  const f = fixture(t);
  const base = { sessionKey: "s", runId: "r", ts: 100 };
  f.state.event("session.tool", {
    ...base,
    data: {
      toolCallId: "c",
      name: "exec",
      phase: "start",
      args: { command: "pwd", path: "notes" },
    },
  });
  f.state.event("session.tool", {
    ...base,
    ts: 120,
    data: {
      toolCallId: "c",
      phase: "result",
      isError: true,
      result: { content: [{ text: "猫".repeat(2000) }] },
    },
  });
  const [name, tool] = f.events.at(-1);
  assert.equal(name, "chat.tool");
  assert.deepEqual(
    [tool.startedAt, tool.endedAt, tool.status, tool.command, tool.paths],
    [100, 120, "error", "pwd", ["notes"]],
  );
  assert.ok(Buffer.byteLength(tool.output) <= 4096);
  assert.equal(normalizeTool({}), null);
});
test("message subscriptions reuse hot sessions and evict the least recently viewed", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) await f.state.subscribe(String(i));
  await f.state.subscribe("0");
  await f.state.subscribe("20");
  assert.deepEqual(f.calls.at(-1), [
    "sessions.messages.unsubscribe",
    { key: "1" },
  ]);
});
test("desktop workspace routes require a paired token and use the web handlers", async (t) => {
  for (const [method, path, body] of [
    ["POST", "/chat/abort", { sessionKey: "s" }],
    ["POST", "/chat", { ...chat, attachmentIds: ["file"] }],
    ["PUT", "/sessions/s/thinking", { level: "high" }],
    ["PATCH", "/sessions/s", { label: "Desk" }],
    ["PUT", "/sessions/s/archive", { archived: true }],
    ["GET", "/sessions?archived=1"],
    ["POST", "/sessions/s/compact"],
    ["GET", "/approvals"],
    ["POST", "/approvals/a", { decision: "deny" }],
    ["GET", "/agents/main/models"],
    ["PUT", "/sessions/s/model", { agentId: "main", model: "m" }],
    ["GET", "/sessions/s/execution-target"],
    ["PUT", "/sessions/s/execution-target", { target: "mac" }],
    ["DELETE", "/sessions/s"],
    ["POST", "/sessions/s/reset"],
    [
      "POST",
      "/attachments",
      {
        attachments: [
          { fileName: "test.txt", mimeType: "text/plain", content: "eA==" },
        ],
      },
    ],
  ]) {
    const f = fixture(t, {
      "sessions.list": () => ({ sessions: [] }),
      "exec.approval.list": () => [],
    });
    if (path === "/chat")
      f.state.event("chat", {
        state: "delta",
        sessionKey: "s",
        runId: "active",
      });
    assert.equal((await f.desktop(method, path, body)).code, 401, path);
    const result = await f.desktop(method, path, body, "paired");
    assert.equal(result.code, 200, path + " " + result.error);
    assert.deepEqual(result, await f.web(method, path, body), path);
  }
  assert.ok(desktopEventFrame("chat.tool", {}));
  assert.ok(desktopEventFrame("chat.approval", {}));
});

test("history subscribes before fetching 200 messages and preserves gateway timestamps", async (t) => {
  const f = fixture(t, {
    "chat.history": () => ({
      messages: [{ role: "assistant", content: "ok", ts: 123 }],
    }),
  });
  const history = await f.state.history("s", 5000);
  assert.deepEqual(f.calls, [
    ["sessions.messages.subscribe", { key: "s" }],
    ["chat.history", { sessionKey: "s", limit: 200, maxChars: 5000 }],
  ]);
  assert.equal(history.messages[0].timestamp, 123);
});
test("attachment-only chat validates each ID and the eight-file limit", async (t) => {
  const f = fixture(t);
  for (const attachmentIds of [
    ["missing"],
    Array(9).fill("file"),
    "file",
    null,
  ]) {
    assert.equal(
      (await f.web("POST", "/chat", { sessionKey: "s", attachmentIds })).code,
      400,
    );
  }
  assert.equal(
    (await f.web("POST", "/chat", { sessionKey: "s", attachmentIds: ["file"] }))
      .delivered,
    "turn",
  );
});
test("tool calls reported on the agent stream become chat.tool activity", async (t) => {
  const f = fixture(t);
  // Shape captured from a live OpenClaw 2026.6 gateway: tools arrive as `agent` events.
  const base = { runId: "r", sessionKey: "s", stream: "tool", seq: 2, isHeartbeat: false };
  f.state.event("agent", {
    ...base,
    ts: 100,
    data: { phase: "start", name: "exec", toolCallId: "toolu_1", args: { command: "echo ok" } },
  });
  assert.deepEqual(
    [f.events.at(-1)[0], f.events.at(-1)[1].status, f.events.at(-1)[1].command],
    ["chat.tool", "running", "echo ok"],
  );
  assert.equal(f.state.isRunning("s"), true);
  f.state.event("agent", {
    ...base,
    ts: 140,
    data: { phase: "result", name: "exec", toolCallId: "toolu_1", isError: false, result: "ok" },
  });
  const tool = f.events.at(-1)[1];
  assert.deepEqual([tool.status, tool.startedAt, tool.endedAt, tool.output], ["done", 100, 140, "ok"]);
  const before = f.events.length;
  f.state.event("agent", { ...base, stream: "lifecycle", data: { phase: "start" } });
  assert.equal(f.events.length, before);
});
