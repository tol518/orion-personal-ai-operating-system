import assert from "node:assert/strict";
import test from "node:test";
import {
  matchPeer,
  parseHostOverrides,
  REMOTE_SERVICES,
  RemoteAccessDirectory,
} from "./remote-access.js";

const PEERS = [
  { shortName: "tolgas-mac-mini", dnsName: "tolgas-mac-mini.tail0000.ts.net" },
  { shortName: "windows-pc", dnsName: "windows-pc.tail0000.ts.net" },
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
