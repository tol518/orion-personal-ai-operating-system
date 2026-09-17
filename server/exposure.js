// Bind-address inspection for remote-desktop services.
//
// Reachability alone is the wrong question. A service that answers on the tailnet is fine; a
// service that answers on the tailnet *because it answers on every interface* is also reachable
// from whatever office or café network the machine is on. macOS Screen Sharing and Windows RDP
// both do the latter by default, and nothing in the OS says so.
//
// This module asks each machine which interfaces a port is bound to and classifies the answer.
// It changes nothing: closing a port is the OS's job, and applying a firewall rule is a device
// action that needs explicit consent and an audit trail before Orion does it. What this does is
// make the state visible, with the exact fix beside it, so it cannot sit unnoticed for weeks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Tailscale's address ranges. A bind confined to these is reachable only from the tailnet. */
const TAILNET_V4 = { base: ipv4ToInt("100.64.0.0"), mask: 0xffc00000 }; // 100.64.0.0/10
const TAILNET_V6_PREFIX = "fd7a:115c:a1e0:";
const ALL_INTERFACES = new Set(["*", "0.0.0.0", "::", "[::]"]);

// ---- Parsers ---------------------------------------------------------------

/**
 * Parses `netstat -an` LISTEN lines into { port, address } pairs.
 *
 * Handles both dialects: macOS/BSD writes `*.5900` and `127.0.0.1.4820` (dot before the port),
 * Linux writes `0.0.0.0:5900` and `:::5900` (colon before the port). Anything that is not a TCP
 * LISTEN row is ignored.
 */
export function parseNetstatBinds(text) {
  const binds = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^(tcp\S*)\s+\d+\s+\d+\s+(\S+)\s+\S+\s+LISTEN/i.exec(line.trim());
    if (!match) continue;
    const local = match[2];
    const split = splitLocalAddress(local);
    if (split) binds.push(split);
  }
  return binds;
}

function splitLocalAddress(local) {
  // Linux: everything up to the last colon is the address.
  let m = /^(.*):(\d+)$/.exec(local);
  if (m) return { address: normalizeAddress(m[1]), port: Number(m[2]) };
  // macOS/BSD: everything up to the last dot is the address.
  m = /^(.*)\.(\d+)$/.exec(local);
  if (m) return { address: normalizeAddress(m[1]), port: Number(m[2]) };
  return null;
}

function normalizeAddress(address) {
  // Strip a scope id such as fe80::1%lo0 -> fe80::1, and bracket forms.
  return String(address).replace(/%.*$/, "").replace(/^\[|\]$/g, "") || "*";
}

/**
 * Parses the JSON from
 *   Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort | ConvertTo-Json
 * PowerShell emits a bare object rather than an array when there is exactly one row.
 */
export function parseWindowsBinds(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? "").trim() || "[]");
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      address: normalizeAddress(row.LocalAddress ?? row.localAddress ?? "*"),
      port: Number(row.LocalPort ?? row.localPort),
    }))
    .filter((row) => Number.isInteger(row.port));
}

// ---- Classification ----------------------------------------------------------

/**
 * Classifies how a port is bound from every address it listens on.
 *
 *   all-interfaces  reachable from every network the machine is on
 *   specific        bound to a particular non-tailnet address, e.g. a LAN IP
 *   tailnet-only    bound only to Tailscale addresses
 *   loopback-only   bound only to 127.x / ::1
 *   not-listening   no listener on this port at all
 */
export function classifyBind(addresses) {
  const list = (addresses ?? []).map((a) => normalizeAddress(a));
  if (list.length === 0) return "not-listening";
  if (list.some((a) => ALL_INTERFACES.has(a))) return "all-interfaces";
  if (list.every(isLoopback)) return "loopback-only";
  if (list.every((a) => isLoopback(a) || isTailnet(a))) return "tailnet-only";
  return "specific";
}

/** Who can reach it, in one word the UI can act on. */
export function scopeFor(bind) {
  switch (bind) {
    case "all-interfaces":
    case "specific":
      return "lan";
    case "tailnet-only":
      return "private";
    case "loopback-only":
      return "local";
    default:
      return null;
  }
}

export function isLoopback(address) {
  return address === "::1" || /^127\./.test(address) || address === "localhost";
}

export function isTailnet(address) {
  if (address.startsWith(TAILNET_V6_PREFIX)) return true;
  const n = ipv4ToInt(address);
  return n !== null && (n & TAILNET_V4.mask) === TAILNET_V4.base;
}

function ipv4ToInt(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// ---- Remediation hints -------------------------------------------------------

/**
 * The exact fix for a LAN-exposed service, or an honest note when there is no clean one.
 * Only returned when the scope is "lan"; a private or local bind needs no advice.
 */
export function fixFor({ platform, kind, bind }) {
  if (scopeFor(bind) !== "lan") return null;
  if (platform === "windows" && kind === "remote-desktop") {
    return {
      summary: "Scope the Windows firewall's Remote Desktop rules to Tailscale's address ranges.",
      command:
        "Get-NetFirewallRule -DisplayGroup \"Remote Desktop\" | Where-Object Enabled -eq $True | " +
        "Set-NetFirewallRule -RemoteAddress @('100.64.0.0/10','fd7a:115c:a1e0::/48')",
      shell: "powershell (elevated)",
      rollback: "Get-NetFirewallRule -DisplayGroup \"Remote Desktop\" | Set-NetFirewallRule -RemoteAddress Any",
    };
  }
  if (platform === "macos" && kind === "screen-sharing") {
    return {
      summary:
        "macOS Screen Sharing has no bind setting. Restrict port 5900 with a pf rule, or accept " +
        "LAN reachability — it still requires an account password.",
      command: null,
      shell: null,
      rollback: null,
    };
  }
  return {
    summary: "This service answers on every interface. Restrict it to the tailnet with a host firewall rule.",
    command: null,
    shell: null,
    rollback: null,
  };
}

/** Builds the `exposure` block attached to each remote-access service entry. */
export function describeExposure({ platform, kind, port, binds }) {
  if (binds === null || binds === undefined) {
    return { bind: "unknown", scope: null, fix: null };
  }
  const addresses = binds.filter((b) => b.port === port).map((b) => b.address);
  const bind = classifyBind(addresses);
  return { bind, scope: scopeFor(bind), fix: fixFor({ platform, kind, bind }) };
}

// ---- Collectors --------------------------------------------------------------

/** Listening TCP binds on the host running the BFF — the Mini itself. netstat needs no root. */
export async function inspectLocalBinds() {
  const { stdout } = await execFileAsync("/usr/sbin/netstat", ["-an", "-p", "tcp"], { timeout: 8_000 });
  return parseNetstatBinds(stdout);
}

/**
 * Listening TCP binds on a paired OpenClaw node, via the same system.run path the BFF already
 * uses for node work. Read-only: netstat on Unix, Get-NetTCPConnection on Windows, neither of
 * which needs elevation.
 */
export function createNodeBindInspector({ gateway, timeoutMs = 15_000 }) {
  return async function inspectNodeBinds(node) {
    const nodeId = node?.id ?? node?.nodeId;
    if (!nodeId || !(node.capabilities ?? []).includes("exec")) return null;
    const isWindows = node.platform === "windows";
    const command = isWindows
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(
            "Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress",
            "utf16le",
          ).toString("base64"),
        ]
      : ["/usr/sbin/netstat", "-an", "-p", "tcp"];
    const result = await gateway.request("node.invoke", {
      nodeId,
      command: "system.run",
      params: { command, timeoutMs, suppressNotifyOnExit: true },
      idempotencyKey: `exposure-${nodeId}-${Date.now()}`,
    });
    const run = result?.payload ?? result;
    if (!run?.success) return null;
    return isWindows ? parseWindowsBinds(run.stdout) : parseNetstatBinds(run.stdout);
  };
}
