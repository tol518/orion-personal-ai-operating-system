import assert from "node:assert/strict";
import test from "node:test";
import { HumanScreenControl, normalizeScreenInput } from "./human-screen-control.js";

test("decorates only connected snapshot nodes with bounded manual input", () => {
  const control = createControl();
  const payload = control.decorateNodeList({
    nodes: [
      { nodeId: "ready", connected: true, commands: ["screen.snapshot", "system.run"] },
      { nodeId: "read-only", connected: true, commands: ["screen.snapshot"] },
      { nodeId: "offline", connected: false, commands: ["screen.snapshot", "system.run"] },
    ],
  });
  assert.ok(payload.nodes[0].commands.includes("screen.input"));
  assert.ok(!payload.nodes[1].commands.includes("screen.input"));
  assert.ok(!payload.nodes[2].commands.includes("screen.input"));
});

test("requires a live lease and routes Windows input through the bridge", async () => {
  const inputs = [];
  const control = createControl({
    windowsScreen: {
      isTarget: (nodeId) => nodeId === "windows",
      input: async (value) => {
        inputs.push(value);
        return { ok: true };
      },
    },
  });
  const nodes = [{ nodeId: "windows", connected: true, commands: ["screen.input"] }];
  const lease = control.start("windows", nodes);
  await control.input("windows", lease.token, {
    action: "click",
    screenIndex: 1,
    xRatio: 0.25,
    yRatio: 0.75,
  });
  assert.deepEqual(inputs[0], {
    action: "click",
    screenIndex: 1,
    xRatio: 0.25,
    yRatio: 0.75,
    delta: 0,
  });
  control.stop("windows", lease.token);
  await assert.rejects(
    () => control.input("windows", lease.token, { action: "click", screenIndex: 0, xRatio: 0.5, yRatio: 0.5 }),
    /expired/,
  );
});

test("rejects unsupported actions and out-of-frame coordinates", () => {
  assert.throws(() => normalizeScreenInput({ action: "type", xRatio: 0.5, yRatio: 0.5, screenIndex: 0 }), /Unsupported/);
  assert.throws(() => normalizeScreenInput({ action: "click", xRatio: 1.1, yRatio: 0.5, screenIndex: 0 }), /xRatio/);
  assert.throws(() => normalizeScreenInput({ action: "scroll", xRatio: 0.5, yRatio: 0.5, screenIndex: 0, delta: 0 }), /delta/);
});

function createControl(overrides = {}) {
  return new HumanScreenControl({
    gateway: { request: async () => ({ payload: { success: true } }) },
    windowsScreen: { isTarget: () => false, input: async () => ({ ok: true }) },
    ...overrides,
  });
}
