import assert from "node:assert/strict";
import test from "node:test";
import { enforceHuntingBrowserTarget } from "./policy.js";

test("Hunting browser calls targeting the gateway host are rejected", () => {
  const result = enforceHuntingBrowserTarget(
    { toolName: "browser", params: { action: "snapshot", target: "host", targetId: "T1" } },
    { sessionKey: "agent:main:dashboard:hunting-application-job-1" },
  );
  assert.deepEqual(result, {
    block: true,
    blockReason: 'Hunting browser calls must use target: "node"',
  });
});

test("Hunting browser calls targeting the browser node are allowed", () => {
  assert.equal(
    enforceHuntingBrowserTarget(
      { toolName: "browser", params: { action: "snapshot", target: "node", targetId: "T1" } },
      { sessionKey: "agent:main:dashboard:hunting-application-job-1" },
    ),
    undefined,
  );
});

test("ordinary sessions remain untouched", () => {
  assert.equal(
    enforceHuntingBrowserTarget(
      { toolName: "browser", params: { action: "tabs", target: "host" } },
      { sessionKey: "agent:main:main" },
    ),
    undefined,
  );
});

test("Hunting sessions cannot fall back to Mac command execution", () => {
  const result = enforceHuntingBrowserTarget(
    { toolName: "exec", params: { command: "open -a Safari https://example.com" } },
    { sessionKey: "agent:main:dashboard:hunting-application-job-1" },
  );
  assert.equal(result.block, true);
  assert.match(result.blockReason, /only use the controlled browser tool/);
});
