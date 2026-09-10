import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { DesktopAccess } from "./desktop-access.js";
import { createDesktopApi, desktopEventFrame, DESKTOP_EVENTS, toNodeSummary } from "./desktop-api.js";

const SECRET = "pairing-secret-for-tests";

function fakeGateway(overrides = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ connected: true, scopes: ["operator.read", "operator.write"], error: null }),
    async request(method, params) {
      calls.push({ method, params });
      if (overrides[method]) return overrides[method](params);
      throw new Error(`unexpected gateway method ${method}`);
    },
  };
}

/** Boots the desktop router alone, so nothing here depends on the full BFF starting up. */
async function boot({ gateway = fakeGateway(), access, deps = {} } = {}) {
  const desktopAccess = access ?? new DesktopAccess({ pairingSecret: SECRET });
  const subscribers = new Set();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/desktop",
    createDesktopApi({
      gateway,
      access: desktopAccess,
      submitChatTurn: async (input) => ({ ack: { accepted: true }, echo: input }),
      chatHistory: async (key) => ({ sessionKey: key, messages: [] }),
      modelOptionsFromConfig: (_config, agentId) => ({
        agentId,
        current: "anthropic/claude-opus-4",
        models: [{ id: "anthropic/claude-opus-4", label: "Opus" }],
      }),
      subscribe: (res) => {
        subscribers.add(res);
        return () => subscribers.delete(res);
      },
      ...deps,
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/desktop`;
  return {
    base,
    gateway,
    access: desktopAccess,
    subscribers,
    async close() {
      for (const res of subscribers) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function pairToken(base, overrides = {}) {
  const response = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingSecret: SECRET,
      clientId: "macbook-test",
      clientName: "Test MacBook",
      platform: "macos",
      ...overrides,
    }),
  });
  return { status: response.status, body: await response.json() };
}

const authed = (token) => ({ Authorization: `Bearer ${token}` });

test("pairing issues a token and unpairing revokes it", async (t) => {
  const app = await boot();
  t.after(() => app.close());

  const paired = await pairToken(app.base);
  assert.equal(paired.status, 200);
  assert.equal(paired.body.ok, true);
  const { token } = paired.body;

  const health = await fetch(`${app.base}/health`, { headers: authed(token) });
  assert.equal(health.status, 200);

  const unpaired = await fetch(`${app.base}/unpair`, { method: "POST", headers: authed(token) });
  assert.equal(unpaired.status, 200);

  const after = await fetch(`${app.base}/health`, { headers: authed(token) });
  assert.equal(after.status, 401);
});

test("every data route rejects a missing or bad token", async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const routes = ["/health", "/agents", "/sessions", "/nodes", "/events", "/clients", "/audit"];
  for (const route of routes) {
    const anonymous = await fetch(`${app.base}${route}`);
    assert.equal(anonymous.status, 401, `${route} allowed an anonymous request`);
    const wrong = await fetch(`${app.base}${route}`, { headers: authed("not-a-real-token") });
    assert.equal(wrong.status, 401, `${route} accepted an invalid token`);
  }
  // No gateway call should have been attempted for an unauthorized request.
  assert.deepEqual(app.gateway.calls, []);
});

test("the whole surface answers 503 when no pairing secret is configured", async (t) => {
  const app = await boot({ access: new DesktopAccess({}) });
  t.after(() => app.close());
  assert.equal((await pairToken(app.base)).status, 503);
  const health = await fetch(`${app.base}/health`, { headers: authed("anything") });
  assert.equal(health.status, 503);
});

test("pairing throttles and advertises Retry-After", async (t) => {
  const app = await boot({ access: new DesktopAccess({ pairingSecret: SECRET, maxFailures: 2 }) });
  t.after(() => app.close());
  await pairToken(app.base, { pairingSecret: "wrong" });
  await pairToken(app.base, { pairingSecret: "wrong" });
  const response = await fetch(`${app.base}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingSecret: SECRET, clientId: "macbook-test" }),
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
});

test("health redacts gateway internals and reports a mapped reason", async (t) => {
  const gateway = fakeGateway();
  gateway.status = () => ({
    connected: false,
    server: { url: "ws://127.0.0.1:18789/" },
    scopes: ["operator.admin"],
    error: "connect ECONNREFUSED 127.0.0.1:18789",
  });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);
  const health = await (await fetch(`${app.base}/health`, { headers: authed(body.token) })).json();

  assert.equal(health.gateway.connected, false);
  assert.equal(health.gateway.reason, "gateway not reachable from the host");
  assert.equal(health.gateway.scopeCount, 1);
  const serialized = JSON.stringify(health);
  assert.equal(serialized.includes("18789"), false, "health leaked the gateway address");
  assert.equal(serialized.includes("operator.admin"), false, "health leaked scope names");
  assert.equal(serialized.includes(body.token), false, "health leaked the client token");
});

test("agents projects the gateway list with model options", async (t) => {
  const gateway = fakeGateway({
    "agents.list": () => ({
      agents: [{ id: "main", displayName: "Orion", description: "primary", secretField: "nope" }],
    }),
    "config.get": () => ({ config: {}, hash: "abc" }),
  });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);
  const result = await (await fetch(`${app.base}/agents`, { headers: authed(body.token) })).json();

  assert.deepEqual(result.agents, [
    {
      id: "main",
      name: "Orion",
      description: "primary",
      currentModel: "anthropic/claude-opus-4",
      models: [{ id: "anthropic/claude-opus-4", label: "Opus" }],
    },
  ]);
  assert.equal(JSON.stringify(result).includes("secretField"), false);
});

test("agents still answers when the config read fails", async (t) => {
  const gateway = fakeGateway({
    "agents.list": () => ({ agents: [{ id: "main" }] }),
    "config.get": () => {
      throw new Error("config unavailable");
    },
  });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);
  const result = await (await fetch(`${app.base}/agents`, { headers: authed(body.token) })).json();
  assert.deepEqual(result.agents, [
    { id: "main", name: "main", description: null, currentModel: null, models: [] },
  ]);
});

test("sessions list bounds the limit and requests derived titles", async (t) => {
  const gateway = fakeGateway({ "sessions.list": () => ({ sessions: [{ key: "agent:main:1" }] }) });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);

  await fetch(`${app.base}/sessions?limit=5000`, { headers: authed(body.token) });
  assert.deepEqual(gateway.calls.at(-1).params, {
    limit: 100,
    includeDerivedTitles: true,
    includeLastMessage: true,
  });

  await fetch(`${app.base}/sessions?limit=nonsense`, { headers: authed(body.token) });
  assert.equal(gateway.calls.at(-1).params.limit, 20);
});

test("session creation requires an agentId and never creates agents", async (t) => {
  const gateway = fakeGateway({ "sessions.create": (params) => ({ session: params }) });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);

  const missing = await fetch(`${app.base}/sessions`, {
    method: "POST",
    headers: { ...authed(body.token), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 400);
  assert.deepEqual(gateway.calls, []);

  const created = await fetch(`${app.base}/sessions`, {
    method: "POST",
    headers: { ...authed(body.token), "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: "main", label: "From MacBook" }),
  });
  assert.equal(created.status, 200);
  assert.deepEqual(gateway.calls.map(({ method }) => method), ["sessions.create"]);
});

test("chat delegates to the shared submission path", async (t) => {
  const submitted = [];
  const app = await boot({
    deps: {
      submitChatTurn: async (input) => {
        submitted.push(input);
        return { ack: { accepted: true }, memoryCandidates: [] };
      },
    },
  });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);

  const blank = await fetch(`${app.base}/chat`, {
    method: "POST",
    headers: { ...authed(body.token), "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey: "agent:main:1", message: "   " }),
  });
  assert.equal(blank.status, 400);
  assert.equal(submitted.length, 0);

  const sent = await fetch(`${app.base}/chat`, {
    method: "POST",
    headers: { ...authed(body.token), "Content-Type": "application/json" },
    body: JSON.stringify({ sessionKey: "agent:main:1", message: "status?", agentId: "main" }),
  });
  assert.equal(sent.status, 200);
  assert.deepEqual(submitted, [
    { sessionKey: "agent:main:1", message: "status?", agentId: "main", attachmentIds: [] },
  ]);
});

test("event stream opens with gateway status and unsubscribes on close", async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const { body } = await pairToken(app.base);

  const controller = new AbortController();
  const response = await fetch(`${app.base}/events`, {
    headers: authed(body.token),
    signal: controller.signal,
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const chunk = await response.body.getReader().read();
  const text = Buffer.from(chunk.value).toString("utf8");
  assert.match(text, /^event: gateway\.status\n/);
  assert.equal(app.subscribers.size, 1);

  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.subscribers.size, 0);
});

test("the event stream redacts gateway status on the opening frame", async (t) => {
  const gateway = fakeGateway();
  gateway.status = () => ({
    connected: false,
    server: { url: "ws://127.0.0.1:18789/" },
    scopes: ["operator.admin"],
    error: "connect ECONNREFUSED 127.0.0.1:18789",
  });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);

  const controller = new AbortController();
  const response = await fetch(`${app.base}/events`, {
    headers: authed(body.token),
    signal: controller.signal,
  });
  const chunk = await response.body.getReader().read();
  const text = Buffer.from(chunk.value).toString("utf8");
  assert.equal(text.includes("18789"), false, "the stream leaked the gateway address");
  assert.equal(text.includes("operator.admin"), false, "the stream leaked scope names");
  assert.match(text, /"reason":"gateway not reachable from the host"/);
  controller.abort();
});

test("desktopEventFrame drops out-of-scope events and redacts gateway status", () => {
  assert.equal(desktopEventFrame("memory.changed", { count: 3 }), null);
  assert.equal(desktopEventFrame("hunting.progress", {}), null);
  assert.equal(
    desktopEventFrame("chat", { sessionKey: "agent:main:1", state: "final" }),
    'event: chat\ndata: {"sessionKey":"agent:main:1","state":"final"}\n\n',
  );
  const frame = desktopEventFrame("gateway.status", {
    connected: true,
    server: { url: "ws://127.0.0.1:18789/" },
    scopes: ["operator.read", "operator.write"],
    error: null,
  });
  assert.equal(frame, 'event: gateway.status\ndata: {"connected":true,"scopeCount":2,"reason":null}\n\n');
});

test("the desktop event allowlist excludes out-of-scope features", () => {
  for (const event of ["chat", "agent", "sessions.changed", "gateway.status"]) {
    assert.ok(DESKTOP_EVENTS.has(event), `${event} should reach the desktop`);
  }
  for (const event of ["memory.changed", "hunting.progress", "extraction.run", "workflow.session"]) {
    assert.equal(DESKTOP_EVENTS.has(event), false, `${event} must not reach the desktop`);
  }
});

test("nodes are projected to the read-only summary shape", async (t) => {
  const gateway = fakeGateway({
    "node.list": () => ({
      nodes: [
        {
          nodeId: "node-1",
          displayName: "Mac mini",
          platform: "darwin",
          connected: true,
          commands: ["system.run", "screen.capture", "unknown.command"],
          lastSeen: "2026-09-10T12:00:00.000Z",
          pairingToken: "must-not-appear",
        },
        { nodeId: "node-2", platform: "win32", connected: false, commands: [] },
        { nodeId: "node-3", platform: "something", commands: ["browser.open"] },
      ],
    }),
  });
  const app = await boot({ gateway });
  t.after(() => app.close());
  const { body } = await pairToken(app.base);
  const result = await (await fetch(`${app.base}/nodes`, { headers: authed(body.token) })).json();

  assert.deepEqual(result.nodes, [
    {
      id: "node-1",
      name: "Mac mini",
      platform: "macos",
      status: "online",
      capabilities: ["exec", "screen"],
      lastSeenAt: "2026-09-10T12:00:00.000Z",
    },
    { id: "node-2", name: "node-2", platform: "windows", status: "offline", capabilities: [] },
    { id: "node-3", name: "node-3", platform: "unknown", status: "unknown", capabilities: ["browser"] },
  ]);
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
});

test("toNodeSummary tolerates a malformed node", () => {
  assert.deepEqual(toNodeSummary({}), {
    id: "",
    name: "unknown",
    platform: "unknown",
    status: "unknown",
    capabilities: [],
  });
});

test("no destructive session or node route is exposed in V1", async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const { body } = await pairToken(app.base);
  for (const route of ["/sessions/agent:main:1", "/nodes/node-1"]) {
    const response = await fetch(`${app.base}${route}`, {
      method: "DELETE",
      headers: authed(body.token),
    });
    assert.equal(response.status, 404, `${route} should not accept DELETE in V1`);
  }
  assert.deepEqual(app.gateway.calls, []);
});

test("a client can be revoked by id from the desktop surface", async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const first = await pairToken(app.base, { clientId: "macbook-test" });
  const second = await pairToken(app.base, { clientId: "spare-laptop" });

  const listed = await (await fetch(`${app.base}/clients`, { headers: authed(first.body.token) })).json();
  assert.equal(listed.clients.length, 2);

  const revoked = await fetch(`${app.base}/clients/spare-laptop`, {
    method: "DELETE",
    headers: authed(first.body.token),
  });
  assert.equal(revoked.status, 200);
  const after = await fetch(`${app.base}/health`, { headers: authed(second.body.token) });
  assert.equal(after.status, 401);
  const missing = await fetch(`${app.base}/clients/never-existed`, {
    method: "DELETE",
    headers: authed(first.body.token),
  });
  assert.equal(missing.status, 404);
});
