import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildWindowsInputScript, WindowsScreenBridge } from "./windows-screen-bridge.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("decorates only the configured node when the bridge is healthy", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, screenCount: 2 }));
  const bridge = new WindowsScreenBridge({
    url: "http://192.0.2.20:43129",
    token: "secret",
    nodeId: "windows-node",
  });
  const payload = await bridge.decorateNodeList({
    nodes: [
      { nodeId: "windows-node", platform: "linux", connected: false, commands: ["system.run"] },
      { nodeId: "mac-node", platform: "macOS", connected: true, commands: ["screen.snapshot"] },
    ],
  });
  assert.equal(payload.nodes[0].connected, true);
  assert.equal(payload.nodes[0].platform, "Windows");
  assert.deepEqual(payload.nodes[0].commands, ["system.run", "screen.snapshot", "screen.input"]);
  assert.equal(payload.nodes[1].platform, "macOS");
});

test("forwards a bounded snapshot request and validates the frame", async () => {
  let requested;
  globalThis.fetch = async (url, init) => {
    requested = { url: String(url), authorization: init.headers.Authorization };
    return new Response(
      JSON.stringify({
        ok: true,
        format: "jpg",
        base64: "dGVzdA==",
        width: 1280,
        height: 720,
        screenIndex: 0,
        capturedAtMs: 123,
      }),
    );
  };
  const bridge = new WindowsScreenBridge({
    url: "http://192.0.2.20:43129/",
    token: "secret",
    nodeId: "windows-node",
  });
  const frame = await bridge.snapshot({ screenIndex: 0, maxWidth: 99999, quality: 0.58 });
  assert.match(requested.url, /maxWidth=2560/);
  assert.match(requested.url, /quality=58/);
  assert.equal(requested.authorization, "Bearer secret");
  assert.equal(frame.format, "jpeg");
  assert.equal(frame.width, 1280);
});

test("does not advertise screen capture while the bridge is offline", async () => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  const bridge = new WindowsScreenBridge({
    url: "http://192.0.2.20:43129",
    token: "secret",
    nodeId: "windows-node",
  });
  const payload = await bridge.decorateNodeList({
    nodes: [{ nodeId: "windows-node", connected: false, commands: ["system.run", "screen.snapshot"] }],
  });
  assert.equal(payload.nodes[0].connected, false);
  assert.deepEqual(payload.nodes[0].commands, ["system.run"]);
  assert.equal(payload.nodes[0].screenBridgeConfigured, true);
});

test("captures through the secured gateway when no direct URL is configured", async () => {
  const frameBytes = Buffer.alloc(120_005, 7);
  const invocations = [];
  const bridge = new WindowsScreenBridge({
    nodeId: "windows-node",
    powershellScript: "# JARVIS_SCREEN_CAPTURE",
    invoke: async (request) => {
      invocations.push(request);
      const script = Buffer.from(request.params.command[4], "base64").toString("utf16le");
      if (script.includes("JARVIS_SCREEN_CLEANUP")) {
        return { payload: { success: true, stdout: "" } };
      }
      if (script.includes("JARVIS_SCREEN_CHUNK")) {
        const offset = Number(script.match(/\$offset = (\d+)/)?.[1] ?? -1);
        return {
          payload: {
            success: true,
            stdout: frameBytes.subarray(offset, offset + 120_000).toString("base64"),
          },
        };
      }
      const captureId = script.match(/JARVIS_SCREEN_CAPTURE_ID = "([^"]+)"/)?.[1];
      return {
        payload: {
          success: true,
          stdout: JSON.stringify({
            ok: true,
            captureId,
            format: "jpeg",
            byteLength: frameBytes.length,
            width: 1920,
            height: 1080,
            displayWidth: 2560,
            displayHeight: 1440,
            screenCount: 2,
          }),
        },
      };
    },
  });
  const nodes = await bridge.decorateNodeList({
    nodes: [{ nodeId: "windows-node", connected: true, commands: ["system.run"] }],
  });
  assert.ok(nodes.nodes[0].commands.includes("screen.snapshot"));
  const frame = await bridge.snapshot({ screenIndex: 1, maxWidth: 1920, quality: 0.75 });
  assert.equal(invocations[0].command, "system.run");
  assert.deepEqual(invocations[0].params.command.slice(0, 4), [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  assert.equal(frame.width, 1920);
  assert.equal(frame.screenCount, 2);
  assert.equal(frame.displayHeight, 1440);
  assert.deepEqual(Buffer.from(frame.base64, "base64"), frameBytes);
  assert.equal(invocations.length, 4);
  const captureScript = Buffer.from(invocations[0].params.command[4], "base64").toString("utf16le");
  assert.match(captureScript, /JARVIS_SCREEN_INDEX = "1"/);
  assert.match(captureScript, /JARVIS_SCREEN_MAX_WIDTH = "1920"/);
  assert.match(captureScript, /JARVIS_SCREEN_QUALITY = "75"/);
});

test("cleans up the temporary Windows frame when the manifest is invalid", async () => {
  const scripts = [];
  const bridge = new WindowsScreenBridge({
    nodeId: "windows-node",
    powershellScript: "# JARVIS_SCREEN_CAPTURE",
    invoke: async (request) => {
      const script = Buffer.from(request.params.command[4], "base64").toString("utf16le");
      scripts.push(script);
      return { payload: { success: true, stdout: script.includes("JARVIS_SCREEN_CLEANUP") ? "" : "{" } };
    },
  });

  await assert.rejects(() => bridge.snapshot({ screenIndex: 0 }), /invalid manifest/);
  assert.equal(scripts.length, 2);
  assert.match(scripts[1], /JARVIS_SCREEN_CLEANUP/);
});

test("maps bounded manual clicks to the selected Windows display", async () => {
  const scripts = [];
  const bridge = new WindowsScreenBridge({
    nodeId: "windows-node",
    powershellScript: "# JARVIS_SCREEN_CAPTURE",
    invoke: async (request) => {
      const script = Buffer.from(request.params.command[4], "base64").toString("utf16le");
      scripts.push(script);
      return {
        payload: {
          success: true,
          stdout: JSON.stringify({ ok: true, action: "click", screenIndex: 1 }),
        },
      };
    },
  });
  const result = await bridge.input({
    action: "click",
    screenIndex: 1,
    xRatio: 0.25,
    yRatio: 0.75,
  });
  assert.equal(result.ok, true);
  assert.match(scripts[0], /\$screenIndex = \[Math\]::Min\(\$screens.Count - 1, 1\)/);
  assert.match(scripts[0], /\* 0\.25/);
  assert.match(scripts[0], /\* 0\.75/);
  assert.match(scripts[0], /mouse_event\(0x0002/);
});

test("builds a clamped Windows scroll command", () => {
  const script = buildWindowsInputScript({
    action: "scroll",
    screenIndex: 99,
    xRatio: -1,
    yRatio: 3,
    delta: 5000,
  });
  assert.match(script, /\$screenIndex = \[Math\]::Min\(\$screens.Count - 1, 15\)/);
  assert.match(script, /\* 0\)/);
  assert.match(script, /\* 1\)/);
  assert.match(script, /mouse_event\(0x0800, 0, 0, -1200/);
});
