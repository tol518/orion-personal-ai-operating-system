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
import { describeExposure } from "./exposure.js";

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
/** Node id standing for the Mini itself, which may not appear in the gateway's node list. */
export const SELF_NODE_ID = "orion-mini";
const TAILSCALE_BINARIES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];
// A tailnet DNS name, an IP, or a plain hostname. Anything else is not probed: the address ends
// up in a URL the client opens, so it must not be able to carry a path, port, or credentials.
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

const PLATFORMS = new Set(["macos", "windows", "linux"]);

/**
 * Parses `Label|host|platform` entries separated by commas.
 *
 * Machines configured this way are listed whether or not the gateway knows about them. A machine
 * can be perfectly reachable for remote desktop while not being an OpenClaw execution node —
 * those are different relationships, and a Windows PC that reaches the gateway over its own
 * outbound channel has no route back for RDP unless it is on the private network too.
 */
export function parseMachines(raw) {
  const machines = [];
  const seen = new Set();
  for (const entry of String(raw ?? "").split(",")) {
    const parts = entry.split("|").map((value) => (value ?? "").trim());
    if (parts.length !== 3) continue;
    const [label, host, platform] = parts;
    if (!label || label.length > 40) continue;
    if (!HOST_PATTERN.test(host)) continue;
    if (!PLATFORMS.has(platform)) continue;
    const id = `machine:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
    if (!id.slice(8) || seen.has(id)) continue;
    seen.add(id);
    machines.push({ nodeId: id, label, host, platform });
  }
  return machines;
}

export class RemoteAccessDirectory {
  /**
   * @param {object} options
   * @param {string} [options.hostOverrides] `nodeId=host,nodeId=host` from configuration.
   * @param {Function} [options.probe] TCP reachability check, injected for tests.
   * @param {Function} [options.listPeers] Tailnet peer lookup, injected for tests.
   */
  constructor({
    hostOverrides = "",
    machines = "",
    probe,
    listPeers,
    // Bind inspection is optional. Without an inspector every service reports bind "unknown",
    // which is honest: reachability was checked, interface exposure was not.
    inspectLocalBinds = null,
    inspectNodeBinds = null,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.overrides = parseHostOverrides(hostOverrides);
    this.machines = parseMachines(machines);
    this.probeReachable = probe ?? probeTcpPort;
    this.listPeers = listPeers ?? listTailnetPeers;
    this.inspectLocalBinds = inspectLocalBinds;
    this.inspectNodeBinds = inspectNodeBinds;
    this.bindCache = new Map();
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
    const binds = await this.cachedBinds(
      `node:${node.id ?? node.nodeId}`,
      this.inspectNodeBinds ? () => this.inspectNodeBinds(node) : null,
    );
    const services = await Promise.all(
      candidates.map(async (service) => ({
        kind: service.kind,
        label: service.label,
        port: service.port,
        scheme: service.scheme,
        launchable: service.scheme !== null,
        reachable: await this.cachedProbe(host, service.port),
        exposure: describeExposure({ platform, kind: service.kind, port: service.port, binds }),
      })),
    );
    return {
      nodeId: node.id ?? node.nodeId ?? "",
      host,
      hostSource: this.overrides.has(node.id ?? node.nodeId) ? "configured" : "tailnet",
      services,
    };
  }

  /**
   * Describes the Mini itself.
   *
   * The Mini runs the gateway, and it is not necessarily registered as an OpenClaw execution
   * node — on a single-machine deployment `node.list` is empty. It is also the machine the user
   * most wants to reach, so it gets a first-class entry instead of waiting to appear in a list
   * it may never join.
   *
   * Reachability is probed on loopback, which answers "is Screen Sharing running here". The
   * address handed back is the tailnet name, because that is what the client has to dial; when
   * the Tailscale CLI is unavailable the client falls back to the address it is already
   * connected through.
   */
  async describeSelf() {
    const override = this.overrides.get(SELF_NODE_ID);
    let host = override ?? null;
    let hostSource = override ? "configured" : "unresolved";
    if (!host) {
      const peers = await this.safePeers();
      const own = peers.find((peer) => peer.isSelf);
      if (own?.dnsName && HOST_PATTERN.test(own.dnsName)) {
        host = own.dnsName;
        hostSource = "tailnet";
      }
    }
    const binds = await this.cachedBinds("self", this.inspectLocalBinds);
    const services = await Promise.all(
      REMOTE_SERVICES.filter((service) => service.platforms.includes("macos")).map(
        async (service) => ({
          kind: service.kind,
          label: service.label,
          port: service.port,
          scheme: service.scheme,
          launchable: service.scheme !== null,
          // Loopback: this is the host running the probe.
          reachable: await this.cachedProbe("127.0.0.1", service.port),
          exposure: describeExposure({ platform: "macos", kind: service.kind, port: service.port, binds }),
        }),
      ),
    );
    return {
      nodeId: SELF_NODE_ID,
      host,
      hostSource,
      services,
      ...(host
        ? {}
        : {
            hint: "Could not determine this Mini's own network name. The app will use the address you connected with.",
          }),
    };
  }

  /** Machines listed by configuration, each probed for the services its platform supports. */
  async describeMachines() {
    return Promise.all(
      this.machines.map(async (machine) => ({
        nodeId: machine.nodeId,
        label: machine.label,
        platform: machine.platform,
        host: machine.host,
        hostSource: "configured",
        services: await Promise.all(
          REMOTE_SERVICES.filter((service) => service.platforms.includes(machine.platform)).map(
            async (service) => ({
              kind: service.kind,
              label: service.label,
              port: service.port,
              scheme: service.scheme,
              launchable: service.scheme !== null,
              reachable: await this.cachedProbe(machine.host, service.port),
              // No agent runs on a configured machine, so its interfaces cannot be inspected.
              exposure: describeExposure({ platform: machine.platform, kind: service.kind, port: service.port, binds: null }),
            }),
          ),
        ),
      })),
    );
  }

  findMachine(nodeId) {
    return this.machines.find((machine) => machine.nodeId === nodeId) ?? null;
  }

  resolveHost(node, peers) {
    const nodeId = node.id ?? node.nodeId ?? "";
    const override = this.overrides.get(nodeId);
    if (override) return override;
    return matchPeer(peers, node);
  }

  /**
   * Listening binds for a target, cached like probes. A failed or unavailable inspection yields
   * null, which surfaces as bind "unknown" rather than as an error or a false "private".
   */
  async cachedBinds(key, inspect) {
    if (typeof inspect !== "function") return null;
    const cached = this.bindCache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.binds;
    let binds = null;
    try {
      binds = await inspect();
    } catch {
      binds = null;
    }
    this.bindCache.set(key, { binds, expiresAt: this.now() + this.cacheTtlMs });
    return binds;
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
  const selfName = String(status.Self?.DNSName ?? "").replace(/\.$/, "");
  return entries
    .map((peer) => {
      const dnsName = String(peer.DNSName ?? "").replace(/\.$/, "");
      return {
        shortName: dnsName.split(".")[0] ?? "",
        dnsName,
        isSelf: dnsName !== "" && dnsName === selfName,
      };
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
