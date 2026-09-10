// Remote-access discovery for the native client.
//
// Orion does not carry pixels. macOS Screen Sharing and Windows RDP already do that far better
// than a hand-written transport could: hardware video decode, audio, clipboard sync, file
// drag-and-drop, multiple displays. This module's whole job is to answer "which of those is
// actually reachable on each node, and at what address" so the app can hand off to the native
// client — and to record that a session was opened.
//
// Deliberately not implemented here: any framebuffer, input injection, or session proxying. See
// the plan's rule against a custom remote-desktop transport.
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Services worth offering, and the platforms they belong to. */
export const REMOTE_SERVICES = [
  {
    kind: "screen-sharing",
    label: "Screen Sharing",
    port: 5900,
    platforms: ["macos"],
    // The client builds its own URL from this scheme; the server never hands over a URL string.
    scheme: "vnc",
  },
  {
    kind: "remote-desktop",
    label: "Remote Desktop",
    port: 3389,
    platforms: ["windows"],
    scheme: "rdp",
  },
  {
    kind: "apple-remote-desktop",
    label: "Apple Remote Desktop",
    port: 3283,
    platforms: ["macos"],
    scheme: null, // Management channel; presence is informational, not something to launch.
  },
];

const DEFAULT_PROBE_TIMEOUT_MS = 1_200;
const DEFAULT_CACHE_TTL_MS = 15_000;
const MAX_AUDIT_EVENTS = 200;
const TAILSCALE_BINARIES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
// A tailnet DNS name, an IP, or a plain hostname. Anything else is not probed: the address ends
// up in a URL the client opens, so it must not be able to carry a path, port, or credentials.
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export class RemoteAccessDirectory {
  /**
   * @param {object} options
   * @param {string} [options.hostOverrides] `nodeId=host,nodeId=host` from configuration.
   * @param {Function} [options.probe] TCP reachability check, injected for tests.
   * @param {Function} [options.listPeers] Tailnet peer lookup, injected for tests.
   */
  constructor({
    hostOverrides = "",
    probe,
    listPeers,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.overrides = parseHostOverrides(hostOverrides);
    this.probeReachable = probe ?? probeTcpPort;
    this.listPeers = listPeers ?? listTailnetPeers;
    this.probeTimeoutMs = probeTimeoutMs;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
    this.auditEvents = [];
  }

  /**
   * Projects each node with the remote-access services reachable on it.
   *
   * Address resolution, in order: an explicit override for the node id, then a tailnet peer whose
   * name matches the node. A node with no resolvable address reports `host: null` and no services
   * rather than guessing — a wrong address would send the user's viewer at someone else's machine.
   */
  async describe(nodes = []) {
    const peers = await this.safePeers();
    return Promise.all(
      (Array.isArray(nodes) ? nodes : []).map((node) => this.describeNode(node, peers)),
    );
  }

  async describeNode(node, peers) {
    const host = this.resolveHost(node, peers);
    if (!host) {
      return {
        nodeId: node.id ?? node.nodeId ?? "",
        host: null,
        hostSource: "unresolved",
        services: [],
        // Says what to do about it, because an unresolved node is a configuration gap.
        hint: "No address for this node. Set ORION_REMOTE_ACCESS_HOSTS on the Mini to map it.",
      };
    }
    const platform = node.platform ?? "unknown";
    const candidates = REMOTE_SERVICES.filter(
      (service) => platform === "unknown" || service.platforms.includes(platform),
    );
    const services = await Promise.all(
      candidates.map(async (service) => ({
        kind: service.kind,
        label: service.label,
        port: service.port,
        scheme: service.scheme,
        launchable: service.scheme !== null,
        reachable: await this.cachedProbe(host, service.port),
      })),
    );
    return {
      nodeId: node.id ?? node.nodeId ?? "",
      host,
      hostSource: this.overrides.has(node.id ?? node.nodeId) ? "configured" : "tailnet",
      services,
    };
  }

  resolveHost(node, peers) {
    const nodeId = node.id ?? node.nodeId ?? "";
    const override = this.overrides.get(nodeId);
    if (override) return override;
    return matchPeer(peers, node);
  }

  /** Probes are cached briefly: the Nodes screen refreshes often and a port does not flap. */
  async cachedProbe(host, port) {
    const key = `${host}:${port}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.reachable;
    let reachable = false;
    try {
      reachable = await this.probeReachable(host, port, this.probeTimeoutMs);
    } catch {
      reachable = false;
    }
    this.cache.set(key, { reachable, expiresAt: this.now() + this.cacheTtlMs });
    return reachable;
  }

  async safePeers() {
    try {
      return await this.listPeers();
    } catch {
      // No Tailscale CLI, or it failed. Configured overrides still work.
      return [];
    }
  }

  /**
   * Records that a client opened a remote session. This is the audit trail the plan requires
   * before any high-risk device action: actor, node, service, and time — never a credential.
   */
  recordSession({ nodeId, kind, clientId }) {
    const event = {
      at: new Date(this.now()).toISOString(),
      action: "remote-session.open",
      nodeId: String(nodeId ?? ""),
      service: String(kind ?? ""),
      clientId: String(clientId ?? ""),
    };
    this.auditEvents.push(event);
    if (this.auditEvents.length > MAX_AUDIT_EVENTS) {
      this.auditEvents.splice(0, this.auditEvents.length - MAX_AUDIT_EVENTS);
    }
    return event;
  }

  audit() {
    return this.auditEvents.map((event) => ({ ...event }));
  }
}

/** Parses `nodeId=host,nodeId=host`, dropping any entry whose host is not a bare hostname. */
export function parseHostOverrides(raw) {
  const map = new Map();
  for (const entry of String(raw ?? "").split(",")) {
    const [nodeId, host] = entry.split("=").map((value) => (value ?? "").trim());
    if (!nodeId || !host) continue;
    if (!HOST_PATTERN.test(host)) continue;
    map.set(nodeId, host);
  }
  return map;
}

/**
 * Matches an OpenClaw node to a tailnet peer.
 *
 * Only an unambiguous match counts: exactly one peer whose short name equals the node's name or
 * id after normalization. A fuzzy or multiple match returns nothing, because connecting a screen
 * viewer to the wrong machine is worse than reporting no address at all.
 */
export function matchPeer(peers, node) {
  const candidates = [node?.name, node?.displayName, node?.id, node?.nodeId]
    .filter((value) => typeof value === "string" && value.trim())
    .map(normalizeName);
  if (candidates.length === 0) return null;
  const matches = (Array.isArray(peers) ? peers : []).filter((peer) =>
    candidates.includes(normalizeName(peer.shortName)),
  );
  const unique = [...new Set(matches.map((peer) => peer.dnsName))];
  return unique.length === 1 && HOST_PATTERN.test(unique[0]) ? unique[0] : null;
}

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Reads tailnet peers, including this host, as `{ shortName, dnsName }`. */
export async function listTailnetPeers() {
  const binary = await firstExistingBinary();
  if (!binary) return [];
  const { stdout } = await execFileAsync(binary, ["status", "--json"], { timeout: 5_000 });
  const status = JSON.parse(stdout);
  const entries = [status.Self, ...Object.values(status.Peer ?? {})].filter(Boolean);
  return entries
    .map((peer) => {
      const dnsName = String(peer.DNSName ?? "").replace(/\.$/, "");
      return { shortName: dnsName.split(".")[0] ?? "", dnsName };
    })
    .filter((peer) => peer.dnsName);
}

async function firstExistingBinary() {
  const { access } = await import("node:fs/promises");
  for (const candidate of TAILSCALE_BINARIES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Resolves true when a TCP connection to host:port completes inside the timeout. */
export function probeTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
