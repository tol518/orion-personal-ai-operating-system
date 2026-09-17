import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Structural tests for the browser API's authentication boundary.
//
// These exist because a deployment was found serving every /api route without authentication:
// the gate had never made it into that copy of index.js. Nothing failed, no test went red, and
// the web UI still showed its lock screen — drawn by the client, and not a security boundary.
//
// The boundary now lives in browser-auth.js, and browserAuth.assertGateOrder() inspects the live
// Express router at startup and refuses to serve if the gate is missing or misordered. That is
// the runtime layer, covered in browser-auth.test.js against real misassembled apps. This file is
// the source layer: it checks that index.js actually mounts the module, in the right order, and
// actually calls the startup check — because a runtime check nobody wires in protects nothing.

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "index.js"), "utf8");
const lines = source.split("\n");
const authSource = fs.readFileSync(path.join(here, "browser-auth.js"), "utf8");

/** Line number (1-based) of the first line matching `pattern`, or null. */
function lineOf(pattern) {
  const index = lines.findIndex((line) => pattern.test(line));
  return index === -1 ? null : index + 1;
}

/** Every browser API route registered directly in index.js, as { line, method, route }. */
function apiRoutes() {
  const found = [];
  lines.forEach((line, index) => {
    const match = /^app\.(get|post|put|patch|delete)\("(\/api\/[^"]*)"/.exec(line);
    if (match) found.push({ line: index + 1, method: match[1], route: match[2] });
  });
  return found;
}

const GATE = /^app\.use\("\/api", browserAuth\.gate\);/;
const MOUNT_ROUTES = /^browserAuth\.mountRoutes\(app\);/;
const STARTUP_CHECK = /^browserAuth\.assertGateOrder\(app/;
const LISTEN = /app\.listen\(PORT, HOST/;
const DESKTOP_MOUNT = /^\s*"\/api\/v1\/desktop",/;
// Public by design: the health check, and the sign-in routes the module mounts.
const PUBLIC_ROUTES = new Set(["/api/health"]);

test("the browser API is gated at all", () => {
  assert.ok(lineOf(GATE), 'app.use("/api", browserAuth.gate) is missing — every browser API route is unauthenticated');
  // The gate must actually verify something, not merely exist.
  assert.match(authSource, /function gate\(req, res, next\) \{[\s\S]*?access\.verify\(tokenFrom\(req\)\)[\s\S]*?401/, "the gate does not verify a session and reject with 401");
});

test("every browser API route sits behind the gate", () => {
  const gate = lineOf(GATE);
  const unprotected = apiRoutes().filter((entry) => entry.line < gate && !PUBLIC_ROUTES.has(entry.route));
  assert.deepEqual(
    unprotected.map((entry) => `${entry.method.toUpperCase()} ${entry.route}`),
    [],
    "these routes are registered before the gate and answer without authentication",
  );
});

test("the sign-in routes are mounted in front of the gate", () => {
  // A gate placed above the sign-in routes would make signing in impossible.
  const mount = lineOf(MOUNT_ROUTES);
  assert.ok(mount, "browserAuth.mountRoutes(app) is missing — nobody can sign in");
  assert.ok(mount < lineOf(GATE), "the sign-in routes must be mounted before the gate");
  for (const route of ["/api/auth/status", "/api/auth/login", "/api/auth/logout"]) {
    assert.ok(authSource.includes(`"${route}"`), `${route} is not defined by the module`);
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
  // cookie and same-origin checks to a native client, which has no browser origin.
  const mount = lineOf(DESKTOP_MOUNT);
  assert.ok(mount, "the desktop router mount is missing");
  assert.ok(mount < lineOf(GATE), "the desktop router must be mounted before the browser gate");
});

test("the desktop surface runs its own authorization", () => {
  const desktop = fs.readFileSync(path.join(here, "desktop-api.js"), "utf8");
  assert.match(desktop, /access\.verify\(desktopBearerToken\(req\)\)/, "the desktop router does not verify a token");
  assert.match(desktop, /Desktop authentication required/, "the desktop router does not reject unauthenticated requests");
});

test("the Second Brain keeps its own lock behind the gate", () => {
  // Memory is gated twice on purpose: general app access is not the same as vault access.
  assert.ok(lineOf(/^app\.use\("\/api\/memories", requireMemoryAccess\)/), "/api/memories has lost its Second Brain lock");
  assert.ok(lineOf(/^app\.use\("\/api\/memory", \(req, res, next\) => \{/), "/api/memory has lost its Second Brain lock");
  assert.match(source, /function requireMemoryAccess/, "requireMemoryAccess is missing");
});

test("Hunting keeps its own lock", () => {
  assert.ok(lineOf(/^app\.use\("\/api\/hunting", \(req, res, next\) => \{/), "/api/hunting has lost its lock");
});

test("the server refuses to start if the boundary is misassembled", () => {
  // The runtime check is only worth anything if index.js actually calls it before listening.
  const check = lineOf(STARTUP_CHECK);
  const listen = lineOf(LISTEN);
  assert.ok(check, "browserAuth.assertGateOrder(app) is never called — a misplaced gate would go unnoticed at boot");
  assert.ok(listen, "app.listen is missing");
  assert.ok(check < listen, "assertGateOrder must run before app.listen, or the server serves before it checks");
});

test("the boundary is one module, not scattered pieces", () => {
  // It fell out of a deployment precisely because it was six separate edits across 3,700 lines.
  for (const [fragment, why] of [
    [/^function appAccessToken/m, "the cookie parser has crept back into index.js"],
    [/^const APP_SESSION_COOKIE/m, "the cookie constant has crept back into index.js"],
    [/^const ALLOWED_ORIGINS/m, "the origin set has crept back into index.js"],
    [/^app\.post\("\/api\/auth\/login"/m, "an inline sign-in route has crept back into index.js"],
  ]) {
    assert.doesNotMatch(source, fragment, why);
  }
  assert.match(authSource, /export function createBrowserAuth/, "browser-auth.js must export the boundary");
  assert.match(authSource, /export function assertGateOrder/, "browser-auth.js must export the startup check");
});

test("binding to every interface is called out at startup", () => {
  assert.match(source, /warnIfBoundToEveryInterface/, "the bind warning is missing");
});
