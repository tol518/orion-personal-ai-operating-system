import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBind,
  createNodeBindInspector,
  describeExposure,
  fixFor,
  isTailnet,
  parseNetstatBinds,
  parseWindowsBinds,
  scopeFor,
} from "./exposure.js";

// ---- netstat parsing ---------------------------------------------------------

const MAC_NETSTAT = `
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  *.5900                 *.*                    LISTEN
tcp46      0      0  *.3283                 *.*                    LISTEN
tcp4       0      0  127.0.0.1.4820         *.*                    LISTEN
tcp4       0      0  100.105.255.126.22     *.*                    LISTEN
tcp6       0      0  fe80::1%lo0.4820       *.*                    LISTEN
tcp4       0      0  192.168.1.20.52344     17.253.144.10.443      ESTABLISHED
udp4       0      0  *.5353                 *.*
`;

test("parses macOS netstat LISTEN rows, dot-separated ports", () => {
  const binds = parseNetstatBinds(MAC_NETSTAT);
  assert.deepEqual(binds, [
    { address: "*", port: 5900 },
    { address: "*", port: 3283 },
    { address: "127.0.0.1", port: 4820 },
    { address: "100.105.255.126", port: 22 },
    { address: "fe80::1", port: 4820 }, // scope id stripped
  ]);
});

test("ignores established connections, udp, and header lines", () => {
  const binds = parseNetstatBinds(MAC_NETSTAT);
  assert.equal(binds.some((b) => b.port === 52344), false, "ESTABLISHED row must not count");
  assert.equal(binds.some((b) => b.port === 5353), false, "udp row must not count");
});

test("parses Linux netstat rows, colon-separated ports", () => {
  const binds = parseNetstatBinds(`
tcp        0      0 0.0.0.0:5900            0.0.0.0:*               LISTEN
tcp6       0      0 :::3389                 :::*                    LISTEN
tcp        0      0 127.0.0.1:631           0.0.0.0:*               LISTEN
`);
  assert.deepEqual(binds, [
    { address: "0.0.0.0", port: 5900 },
    { address: "::", port: 3389 },
    { address: "127.0.0.1", port: 631 },
  ]);
});

test("empty or garbage netstat output yields no binds", () => {
  assert.deepEqual(parseNetstatBinds(""), []);
  assert.deepEqual(parseNetstatBinds(null), []);
  assert.deepEqual(parseNetstatBinds("not netstat at all"), []);
});

// ---- Windows parsing ---------------------------------------------------------

test("parses Get-NetTCPConnection JSON, array form", () => {
  const binds = parseWindowsBinds(
    '[{"LocalAddress":"0.0.0.0","LocalPort":3389},{"LocalAddress":"::","LocalPort":3389},{"LocalAddress":"127.0.0.1","LocalPort":5040}]',
  );
  assert.deepEqual(binds, [
    { address: "0.0.0.0", port: 3389 },
    { address: "::", port: 3389 },
    { address: "127.0.0.1", port: 5040 },
  ]);
});

test("handles PowerShell emitting a bare object for a single row", () => {
  // ConvertTo-Json drops the array when there is exactly one result.
  assert.deepEqual(parseWindowsBinds('{"LocalAddress":"0.0.0.0","LocalPort":3389}'), [
    { address: "0.0.0.0", port: 3389 },
  ]);
});

test("tolerates invalid or empty Windows output", () => {
  assert.deepEqual(parseWindowsBinds(""), []);
  assert.deepEqual(parseWindowsBinds("not json"), []);
  assert.deepEqual(parseWindowsBinds("[]"), []);
  assert.deepEqual(parseWindowsBinds('[{"LocalAddress":"0.0.0.0"}]'), [], "a row without a port is dropped");
});

// ---- classification ------------------------------------------------------------

test("any wildcard address means all interfaces, even alongside tailnet binds", () => {
  assert.equal(classifyBind(["*"]), "all-interfaces");
  assert.equal(classifyBind(["0.0.0.0"]), "all-interfaces");
  assert.equal(classifyBind(["::"]), "all-interfaces");
  assert.equal(classifyBind(["[::]"]), "all-interfaces");
  assert.equal(classifyBind(["100.105.255.126", "0.0.0.0"]), "all-interfaces");
});

test("tailnet-only when every non-loopback bind is a Tailscale address", () => {
  assert.equal(classifyBind(["100.105.255.126"]), "tailnet-only");
  assert.equal(classifyBind(["fd7a:115c:a1e0:ab12::1"]), "tailnet-only");
  assert.equal(classifyBind(["100.105.255.126", "127.0.0.1"]), "tailnet-only");
});

test("loopback-only, specific, and not-listening", () => {
  assert.equal(classifyBind(["127.0.0.1"]), "loopback-only");
  assert.equal(classifyBind(["::1", "127.0.0.1"]), "loopback-only");
  assert.equal(classifyBind(["192.168.1.20"]), "specific", "a LAN address is not private to the tailnet");
  assert.equal(classifyBind(["192.168.1.20", "100.105.255.126"]), "specific");
  assert.equal(classifyBind([]), "not-listening");
  assert.equal(classifyBind(undefined), "not-listening");
});

test("the Tailscale IPv4 range is exactly 100.64.0.0/10", () => {
  assert.equal(isTailnet("100.64.0.0"), true);
  assert.equal(isTailnet("100.127.255.255"), true);
  assert.equal(isTailnet("100.63.255.255"), false);
  assert.equal(isTailnet("100.128.0.0"), false);
  assert.equal(isTailnet("10.0.0.1"), false);
  assert.equal(isTailnet("garbage"), false);
});

test("scope names who can reach a bind", () => {
  assert.equal(scopeFor("all-interfaces"), "lan");
  assert.equal(scopeFor("specific"), "lan");
  assert.equal(scopeFor("tailnet-only"), "private");
  assert.equal(scopeFor("loopback-only"), "local");
  assert.equal(scopeFor("not-listening"), null);
  assert.equal(scopeFor("unknown"), null);
});

// ---- fixes ---------------------------------------------------------------------

test("Windows RDP on all interfaces gets the firewall scoping command and a rollback", () => {
  const fix = fixFor({ platform: "windows", kind: "remote-desktop", bind: "all-interfaces" });
  assert.match(fix.command, /Set-NetFirewallRule/);
  assert.match(fix.command, /100\.64\.0\.0\/10/);
  assert.match(fix.command, /fd7a:115c:a1e0::\/48/, "IPv6 range included because RDP listens on :: too");
  assert.match(fix.rollback, /-RemoteAddress Any/);
  assert.equal(fix.shell, "powershell (elevated)");
});

test("macOS Screen Sharing is honest that there is no bind setting", () => {
  const fix = fixFor({ platform: "macos", kind: "screen-sharing", bind: "all-interfaces" });
  assert.equal(fix.command, null, "no one-liner exists, so none is invented");
  assert.match(fix.summary, /pf rule/);
  assert.match(fix.summary, /password/, "says why accepting it is defensible");
});

test("a private or local bind needs no fix", () => {
  assert.equal(fixFor({ platform: "windows", kind: "remote-desktop", bind: "tailnet-only" }), null);
  assert.equal(fixFor({ platform: "macos", kind: "screen-sharing", bind: "loopback-only" }), null);
  assert.equal(fixFor({ platform: "macos", kind: "screen-sharing", bind: "not-listening" }), null);
});

// ---- describeExposure ----------------------------------------------------------

test("describeExposure attaches bind, scope, and fix for a LAN-exposed port", () => {
  const exposure = describeExposure({
    platform: "windows",
    kind: "remote-desktop",
    port: 3389,
    binds: [
      { address: "0.0.0.0", port: 3389 },
      { address: "::", port: 3389 },
      { address: "127.0.0.1", port: 5040 },
    ],
  });
  assert.equal(exposure.bind, "all-interfaces");
  assert.equal(exposure.scope, "lan");
  assert.match(exposure.fix.command, /Set-NetFirewallRule/);
});

test("describeExposure only considers binds on the service's own port", () => {
  const exposure = describeExposure({
    platform: "macos",
    kind: "screen-sharing",
    port: 5900,
    binds: [{ address: "0.0.0.0", port: 4820 }], // a different port being open is irrelevant
  });
  assert.equal(exposure.bind, "not-listening");
  assert.equal(exposure.scope, null);
  assert.equal(exposure.fix, null);
});

test("describeExposure reports unknown when inspection was unavailable", () => {
  // Honest: reachability was checked, interfaces were not. Never a false "private".
  for (const binds of [null, undefined]) {
    const exposure = describeExposure({ platform: "macos", kind: "screen-sharing", port: 5900, binds });
    assert.deepEqual(exposure, { bind: "unknown", scope: null, fix: null });
  }
});

// ---- node inspector -----------------------------------------------------------

function fakeGateway(handler) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      return handler(method, params);
    },
  };
}

test("the node inspector runs Get-NetTCPConnection on Windows via an encoded command", async () => {
  const gateway = fakeGateway(() => ({
    payload: { success: true, stdout: '[{"LocalAddress":"0.0.0.0","LocalPort":3389}]' },
  }));
  const inspect = createNodeBindInspector({ gateway });
  const binds = await inspect({ id: "node-pc", platform: "windows", capabilities: ["exec"] });

  assert.deepEqual(binds, [{ address: "0.0.0.0", port: 3389 }]);
  const call = gateway.calls[0];
  assert.equal(call.method, "node.invoke");
  assert.equal(call.params.nodeId, "node-pc");
  assert.equal(call.params.command, "system.run");
  assert.equal(call.params.params.command[0], "powershell.exe");
  assert.ok(call.params.params.command.includes("-EncodedCommand"));
  const encoded = call.params.params.command.at(-1);
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /Get-NetTCPConnection -State Listen/);
  assert.match(decoded, /ConvertTo-Json/);
  assert.ok(call.params.idempotencyKey.startsWith("exposure-node-pc-"));
});

test("the node inspector runs netstat on a Mac node", async () => {
  const gateway = fakeGateway(() => ({
    payload: { success: true, stdout: "tcp4  0  0  *.5900  *.*  LISTEN\n" },
  }));
  const inspect = createNodeBindInspector({ gateway });
  const binds = await inspect({ id: "node-mac", platform: "macos", capabilities: ["exec"] });
  assert.deepEqual(binds, [{ address: "*", port: 5900 }]);
  assert.deepEqual(gateway.calls[0].params.params.command, ["/usr/sbin/netstat", "-an", "-p", "tcp"]);
});

test("the node inspector declines a node without exec rather than guessing", async () => {
  const gateway = fakeGateway(() => {
    throw new Error("should not be called");
  });
  const inspect = createNodeBindInspector({ gateway });
  assert.equal(await inspect({ id: "node-x", platform: "windows", capabilities: ["screen"] }), null);
  assert.equal(await inspect({ id: "node-y", platform: "windows", capabilities: [] }), null);
  assert.equal(await inspect({}), null);
  assert.deepEqual(gateway.calls, [], "no command may run on a node that cannot exec");
});

test("a failed run reports unknown, not a false negative", async () => {
  const gateway = fakeGateway(() => ({ payload: { success: false, stderr: "access denied" } }));
  const inspect = createNodeBindInspector({ gateway });
  assert.equal(await inspect({ id: "node-pc", platform: "windows", capabilities: ["exec"] }), null);
});

test("the inspector accepts a result without a payload wrapper", async () => {
  const gateway = fakeGateway(() => ({ success: true, stdout: "tcp4 0 0 127.0.0.1.5900 *.* LISTEN\n" }));
  const inspect = createNodeBindInspector({ gateway });
  assert.deepEqual(await inspect({ id: "n", platform: "macos", capabilities: ["exec"] }), [
    { address: "127.0.0.1", port: 5900 },
  ]);
});
