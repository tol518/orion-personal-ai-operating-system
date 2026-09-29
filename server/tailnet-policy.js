// Tailnet access policy: what the tailnet enforces now, and what it should enforce instead.
//
// Tailscale's default policy lets every device reach every port on every other device. Orion can
// see that without any Tailscale credential, by reading the packet filter this machine's own
// tailscaled enforces. It also knows enough of the topology — which machine is the Mini, which are
// OpenClaw nodes, which are the user's own devices — to write the least-privilege replacement.
//
// It stops there. Applying a policy takes a key that can rewrite access for every device on the
// tailnet, including devices Orion has nothing to do with. The user pastes the policy into the
// admin console instead, where the tests embedded in it make Tailscale refuse it if it would cut
// off a path Orion needs.
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findTailscaleBinary, matchPeer, REMOTE_SERVICES } from "./remote-access.js";

const execFileAsync = promisify(execFile);

/** A device that has not been seen for this long is left out of a generated policy. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const MOBILE_OS = new Set(["ios", "android"]);
const MAX_REQUESTER_ADDRESSES = 8;

export class TailnetPolicyError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Runs a Tailscale CLI command that prints JSON. Null when there is no CLI on this machine. */
async function runTailscale(args) {
  const binary = await findTailscaleBinary();
  if (!binary) return null;
  const { stdout } = await execFileAsync(binary, args, { timeout: 8_000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// ---- Reading the enforced policy -------------------------------------------------------------

function parsePrefix(value) {
  const text = String(value ?? "").trim();
  if (text === "*") return { any: true };
  const [address, bitsText] = text.split("/");
  const version = net.isIP(address);
  if (!version) return null;
  const max = version === 6 ? 128 : 32;
  const bits = bitsText === undefined ? max : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return { address, bits, max, family: version === 6 ? "ipv6" : "ipv4" };
}

function prefixContains(prefix, address) {
  const parsed = parsePrefix(prefix);
  if (!parsed) return false;
  if (parsed.any) return true;
  const family = net.isIPv6(address) ? "ipv6" : "ipv4";
  if (family !== parsed.family) return false;
  const list = new net.BlockList();
  list.addSubnet(parsed.address, parsed.bits, parsed.family);
  return list.check(address, family);
}

/** A source wider than one address. Anything unreadable counts, since it cannot be shown to be one device. */
function isBroadSource(prefix) {
  const parsed = parsePrefix(prefix);
  if (!parsed || parsed.any) return true;
  return parsed.bits < parsed.max;
}

/**
 * Which sources can reach each port on this machine, according to the packet filter tailscaled
 * enforces — the compiled `PacketFilter` in `tailscale debug netmap`.
 *
 * Returns null when the filter or this machine's own addresses cannot be read. That is "could not
 * check", and it must never be presented as "restricted".
 */
export function exposureFromPacketFilter(netmap, ports) {
  const matches = netmap?.PacketFilter;
  const self = (netmap?.SelfNode?.Addresses ?? [])
    .map((entry) => parsePrefix(entry))
    .filter((entry) => entry && !entry.any)
    .map((entry) => entry.address);
  if (!Array.isArray(matches) || self.length === 0) return null;

  return ports.map(({ port, label }) => {
    const sources = [];
    for (const match of matches) {
      const protocols = match?.IPProto;
      // An empty protocol list means Tailscale's default set, which includes TCP.
      if (Array.isArray(protocols) && protocols.length > 0 && !protocols.includes(6)) continue;
      const reachesPort = (match?.Dsts ?? []).some(
        (dst) =>
          dst?.Ports &&
          dst.Ports.First <= port &&
          port <= dst.Ports.Last &&
          self.some((address) => prefixContains(dst.Net, address)),
      );
      if (reachesPort) sources.push(...(match?.Srcs ?? []));
    }
    const reachableFrom = sources.some(isBroadSource) ? "tailnet" : sources.length > 0 ? "specific" : "none";
    return { port, label, reachableFrom };
  });
}

function listSentence(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Findings for the tailnet policy. `exposure` is the result of exposureFromPacketFilter: null
 * means the check failed and says so, rather than going quiet.
 */
export function tailnetFindings(exposure, remediation = null) {
  if (exposure === null || exposure === undefined) {
    return [
      {
        id: "tailnet-unchecked",
        severity: "info",
        title: "Orion could not check your tailnet's access policy",
        detail:
          "Reading the rules this Mac mini's Tailscale enforces did not succeed, so Orion cannot say " +
          "which devices on your tailnet can reach it. This is an unverified blind spot, not a clean result.",
        target: null,
        remediation: null,
      },
    ];
  }
  const open = exposure.filter((entry) => entry.reachableFrom === "tailnet");
  if (open.length > 0) {
    return [
      {
        id: "tailnet-open",
        severity: "warning",
        title: "Every device on your tailnet can reach this Mac mini",
        detail:
          `Your tailnet's access policy lets any device on it — including ones added later — reach ` +
          `${listSentence(open.map((entry) => `${entry.label} (port ${entry.port})`))}. The policy is ` +
          `tailnet-wide, so your other machines are very likely open the same way.`,
        target: null,
        remediation,
      },
    ];
  }
  return [
    {
      id: "tailnet-restricted",
      severity: "ok",
      title: "Only named devices can reach this Mac mini on your tailnet",
      detail: "Your tailnet's access policy allows specific devices, not the whole tailnet, to reach Orion's services here.",
      target: null,
      remediation: null,
    },
  ];
}

// ---- Proposing a policy ----------------------------------------------------------------------

function toDevice(peer, isSelf) {
  const addresses = (peer?.TailscaleIPs ?? []).filter((ip) => net.isIP(ip));
  const dnsName = String(peer?.DNSName ?? "").replace(/\.$/, "");
  const lastSeen = Date.parse(peer?.LastSeen ?? "");
  return {
    name: dnsName.split(".")[0] || String(peer?.HostName ?? ""),
    dnsName,
    os: String(peer?.OS ?? "").toLowerCase(),
    v4: addresses.find((ip) => net.isIPv4(ip)) ?? null,
    v6: addresses.find((ip) => net.isIPv6(ip)) ?? null,
    tags: Array.isArray(peer?.Tags) ? peer.Tags : [],
    userId: peer?.UserID ?? null,
    online: isSelf || peer?.Online === true,
    // Tailscale reports the zero time (year 1) for devices that are online now.
    lastSeen: Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : null,
    isSelf,
  };
}

function platformOf(device, hinted) {
  const value = String(hinted || device.os || "").toLowerCase();
  if (value === "darwin" || value === "macos") return "macos";
  if (value === "windows") return "windows";
  if (value === "linux") return "linux";
  return value;
}

/** Ports a user opens a native remote-desktop client against, for a platform. */
function remoteDesktopPorts(platform) {
  return REMOTE_SERVICES.filter((service) => service.scheme && service.platforms.includes(platform)).map(
    (service) => service.port,
  );
}

function allocateAliases(devices) {
  const used = new Set();
  const aliases = new Map();
  for (const device of devices) {
    let base = device.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!base) base = "device";
    if (/^[0-9]/.test(base)) base = `d-${base}`;
    let alias = base;
    for (let n = 2; used.has(alias) || used.has(`${alias}-v6`); n += 1) alias = `${base}-${n}`;
    used.add(alias);
    used.add(`${alias}-v6`);
    aliases.set(device, alias);
  }
  return aliases;
}

function describeDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Writes a least-privilege tailnet policy for the devices this Mini can see.
 *
 * Roles: the Mini; servers (OpenClaw nodes and configured machines); clients (the user's own,
 * untagged, recently seen devices). Clients reach Orion and remote desktop, phones reach Orion
 * only, nodes reach the gateway, and the Mini reaches remote-desktop ports to check they answer
 * before it launches a session. Everything else is refused.
 *
 * The device the request came from is always kept as a client, even if it is also a node, so a
 * generated policy cannot lock out the machine it was generated from. The embedded tests assert
 * every path above, so Tailscale refuses the policy on save if any would be blocked.
 */
export function generateTailnetPolicy({
  status,
  nodes = [],
  machines = [],
  orionPort,
  gatewayPort,
  requesterAddresses = [],
  now = Date.now(),
}) {
  if (!status?.Self) throw new TailnetPolicyError("Could not read this Mac mini's tailnet status", 503);

  const self = toDevice(status.Self, true);
  const peers = Object.values(status.Peer ?? {}).map((peer) => toDevice(peer, false));
  const requested = new Set(
    (Array.isArray(requesterAddresses) ? requesterAddresses : [])
      .slice(0, MAX_REQUESTER_ADDRESSES)
      .map((value) => String(value ?? "").trim())
      .filter((value) => net.isIP(value)),
  );
  const requester = peers.find((device) => requested.has(device.v4) || requested.has(device.v6)) ?? null;

  // Servers: OpenClaw nodes the gateway knows, and machines configured by address.
  const servers = new Map();
  const peerNames = peers.map((device) => ({ shortName: device.name, dnsName: device.dnsName }));
  for (const node of nodes) {
    const dnsName = matchPeer(peerNames, node);
    const device = peers.find((candidate) => candidate.dnsName === dnsName);
    if (!device) continue;
    const entry = servers.get(device) ?? { platform: null, isNode: false };
    servers.set(device, { platform: entry.platform ?? platformOf(device, node.platform), isNode: true });
  }
  for (const machine of machines) {
    const host = String(machine?.host ?? "").toLowerCase();
    const device = peers.find(
      (candidate) => [candidate.dnsName, candidate.name, candidate.v4, candidate.v6].includes(host),
    );
    if (!device) continue;
    const entry = servers.get(device) ?? { platform: null, isNode: false };
    servers.set(device, { platform: entry.platform ?? platformOf(device, machine.platform), isNode: entry.isNode });
  }

  const excluded = [];
  const clients = [];
  for (const device of peers) {
    const recent = device.online || (device.lastSeen !== null && now - device.lastSeen <= RECENT_MS);
    const own = device.userId !== null && device.userId === self.userId && device.tags.length === 0;
    const isServer = servers.has(device);
    if (device === requester || (own && recent && !isServer)) {
      clients.push(device);
    } else if (!isServer) {
      const reason = device.tags.length > 0
        ? `tagged ${device.tags.join(", ")}`
        : !own
          ? "belongs to another user"
          : device.lastSeen !== null
            ? `offline since ${describeDate(device.lastSeen)}`
            : "not seen recently";
      excluded.push({ name: device.name, reason });
    }
  }
  if (clients.length === 0) {
    throw new TailnetPolicyError(
      "Orion found none of your own devices on the tailnet, so any policy it wrote would lock you out.",
    );
  }

  const referenced = [self, ...clients, ...[...servers.keys()].filter((device) => !clients.includes(device))];
  const aliases = allocateAliases(referenced);
  // Addresses carry their family explicitly. Inferring it from an alias's "-v6" suffix would
  // misread a device that happens to be named that way.
  const addressesOf = (device) => [
    ...(device.v4 ? [{ alias: aliases.get(device), family: 4 }] : []),
    ...(device.v6 ? [{ alias: `${aliases.get(device)}-v6`, family: 6 }] : []),
  ];
  const dstFor = (device, ports) => addressesOf(device).map((address) => ({ ...address, ports }));

  const rules = [];
  const serverList = [...servers.entries()];
  for (const client of clients) {
    const mobile = MOBILE_OS.has(client.os);
    const dst = dstFor(self, mobile ? [orionPort] : [orionPort, 5900]);
    if (!mobile) {
      for (const [server, { platform }] of serverList) {
        if (server === client) continue;
        const ports = remoteDesktopPorts(platform);
        if (ports.length) dst.push(...dstFor(server, ports));
      }
    }
    const role = client === requester ? "the device you generated this from" : "your device";
    rules.push({
      comment: mobile
        ? `${client.name} (${client.os}, ${role}): Orion only.`
        : `${client.name} (${client.os}, ${role}): Orion, Screen Sharing on the Mini, and remote desktop.`,
      src: addressesOf(client),
      dst,
    });
  }
  for (const [server, { isNode }] of serverList) {
    if (!isNode) continue;
    rules.push({
      comment: `${server.name}: an OpenClaw node reaching the gateway. Without this it goes offline.`,
      src: addressesOf(server),
      dst: dstFor(self, [gatewayPort]),
    });
  }
  const probeTargets = serverList.filter(([, { platform }]) => remoteDesktopPorts(platform).length > 0);
  if (probeTargets.length > 0) {
    rules.push({
      comment: "The Mini checking remote desktop answers before Orion will launch a session.",
      src: addressesOf(self),
      dst: probeTargets.flatMap(([server, { platform }]) => dstFor(server, remoteDesktopPorts(platform))),
    });
  }

  // Every permitted (src alias, dst alias, port), so deny tests can never contradict the rules.
  const allowed = new Set();
  for (const rule of rules) {
    for (const src of rule.src) {
      for (const dst of rule.dst) {
        for (const port of dst.ports) allowed.add(`${src.alias}>${dst.alias}:${port}`);
      }
    }
  }
  const tests = [];
  for (const rule of rules) {
    for (const src of rule.src) {
      const accept = rule.dst
        .filter((dst) => dst.family === src.family)
        .flatMap((dst) => dst.ports.map((port) => `${dst.alias}:${port}`));
      if (accept.length) tests.push({ src: src.alias, accept });
    }
  }
  const deny = new Map();
  const refuse = (device, target, port) => {
    const src = aliases.get(device);
    const dst = `${aliases.get(target)}:${port}`;
    if (!device.v4 || !target.v4 || allowed.has(`${src}>${dst}`)) return;
    deny.set(src, [...(deny.get(src) ?? []), dst]);
  };
  for (const client of clients) {
    refuse(client, self, gatewayPort);
    if (MOBILE_OS.has(client.os)) {
      for (const [server, { platform }] of serverList) {
        for (const port of remoteDesktopPorts(platform)) refuse(client, server, port);
      }
    }
  }
  for (const [server] of serverList) {
    if (clients.includes(server)) continue;
    refuse(server, self, orionPort);
    refuse(server, self, 5900);
  }
  for (const [src, list] of deny) tests.push({ src, deny: [...new Set(list)] });

  const hosts = [];
  for (const device of referenced) {
    if (device.v4) hosts.push([aliases.get(device), device.v4]);
    if (device.v6) hosts.push([`${aliases.get(device)}-v6`, device.v6]);
  }

  const lines = [
    `// Orion tailnet policy, generated ${new Date(now).toISOString()} from the devices this Mac mini can see.`,
    "//",
    "// Replaces allow-all. Anything not listed is refused, including devices you add later.",
    "// Paste it into the Tailscale admin console under Access controls. If Tailscale rejects it,",
    "// one of the tests at the bottom failed and nothing has changed.",
    "//",
    "// Each device is listed by both of its addresses: a host alias is a single IP, and MagicDNS",
    "// hands out both, so a rule naming one would block the device whenever the other was used.",
  ];
  if (!requester) {
    lines.push(
      "//",
      "// Orion could not tell which device this was generated from. Before saving, check that the",
      "// device you use for Orion appears below as a client.",
    );
  }
  if (excluded.length) {
    lines.push("//", "// Not included — these lose all access when this policy is saved:");
    for (const entry of excluded) lines.push(`//   ${entry.name}: ${entry.reason}`);
  }
  const block = (items) => items.join(",\n");
  lines.push(
    "{",
    '  "hosts": {',
    block(hosts.map(([alias, ip]) => `    ${JSON.stringify(alias)}: ${JSON.stringify(ip)}`)),
    "  },",
    "",
    '  "acls": [',
    block(
      rules.map((rule) => {
        const src = rule.src.map((address) => address.alias);
        const dst = rule.dst.map((address) => `${address.alias}:${address.ports.join(",")}`);
        return `    // ${rule.comment}\n    {"action": "accept", "src": ${JSON.stringify(src)}, "dst": ${JSON.stringify(dst)}}`;
      }),
    ),
    "  ],",
    "",
    "  // Tailscale refuses to save the policy if any of these fail.",
    '  "tests": [',
    block(tests.map((test) => `    ${JSON.stringify(test)}`)),
    "  ]",
    "}",
    "",
  );

  return {
    policy: lines.join("\n"),
    requesterIdentified: Boolean(requester),
    clients: clients.map((device) => device.name),
    excluded,
    generatedAt: new Date(now).toISOString(),
  };
}

/** Reads the enforced policy and writes proposals, using this machine's Tailscale CLI. */
export class TailnetInspector {
  constructor({ orionPort, gatewayPort, run = runTailscale, now = () => Date.now() } = {}) {
    this.orionPort = orionPort;
    this.gatewayPort = gatewayPort;
    this.run = run;
    this.now = now;
  }

  sensitivePorts() {
    const ports = [
      { port: this.orionPort, label: "Orion" },
      { port: this.gatewayPort, label: "the OpenClaw gateway" },
      { port: 5900, label: "Screen Sharing" },
      { port: 3283, label: "Apple Remote Desktop" },
    ];
    return ports.filter((entry, index) => ports.findIndex((other) => other.port === entry.port) === index);
  }

  /** Null when the filter cannot be read, which the findings report as "could not check". */
  async exposure() {
    try {
      return exposureFromPacketFilter(await this.run(["debug", "netmap"]), this.sensitivePorts());
    } catch {
      return null;
    }
  }

  async policy({ nodes, machines, requesterAddresses }) {
    let status = null;
    try {
      status = await this.run(["status", "--json"]);
    } catch {
      status = null;
    }
    return generateTailnetPolicy({
      status,
      nodes,
      machines,
      orionPort: this.orionPort,
      gatewayPort: this.gatewayPort,
      requesterAddresses,
      now: this.now(),
    });
  }
}
