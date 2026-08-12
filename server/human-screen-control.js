import { randomBytes, randomUUID } from "node:crypto";

const DEFAULT_LEASE_MS = 2 * 60_000;

export class HumanScreenControl {
  constructor({ gateway, windowsScreen, leaseMs = DEFAULT_LEASE_MS }) {
    this.gateway = gateway;
    this.windowsScreen = windowsScreen;
    this.leaseMs = leaseMs;
    this.leases = new Map();
  }

  decorateNodeList(payload) {
    if (!Array.isArray(payload?.nodes)) return payload;
    return {
      ...payload,
      nodes: payload.nodes.map((node) => {
        const commands = new Set(node.commands ?? []);
        if (
          node.connected &&
          commands.has("screen.snapshot") &&
          commands.has("system.run")
        ) {
          commands.add("screen.input");
        } else {
          commands.delete("screen.input");
        }
        return { ...node, commands: [...commands] };
      }),
    };
  }

  start(nodeId, nodes) {
    this.#prune();
    const node = nodes.find((entry) => entry.nodeId === nodeId);
    if (!node?.connected || !node.commands?.includes("screen.input")) {
      throw Object.assign(new Error("This screen does not support manual input"), { statusCode: 409 });
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + this.leaseMs;
    this.leases.set(token, { nodeId, expiresAt, lastInputAt: 0 });
    return { token, expiresAt };
  }

  stop(nodeId, token) {
    const lease = this.leases.get(token);
    if (lease?.nodeId === nodeId) this.leases.delete(token);
  }

  async input(nodeId, token, input) {
    this.#prune();
    const lease = this.leases.get(token);
    if (!lease || lease.nodeId !== nodeId) {
      throw Object.assign(new Error("Manual control expired; enable it again"), { statusCode: 401 });
    }
    const now = Date.now();
    if (now - lease.lastInputAt < 40) {
      throw Object.assign(new Error("Manual input is arriving too quickly"), { statusCode: 429 });
    }
    const normalized = normalizeScreenInput(input);
    lease.lastInputAt = now;
    lease.expiresAt = now + this.leaseMs;

    if (this.windowsScreen.isTarget(nodeId)) {
      return this.windowsScreen.input(normalized);
    }
    if (normalized.screenIndex !== 0) {
      throw Object.assign(new Error("Mac manual control currently supports the primary display only"), {
        statusCode: 400,
      });
    }
    return this.#runMacInput(nodeId, normalized);
  }

  async #runMacInput(nodeId, input) {
    const click = input.action === "click";
    const script = click
      ? macClickScript(input)
      : macScrollScript(input);
    const result = await this.gateway.request("node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["/usr/bin/osascript", "-e", script],
        timeoutMs: 10_000,
        suppressNotifyOnExit: true,
      },
      idempotencyKey: randomUUID(),
    });
    const run = result?.payload ?? result;
    if (!run?.success) {
      throw Object.assign(
        new Error(
          run?.error ||
            run?.stderr ||
            "Mac input failed. Enable Accessibility for OpenClaw in System Settings.",
        ),
        { statusCode: 502 },
      );
    }
    return { ok: true, action: input.action, screenIndex: input.screenIndex };
  }

  #prune() {
    const now = Date.now();
    for (const [token, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(token);
    }
  }
}

export function normalizeScreenInput(input) {
  const action = String(input?.action ?? "");
  if (action !== "click" && action !== "scroll") {
    throw Object.assign(new Error("Unsupported manual screen input"), { statusCode: 400 });
  }
  const xRatio = normalizedRatio(input?.xRatio, "xRatio");
  const yRatio = normalizedRatio(input?.yRatio, "yRatio");
  const screenIndex = boundedInteger(input?.screenIndex, 0, 15, "screenIndex");
  const delta = action === "scroll"
    ? Math.max(-1_200, Math.min(1_200, Number(input?.delta) || 0))
    : 0;
  if (action === "scroll" && Math.abs(delta) < 1) {
    throw Object.assign(new Error("Scroll input requires a delta"), { statusCode: 400 });
  }
  return { action, xRatio, yRatio, screenIndex, delta };
}

function normalizedRatio(value, name) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw Object.assign(new Error(`${name} must be between 0 and 1`), { statusCode: 400 });
  }
  return Math.round(ratio * 100_000) / 100_000;
}

function boundedInteger(value, min, max, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${name} is invalid`), { statusCode: 400 });
  }
  return number;
}

function macClickScript(input) {
  return [
    'tell application "Finder" to set desktopBounds to bounds of window of desktop',
    `set targetX to (item 1 of desktopBounds) + ((item 3 of desktopBounds) - (item 1 of desktopBounds)) * ${input.xRatio}`,
    `set targetY to (item 2 of desktopBounds) + ((item 4 of desktopBounds) - (item 2 of desktopBounds)) * ${input.yRatio}`,
    "set targetX to targetX as integer",
    "set targetY to targetY as integer",
    'tell application "System Events" to click at {targetX, targetY}',
  ].join("\n");
}

function macScrollScript(input) {
  const keyCode = input.delta > 0 ? 125 : 126;
  const repeats = Math.max(1, Math.min(6, Math.round(Math.abs(input.delta) / 180)));
  return [
    'tell application "System Events"',
    `repeat ${repeats} times`,
    `key code ${keyCode}`,
    "end repeat",
    "end tell",
  ].join("\n");
}
