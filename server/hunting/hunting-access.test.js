import assert from "node:assert/strict";
import test from "node:test";
import { HuntingAccess } from "./hunting-access.js";

test("creates and verifies an opaque Hunting session", () => {
  let now = 1_000;
  const access = new HuntingAccess({ password: "correct", sessionTtlMs: 500, now: () => now });
  const session = access.unlock("correct", "browser");

  assert.equal(access.verify(session.token), true);
  assert.equal(session.token.includes("correct"), false);
  now += 501;
  assert.equal(access.verify(session.token), false);
});

test("rejects incorrect passwords and rate limits repeated failures", () => {
  const access = new HuntingAccess({ password: "correct", maxFailures: 2 });

  assert.throws(() => access.unlock("wrong", "browser"), { statusCode: 401 });
  assert.throws(() => access.unlock("wrong", "browser"), { statusCode: 401 });
  assert.throws(() => access.unlock("correct", "browser"), { statusCode: 429 });
});

test("successful unlock clears failures and revoke invalidates a session", () => {
  const access = new HuntingAccess({ password: "correct", maxFailures: 3 });
  assert.throws(() => access.unlock("wrong", "browser"), { statusCode: 401 });

  const session = access.unlock("correct", "browser");
  access.revoke(session.token);
  assert.equal(access.verify(session.token), false);
});

test("fails closed when no Hunting password is configured", () => {
  const access = new HuntingAccess();
  assert.throws(() => access.unlock("anything", "browser"), { statusCode: 503 });
});
