import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  exposureFromPacketFilter,
  generateTailnetPolicy,
  TailnetInspector,
  TailnetPolicyError,
  tailnetFindings,
} from "./tailnet-policy.js";
import { buildFindings } from "./security-review.js";

const PORTS = [
  { port: 443, label: "Orion" },
  { port: 18789, label: "the OpenClaw gateway" },
  { port: 5900, label: "Screen Sharing" },
];
const SELF_ADDRESSES = ["100.64.0.1/32", "fd7a:115c:a1e0::1/128"];

// The shape tailscaled reports for Tailscale's default allow-all policy, taken from a real netmap.
const ALLOW_ALL = {
  SelfNode: { Addresses: SELF_ADDRESSES },
  PacketFilter: [
    {
      IPProto: [6, 17, 1, 58],
      Srcs: ["100.64.0.0/11", "100.96.0.0/12", "100.120.0.0/13", "fd7a:115c:a1e0::/48"],
      Dsts: [
        { Net: "0.0.0.0/0", Ports: { First: 0, Last: 65535 } },
        { Net: "::/0", Ports: { First: 0, Last: 65535 } },
      ],
      Caps: [],
    },
  ],
};

function netmapWith(matches) {
  return { SelfNode: { Addresses: SELF_ADDRESSES }, PacketFilter: matches };
}

const byPort = (exposure) => Object.fromEntries(exposure.map((entry) => [entry.port, entry.reachableFrom]));

test("Tailscale's default allow-all reads as open to the whole tailnet", () => {
  assert.deepEqual(byPort(exposureFromPacketFilter(ALLOW_ALL, PORTS)), {
    443: "tailnet",
    18789: "tailnet",
    5900: "tailnet",
  });
});

test("a filter naming single devices reads as specific, and an unlisted port as none", () => {
  const exposure = exposureFromPacketFilter(
    netmapWith([
      {
        IPProto: [6],
        Srcs: ["100.64.0.2/32", "fd7a:115c:a1e0::2/128"],
        Dsts: [{ Net: "100.64.0.1/32", Ports: { First: 443, Last: 443 } }],
      },
    ]),
    PORTS,
  );
  assert.deepEqual(byPort(exposure), { 443: "specific", 18789: "none", 5900: "none" });
});

test("a UDP-only rule does not open a TCP port", () => {
  const exposure = exposureFromPacketFilter(
    netmapWith([{ IPProto: [17], Srcs: ["100.64.0.0/10"], Dsts: [{ Net: "0.0.0.0/0", Ports: { First: 0, Last: 65535 } }] }]),
    PORTS,
  );
  assert.deepEqual(byPort(exposure), { 443: "none", 18789: "none", 5900: "none" });
});

test("a rule for another machine's address does not count against this one", () => {
  const exposure = exposureFromPacketFilter(
    netmapWith([{ Srcs: ["100.64.0.0/10"], Dsts: [{ Net: "100.64.0.9/32", Ports: { First: 0, Last: 65535 } }] }]),
    PORTS,
  );
  assert.deepEqual(byPort(exposure), { 443: "none", 18789: "none", 5900: "none" });
});

test("an unreadable filter is null — could not check, never restricted", () => {
  assert.equal(exposureFromPacketFilter(null, PORTS), null);
  assert.equal(exposureFromPacketFilter({ SelfNode: { Addresses: SELF_ADDRESSES } }, PORTS), null);
  assert.equal(exposureFromPacketFilter({ PacketFilter: [] }, PORTS), null);
});

test("a source that cannot be parsed counts as open, since it cannot be shown to be one device", () => {
  const exposure = exposureFromPacketFilter(
    netmapWith([{ Srcs: ["not-an-address"], Dsts: [{ Net: "100.64.0.1/32", Ports: { First: 443, Last: 443 } }] }]),
    PORTS,
  );
  assert.equal(byPort(exposure)[443], "tailnet");
});

test("findings: open is a warning with the manual policy fix, unreadable is a blind spot, restricted is ok", () => {
  const remediation = { id: "restrict-tailnet-policy", automatic: false };
  const [open] = tailnetFindings(exposureFromPacketFilter(ALLOW_ALL, PORTS), remediation);
  assert.equal(open.id, "tailnet-open");
  assert.equal(open.severity, "warning");
  assert.match(open.detail, /the OpenClaw gateway \(port 18789\)/);
  assert.equal(open.remediation, remediation);

  const [unchecked] = tailnetFindings(null);
  assert.equal(unchecked.id, "tailnet-unchecked");
  assert.notEqual(unchecked.severity, "ok");

  const [restricted] = tailnetFindings([{ port: 443, label: "Orion", reachableFrom: "specific" }]);
  assert.equal(restricted.id, "tailnet-restricted");
  assert.equal(restricted.severity, "ok");
});

test("the checklist reports the tailnet only when an inspector ran, and never offers to apply the policy", () => {
  const ids = (input) => buildFindings({ apiAuthenticated: true, ...input }).map((finding) => finding.id);
  assert.equal(ids({}).some((id) => id.startsWith("tailnet-")), false);
  assert.ok(ids({ tailnetExposure: null }).includes("tailnet-unchecked"));

  const open = buildFindings({ apiAuthenticated: true, tailnetExposure: exposureFromPacketFilter(ALLOW_ALL, PORTS) })
    .find((finding) => finding.id === "tailnet-open");
  assert.equal(open.remediation.id, "restrict-tailnet-policy");
  assert.equal(open.remediation.automatic, false);
  assert.equal(open.remediation.command, null);
});

// ---- Generated policies ------------------------------------------------------------------------

const USER = 111;
const NOW = Date.parse("2026-09-29T00:00:00Z");
function device(name, os, index, extra = {}) {
  return {
    DNSName: `${name}.tail0000.ts.net.`,
    HostName: name,
    OS: os,
    TailscaleIPs: [`100.64.0.${index}`, `fd7a:115c:a1e0::${index}`],
    UserID: USER,
    Online: true,
    LastSeen: "0001-01-01T00:00:00Z",
    Tags: null,
    ...extra,
  };
}
function tailnet(peers) {
  return { Self: device("mac-mini", "macOS", 1), Peer: Object.fromEntries(peers.map((peer, i) => [`p${i}`, peer])) };
}
const HOME = tailnet([
  device("macbook", "macOS", 2),
  device("iphone", "iOS", 3),
  device("windows-pc", "windows", 4),
  device("old-macbook", "macOS", 5, { Online: false, LastSeen: "2026-08-01T00:00:00Z" }),
]);
const WINDOWS_NODE = [{ id: "windows-pc", name: "windows-pc", platform: "windows" }];

function generate(overrides = {}) {
  return generateTailnetPolicy({
    status: HOME,
    nodes: WINDOWS_NODE,
    orionPort: 443,
    gatewayPort: 18789,
    requesterAddresses: ["100.64.0.2"],
    now: NOW,
    ...overrides,
  });
}

/** Strips HuJSON comments; the generator emits no trailing commas, so what remains is strict JSON. */
function parsePolicy(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[(i += 1)];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/** What Tailscale checks on save: every test agrees with the rules, and every alias is defined. */
function evaluate(policy) {
  const allowed = new Set();
  const problems = [];
  const known = (alias) => {
    if (!(alias in policy.hosts)) problems.push(`undefined alias ${alias}`);
  };
  for (const rule of policy.acls) {
    for (const src of rule.src) {
      known(src);
      for (const dst of rule.dst) {
        const [alias, ports] = dst.split(":");
        known(alias);
        for (const port of ports.split(",")) allowed.add(`${src}>${alias}:${port}`);
      }
    }
  }
  for (const entry of policy.tests) {
    known(entry.src);
    for (const [kind, list] of [["accept", entry.accept ?? []], ["deny", entry.deny ?? []]]) {
      for (const dst of list) {
        const alias = dst.split(":")[0];
        known(alias);
        if (kind === "accept" && net.isIP(policy.hosts[entry.src]) !== net.isIP(policy.hosts[alias])) {
          problems.push(`accept test mixes address families: ${entry.src} -> ${dst}`);
        }
        const permitted = allowed.has(`${entry.src}>${dst}`);
        if (kind === "accept" ? !permitted : permitted) problems.push(`${kind} fails: ${entry.src} -> ${dst}`);
      }
    }
  }
  return { allowed, problems };
}

test("every test in a generated policy agrees with its rules, so Tailscale will accept it", () => {
  const policy = parsePolicy(generate().policy);
  const { problems } = evaluate(policy);
  assert.deepEqual(problems, []);
  assert.ok(policy.tests.some((entry) => entry.deny), "a policy with no deny tests proves nothing is closed");
});

test("roles: laptops reach Orion and remote desktop, phones Orion only, nodes the gateway, the Mini its probes", () => {
  const { allowed } = evaluate(parsePolicy(generate().policy));
  for (const path of [
    "macbook>mac-mini:443",
    "macbook>mac-mini:5900",
    "macbook>windows-pc:3389",
    "macbook-v6>windows-pc-v6:3389",
    "iphone>mac-mini:443",
    "windows-pc>mac-mini:18789",
    "mac-mini>windows-pc:3389",
  ]) {
    assert.ok(allowed.has(path), `expected ${path}`);
  }
  for (const path of [
    "iphone>mac-mini:5900",
    "iphone>windows-pc:3389",
    "iphone>mac-mini:18789",
    "macbook>mac-mini:18789",
    "windows-pc>mac-mini:443",
    "windows-pc>mac-mini:5900",
  ]) {
    assert.equal(allowed.has(path), false, `unexpected ${path}`);
  }
});

test("a device not seen for a month is left out, and the policy says so", () => {
  const result = generate();
  assert.deepEqual(result.excluded, [{ name: "old-macbook", reason: "offline since 2026-08-01" }]);
  assert.equal("old-macbook" in parsePolicy(result.policy).hosts, false);
  assert.match(result.policy, /old-macbook: offline since 2026-08-01/);
});

test("the device a policy is generated from keeps client access even when it is also a node", () => {
  const result = generate({ nodes: [...WINDOWS_NODE, { id: "macbook", name: "macbook", platform: "macos" }] });
  const { allowed, problems } = evaluate(parsePolicy(result.policy));
  assert.deepEqual(problems, []);
  assert.ok(allowed.has("macbook>mac-mini:443"), "the requesting device must not be locked out of Orion");
  assert.ok(allowed.has("macbook>mac-mini:18789"), "and it still reaches the gateway as a node");
});

test("refuses to write a policy that would lock out every one of your devices", () => {
  const onlyServers = tailnet([device("windows-pc", "windows", 4)]);
  assert.throws(
    () => generate({ status: onlyServers, requesterAddresses: [] }),
    (err) => err instanceof TailnetPolicyError && err.statusCode === 409,
  );
});

test("no tailnet status is a clear 503 rather than an empty policy", () => {
  assert.throws(
    () => generate({ status: null }),
    (err) => err instanceof TailnetPolicyError && err.statusCode === 503,
  );
});

test("a device whose name already ends in -v6 does not confuse address families", () => {
  const status = tailnet([device("macbook", "macOS", 2), device("nas-v6", "linux", 6), device("nas", "linux", 7)]);
  const result = generate({ status, nodes: [] });
  const policy = parsePolicy(result.policy);
  assert.deepEqual(evaluate(policy).problems, []);
  const aliases = Object.keys(policy.hosts);
  assert.equal(new Set(aliases).size, aliases.length, "aliases must be unique");
  for (const [alias, ip] of Object.entries(policy.hosts)) {
    const isV6Alias = policy.acls.some((rule) => rule.src.includes(alias) && rule.src.indexOf(alias) > 0);
    if (isV6Alias) assert.equal(net.isIPv6(ip), true, `${alias} should be an IPv6 alias`);
  }
});

test("tagged and other people's devices are left out with the reason", () => {
  const status = tailnet([
    device("macbook", "macOS", 2),
    device("build-box", "linux", 8, { Tags: ["tag:ci"] }),
    device("friends-laptop", "macOS", 9, { UserID: 222 }),
  ]);
  const { excluded } = generate({ status, nodes: [] });
  assert.deepEqual(excluded, [
    { name: "build-box", reason: "tagged tag:ci" },
    { name: "friends-laptop", reason: "belongs to another user" },
  ]);
});

test("an unrecognised requester is flagged in the policy instead of silently trusted", () => {
  const result = generate({ requesterAddresses: ["10.0.0.5", "not an ip; rm -rf /", "", 42] });
  assert.equal(result.requesterIdentified, false);
  assert.match(result.policy, /could not tell which device this was generated from/);
  // The user's own devices are still clients on their own merits.
  assert.deepEqual(result.clients.sort(), ["iphone", "macbook"]);
});

test("the inspector reports a failed read as null and passes live status to the generator", async () => {
  const failing = new TailnetInspector({ orionPort: 443, gatewayPort: 18789, run: async () => { throw new Error("no cli"); } });
  assert.equal(await failing.exposure(), null);
  await assert.rejects(failing.policy({ nodes: [], machines: [], requesterAddresses: [] }), /tailnet status/);

  const calls = [];
  const live = new TailnetInspector({
    orionPort: 443,
    gatewayPort: 18789,
    now: () => NOW,
    run: async (args) => {
      calls.push(args.join(" "));
      return args[0] === "debug" ? ALLOW_ALL : HOME;
    },
  });
  assert.equal((await live.exposure()).every((entry) => entry.reachableFrom === "tailnet"), true);
  const result = await live.policy({ nodes: WINDOWS_NODE, machines: [], requesterAddresses: ["100.64.0.2"] });
  assert.equal(result.requesterIdentified, true);
  assert.deepEqual(calls, ["debug netmap", "status --json"]);
});
