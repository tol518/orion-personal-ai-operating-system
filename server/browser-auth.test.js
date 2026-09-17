import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  APP_SESSION_COOKIE,
  assertGateOrder,
  buildAllowedOrigins,
  createBrowserAuth,
  inspectGateOrder,
  PUBLIC_API_PATHS,
} from "./browser-auth.js";

const PASSWORD = "dashboard-password-for-tests";
const PORT = 4820;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** A correctly assembled app: public routes, desktop mount, gate, then protected routes. */
function assembledApp(auth, { withGate = true, withRoutes = true } = {}) {
  const app = express();
  app.use(express.json());
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  if (withRoutes) auth.mountRoutes(app);
  const desktop = express.Router();
  desktop.get("/health", (_req, res) => res.json({ ok: true, desktop: true }));
  app.use("/api/v1/desktop", desktop);
  if (withGate) app.use("/api", auth.gate);
  app.get("/api/secret", (_req, res) => res.json({ ok: true, secret: "data" }));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.()[0] ?? response.headers.get("set-cookie") ?? "";
  return raw.split(";")[0];
}

// ---- allowed origins ------------------------------------------------------------

test("loopback dev origins are always allowed and configured ones are added", () => {
  const origins = buildAllowedOrigins(" https://mini.example.ts.net , http://other.example ", 4820);
  for (const expected of [
    "http://127.0.0.1:4820",
    "http://localhost:4820",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "https://mini.example.ts.net",
    "http://other.example",
  ]) {
    assert.ok(origins.has(expected), `${expected} should be allowed`);
  }
  assert.equal(origins.size, 6);
});

test("an empty configuration still allows loopback", () => {
  assert.equal(buildAllowedOrigins(undefined, 4820).size, 4);
  assert.equal(buildAllowedOrigins("", 4820).size, 4);
});

// ---- the boundary over HTTP -------------------------------------------------------

test("a protected route is 401 without a session and 200 with one", async (t) => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);

  assert.equal((await fetch(`${base}/api/secret`)).status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);
  assert.match(cookie, new RegExp(`^${APP_SESSION_COOKIE}=`));

  const secret = await fetch(`${base}/api/secret`, { headers: { Cookie: cookie } });
  assert.equal(secret.status, 200);
  assert.equal((await secret.json()).secret, "data");
});

test("the session cookie is httpOnly and strictly same-site", async (t) => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const raw = login.headers.getSetCookie?.()[0] ?? login.headers.get("set-cookie");
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
});

test("sign-in is refused from an origin that is not the dashboard", async (t) => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);

  const noOrigin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(noOrigin.status, 403, "a request with no Origin header is not the dashboard");

  const wrongOrigin = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(wrongOrigin.status, 403);
});

test("a configured HTTPS origin such as Tailscale Serve is accepted", async (t) => {
  const auth = createBrowserAuth({
    password: PASSWORD,
    port: PORT,
    allowedOrigins: "https://mini.example.ts.net",
  });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://mini.example.ts.net" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
});

test("a wrong password is rejected and issues no cookie", async (t) => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: "nope" }),
  });
  assert.equal(login.status, 401);
  assert.equal(cookieFrom(login), "");
});

test("status reports the session and logout ends it", async (t) => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);

  assert.equal((await (await fetch(`${base}/api/auth/status`)).json()).authenticated, false);

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = cookieFrom(login);
  assert.equal(
    (await (await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } })).json()).authenticated,
    true,
  );

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: ORIGIN },
  });
  assert.equal(logout.status, 200);
  // The token is revoked server-side, so replaying the old cookie no longer works.
  assert.equal((await fetch(`${base}/api/secret`, { headers: { Cookie: cookie } })).status, 401);
});

test("without a password the boundary fails closed: nobody can sign in, nothing is served", async (t) => {
  const auth = createBrowserAuth({ password: undefined, port: PORT });
  assert.equal(auth.configured, false);
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: "" }),
  });
  assert.equal(login.status, 503, "sign-in explains that access is not configured");
  assert.equal((await fetch(`${base}/api/secret`)).status, 401, "and every gated route stays shut");
});

test("public routes answer without a session", async (t) => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const { base, close } = await listen(assembledApp(auth));
  t.after(close);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/status`)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/desktop/health`)).status, 200, "the desktop router is in front of the gate");
});

// ---- token parsing ------------------------------------------------------------------

test("tokenFrom reads only this app's cookie and decodes it", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const req = (cookie) => ({ get: (name) => (name === "cookie" ? cookie : undefined) });
  assert.equal(auth.tokenFrom(req(`${APP_SESSION_COOKIE}=abc123`)), "abc123");
  assert.equal(auth.tokenFrom(req(`other=1; ${APP_SESSION_COOKIE}=a%20b; more=2`)), "a b");
  assert.equal(auth.tokenFrom(req("other=1")), "");
  assert.equal(auth.tokenFrom(req(undefined)), "");
  assert.equal(auth.tokenFrom(req(`${APP_SESSION_COOKIE}=%E0%A4%A`)), "", "a malformed encoding is treated as no token");
});

// ---- the startup order check ----------------------------------------------------------

test("a correctly assembled app has no problems", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  assert.deepEqual(auth.inspectGateOrder(assembledApp(auth)), []);
  assert.doesNotThrow(() => auth.assertGateOrder(assembledApp(auth)));
});

test("a missing gate is reported as every route being unauthenticated", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const problems = auth.inspectGateOrder(assembledApp(auth, { withGate: false }));
  assert.ok(problems.some((p) => /is not mounted/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /GET \/api\/secret is registered before the gate/.test(p)), problems.join("\n"));
});

test("a route registered before the gate is named", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const app = express();
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  auth.mountRoutes(app);
  app.get("/api/leaky", (_req, res) => res.json({}));
  app.post("/api/leaky", (_req, res) => res.json({}));
  app.use("/api", auth.gate);
  const problems = auth.inspectGateOrder(app);
  assert.deepEqual(problems, [
    "GET /api/leaky is registered before the gate and answers without authentication",
    "POST /api/leaky is registered before the gate and answers without authentication",
  ]);
});

test("the desktop router mounted after the gate is reported", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const app = express();
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  auth.mountRoutes(app);
  app.use("/api", auth.gate);
  app.use("/api/v1/desktop", express.Router());
  const problems = auth.inspectGateOrder(app);
  assert.ok(problems.some((p) => /\/api\/v1\/desktop router is mounted after the gate/.test(p)), problems.join("\n"));
});

test("missing sign-in routes are reported so a deployment cannot forget mountRoutes", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const problems = auth.inspectGateOrder(assembledApp(auth, { withRoutes: false }));
  for (const path of ["/api/auth/status", "/api/auth/login", "/api/auth/logout"]) {
    assert.ok(problems.some((p) => p.startsWith(`${path} is not registered`)), `${path}: ${problems.join("\n")}`);
  }
});

test("a public route registered after the gate is reported, because nobody could sign in", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const app = express();
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", auth.gate);
  auth.mountRoutes(app);
  const problems = auth.inspectGateOrder(app);
  assert.ok(problems.some((p) => /\/api\/auth\/login is registered after the gate/.test(p)), problems.join("\n"));
});

test("non-api routes and the catch-all are ignored", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const app = assembledApp(auth);
  app.get("/", (_req, res) => res.send("home"));
  app.get("*", (_req, res) => res.send("spa"));
  assert.deepEqual(auth.inspectGateOrder(app), []);
});

test("assertGateOrder refuses to start with the problems in the message", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  assert.throws(
    () => auth.assertGateOrder(assembledApp(auth, { withGate: false })),
    (error) => /Refusing to start/.test(error.message) && /is not mounted/.test(error.message),
  );
});

test("allowUngated downgrades the refusal to a loud warning", () => {
  const auth = createBrowserAuth({ password: PASSWORD, port: PORT });
  const warnings = [];
  assert.doesNotThrow(() =>
    auth.assertGateOrder(assembledApp(auth, { withGate: false }), {
      allowUngated: true,
      warn: (message) => warnings.push(message),
    }),
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NOT in place/);
  assert.match(warnings[0], /Every browser API route is open/);
});

test("an app that cannot be inspected fails closed", () => {
  const gate = () => {};
  assert.throws(() => assertGateOrder({}, { gate }), /could not be inspected/);
  assert.deepEqual(
    inspectGateOrder({ _router: { stack: "nope" } }, { gate }),
    ["the Express router stack could not be inspected (no routes mounted, or an unsupported Express version)"],
  );
});

test("the public path list is exactly what a client needs to obtain a session", () => {
  assert.deepEqual([...PUBLIC_API_PATHS], ["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"]);
  assert.ok(Object.isFrozen(PUBLIC_API_PATHS));
});
