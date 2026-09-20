import assert from "node:assert/strict";
import test from "node:test";
import { buildFindings, REMEDIATIONS, SecurityRemediator } from "./security-review.js";

const lanExposure = { bind: "all-interfaces", scope: "lan", fix: { summary: "x" } };
const privateExposure = { bind: "tailnet-only", scope: "private", fix: null };

const rdp = (exposure) => ({ kind: "remote-desktop", label: "Remote Desktop", port: 3389, exposure });
const vnc = (exposure) => ({ kind: "screen-sharing", label: "Screen Sharing", port: 5900, exposure });

// ---- findings -----------------------------------------------------------------

test("an ungated API is the most severe finding and sorts first", () => {
  const findings = buildFindings({
    apiAuthenticated: false,
    nodes: [{ nodeId: "n", name: "PC", platform: "windows", services: [rdp(lanExposure)] }],
  });
  assert.equal(findings[0].id, "api-auth");
  assert.equal(findings[0].severity, "critical");
  assert.match(findings[0].detail, /Second Brain/);
  // Editing the Mini's own .env and restarting itself is not a button press.
  assert.equal(findings[0].remediation, null);
});

test("a gated API reports as ok", () => {
  // Selected by id, not position: other findings legitimately sort above an "ok" one.
  const finding = buildFindings({ apiAuthenticated: true }).find((f) => f.id === "api-auth");
  assert.equal(finding.severity, "ok");
  assert.equal(finding.remediation, null);
});

test("a LAN-exposed Windows RDP port produces an automatic remediation", () => {
  const findings = buildFindings({
    apiAuthenticated: true,
    nodes: [{ nodeId: "node-pc", name: "Windows PC", platform: "windows", services: [rdp(lanExposure)] }],
  });
  const finding = findings.find((f) => f.id === "exposure:node-pc:remote-desktop");
  assert.equal(finding.severity, "warning");
  assert.match(finding.title, /Remote Desktop on Windows PC/);
  assert.equal(finding.target.port, 3389);
  assert.equal(finding.remediation.automatic, true);
  assert.match(finding.remediation.command, /Set-NetFirewallRule/);
  assert.match(finding.remediation.rollback, /-RemoteAddress Any/);
});

test("macOS Screen Sharing is reported but is explicitly not automatic", () => {
  const findings = buildFindings({
    apiAuthenticated: true,
    mini: { nodeId: "orion-mini", services: [vnc(lanExposure)] },
  });
  const finding = findings.find((f) => f.id === "exposure:orion-mini:screen-sharing");
  assert.match(finding.title, /this Mac mini/);
  assert.equal(finding.remediation.automatic, false);
  assert.equal(finding.remediation.command, null, "no command is invented where none exists");
  assert.match(finding.remediation.summary, /no bind setting/);
});

test("a private or unknown bind produces no finding at all", () => {
  for (const exposure of [privateExposure, { bind: "unknown", scope: null }, undefined]) {
    const findings = buildFindings({
      apiAuthenticated: true,
      nodes: [{ nodeId: "n", name: "PC", platform: "windows", services: [rdp(exposure)] }],
    });
    assert.equal(findings.filter((f) => f.id.startsWith("exposure:")).length, 0);
  }
});

test("a configured machine reports the finding but cannot be fixed automatically", () => {
  // There is no agent on it, so there is nothing to run the command.
  const findings = buildFindings({
    apiAuthenticated: true,
    machines: [{ nodeId: "machine:pc", label: "Windows PC", platform: "windows", services: [rdp(lanExposure)] }],
  });
  const finding = findings.find((f) => f.id === "exposure:machine:pc:remote-desktop");
  assert.equal(finding.remediation.automatic, false);
  assert.match(finding.remediation.blocked, /configured by address only/);
});

test("findings sort worst-first", () => {
  const findings = buildFindings({
    apiAuthenticated: false,
    nodes: [{ nodeId: "n", name: "PC", platform: "windows", services: [rdp(lanExposure)] }],
  });
  assert.deepEqual(findings.map((f) => f.severity), ["critical", "warning"]);
});

test("the remediation catalogue is frozen and embeds no credential values", () => {
  // Prose may mention a password — one entry explains that Screen Sharing still demands an
  // account password. What must never appear is an actual credential: an assignment of one, or
  // a long opaque literal that looks like a key.
  assert.ok(Object.isFrozen(REMEDIATIONS));
  const serialized = JSON.stringify(REMEDIATIONS);
  assert.doesNotMatch(serialized, /(password|token|secret|key)\s*[:=]\s*["']?\S{6,}/i, "a credential assignment");
  assert.doesNotMatch(serialized, /[A-Za-z0-9+/]{32,}={0,2}/, "a long opaque literal");
});

test("every automatic remediation carries a rollback and a verification", () => {
  // A fix you cannot undo or confirm is not one to offer behind a button.
  for (const [id, remediation] of Object.entries(REMEDIATIONS)) {
    if (!remediation.automatic) continue;
    assert.ok(remediation.command, `${id} is automatic but has no command`);
    assert.ok(remediation.rollback, `${id} is automatic but cannot be undone`);
    assert.ok(remediation.verify, `${id} is automatic but cannot be verified`);
  }
});

// ---- applying -------------------------------------------------------------------

function fakeGateway(handler) {
  const calls = [];
  return { calls, async request(method, params) { calls.push({ method, params }); return handler(method, params); } };
}

function decodeScript(call) {
  return Buffer.from(call.params.params.command.at(-1), "base64").toString("utf16le");
}

test("applying runs the catalogue command, verifies it, and audits the outcome", async () => {
  let seen = 0;
  const gateway = fakeGateway(() => {
    seen += 1;
    return { payload: { success: true, stdout: seen === 1 ? "" : "100.64.0.0/10,fd7a:115c:a1e0::/48" } };
  });
  const remediator = new SecurityRemediator({ gateway });
  const result = await remediator.apply({
    findingId: "exposure:node-pc:remote-desktop",
    platform: "windows",
    clientId: "macbook",
  });

  assert.equal(result.applied, true);
  assert.equal(result.remediation, "scope-rdp-to-tailnet");
  assert.match(result.verified, /100\.64\.0\.0\/10/, "the rule is read back, not assumed");
  assert.match(decodeScript(gateway.calls[0]), /Set-NetFirewallRule/);
  assert.match(decodeScript(gateway.calls[1]), /Get-NetFirewallAddressFilter/);

  const [event] = remediator.audit();
  assert.equal(event.action, "security.remediate");
  assert.equal(event.outcome, "applied");
  assert.equal(event.clientId, "macbook");
  assert.equal(event.nodeId, "node-pc");
  assert.deepEqual(Object.keys(event).sort(), ["action", "at", "clientId", "findingId", "nodeId", "outcome", "remediation"]);
});

test("an unelevated node gets the specific answer, not a raw error", async () => {
  const gateway = fakeGateway(() => ({ payload: { success: false, stderr: "Access is denied." } }));
  const remediator = new SecurityRemediator({ gateway });
  await assert.rejects(
    remediator.apply({ findingId: "exposure:node-pc:remote-desktop", platform: "windows", clientId: "c" }),
    (error) => error.statusCode === 403 && /administrator rights/.test(error.message) && /elevated PowerShell/.test(error.message),
  );
  assert.equal(remediator.audit()[0].outcome, "failed");
});

test("a non-automatic remediation is refused with its explanation", async () => {
  const gateway = fakeGateway(() => { throw new Error("must not run"); });
  const remediator = new SecurityRemediator({ gateway });
  await assert.rejects(
    remediator.apply({ findingId: "exposure:orion-mini:screen-sharing", platform: "macos", clientId: "c" }),
    (error) => error.statusCode === 409 && /no bind setting/.test(error.message),
  );
  assert.deepEqual(gateway.calls, [], "nothing may run for a manual remediation");
});

test("a finding id the catalogue does not know runs nothing", async () => {
  const gateway = fakeGateway(() => { throw new Error("must not run"); });
  const remediator = new SecurityRemediator({ gateway });
  for (const [findingId, platform] of [
    ["api-auth", "windows"],
    ["exposure:node-pc:invented-service", "windows"],
    ["; rm -rf /", "windows"],
    ["exposure:node-pc:remote-desktop", "macos"],
    ["", "windows"],
  ]) {
    await assert.rejects(remediator.apply({ findingId, platform, clientId: "c" }));
  }
  assert.deepEqual(gateway.calls, [], "no client-supplied string may reach a shell");
});

test("parseFindingId accepts only the exposure shape", () => {
  assert.deepEqual(SecurityRemediator.parseFindingId("exposure:node-pc:remote-desktop"), {
    nodeId: "node-pc",
    kind: "remote-desktop",
  });
  assert.deepEqual(SecurityRemediator.parseFindingId("exposure:machine:pc:screen-sharing"), {
    nodeId: "machine:pc",
    kind: "screen-sharing",
  });
  assert.equal(SecurityRemediator.parseFindingId("api-auth"), null);
  assert.equal(SecurityRemediator.parseFindingId(""), null);
  assert.equal(SecurityRemediator.parseFindingId(undefined), null);
});

test("a verification failure does not fail the apply", async () => {
  // The rule may well have been set; we simply could not read it back.
  let call = 0;
  const gateway = fakeGateway(() => {
    call += 1;
    if (call === 1) return { payload: { success: true, stdout: "" } };
    return { payload: { success: false, stderr: "verification blew up" } };
  });
  const remediator = new SecurityRemediator({ gateway });
  const result = await remediator.apply({ findingId: "exposure:n:remote-desktop", platform: "windows", clientId: "c" });
  assert.equal(result.applied, true);
  assert.equal(result.verified, null, "unverified is reported as unverified");
});

test("the audit ring buffer stays bounded", async () => {
  const remediator = new SecurityRemediator({ gateway: fakeGateway(() => ({})) });
  for (let i = 0; i < 260; i += 1) {
    remediator.record({ findingId: "f", nodeId: "n", remediation: "r", clientId: "c", outcome: "applied" });
  }
  assert.equal(remediator.audit().length, 200);
});

// A checklist that cannot tell "checked and safe" from "could not check" is worse than no
// checklist, because it converts a blind spot into a green tick. These four cases pin that down.

test("an unreadable bind is reported, not silently treated as safe", () => {
  const findings = buildFindings({
    apiAuthenticated: true,
    nodes: [
      {
        nodeId: "node-pc",
        name: "Windows PC",
        platform: "windows",
        services: [rdp({ bind: "unknown", scope: null, fix: null })],
      },
    ],
  });
  const unchecked = findings.find((f) => f.id === "unchecked:node-pc:remote-desktop");
  assert.ok(unchecked, "an unknown bind must produce a finding");
  assert.match(unchecked.title, /could not check/i);
  assert.equal(unchecked.remediation, null);
  // It must not masquerade as a confirmed-clean result.
  assert.notEqual(unchecked.severity, "ok");
});

test("a service that is genuinely not listening stays silent", () => {
  const findings = buildFindings({
    apiAuthenticated: true,
    nodes: [
      {
        nodeId: "node-pc",
        name: "Windows PC",
        platform: "windows",
        services: [rdp({ bind: "not-listening", scope: null, fix: null })],
      },
    ],
  });
  assert.equal(findings.filter((f) => f.id.startsWith("unchecked:")).length, 0);
  assert.equal(findings.filter((f) => f.id.startsWith("exposure:")).length, 0);
});

test("an unreachable gateway is admitted rather than rendering as a clean list", () => {
  const findings = buildFindings({ apiAuthenticated: true, gatewayReachable: false });
  const gap = findings.find((f) => f.id === "nodes-unreachable");
  assert.ok(gap, "a failed node enumeration must be visible");
  assert.match(gap.detail, /would not appear/i);
  // The false-negative case: it must not be the only-green outcome we shipped.
  assert.notEqual(findings.every((f) => f.severity === "ok"), true);
});

test("knowing about no other machines says so, and names how to add one", () => {
  const findings = buildFindings({ apiAuthenticated: true, mini: { nodeId: "orion-mini", services: [] } });
  const only = findings.find((f) => f.id === "no-machines-known");
  assert.ok(only, "a checklist covering only the Mini must say so");
  assert.match(only.detail, /ORION_REMOTE_ACCESS_MACHINES/);
});
