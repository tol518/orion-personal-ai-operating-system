import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionPolicy,
  buildSessionExecutionPatch,
  resolveExecutionDevices,
} from "./execution-target.js";

const payload = {
  nodes: [
    {
      nodeId: "mac-offline",
      displayName: "the user's Mac mini",
      platform: "macOS",
      connected: false,
      commands: ["system.run"],
    },
    {
      nodeId: "mac-live",
      displayName: "the user's Mac mini",
      platform: "macOS",
      connected: true,
      commands: ["system.run"],
    },
    {
      nodeId: "windows-live",
      displayName: "Windows PC",
      platform: "Windows",
      connected: true,
      commands: ["system.run"],
    },
  ],
};

test("resolves the connected executable Mac and Windows nodes", () => {
  assert.deepEqual(resolveExecutionDevices(payload), {
    mac: { name: "the user's Mac mini", nodeId: "mac-live", available: true },
    windows: { name: "Windows PC", nodeId: "windows-live", available: true },
  });
});

test("builds hard exec bindings for a selected machine and clears them for neutral", () => {
  const devices = resolveExecutionDevices(payload);
  assert.deepEqual(buildSessionExecutionPatch("mac", devices), {
    execHost: "node",
    execNode: "mac-live",
  });
  assert.deepEqual(buildSessionExecutionPatch("windows", devices), {
    execHost: "node",
    execNode: "windows-live",
  });
  assert.deepEqual(buildSessionExecutionPatch("neutral", devices), {
    execHost: "auto",
    execNode: null,
  });
});

test("neutral policy names both nodes and allows parallel work", () => {
  const policy = buildExecutionPolicy("neutral", resolveExecutionDevices(payload));
  assert.match(policy, /mac-live/);
  assert.match(policy, /windows-live/);
  assert.match(policy, /parallel operations/);
  assert.match(policy, /use node_exec/);
  assert.match(policy, /native shell tools such as bash run in the gateway\/app-server workspace/);
  assert.match(policy, /timeout as a command timeout/);
});

test("Mac policy directs Codex away from its local shell and toward bounded workspace discovery", () => {
  const policy = buildExecutionPolicy("mac", resolveExecutionDevices(payload));
  assert.match(policy, /must use node_exec/);
  assert.match(policy, /never use them for Mac files/);
  assert.match(policy, /code --status/);
  assert.match(policy, /mdfind/);
  assert.match(policy, /maximum depth 4/);
  assert.match(policy, /Git exit 128 is a path\/repository error/);
  assert.match(policy, /timeout means that command timed out, not that the Mac is offline/);
  assert.match(policy, /Avoid AppleScript or System Events/);
});

test("fails closed when a selected execution node is unavailable", () => {
  const devices = resolveExecutionDevices({ nodes: [] });
  assert.throws(() => buildSessionExecutionPatch("windows", devices), /offline/);
});
