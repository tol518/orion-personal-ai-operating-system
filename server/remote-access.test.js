import assert from "node:assert/strict";
import test from "node:test";
import {
  matchPeer,
  parseHostOverrides,
  REMOTE_SERVICES,
  parseMachines,
  RemoteAccessDirectory,
  SELF_NODE_ID,
} from "./remote-access.js";

const PEERS = [
  { shortName: "tolgas-mac-mini", dnsName: "tolgas-mac-mini.tail0000.ts.net", isSelf: true },
  { shortName: "windows-pc", dnsName: "windows-pc.tail0000.ts.net", isSelf: false },
];

function directory(overrides = {}) {
  return new RemoteAccessDirectory({
    listPeers: async () => PEERS,
    probe: async (_host, port) => port === 5900 || port === 3389,
    ...overrides,
  });
}

test("describes a mac node with the services that belong to its platform", async () => {
  const [described] = await directory().describe([
    { id: "node-mini", name: "tolgas-mac-mini", platform: "macos" },
  ]);
  assert.equal(described.host, "tolgas-mac-mini.tail0000.ts.net");
  assert.equal(described.hostSource, "tailnet");
  assert.deepEqual(described.services.map((service) => service.kind).sort(), [
    "apple-remote-desktop",
    "screen-sharing",
  ]);
  const screenSharing = described.services.find((s) => s.kind === "screen-sharing");
  assert.equal(screenSharing.reachable, true);
  assert.equal(screenSharing.scheme, "vnc");
  assert.equal(screenSharing.launchable, true);
});

test("RDP is offered to windows and not to mac", async () => {
  const [windows] = await directory().describe([
    { id: "node-pc", name: "windows-pc", platform: "windows" },
  ]);
  assert.deepEqual(windows.services.map((s) => s.kind), ["remote-desktop"]);
  assert.equal(windows.services[0].reachable, true);

  const [mac] = await directory().describe([
    { id: "node-mini", name: "tolgas-mac-mini", platform: "macos" },
  ]);
  assert.equal(mac.services.some((s) => s.kind === "remote-desktop"), false);
});

test("an unknown platform is offered every service rather than none", async () => {
  const [described] = await directory().describe([
    { id: "node-x", name: "windows-pc", platform: "unknown" },
  ]);
  assert.equal(described.services.length, REMOTE_SERVICES.length);
});

test("an unreachable port is reported as unreachable, not omitted", async () => {
  const dir = directory({ probe: async () => false });
  const [described] = await dir.describe([
    { id: "node-mini", name: "tolgas-mac-mini", platform: "macos" },
  ]);
  assert.equal(described.services.every((service) => service.reachable === false), true);
});

test("a node with no resolvable address reports no services and says why", async () => {
  const [described] = await directory().describe([
    { id: "node-ghost", name: "not-in-the-tailnet", platform: "macos" },
  ]);
  assert.equal(described.host, null);
  assert.equal(described.hostSource, "unresolved");
  assert.deepEqual(described.services, []);
  assert.match(described.hint, /ORION_REMOTE_ACCESS_HOSTS/);
});

test("a configured override wins over tailnet discovery", async () => {
  const dir = directory({ hostOverrides: "node-mini=explicit.example.ts.net" });
  const [described] = await dir.describe([
    { id: "node-mini", name: "tolgas-mac-mini", platform: "macos" },
  ]);
  assert.equal(described.host, "explicit.example.ts.net");
  assert.equal(described.hostSource, "configured");
});

test("overrides reject anything that is not a bare hostname", () => {
  // The address ends up in a URL the client opens, so it must not carry a path, port, or auth.
  const parsed = parseHostOverrides(
    "ok=mini.example.ts.net,path=host/evil,creds=user@host,port=host:22,space=a b,empty=",
  );
  assert.deepEqual([...parsed.keys()], ["ok"]);
});

test("overrides tolerate whitespace and ignore malformed entries", () => {
  const parsed = parseHostOverrides(" a = host-a.example , , broken , b=host-b.example ");
  assert.deepEqual([...parsed.entries()], [["a", "host-a.example"], ["b", "host-b.example"]]);
});

test("peer matching requires an unambiguous match", () => {
  // Connecting a screen viewer to the wrong machine is worse than reporting no address.
  assert.equal(matchPeer(PEERS, { name: "Tolgas Mac Mini" }), "tolgas-mac-mini.tail0000.ts.net");
  assert.equal(matchPeer(PEERS, { name: "unrelated" }), null);
  const ambiguous = [
    { shortName: "mini", dnsName: "mini.one.ts.net" },
    { shortName: "mini", dnsName: "mini.two.ts.net" },
  ];
  assert.equal(matchPeer(ambiguous, { name: "mini" }), null, "two candidates must not resolve");
  assert.equal(matchPeer([], { name: "mini" }), null);
  assert.equal(matchPeer(PEERS, {}), null);
});

test("peer matching falls back to the node id", () => {
  assert.equal(matchPeer(PEERS, { id: "windows_pc" }), "windows-pc.tail0000.ts.net");
});

test("a missing tailscale CLI degrades to configured overrides only", async () => {
  const dir = new RemoteAccessDirectory({
    listPeers: async () => {
      throw new Error("tailscale not installed");
    },
    probe: async () => true,
    hostOverrides: "node-pc=pc.example.ts.net",
  });
  const described = await dir.describe([
    { id: "node-pc", name: "pc", platform: "windows" },
    { id: "node-other", name: "other", platform: "macos" },
  ]);
  assert.equal(described[0].host, "pc.example.ts.net");
  assert.equal(described[1].host, null);
});

test("probe results are cached and then re-checked after the ttl", async () => {
  let calls = 0;
  let clock = 0;
  const dir = new RemoteAccessDirectory({
    listPeers: async () => PEERS,
    probe: async () => {
      calls += 1;
      return true;
    },
    cacheTtlMs: 1_000,
    now: () => clock,
  });
  const node = { id: "node-pc", name: "windows-pc", platform: "windows" };
  await dir.describe([node]);
  await dir.describe([node]);
  assert.equal(calls, 1, "the second read should come from the cache");
  clock += 1_001;
  await dir.describe([node]);
  assert.equal(calls, 2, "the cache should expire");
});

test("a throwing probe is treated as unreachable, not as an error", async () => {
  const dir = directory({
    probe: async () => {
      throw new Error("network unreachable");
    },
  });
  const [described] = await dir.describe([
    { id: "node-mini", name: "tolgas-mac-mini", platform: "macos" },
  ]);
  assert.equal(described.services.every((service) => service.reachable === false), true);
});

test("opening a session is audited with actor, node, and service only", () => {
  const dir = directory();
  const event = dir.recordSession({ nodeId: "node-mini", kind: "screen-sharing", clientId: "macbook" });
  assert.equal(event.action, "remote-session.open");
  assert.deepEqual(Object.keys(event).sort(), ["action", "at", "clientId", "nodeId", "service"]);
  assert.deepEqual(dir.audit(), [event]);
});

test("the audit ring buffer stays bounded", () => {
  const dir = directory();
  for (let index = 0; index < 260; index += 1) {
    dir.recordSession({ nodeId: "n", kind: "screen-sharing", clientId: "c" });
  }
  assert.equal(dir.audit().length, 200);
});

test("apple remote desktop is reported but not launchable", () => {
  const ard = REMOTE_SERVICES.find((service) => service.kind === "apple-remote-desktop");
  assert.equal(ard.scheme, null, "a management channel is not something to open in a viewer");
});

test("no service in the catalogue implies a proxied transport", () => {
  // A guard on the plan's rule: this module reports reachability, it does not carry sessions.
  for (const service of REMOTE_SERVICES) {
    assert.ok(["vnc", "rdp", null].includes(service.scheme), `unexpected scheme ${service.scheme}`);
    assert.equal(typeof service.port, "number");
  }
});

test("describe tolerates a malformed node list", async () => {
  const dir = directory();
  assert.deepEqual(await dir.describe(null), []);
  assert.deepEqual(await dir.describe(undefined), []);
  const [described] = await dir.describe([{}]);
  assert.equal(described.host, null);
});

test("the Mini describes itself with its tailnet name and loopback reachability", async () => {
  const probed = [];
  const dir = new RemoteAccessDirectory({
    listPeers: async () => PEERS,
    probe: async (host, port) => {
      probed.push(`${host}:${port}`);
      return port === 5900;
    },
  });
  const mini = await dir.describeSelf();

  assert.equal(mini.nodeId, SELF_NODE_ID);
  assert.equal(mini.host, "tolgas-mac-mini.tail0000.ts.net", "the client dials the tailnet name");
  assert.equal(mini.hostSource, "tailnet");
  // Reachability is a local question, so the probe stays on loopback.
  assert.deepEqual(probed.sort(), ["127.0.0.1:3283", "127.0.0.1:5900"]);
  const screenSharing = mini.services.find((service) => service.kind === "screen-sharing");
  assert.equal(screenSharing.reachable, true);
  assert.equal(screenSharing.launchable, true);
  // RDP is never offered for the Mini.
  assert.equal(mini.services.some((service) => service.kind === "remote-desktop"), false);
});

test("the Mini still reports its services when its own name is unknown", async () => {
  // The client falls back to the address it is already connected through.
  const dir = new RemoteAccessDirectory({
    listPeers: async () => [],
    probe: async () => true,
  });
  const mini = await dir.describeSelf();
  assert.equal(mini.host, null);
  assert.equal(mini.hostSource, "unresolved");
  assert.equal(mini.services.length > 0, true, "services are reported regardless of the address");
  assert.match(mini.hint, /address you connected with/);
});

test("an override wins for the Mini too", async () => {
  const dir = new RemoteAccessDirectory({
    listPeers: async () => PEERS,
    probe: async () => true,
    hostOverrides: `${SELF_NODE_ID}=mini.override.ts.net`,
  });
  const mini = await dir.describeSelf();
  assert.equal(mini.host, "mini.override.ts.net");
  assert.equal(mini.hostSource, "configured");
});

test("a configured machine is listed and probed for its platform's services", async () => {
  const dir = new RemoteAccessDirectory({
    listPeers: async () => [],
    probe: async (_host, port) => port === 3389,
    machines: "Windows PC|atakarasupc.example.ts.net|windows",
  });
  const [machine] = await dir.describeMachines();

  assert.equal(machine.nodeId, "machine:windows-pc");
  assert.equal(machine.label, "Windows PC");
  assert.equal(machine.platform, "windows");
  assert.equal(machine.host, "atakarasupc.example.ts.net");
  assert.deepEqual(machine.services.map((service) => service.kind), ["remote-desktop"]);
  assert.equal(machine.services[0].reachable, true);
  assert.equal(machine.services[0].scheme, "rdp");
});

test("a configured machine does not need the gateway to know it", async () => {
  // The whole point: RDP reachability and OpenClaw node pairing are unrelated relationships.
  const dir = new RemoteAccessDirectory({
    listPeers: async () => [],
    probe: async () => true,
    machines: "PC|pc.example.ts.net|windows",
  });
  assert.deepEqual(await dir.describe([]), [], "no gateway nodes");
  assert.equal((await dir.describeMachines()).length, 1);
  assert.equal(dir.findMachine("machine:pc").label, "PC");
  assert.equal(dir.findMachine("machine:nope"), null);
});

test("machine parsing rejects malformed, unsafe, and duplicate entries", () => {
  const parsed = parseMachines([
    "Good|host.example|windows",
    "NoPlatform|host.example",
    "BadPlatform|host.example|toaster",
    "BadHost|host/evil|windows",
    "|host.example|windows",
    "Good|other.example|macos",
    `${"x".repeat(41)}|host.example|macos`,
  ].join(","));
  assert.deepEqual(parsed.map((machine) => machine.label), ["Good"]);
  assert.equal(parsed[0].nodeId, "machine:good");
});

test("machine parsing handles an empty setting", () => {
  assert.deepEqual(parseMachines(""), []);
  assert.deepEqual(parseMachines(undefined), []);
});

test("a mac machine is offered screen sharing rather than RDP", async () => {
  const dir = new RemoteAccessDirectory({
    listPeers: async () => [],
    probe: async () => true,
    machines: "Studio|studio.example.ts.net|macos",
  });
  const [machine] = await dir.describeMachines();
  assert.deepEqual(
    machine.services.map((service) => service.kind).sort(),
    ["apple-remote-desktop", "screen-sharing"],
  );
});
