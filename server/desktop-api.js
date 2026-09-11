// Additive desktop API surface (/api/v1/desktop) consumed by the native macOS client.
//
// Every route here delegates to a capability the BFF already owns: the gateway client, the
// existing chat submission path, and the existing SSE fan-out. Nothing in this file keeps its own
// agent, session, memory, or node state — a second store would drift from the web client, and the
// Mac mini is the single authoritative runtime.
//
// This surface is mounted BEFORE app.use("/api", cookieAuth) in index.js. Express matches "/api"
// as a prefix, so mounting it later would subject native requests to the browser's cookie and
// same-origin checks, which a native client cannot satisfy.
import express from "express";
import { DesktopAccess, desktopBearerToken } from "./desktop-access.js";
import { REMOTE_SERVICES } from "./remote-access.js";

// Only these gateway events reach Orion.app. Hunting, extraction, workflow-learning, and memory
// mutation events belong to features that are out of scope for the native app in V1, so they are
// not exposed to it even though the browser stream carries them.
export const DESKTOP_EVENTS = new Set([
  "gateway.status",
  "gateway.disconnected",
  "chat",
  "agent",
  "session.tool",
  "session.message",
  "sessions.changed",
  "node.presence.alive",
]);

/**
 * Reduces the gateway status to what a desktop client needs: whether it is connected, how much
 * authority the connection has, and a mapped reason when it is down. The raw status carries the
 * gateway URL and the connect error string, neither of which leaves the Mini.
 */
export function redactGatewayStatus(status) {
  return {
    connected: Boolean(status?.connected),
    // Scope names describe authority, not secrets, but the native UI only needs the count.
    scopeCount: Array.isArray(status?.scopes) ? status.scopes.length : 0,
    reason: status?.connected ? null : shortReason(status?.error),
  };
}

/**
 * The SSE frame a desktop client may receive, or null when the event is out of scope. Both the
 * BFF fan-out and this router's opening frame go through here, so an event cannot reach Orion.app
 * unredacted by taking a different path.
 */
export function desktopEventFrame(event, data) {
  if (!DESKTOP_EVENTS.has(event)) return null;
  const payload = event === "gateway.status" ? redactGatewayStatus(data) : data;
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const CAPABILITY_MAP = [
  { capability: "exec", commands: ["system.run", "node_exec"] },
  { capability: "screen", commands: ["screen.capture", "screen.control", "screen.input"] },
  { capability: "browser", commands: ["browser.open", "browser.navigate", "browser.input"] },
  { capability: "canvas", commands: ["canvas.render", "canvas.draw"] },
];

/**
 * Builds the desktop router.
 *
 * @param {object} deps
 * @param {{ request: Function, status: Function }} deps.gateway  existing gateway client
 * @param {DesktopAccess} deps.access                             desktop credential boundary
 * @param {Function} deps.submitChatTurn                          the same path /api/chat uses
 * @param {Function} deps.chatHistory                             bounded history reader
 * @param {Function} deps.modelOptionsFromConfig                  existing model projection
 * @param {Function} deps.subscribe                               registers an SSE responder
 * @param {import("./remote-access.js").RemoteAccessDirectory} [deps.remoteAccess]
 * @param {Function} [deps.decorateNodes]                         existing node projection
 */
export function createDesktopApi({
  gateway,
  access,
  submitChatTurn,
  chatHistory,
  modelOptionsFromConfig,
  subscribe,
  remoteAccess,
  decorateNodes,
}) {
  const router = express.Router();

  const ok = (res, payload) => res.json({ ok: true, ...payload });
  const fail = (res, err, code = 502) =>
    res.status(err?.statusCode ?? code).json({ ok: false, error: String(err?.message ?? err) });
  const listNodes = async () => {
    const payload = await gateway.request("node.list", {});
    const decorated = decorateNodes ? await decorateNodes(payload) : payload;
    return (decorated?.nodes ?? []).map(toNodeSummary);
  };

  // ---- Pairing ------------------------------------------------------------
  // Unauthenticated by necessity: this is where a device obtains its credential. It is protected
  // by the pairing secret, the optional client allowlist, and per-client failure throttling.
  router.post("/pair", (req, res) => {
    try {
      const result = access.pair({
        pairingSecret: req.body?.pairingSecret,
        clientId: req.body?.clientId,
        clientName: req.body?.clientName,
        platform: req.body?.platform,
        clientKey: req.ip,
      });
      ok(res, result);
    } catch (err) {
      if (err?.retryAfter) res.set("Retry-After", String(err.retryAfter));
      fail(res, err, 401);
    }
  });

  // ---- Authorization ------------------------------------------------------
  // Server-side check on every desktop action below this line. The token proves a paired device;
  // it carries no gateway authority of its own.
  router.use((req, res, next) => {
    if (!access.configured) {
      return fail(res, "Desktop access is not configured on this host", 503);
    }
    const client = access.verify(desktopBearerToken(req));
    if (!client) return fail(res, "Desktop authentication required", 401);
    req.desktopClient = client;
    next();
  });

  router.post("/unpair", (req, res) => {
    access.revoke(desktopBearerToken(req));
    ok(res, { paired: false });
  });

  router.get("/clients", (_req, res) => ok(res, { clients: access.clients() }));

  router.delete("/clients/:clientId", (req, res) => {
    const revoked = access.revokeClient(req.params.clientId);
    if (revoked === 0) return fail(res, "client not found", 404);
    ok(res, { revoked });
  });

  router.get("/audit", (_req, res) => ok(res, { events: access.audit() }));

  // ---- Health -------------------------------------------------------------
  // Deliberately redacted: the native client learns whether the gateway is reachable and how
  // capable the connection is, not where it lives or which token authorized it.
  router.get("/health", (req, res) => {
    ok(res, {
      reachable: true,
      gateway: redactGatewayStatus(gateway.status()),
      client: {
        clientId: req.desktopClient.clientId,
        clientName: req.desktopClient.clientName,
        expiresAt: new Date(req.desktopClient.expiresAt).toISOString(),
      },
      serverTime: new Date().toISOString(),
    });
  });

  // ---- Agents -------------------------------------------------------------
  router.get("/agents", async (_req, res) => {
    try {
      const [agentsResult, config] = await Promise.all([
        gateway.request("agents.list", {}),
        gateway.request("config.get", {}).catch(() => null),
      ]);
      const agents = (agentsResult?.agents ?? []).map((agent) => {
        const options = config ? modelOptionsFromConfig(config, agent.id) : null;
        return {
          id: agent.id,
          name: agent.displayName ?? agent.name ?? agent.id,
          description: typeof agent.description === "string" ? agent.description : null,
          currentModel: options?.current ?? null,
          models: options?.models ?? [],
        };
      });
      ok(res, { agents });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Sessions -----------------------------------------------------------
  router.get("/sessions", async (req, res) => {
    const limit = boundedLimit(req.query.limit, 20, 100);
    try {
      const result = await gateway.request("sessions.list", {
        limit,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      ok(res, { sessions: (result?.sessions ?? []).map(toSessionSummary) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post("/sessions", async (req, res) => {
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    if (!agentId) return fail(res, "agentId required", 400);
    try {
      // sessions.create attaches to an agent that already exists on the Mini. The desktop app
      // never creates agents, so an unknown agentId is the gateway's error to raise.
      ok(res, await gateway.request("sessions.create", { agentId, ...(label ? { label } : {}) }));
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.get("/sessions/:key/history", async (req, res) => {
    try {
      ok(res, await chatHistory(req.params.key));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Chat ---------------------------------------------------------------
  // Delegates to the identical function /api/chat uses, so memory retrieval, execution policy,
  // attachment grants, and safety behavior stay in one place for both clients.
  router.post("/chat", async (req, res) => {
    const sessionKey = typeof req.body?.sessionKey === "string" ? req.body.sessionKey.trim() : "";
    const message = String(req.body?.message ?? "");
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    if (!sessionKey || !message.trim()) {
      return fail(res, "sessionKey and a message are required", 400);
    }
    try {
      // Attachments are not part of the native V1 surface; an empty grant keeps the shared
      // chat path's contract intact without exposing the attachment store to the desktop.
      ok(res, await submitChatTurn({ sessionKey, message, agentId, attachmentIds: [] }));
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Events -------------------------------------------------------------
  // Same SSE semantics and the same broadcast fan-out as /api/events, narrowed to DESKTOP_EVENTS.
  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(desktopEventFrame("gateway.status", gateway.status()));
    const unsubscribe = subscribe(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        unsubscribe();
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---- Nodes --------------------------------------------------------------
  router.get("/nodes", async (_req, res) => {
    try {
      ok(res, { nodes: await listNodes() });
    } catch (err) {
      fail(res, err);
    }
  });

  // ---- Remote access ------------------------------------------------------
  // Orion reports which native remote-desktop service is reachable on each node and records that
  // a session was opened. It never proxies a framebuffer or injects input: macOS Screen Sharing
  // and Windows RDP already do that properly, and a hand-written transport would be worse.
  router.get("/remote-access", async (_req, res) => {
    if (!remoteAccess) return fail(res, "Remote access discovery is not configured", 503);
    try {
      const nodes = await listNodes();
      ok(res, { nodes: await remoteAccess.describe(nodes) });
    } catch (err) {
      fail(res, err);
    }
  });

  // Records the intent to open a session. The response carries the host and scheme, never a
  // ready-made URL: the client builds its own from an allowlisted scheme so a compromised or
  // buggy server cannot hand the desktop an arbitrary URL to open.
  router.post("/remote-access/:nodeId/session", async (req, res) => {
    if (!remoteAccess) return fail(res, "Remote access discovery is not configured", 503);
    const kind = typeof req.body?.kind === "string" ? req.body.kind.trim() : "";
    const service = REMOTE_SERVICES.find((entry) => entry.kind === kind);
    if (!service) return fail(res, "unknown remote access service", 400);
    if (!service.scheme) return fail(res, `${service.label} is not something to launch`, 400);
    try {
      const nodes = await listNodes();
      const node = nodes.find((entry) => entry.id === req.params.nodeId);
      if (!node) return fail(res, "node not found", 404);

      // describe() resolves peers itself, so address resolution is identical to the read model.
      // Calling describeNode() directly here would skip tailnet discovery and see only overrides.
      const [described] = await remoteAccess.describe([node]);
      if (!described.host) return fail(res, described.hint ?? "no address for this node", 409);
      const available = described.services.find((entry) => entry.kind === kind);
      if (!available?.reachable) {
        return fail(res, `${service.label} is not reachable on ${node.name}`, 409);
      }

      const event = remoteAccess.recordSession({
        nodeId: node.id,
        kind,
        clientId: req.desktopClient.clientId,
      });
      ok(res, {
        host: described.host,
        port: service.port,
        scheme: service.scheme,
        service: service.kind,
        openedAt: event.at,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.get("/remote-access/audit", (_req, res) => {
    if (!remoteAccess) return fail(res, "Remote access discovery is not configured", 503);
    ok(res, { events: remoteAccess.audit() });
  });

  return router;
}

/** Projects a gateway node into the plan's read-only DesktopNodeSummary shape. */
export function toNodeSummary(node) {
  const commands = Array.isArray(node?.commands) ? node.commands : [];
  return {
    id: String(node?.nodeId ?? ""),
    name: typeof node?.displayName === "string" && node.displayName ? node.displayName : String(node?.nodeId ?? "unknown"),
    platform: normalizePlatform(node?.platform),
    status: node?.connected === true ? "online" : node?.connected === false ? "offline" : "unknown",
    // Coarsened so the native UI does not depend on gateway command spellings.
    capabilities: CAPABILITY_MAP.filter(({ commands: names }) =>
      names.some((name) => commands.includes(name)),
    ).map(({ capability }) => capability),
    ...(node?.lastSeen ? { lastSeenAt: new Date(node.lastSeen).toISOString() } : {}),
  };
}

/**
 * Projects a gateway session into a stable native shape. The agent id is derived from the session
 * key the same way the web client derives it, so both surfaces agree on which agent owns a
 * session without the native app parsing gateway key formats itself.
 */
export function toSessionSummary(session) {
  const key = String(session?.key ?? "");
  const title =
    firstNonEmpty(session?.derivedTitle, session?.label, session?.displayName) ?? "Untitled session";
  return {
    key,
    agentId: /^agent:([^:]+):/.exec(key)?.[1] ?? "main",
    title,
    model: firstNonEmpty(session?.model) ?? null,
    lastMessagePreview: firstNonEmpty(session?.lastMessagePreview) ?? null,
    hasActiveRun: session?.hasActiveRun === true,
    totalTokens: Number.isFinite(session?.totalTokens) ? session.totalTokens : null,
    contextTokens: Number.isFinite(session?.contextTokens) ? session.contextTokens : null,
    ...(Number.isFinite(session?.updatedAt)
      ? { updatedAt: new Date(session.updatedAt).toISOString() }
      : {}),
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizePlatform(value) {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("darwin") || text.includes("mac")) return "macos";
  if (text.includes("win")) return "windows";
  if (text.includes("linux")) return "linux";
  return "unknown";
}

/** Keeps an internal error string out of the response while still saying why a connect failed. */
function shortReason(error) {
  if (!error) return null;
  const text = String(error);
  if (/unauthor|forbidden|token/i.test(text)) return "gateway rejected the BFF credential";
  if (/ECONNREFUSED|connect|refused/i.test(text)) return "gateway not reachable from the host";
  if (/timeout|ETIMEDOUT/i.test(text)) return "gateway connection timed out";
  return "gateway connection failed";
}

function boundedLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
