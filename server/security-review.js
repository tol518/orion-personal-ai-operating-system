// Security findings and their remediations.
//
// The point of this module is that a user who never reads documentation still ends up secure.
// Orion already knows which ports answer beyond the tailnet and whether its own API is
// authenticated; this turns that knowledge into a checklist with a button, rather than something
// you have to know to go and ask about.
//
// Two rules shape the design:
//
//   Commands are never taken from the client. A request names a finding id; the command is looked
//   up in REMEDIATIONS here. A compromised or buggy client can ask for a known fix on a known
//   node, and nothing else — it cannot ask the Mini to run something of its choosing on a machine.
//
//   Applying is consented and audited. Each application records actor, finding, node, and outcome.
//   That is the contract the plan requires before Orion takes any high-risk device action.
import { randomUUID } from "node:crypto";

const MAX_AUDIT_EVENTS = 200;

/**
 * Every fix Orion can apply, keyed by id. A finding may only reference an entry here.
 *
 * `automatic` marks the ones Orion can run itself. The rest carry instructions and no command,
 * because they are OS privacy toggles — an app that could silently enable remote desktop would be
 * malware, and that gate is deliberate.
 */
export const REMEDIATIONS = Object.freeze({
  "scope-rdp-to-tailnet": {
    id: "scope-rdp-to-tailnet",
    title: "Restrict Remote Desktop to your private network",
    summary:
      "Scopes the Windows firewall's Remote Desktop rules to Tailscale's address ranges, so the " +
      "port stops answering on any other network. You keep connecting from Orion exactly as now.",
    platform: "windows",
    automatic: true,
    shell: "powershell",
    // Elevation is required. An unelevated node fails with access denied, which is reported as
    // such rather than being retried or papered over.
    command:
      'Get-NetFirewallRule -DisplayGroup "Remote Desktop" | Where-Object Enabled -eq $True | ' +
      "Set-NetFirewallRule -RemoteAddress @('100.64.0.0/10','fd7a:115c:a1e0::/48')",
    rollback:
      'Get-NetFirewallRule -DisplayGroup "Remote Desktop" | Set-NetFirewallRule -RemoteAddress Any',
    verify:
      "(Get-NetFirewallRule -DisplayGroup \"Remote Desktop\" | Where-Object Enabled -eq $True | " +
      "Get-NetFirewallAddressFilter | Select-Object -ExpandProperty RemoteAddress) -join ','",
  },
  "restrict-screen-sharing-manually": {
    id: "restrict-screen-sharing-manually",
    title: "Restrict Screen Sharing to your private network",
    summary:
      "macOS Screen Sharing has no bind setting, so there is no command Orion can run for this. " +
      "Either restrict port 5900 with a pf rule, or accept local-network reachability — unlike an " +
      "open API, it still requires a full account password.",
    platform: "macos",
    automatic: false,
    shell: null,
    command: null,
    rollback: null,
    verify: null,
  },
});

/** Severity ordering for presentation: the worst thing first. */
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, ok: 3 };

/**
 * Builds the findings list.
 *
 * @param {object} input
 * @param {boolean} input.apiAuthenticated  whether the browser API boundary is in place
 * @param {object|null} input.mini          the Mini's own remote-access entry
 * @param {Array} input.nodes               paired nodes' remote-access entries
 * @param {Array} input.machines            configured machines' entries
 */
export function buildFindings({ apiAuthenticated, mini = null, nodes = [], machines = [] } = {}) {
  const findings = [];

  findings.push(
    apiAuthenticated
      ? {
          id: "api-auth",
          severity: "ok",
          title: "Orion's API requires a password",
          detail: "Browser requests without a session are refused.",
          target: null,
          remediation: null,
        }
      : {
          id: "api-auth",
          severity: "critical",
          title: "Orion's API accepts anyone who can reach it",
          detail:
            "Sessions, transcripts, the Second Brain, and chat into your agents are readable and " +
            "writable without a password. Set JARVIS_ACCESS_PASSWORD on the Mini and restart it.",
          target: null,
          // Editing the Mini's own .env and restarting itself is not something Orion should do
          // to itself on a button press.
          remediation: null,
        },
  );

  const entries = [
    ...(mini ? [{ entry: mini, label: "this Mac mini", platform: "macos", nodeId: mini.nodeId }] : []),
    ...nodes.map((entry) => ({
      entry,
      label: entry.name ?? entry.nodeId,
      platform: entry.platform ?? platformOfServices(entry),
      nodeId: entry.nodeId,
    })),
    ...machines.map((entry) => ({
      entry,
      label: entry.label ?? entry.nodeId,
      platform: entry.platform,
      nodeId: entry.nodeId,
      configuredOnly: true,
    })),
  ];

  for (const { entry, label, platform, nodeId, configuredOnly } of entries) {
    for (const service of entry.services ?? []) {
      const exposure = service.exposure ?? {};
      if (exposure.scope !== "lan") continue;
      const remediation = remediationFor(platform, service.kind);
      findings.push({
        id: `exposure:${nodeId}:${service.kind}`,
        severity: "warning",
        title: `${service.label} on ${label} answers beyond your private network`,
        detail:
          `Port ${service.port} is listening on every network interface, so anyone on the same ` +
          `local network can reach its login prompt — not only devices on your tailnet.`,
        target: { nodeId, kind: service.kind, port: service.port, platform, label },
        remediation: remediation
          ? {
              ...publicRemediation(remediation),
              // A machine Orion only knows by address has no agent to run anything on.
              automatic: remediation.automatic && !configuredOnly,
              ...(configuredOnly && remediation.automatic
                ? { blocked: "This machine is configured by address only, so Orion has no way to run the fix on it." }
                : {}),
            }
          : null,
      });
    }
  }

  return findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function platformOfServices(entry) {
  const kinds = new Set((entry.services ?? []).map((service) => service.kind));
  if (kinds.has("remote-desktop")) return "windows";
  if (kinds.has("screen-sharing")) return "macos";
  return "unknown";
}

function remediationFor(platform, kind) {
  if (platform === "windows" && kind === "remote-desktop") return REMEDIATIONS["scope-rdp-to-tailnet"];
  if (platform === "macos" && kind === "screen-sharing") return REMEDIATIONS["restrict-screen-sharing-manually"];
  return null;
}

/** The remediation as the client sees it: everything needed to show what will run, and no more. */
function publicRemediation(remediation) {
  return {
    id: remediation.id,
    title: remediation.title,
    summary: remediation.summary,
    automatic: remediation.automatic,
    shell: remediation.shell,
    command: remediation.command,
    rollback: remediation.rollback,
  };
}

/**
 * Applies a remediation to a node, and records that it happened.
 *
 * The client names a finding; the command comes from REMEDIATIONS. Nothing the client sends
 * reaches a shell.
 */
export class SecurityRemediator {
  constructor({ gateway, timeoutMs = 30_000, now = () => Date.now() }) {
    this.gateway = gateway;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.auditEvents = [];
  }

  /** Parses `exposure:<nodeId>:<kind>`, which is the only finding shape that can be remediated. */
  static parseFindingId(findingId) {
    const match = /^exposure:(.+):([a-z-]+)$/.exec(String(findingId ?? ""));
    return match ? { nodeId: match[1], kind: match[2] } : null;
  }

  async apply({ findingId, platform, clientId }) {
    const parsed = SecurityRemediator.parseFindingId(findingId);
    if (!parsed) throw error("unknown finding", 400);

    const remediation = remediationFor(platform, parsed.kind);
    if (!remediation) throw error("no remediation exists for this finding", 400);
    if (!remediation.automatic || !remediation.command) {
      throw error(`${remediation.title} has no command Orion can run. ${remediation.summary}`, 409);
    }

    let result;
    try {
      result = await this.runPowershell(parsed.nodeId, remediation.command);
    } catch (cause) {
      this.record({ findingId, nodeId: parsed.nodeId, remediation: remediation.id, clientId, outcome: "failed" });
      throw cause;
    }

    // Read the rule back rather than trusting the exit code: a firewall command can succeed
    // syntactically and still not be what was intended.
    let verified = null;
    if (remediation.verify) {
      verified = await this.runPowershell(parsed.nodeId, remediation.verify)
        .then((run) => String(run.stdout ?? "").trim())
        .catch(() => null);
    }

    this.record({ findingId, nodeId: parsed.nodeId, remediation: remediation.id, clientId, outcome: "applied" });
    return {
      applied: true,
      remediation: remediation.id,
      rollback: remediation.rollback,
      verified,
      stdout: String(result.stdout ?? "").trim().slice(0, 2_000),
    };
  }

  async runPowershell(nodeId, script) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = await this.gateway.request("node.invoke", {
      nodeId,
      command: "system.run",
      params: {
        command: ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        timeoutMs: this.timeoutMs,
        suppressNotifyOnExit: true,
      },
      idempotencyKey: randomUUID(),
    });
    const run = result?.payload ?? result;
    if (!run?.success) {
      const message = String(run?.error ?? run?.stderr ?? "the command failed on the node");
      // The likeliest failure by far, and the one with a specific answer.
      if (/access is denied|requires elevation|administrator/i.test(message)) {
        throw error(
          "The OpenClaw node on this machine is not running with administrator rights, so it " +
            "cannot change firewall rules. Run the command yourself in an elevated PowerShell, " +
            "or restart the node elevated.",
          403,
        );
      }
      throw error(message, 502);
    }
    return run;
  }

  /** Actor, finding, node, outcome. No command output, no credentials. */
  record({ findingId, nodeId, remediation, clientId, outcome }) {
    this.auditEvents.push({
      at: new Date(this.now()).toISOString(),
      action: "security.remediate",
      findingId: String(findingId ?? ""),
      nodeId: String(nodeId ?? ""),
      remediation: String(remediation ?? ""),
      clientId: String(clientId ?? ""),
      outcome,
    });
    if (this.auditEvents.length > MAX_AUDIT_EVENTS) {
      this.auditEvents.splice(0, this.auditEvents.length - MAX_AUDIT_EVENTS);
    }
  }

  audit() {
    return this.auditEvents.map((event) => ({ ...event }));
  }
}

function error(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}
