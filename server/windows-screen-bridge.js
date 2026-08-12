import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 4_000;
const HEALTH_CACHE_MS = 3_000;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const GATEWAY_CHUNK_BYTES = 120_000;

export class WindowsScreenBridge {
  constructor({
    url = "",
    token = "",
    nodeId = "",
    timeoutMs = DEFAULT_TIMEOUT_MS,
    invoke,
    powershellScript = "",
  } = {}) {
    this.url = url.trim().replace(/\/$/, "");
    this.token = token.trim();
    this.nodeId = nodeId.trim();
    this.timeoutMs = timeoutMs;
    this.invoke = invoke;
    this.powershellScript = powershellScript;
    this.gatewayQueue = Promise.resolve();
    this.lastHealth = null;
  }

  get enabled() {
    return this.httpEnabled || this.gatewayEnabled;
  }

  get httpEnabled() {
    return Boolean(this.url && this.token && this.nodeId);
  }

  get gatewayEnabled() {
    return Boolean(this.nodeId && this.invoke && this.powershellScript);
  }

  handles(nodeId, command) {
    return this.enabled && nodeId === this.nodeId && command === "screen.snapshot";
  }

  isTarget(nodeId) {
    return this.enabled && nodeId === this.nodeId;
  }

  async decorateNodeList(payload) {
    if (!this.enabled || !Array.isArray(payload?.nodes)) return payload;
    const target = payload.nodes.find((node) => node.nodeId === this.nodeId);
    const gatewayOnline = Boolean(
      this.gatewayEnabled && target?.connected && target.commands?.includes("system.run"),
    );
    const health = this.httpEnabled ? await this.health() : { online: gatewayOnline };
    return {
      ...payload,
      nodes: payload.nodes.map((node) => {
        if (node.nodeId !== this.nodeId) return node;
        const commands = new Set(node.commands ?? []);
        if (health.online) {
          commands.add("screen.snapshot");
          commands.add("screen.input");
        } else {
          commands.delete("screen.snapshot");
          commands.delete("screen.input");
        }
        return {
          ...node,
          platform: "Windows",
          deviceFamily: "Windows",
          connected: Boolean(node.connected || health.online),
          commands: [...commands],
          lastSeenAtMs: health.online ? Date.now() : node.lastSeenAtMs,
          screenBridgeConfigured: true,
          screenBridgeOnline: health.online,
        };
      }),
    };
  }

  async health() {
    const now = Date.now();
    if (this.lastHealth && now - this.lastHealth.checkedAtMs < HEALTH_CACHE_MS) {
      return this.lastHealth;
    }
    if (!this.enabled) return { online: false, checkedAtMs: now };
    try {
      const response = await this.request("/health", { timeoutMs: Math.min(this.timeoutMs, 1_500) });
      const body = await response.json();
      this.lastHealth = {
        online: response.ok && body?.ok === true,
        checkedAtMs: now,
        screenCount: Number(body?.screenCount ?? 0),
      };
    } catch {
      this.lastHealth = { online: false, checkedAtMs: now };
    }
    return this.lastHealth;
  }

  async snapshot(params = {}, signal) {
    if (!this.enabled) throw Object.assign(new Error("Windows screen bridge is not configured"), { statusCode: 503 });
    if (this.gatewayEnabled && !this.httpEnabled) return this.snapshotViaGateway(params, signal);
    const query = new URLSearchParams({
      screenIndex: String(normalizeInteger(params.screenIndex, 0, 0, 15)),
      maxWidth: String(normalizeInteger(params.maxWidth, 1280, 320, 2560)),
      quality: String(normalizeQuality(params.quality)),
    });
    const response = await this.request(`/snapshot?${query}`, { signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      const error = body?.error || `Windows screen bridge returned HTTP ${response.status}`;
      throw Object.assign(new Error(error), { statusCode: response.status || 502 });
    }
    const frame = validateFrame(body);
    this.lastHealth = { online: true, checkedAtMs: Date.now(), screenCount: body.screenCount };
    return frame;
  }

  async input(params = {}) {
    if (!this.enabled) {
      throw Object.assign(new Error("Windows screen bridge is not configured"), { statusCode: 503 });
    }
    if (this.gatewayEnabled) {
      const operation = this.gatewayQueue.then(() => this.inputViaGateway(params));
      this.gatewayQueue = operation.catch(() => undefined);
      return operation;
    }
    throw Object.assign(
      new Error("Manual Windows input requires the secured OpenClaw gateway connection"),
      { statusCode: 409 },
    );
  }

  async inputViaGateway(params) {
    const script = buildWindowsInputScript(params);
    const run = await this.runGatewayPowershell(script);
    let result;
    try {
      result = JSON.parse(String(run.stdout ?? "").trim());
    } catch {
      throw Object.assign(new Error("Windows screen input returned invalid JSON"), { statusCode: 502 });
    }
    if (result?.ok !== true) {
      throw Object.assign(new Error(result?.error || "Windows screen input failed"), { statusCode: 502 });
    }
    return result;
  }

  async snapshotViaGateway(params, signal) {
    const operation = this.gatewayQueue.then(() => this.captureGatewayFrame(params, signal));
    this.gatewayQueue = operation.catch(() => undefined);
    return operation;
  }

  async captureGatewayFrame(params, signal) {
    if (signal?.aborted) throw signal.reason;
    const screenIndex = normalizeInteger(params.screenIndex, 0, 0, 15);
    const maxWidth = normalizeInteger(params.maxWidth, 1920, 1280, 2560);
    const quality = normalizeQuality(params.quality);
    const captureId = randomUUID();
    const script = [
      `$env:JARVIS_SCREEN_INDEX = "${screenIndex}"`,
      `$env:JARVIS_SCREEN_CAPTURE_ID = "${captureId}"`,
      `$env:JARVIS_SCREEN_MAX_WIDTH = "${maxWidth}"`,
      `$env:JARVIS_SCREEN_QUALITY = "${quality}"`,
      this.powershellScript,
    ].join("\r\n");
    try {
      const run = await this.runGatewayPowershell(script);
      let manifest;
      try {
        manifest = JSON.parse(String(run.stdout ?? "").trim());
      } catch {
        throw Object.assign(new Error("Windows screen capture returned an invalid manifest"), {
          statusCode: 502,
        });
      }
      validateGatewayManifest(manifest, captureId);
      const base64 = await this.readGatewayFrameChunks(captureId, manifest.byteLength, signal);
      return validateFrame({ ...manifest, base64 });
    } finally {
      await this.cleanupGatewayFrame(captureId);
    }
  }

  async runGatewayPowershell(script) {
    const encodedPowershell = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.invoke({
      nodeId: this.nodeId,
      command: "system.run",
      params: {
        command: [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encodedPowershell,
        ],
        timeoutMs: Math.max(this.timeoutMs, 20_000),
        suppressNotifyOnExit: true,
      },
    });
    const run = result?.payload ?? result;
    if (!run?.success) {
      throw Object.assign(new Error(run?.error || run?.stderr || "Windows screen capture failed"), {
        statusCode: 502,
      });
    }
    return run;
  }

  async readGatewayFrameChunks(captureId, byteLength, signal) {
    const offsets = Array.from(
      { length: Math.ceil(byteLength / GATEWAY_CHUNK_BYTES) },
      (_, index) => index * GATEWAY_CHUNK_BYTES,
    );
    const chunks = await Promise.all(
      offsets.map(async (offset) => {
        if (signal?.aborted) throw signal.reason;
        const script = [
          "# JARVIS_SCREEN_CHUNK",
          '$ErrorActionPreference = "Stop"',
          `$path = Join-Path ([IO.Path]::GetTempPath()) "jarvis-screen-${captureId}.jpg"`,
          "$bytes = [IO.File]::ReadAllBytes($path)",
          `$offset = ${offset}`,
          `$count = [Math]::Min(${GATEWAY_CHUNK_BYTES}, $bytes.Length - $offset)`,
          'if ($count -le 0) { throw "Invalid Windows screen chunk offset" }',
          "[Convert]::ToBase64String($bytes, $offset, $count)",
        ].join("\r\n");
        const run = await this.runGatewayPowershell(script);
        return String(run.stdout ?? "").trim();
      }),
    );
    if (signal?.aborted) throw signal.reason;
    const base64 = chunks.join("");
    if (Buffer.from(base64, "base64").length !== byteLength) {
      throw Object.assign(new Error("Windows screen capture chunks were incomplete"), {
        statusCode: 502,
      });
    }
    return base64;
  }

  async cleanupGatewayFrame(captureId) {
    const script = [
      "# JARVIS_SCREEN_CLEANUP",
      `$path = Join-Path ([IO.Path]::GetTempPath()) "jarvis-screen-${captureId}.jpg"`,
      "Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue",
    ].join("\r\n");
    try {
      await this.runGatewayPowershell(script);
    } catch {
      // The capture script removes stale Jarvis frames on the next request.
    }
  }

  async request(pathname, { signal, timeoutMs = this.timeoutMs } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return fetch(`${this.url}${pathname}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: combined,
    });
  }
}

export function buildWindowsInputScript(params) {
  const action = params.action === "scroll" ? "scroll" : "click";
  const screenIndex = normalizeInteger(params.screenIndex, 0, 0, 15);
  const xRatio = normalizeRatio(params.xRatio);
  const yRatio = normalizeRatio(params.yRatio);
  const delta = Math.max(-1200, Math.min(1200, Math.round(Number(params.delta) || 0)));
  const wheelDelta = -delta;
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type @"',
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class JarvisHumanInput {",
    '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);',
    "}",
    '"@',
    'try { [void][JarvisHumanInput]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][JarvisHumanInput]::SetProcessDPIAware() } catch {} }',
    "Add-Type -AssemblyName System.Windows.Forms",
    "$screens = [Windows.Forms.Screen]::AllScreens",
    'if ($screens.Count -eq 0) { throw "No Windows display is available" }',
    `$screenIndex = [Math]::Min($screens.Count - 1, ${screenIndex})`,
    "$bounds = $screens[$screenIndex].Bounds",
    `$x = $bounds.X + [Math]::Min($bounds.Width - 1, [Math]::Max(0, [int][Math]::Round(($bounds.Width - 1) * ${xRatio})))`,
    `$y = $bounds.Y + [Math]::Min($bounds.Height - 1, [Math]::Max(0, [int][Math]::Round(($bounds.Height - 1) * ${yRatio})))`,
    "[void][JarvisHumanInput]::SetCursorPos($x, $y)",
    action === "click"
      ? "[JarvisHumanInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [JarvisHumanInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)"
      : `[JarvisHumanInput]::mouse_event(0x0800, 0, 0, ${wheelDelta}, [UIntPtr]::Zero)`,
    `@{ ok = $true; action = "${action}"; screenIndex = $screenIndex } | ConvertTo-Json -Compress`,
  ].join("\r\n");
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeQuality(value) {
  const parsed = Number(value);
  const ratio = Number.isFinite(parsed) ? Math.min(1, Math.max(0.1, parsed)) : 0.58;
  return Math.round(ratio * 100);
}

function normalizeRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, parsed)) * 100_000) / 100_000;
}

function validateGatewayManifest(body, captureId) {
  const byteLength = Number(body?.byteLength);
  if (
    body?.captureId !== captureId ||
    body?.format !== "jpeg" ||
    !Number.isInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > MAX_FRAME_BYTES
  ) {
    throw Object.assign(new Error("Windows screen capture returned an invalid manifest"), {
      statusCode: 502,
    });
  }
}

function validateFrame(body) {
  const base64 = typeof body?.base64 === "string" ? body.base64 : "";
  const format = typeof body?.format === "string" ? body.format.toLowerCase() : "";
  const width = Number(body?.width);
  const height = Number(body?.height);
  const displayWidth = Number(body?.displayWidth);
  const displayHeight = Number(body?.displayHeight);
  if (!base64 || !["jpg", "jpeg", "png"].includes(format)) {
    throw Object.assign(new Error("Windows screen bridge returned an invalid frame"), { statusCode: 502 });
  }
  if (base64.length > Math.ceil((MAX_FRAME_BYTES * 4) / 3)) {
    throw Object.assign(new Error("Windows screen bridge frame is too large"), { statusCode: 502 });
  }
  return {
    format: format === "png" ? "png" : "jpeg",
    base64,
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
    displayWidth: Number.isFinite(displayWidth) ? displayWidth : undefined,
    displayHeight: Number.isFinite(displayHeight) ? displayHeight : undefined,
    screenIndex: normalizeInteger(body.screenIndex, 0, 0, 15),
    screenCount: normalizeInteger(body.screenCount, 1, 1, 16),
    capturedAtMs: Number.isFinite(Number(body.capturedAtMs)) ? Number(body.capturedAtMs) : Date.now(),
  };
}
