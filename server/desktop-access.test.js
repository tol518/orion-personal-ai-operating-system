import assert from "node:assert/strict";
import test from "node:test";
import { DesktopAccess, desktopBearerToken } from "./desktop-access.js";

const SECRET = "pairing-secret-for-tests";

function makeAccess(overrides = {}) {
  return new DesktopAccess({ pairingSecret: SECRET, ...overrides });
}

function pair(access, overrides = {}) {
  return access.pair({
    pairingSecret: SECRET,
    clientId: "macbook-test",
    clientName: "Test MacBook",
    platform: "macos",
    ...overrides,
  });
}

test("stays unconfigured without a pairing secret", () => {
  const access = new DesktopAccess({});
  assert.equal(access.configured, false);
  assert.throws(() => pair(access), { statusCode: 503 });
});

test("issues a bearer token bound to the client identity", () => {
  const access = makeAccess();
  const { token, client } = pair(access);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(client.clientId, "macbook-test");
  assert.equal(client.platform, "macos");
  assert.equal(access.verify(token).clientId, "macbook-test");
});

test("rejects an incorrect pairing secret without issuing a token", () => {
  const access = makeAccess();
  assert.throws(() => pair(access, { pairingSecret: "wrong" }), { statusCode: 401 });
  assert.equal(access.clients().length, 0);
});

test("rejects an unsafe client id", () => {
  const access = makeAccess();
  assert.throws(() => pair(access, { clientId: "../etc/passwd" }), { statusCode: 400 });
  assert.throws(() => pair(access, { clientId: "" }), { statusCode: 400 });
});

test("normalizes an unknown platform rather than trusting the client", () => {
  const access = makeAccess();
  assert.equal(pair(access, { platform: "toaster" }).client.platform, "unknown");
});

test("enforces the client allowlist when one is configured", () => {
  const access = makeAccess({ allowedClients: "macbook-orion" });
  assert.equal(access.allowlistEnforced, true);
  assert.throws(() => pair(access, { clientId: "other-laptop" }), { statusCode: 403 });
  assert.ok(pair(access, { clientId: "macbook-orion" }).token);
});

test("accepts a comma-separated allowlist string and ignores case", () => {
  const access = makeAccess({ allowedClients: " Macbook-Orion , spare " });
  assert.ok(pair(access, { clientId: "MACBOOK-ORION" }).token);
  assert.ok(pair(access, { clientId: "spare" }).token);
});

test("throttles repeated failures per client key", () => {
  const access = makeAccess({ maxFailures: 3 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(() => pair(access, { pairingSecret: "wrong", clientKey: "1.2.3.4" }), {
      statusCode: 401,
    });
  }
  const throttled = () => pair(access, { pairingSecret: SECRET, clientKey: "1.2.3.4" });
  assert.throws(throttled, { statusCode: 429 });
  // A different device is unaffected by another device's failures.
  assert.ok(pair(access, { clientKey: "5.6.7.8" }).token);
});

test("expires a token once its TTL passes", () => {
  let clock = 1_000;
  const access = makeAccess({ tokenTtlMs: 500, now: () => clock });
  const { token } = pair(access);
  assert.ok(access.verify(token));
  clock += 501;
  assert.equal(access.verify(token), null);
  assert.equal(access.clients().length, 0);
});

test("verify touches lastSeenAt", () => {
  let clock = 1_000;
  const access = makeAccess({ now: () => clock });
  const { token } = pair(access);
  clock += 60_000;
  assert.equal(access.verify(token).lastSeenAt, 61_000);
});

test("revokes a single token without affecting other devices", () => {
  const access = makeAccess();
  const first = pair(access, { clientId: "one" });
  const second = pair(access, { clientId: "two" });
  assert.equal(access.revoke(first.token), true);
  assert.equal(access.verify(first.token), null);
  assert.ok(access.verify(second.token));
  assert.equal(access.revoke("not-a-token"), false);
});

test("revokes every token for one client id", () => {
  const access = makeAccess();
  const a = pair(access, { clientId: "macbook-test" });
  const b = pair(access, { clientId: "macbook-test" });
  const other = pair(access, { clientId: "keep-me" });
  assert.equal(access.revokeClient("macbook-test"), 2);
  assert.equal(access.verify(a.token), null);
  assert.equal(access.verify(b.token), null);
  assert.ok(access.verify(other.token));
  assert.equal(access.revokeClient("macbook-test"), 0);
});

test("client listing never exposes tokens", () => {
  const access = makeAccess();
  const { token } = pair(access);
  const listed = access.clients();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes(token), false);
  assert.deepEqual(Object.keys(listed[0]).sort(), [
    "clientId",
    "clientName",
    "expiresAt",
    "issuedAt",
    "lastSeenAt",
    "platform",
  ]);
});

test("audit records outcomes without the secret or the token", () => {
  const access = makeAccess();
  const { token } = pair(access);
  assert.throws(() => pair(access, { pairingSecret: "wrong" }), { statusCode: 401 });
  access.revoke(token);
  const serialized = JSON.stringify(access.audit());
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(token), false);
  assert.deepEqual(
    access.audit().map(({ action, outcome }) => `${action}:${outcome}`),
    ["pair:granted", "pair:rejected", "unpair:revoked"],
  );
});

test("audit ring buffer stays bounded", () => {
  const access = makeAccess();
  for (let index = 0; index < 260; index += 1) access.record("pair", "c", "granted");
  assert.equal(access.audit().length, 200);
});

test("desktopBearerToken parses only a well-formed Authorization header", () => {
  const header = (value) => ({ get: () => value });
  assert.equal(desktopBearerToken(header("Bearer abc123")), "abc123");
  assert.equal(desktopBearerToken(header("bearer abc123")), "abc123");
  assert.equal(desktopBearerToken(header("Basic abc123")), "");
  assert.equal(desktopBearerToken(header("")), "");
  assert.equal(desktopBearerToken({ get: () => undefined }), "");
});
