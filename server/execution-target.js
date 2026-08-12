import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const EXECUTION_TARGETS = ["mac", "neutral", "windows"];
const TARGET_SET = new Set(EXECUTION_TARGETS);

export class ExecutionTargetStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS chat_execution_targets (
        session_key TEXT PRIMARY KEY,
        target TEXT NOT NULL CHECK (target IN ('mac', 'neutral', 'windows')),
        updated_at TEXT NOT NULL
      )
    `);
  }

  get(sessionKey) {
    const row = this.database
      .prepare("SELECT target FROM chat_execution_targets WHERE session_key = ?")
      .get(sessionKey);
    return row?.target ?? "neutral";
  }

  set(sessionKey, target) {
    if (!TARGET_SET.has(target)) throw Object.assign(new Error("invalid execution target"), { statusCode: 400 });
    this.database
      .prepare(
        `INSERT INTO chat_execution_targets (session_key, target, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           target = excluded.target,
           updated_at = excluded.updated_at`,
      )
      .run(sessionKey, target, new Date().toISOString());
    return target;
  }

  delete(sessionKey) {
    this.database.prepare("DELETE FROM chat_execution_targets WHERE session_key = ?").run(sessionKey);
  }
}

export function resolveExecutionDevices(payload) {
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  return {
    mac: summarizeDevice(findDevice(nodes, "mac"), "Mac"),
    windows: summarizeDevice(findDevice(nodes, "windows"), "Windows"),
  };
}

export function buildSessionExecutionPatch(target, devices) {
  if (!TARGET_SET.has(target)) throw Object.assign(new Error("invalid execution target"), { statusCode: 400 });
  if (target === "neutral") return { execHost: "auto", execNode: null };
  const device = devices[target];
  if (!device?.available || !device.nodeId) {
    throw Object.assign(new Error(`${target === "mac" ? "Mac" : "Windows"} execution node is offline`), {
      statusCode: 409,
    });
  }
  return { execHost: "node", execNode: device.nodeId };
}

export function buildExecutionPolicy(target, devices) {
  const mac = devicePolicyLine("Mac", devices.mac);
  const windows = devicePolicyLine("Windows", devices.windows);
  if (target === "mac") {
    return [
      "Execution mode: MAC ONLY.",
      mac,
      windows,
      "All machine-specific shell work must use node_exec on the bound Mac node. Do not execute on Windows.",
      "Codex native shell tools such as bash run in the gateway/app-server workspace, not on the selected Mac; never use them for Mac files, apps, or commands.",
      "Keep node_exec probes bounded. For an open Visual Studio Code workspace, run the VS Code CLI `code --status` first; if an exact folder path is still needed, use a bounded Spotlight `mdfind` query and then run the requested command with that path.",
      "For Git commands, verify the resolved workspace is a repository. If it is only a parent workspace, use a bounded `.git` search (maximum depth 4) and run Git from the matching repository root; Git exit 128 is a path/repository error, not a node connection failure.",
      "A node_exec timeout means that command timed out, not that the Mac is offline. Verify with a short `hostname` probe and retry with a narrower command before reporting a node connection failure.",
      "Avoid AppleScript or System Events for workspace discovery unless the user explicitly needs UI automation; permissions can block those calls.",
      "For node, screen, canvas, or browser tools, target only the Mac device named above.",
      "When delegating to another agent, include this same Mac-only policy and node id in its task.",
    ].join("\n");
  }
  if (target === "windows") {
    return [
      "Execution mode: WINDOWS ONLY.",
      mac,
      windows,
      "All machine-specific shell work must use node_exec on the bound Windows node. Do not execute on Mac.",
      "Codex native shell tools such as bash run in the gateway/app-server workspace, not on the selected Windows PC; never use them for Windows files, apps, or commands.",
      "A node_exec timeout means that command timed out, not that Windows is offline. Verify with a short hostname probe and retry with a narrower command before reporting a node connection failure.",
      "For node, screen, or browser tools, target only the Windows device named above.",
      "When delegating to another agent, include this same Windows-only policy and node id in its task.",
    ].join("\n");
  }
  return [
    "Execution mode: BOTH / NEUTRAL.",
    mac,
    windows,
    "Choose the machine that best fits each operation. You may use both machines, including independent parallel operations, when the task benefits from it.",
    "For machine-specific shell calls, use node_exec with the matching node. Codex native shell tools such as bash run in the gateway/app-server workspace; do not assume that workspace is either physical machine.",
    "Treat a node_exec timeout as a command timeout. Verify the selected node with a short hostname probe and retry a narrower command before reporting it offline.",
    "When delegating to other agents, pass along the relevant machine choice and node id for each delegated task.",
  ].join("\n");
}

function findDevice(nodes, target) {
  const candidates = nodes.filter((node) => {
    const identity = `${node?.platform ?? ""} ${node?.displayName ?? ""}`.toLowerCase();
    return target === "mac"
      ? identity.includes("mac") || identity.includes("darwin")
      : identity.includes("windows");
  });
  return candidates.sort((a, b) => deviceScore(b) - deviceScore(a))[0] ?? null;
}

function deviceScore(node) {
  return Number(node?.connected === true) * 2 + Number(node?.commands?.includes("system.run"));
}

function summarizeDevice(node, fallbackName) {
  const supportsExec = Array.isArray(node?.commands) && node.commands.includes("system.run");
  return {
    name: typeof node?.displayName === "string" ? node.displayName : fallbackName,
    nodeId: typeof node?.nodeId === "string" ? node.nodeId : null,
    available: Boolean(node?.connected && supportsExec),
  };
}

function devicePolicyLine(label, device) {
  if (!device?.available || !device.nodeId) return `${label} node: unavailable.`;
  return `${label} node: ${device.name} (node id: ${device.nodeId}).`;
}
