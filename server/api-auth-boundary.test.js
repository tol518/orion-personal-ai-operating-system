import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Structural tests for the browser API's authentication boundary.
//
// These exist because a deployment was found serving every /api route without authentication:
// the global gate had simply never made it into that copy of index.js. Nothing failed, no test
// went red, and the web UI still showed its lock screen — which is drawn by the client and is
// not a security boundary at all. A curl to /api/memories returned data.
//
// Unit tests cannot catch that, because the gap is in how index.js is *assembled*: Express
// applies middleware in registration order, so the gate's presence and its position are both
// load-bearing. These assertions read the source and check that ordering directly.
//
// Run these on any deployment before trusting it. A green suite here means the boundary is
// where it must be, and a red one names exactly what moved.

const source = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js"),
  "utf8",
);
const lines = source.split("\n");

/** Line number (1-based) of the first line matching `pattern`, or null. */
function lineOf(pattern) {
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? null : index + 1;
}

/** Every browser API route registration, as { line, method, route }. */
function apiRoutes() {
  const found = [];
  lines.forEach((line, index) => {
    const match = /^app\.(get|post|put|patch|delete)\("(\/api\/[^"]*)"/.exec(line);
    if (match) found.push({ line: index + 1, method: match[1], route: match[2] });
  });
  return found;
}

const GATE = /^app\.use\("\/api", \(req, res, next\) => \{/;
const DESKTOP_MOUNT = /^\s*"\/api\/v1\/desktop",/;
// Public by design: they are how a client authenticates in the first place.
const PUBLIC_ROUTES = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/logout"]);

test("the browser API is gated at all", () => {
  const gate = lineOf(GATE);
  assert.ok(gate, "app.use(\"/api\", ...) is missing — every browser API route is unauthenticated");
  // The gate must actually verify something, not just exist.
  const body = lines.slice(gate, gate + 3).join("\n");
  assert.match(body, /appAccess\.verify\(appAccessToken\(req\)\)/, "the gate does not verify a session");
  assert.match(body, /401/, "the gate does not reject with 401");
});

test("every browser API route sits behind the gate", () => {
  const gate = lineOf(GATE);
  const unprotected = apiRoutes().filter(
    (entry) => entry.line < gate && !PUBLIC_ROUTES.has(entry.route),
  );
  assert.deepEqual(
    unprotected.map((entry) => `${entry.method.toUpperCase()} ${entry.route}`),
    [],
    "these routes are registered before the gate and answer without authentication",
  );
});

test("the routes needed to authenticate stay in front of the gate", () => {
  // A gate placed above /api/auth/login would make signing in impossible.
  const gate = lineOf(GATE);
  for (const route of ["/api/auth/status", "/api/auth/login", "/api/auth/logout"]) {
    const line = lineOf(new RegExp(`^app\\.(get|post)\\("${route.replace(/\//g, "\\/")}"`));
    assert.ok(line, `${route} is missing`);
    assert.ok(line < gate, `${route} must be registered before the gate or nobody can sign in`);
  }
});

test("/api/health stays public and returns no data", () => {
  const health = lineOf(/^app\.get\("\/api\/health"/);
  assert.ok(health, "/api/health is missing");
  assert.ok(health < lineOf(GATE), "/api/health is deliberately public");
  assert.match(lines[health - 1], /res\.json\(\{ ok: true \}\)/, "health must not disclose anything");
});

test("the desktop router is mounted before the browser gate", () => {
  // Express matches "/api" as a prefix. Mounting the desktop router after the gate would apply
  // cookie and same-origin checks to a native client, which has no browser origin — the app
  // would fail to authenticate entirely.
  const mount = lineOf(DESKTOP_MOUNT);
  assert.ok(mount, "the desktop router mount is missing");
  assert.ok(mount < lineOf(GATE), "the desktop router must be mounted before the browser gate");
});

test("the desktop surface runs its own authorization", () => {
  // It sits in front of the browser gate, so it cannot rely on it.
  const desktop = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop-api.js"),
    "utf8",
  );
  assert.match(desktop, /access\.verify\(desktopBearerToken\(req\)\)/, "the desktop router does not verify a token");
  assert.match(desktop, /Desktop authentication required/, "the desktop router does not reject unauthenticated requests");
});

test("the Second Brain keeps its own lock behind the gate", () => {
  // Memory is gated twice on purpose: general app access is not the same as vault access.
  const memories = lineOf(/^app\.use\("\/api\/memories", requireMemoryAccess\)/);
  const memory = lineOf(/^app\.use\("\/api\/memory", \(req, res, next\) => \{/);
  assert.ok(memories, "/api/memories has lost its Second Brain lock");
  assert.ok(memory, "/api/memory has lost its Second Brain lock");
  assert.match(source, /function requireMemoryAccess/, "requireMemoryAccess is missing");
});

test("Hunting keeps its own lock", () => {
  assert.ok(lineOf(/^app\.use\("\/api\/hunting", \(req, res, next\) => \{/), "/api/hunting has lost its lock");
});

test("binding to every interface is called out at startup", () => {
  // A deployment was found on 0.0.0.0 with no gate, reachable from the office LAN. The gate is
  // the fix; this warning is the smoke alarm.
  assert.match(source, /warnIfBoundToEveryInterface/, "the bind warning is missing");
});
