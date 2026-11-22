import express from "express";

const decisions = new Set(["allow-once", "allow-always", "deny"]);
const levels = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
  "max",
  "on",
]);

function requireValue(condition, message, statusCode = 400) {
  if (!condition) throw Object.assign(new Error(message), { statusCode });
}

export function normalizeTool(payload, previous) {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload.event ?? payload;
  const data = envelope.data ?? envelope.tool ?? envelope;
  const sessionKey = payload.sessionKey ?? payload.key;
  const toolCallId = data.toolCallId ?? payload.toolCallId;
  if (!sessionKey || !toolCallId) return null;
  const phase = data.phase ?? data.status;
  const status =
    data.isError || data.result?.isError || ["error", "failed"].includes(phase)
      ? "error"
      : ["end", "done", "result", "completed"].includes(phase)
        ? "done"
        : "running";
  const args = data.args ?? data.input ?? {};
  const result = data.output ?? data.result ?? data.partialResult;
  const output =
    typeof result === "string"
      ? result
      : Array.isArray(result?.content)
        ? result.content.map((block) => block.text ?? "").join("\n")
        : result == null
          ? undefined
          : JSON.stringify(result);
  const time = envelope.ts ?? payload.ts ?? data.ts ?? Date.now();
  const paths = [
    args.path,
    args.file_path,
    args.filePath,
    ...(Array.isArray(data.paths) ? data.paths : []),
  ].filter((p) => typeof p === "string");
  return {
    ...previous,
    sessionKey,
    toolCallId,
    runId: envelope.runId ?? payload.runId ?? previous?.runId,
    name: data.name ?? data.toolName ?? previous?.name ?? "Tool",
    status,
    startedAt: previous?.startedAt ?? data.startedAt ?? time,
    ...(status !== "running" && { endedAt: data.endedAt ?? time }),
    ...(typeof data.summary === "string" && { summary: data.summary }),
    ...(typeof (args.command ?? data.command) === "string" && {
      command: args.command ?? data.command,
    }),
    ...(output !== undefined && {
      output: Buffer.from(output)
        .subarray(0, 4096)
        .toString()
        .replace(/\uFFFD$/, ""),
    }),
    ...(paths.length && { paths }),
  };
}

function approval(payload, previous, resolved = false) {
  const request = payload.request ?? payload;
  const expiresAt =
    payload.expiresAtMs ?? payload.expiresAt ?? previous?.expiresAt;
  const decision = payload.decision;
  const reported = ["approved", "denied", "expired"].includes(payload.status)
    ? payload.status
    : undefined;
  const status =
    decision === "deny"
      ? "denied"
      : decisions.has(decision)
        ? "approved"
        : reported
          ? reported
          : resolved || (expiresAt && expiresAt <= Date.now())
            ? "expired"
            : "pending";
  return {
    id: payload.id,
    sessionKey:
      request.sessionKey ??
      request.systemRunPlan?.sessionKey ??
      previous?.sessionKey,
    command:
      request.command ??
      request.systemRunPlan?.commandText ??
      request.commandArgv?.join(" ") ??
      previous?.command ??
      "",
    cwd: request.cwd ?? request.systemRunPlan?.cwd ?? previous?.cwd,
    host: request.host ?? previous?.host,
    requestedAt:
      payload.createdAtMs ??
      payload.requestedAt ??
      previous?.requestedAt ??
      Date.now(),
    expiresAt,
    status,
  };
}

export function createChatState({
  gateway,
  database,
  broadcast,
  ownsInternalSession = () => false,
}) {
  database?.exec(
    "CREATE TABLE IF NOT EXISTS archived_sessions(session_key TEXT PRIMARY KEY, archived_at TEXT NOT NULL)",
  );
  const running = new Map();
  const reportedRunning = new Set();
  const completed = new Set();
  let revision = 0;
  const isRunning = (key) => running.has(key) || reportedRunning.has(key);
  const subscriptions = new Map();
  const calls = new Map();
  const pending = new Map();
  const parents = new Map();
  function internal(key) {
    const visited = new Set();
    while (parents.has(key) && !visited.has(key)) {
      visited.add(key);
      key = parents.get(key);
    }
    return ownsInternalSession(key);
  }
  function subscribe(key) {
    const existing = subscriptions.get(key);
    subscriptions.delete(key);
    const request =
      existing ??
      gateway.request("sessions.messages.subscribe", { key }).catch(() => {
        if (subscriptions.get(key) === request) subscriptions.delete(key);
      });
    subscriptions.set(key, request);
    if (subscriptions.size > 20) {
      const oldest = subscriptions.keys().next().value;
      subscriptions.delete(oldest);
      gateway
        .request("sessions.messages.unsubscribe", { key: oldest })
        .catch(() => {});
    }
    return request;
  }
  return {
    isRunning,
    activeRun: (key) => running.get(key),
    accepted(key, ack) {
      if (
        ack?.runId &&
        !completed.has(ack.runId) &&
        !running.has(key) &&
        ack.status !== "completed"
      )
        running.set(key, ack.runId);
    },
    async history(key, maxChars) {
      await subscribe(key);
      const history = await gateway.request("chat.history", {
        sessionKey: key,
        limit: 200,
        maxChars,
      });
      return {
        ...history,
        hasActiveRun: isRunning(key),
        activeRunId: running.get(key),
        messages: (history.messages ?? []).map((message) => ({
          ...message,
          timestamp:
            message.timestamp ?? message.ts ?? message.createdAt ?? null,
        })),
      };
    },
    subscribe,
    internal,
    reconnect() {
      const keys = [...subscriptions.keys()];
      subscriptions.clear();
      keys.forEach(subscribe);
    },
    event(event, payload) {
      const key = payload?.sessionKey;
      if (event === "gateway.disconnected") {
        revision++;
        running.clear();
        reportedRunning.clear();
        calls.clear();
      }
      if (event === "chat" && key) {
        revision++;
        reportedRunning.delete(key);
        if (
          payload.runId &&
          ["final", "error", "aborted"].includes(payload.state)
        ) {
          completed.add(payload.runId);
          if (completed.size > 500)
            completed.delete(completed.values().next().value);
        }
        if (payload.state === "delta") running.set(key, payload.runId);
        else if (
          ["final", "error", "aborted"].includes(payload.state) &&
          (!running.get(key) ||
            !payload.runId ||
            running.get(key) === payload.runId)
        )
          running.delete(key);
      }
      // OpenClaw reports live tool calls on the agent stream (`stream: "tool"`, phases
      // `start` / `update` / `result`); `session.tool` is kept for gateways that send it.
      if (
        event === "session.tool" ||
        (event === "agent" && payload?.stream === "tool")
      ) {
        const initial = normalizeTool(payload);
        if (!initial || internal(initial.sessionKey)) return;
        const id = JSON.stringify([initial.sessionKey, initial.toolCallId]);
        const tool = normalizeTool(payload, calls.get(id));
        if (tool.status === "running") {
          calls.set(id, tool);
          if (!completed.has(tool.runId))
            running.set(tool.sessionKey, tool.runId);
        } else calls.delete(id);
        if (calls.size > 500) calls.delete(calls.keys().next().value);
        broadcast("chat.tool", tool);
      }
      if (event.startsWith("exec.approval.") && payload?.id) {
        const record = approval(
          payload,
          pending.get(payload.id),
          event.endsWith(".resolved"),
        );
        if (record.status === "pending") pending.set(record.id, record);
        else pending.delete(record.id);
        if (!internal(record.sessionKey)) broadcast("chat.approval", record);
      }
    },
    async approvals() {
      const result = await gateway.request("exec.approval.list", {});
      const records = (
        Array.isArray(result)
          ? result
          : (result.requests ??
            result.approvals ??
            result.pending ??
            result.items ??
            [])
      ).map((row) => approval(row));
      for (const record of records)
        if (record.status === "pending") pending.set(record.id, record);
      return records.filter(
        (record) => record.status === "pending" && !internal(record.sessionKey),
      );
    },
    archive(key, archived) {
      requireValue(typeof archived === "boolean", "archived must be a boolean");
      requireValue(
        !archived || !/^(main|global|agent:[^:]+:main)$/.test(key),
        "Main conversations cannot be archived",
      );
      if (archived)
        database
          .prepare("INSERT OR REPLACE INTO archived_sessions VALUES (?,?)")
          .run(key, new Date().toISOString());
      else
        database
          .prepare("DELETE FROM archived_sessions WHERE session_key=?")
          .run(key);
      broadcast("sessions.changed", { key });
    },
    async list(limit, archived) {
      const keys = new Set(
        database
          ?.prepare("SELECT session_key FROM archived_sessions")
          .all()
          .map((row) => row.session_key),
      );
      const sessions = [];
      const seen = new Set();
      let offset = 0;
      let result;
      do {
        const before = revision;
        const page = await gateway.request("sessions.list", {
          limit,
          ...(offset && { offset }),
          includeDerivedTitles: true,
          includeLastMessage: true,
        });
        result ??= page;
        const rows = page.sessions ?? [];
        for (const row of rows) {
          if (before === revision && typeof row.hasActiveRun === "boolean") {
            if (row.hasActiveRun) reportedRunning.add(row.key);
            else reportedRunning.delete(row.key);
          }
          if (row.spawnedBy) parents.set(row.key, row.spawnedBy);
          else parents.delete(row.key);
        }
        const fresh = rows.filter((row) => !seen.has(row.key));
        for (const row of fresh) {
          seen.add(row.key);
          if (keys.has(row.key) !== archived) continue;
          sessions.push({
            ...row,
            ...(row.spawnedBy && { parentKey: row.spawnedBy }),
            ...(internal(row.key) && { internal: true }),
            ...(isRunning(row.key) && { hasActiveRun: true }),
          });
        }
        offset += rows.length;
        if (
          !fresh.length ||
          rows.length < limit ||
          (archived && sessions.length >= keys.size)
        )
          break;
      } while (sessions.length < limit);
      return { ...result, sessions: sessions.slice(0, limit) };
    },
  };
}

export function createChatRouter({
  gateway,
  state,
  attachmentStore,
  submitChatTurn,
  modelOptionsFromConfig,
  executionTargets,
  getExecutionDevices,
  patchSessionExecutionTarget,
  projectSession,
  grantSteeredAttachments,
}) {
  const router = express.Router();
  const ok = (res, payload) => res.json({ ok: true, ...payload });
  const fail = (res, err, code = 502) =>
    res
      .status(err?.statusCode ?? code)
      .json({ ok: false, error: String(err?.message ?? err) });
  function handle(method, path, action, errorCode = 400) {
    router[method](path, async (req, res) => {
      try {
        ok(res, await action(req));
      } catch (error) {
        fail(res, error, errorCode);
      }
    });
  }
  handle(
    "get",
    "/sessions",
    async (req) => {
      const n = Number(req.query.limit);
      const limit =
        Number.isInteger(n) && n > 0
          ? Math.min(n, req.desktopClient ? 100 : 1000)
          : 20;
      const result = await state.list(limit, req.query.archived === "1");
      return req.desktopClient
        ? { sessions: result.sessions.map(projectSession) }
        : result;
    },
    502,
  );
  handle("post", "/chat/abort", (req) => {
    const { sessionKey, runId } = req.body ?? {};
    requireValue(
      typeof sessionKey === "string" && sessionKey.trim(),
      "sessionKey required",
    );
    return gateway.request("chat.abort", {
      sessionKey,
      ...(runId && { runId }),
    });
  });
  handle(
    "post",
    "/chat",
    async (req) => {
      const {
        sessionKey,
        message = "",
        agentId,
        attachmentIds = [],
        mode,
      } = req.body ?? {};
      requireValue(
        typeof sessionKey === "string" &&
          sessionKey.trim() &&
          typeof message === "string",
        "sessionKey and message required",
      );
      requireValue(
        Array.isArray(attachmentIds) &&
          attachmentIds.length <= 8 &&
          attachmentIds.every(
            (id) => typeof id === "string" && attachmentStore.get(id),
          ),
        "Provide up to eight valid attachment IDs",
      );
      requireValue(
        message.trim() || attachmentIds.length,
        "Message or attachment required",
      );
      await state.subscribe(sessionKey);
      if (mode === "steer" && state.isRunning(sessionKey)) {
        const activeRun = state.activeRun(sessionKey);
        try {
          const ack = await gateway.request("sessions.steer", {
            key: sessionKey,
            message,
            ...(agentId && { agentId }),
            ...(attachmentIds.length && {
              attachments: attachmentStore.gatewayPayloads(attachmentIds),
            }),
          });
          if (
            ack !== false &&
            ack?.ok !== false &&
            ack?.accepted !== false &&
            ack?.steered !== false &&
            ![
              "idle",
              "rejected",
              "refused",
              "error",
              "not-running",
              "not_running",
              "no-active-run",
            ].includes(ack?.status)
          ) {
            // A steer interrupts the active run and starts a new one, so the memory grant
            // belongs to the run the gateway just started (falling back to the old one).
            if (attachmentIds.length)
              grantSteeredAttachments?.(
                sessionKey,
                ack?.runId ?? activeRun,
                attachmentIds,
                activeRun,
              );
            return { ack, delivered: "steer" };
          }
        } catch (error) {
          if (
            /gateway (socket closed|not connected)|timed? ?out/i.test(
              error.message,
            )
          )
            throw error;
          /* The full turn handles a session that stopped accepting steering. */
        }
      }
      const result = await submitChatTurn({
        sessionKey,
        message,
        agentId,
        attachmentIds,
      });
      state.accepted(sessionKey, result.ack);
      return { ...result, delivered: "turn" };
    },
    502,
  );
  handle("put", "/sessions/:key/thinking", (req) => {
    requireValue(levels.has(req.body?.level), "Unknown thinking level");
    return gateway.request("sessions.patch", {
      key: req.params.key,
      thinkingLevel: req.body.level,
    });
  });
  handle("patch", "/sessions/:key", (req) => {
    const label = typeof req.body?.label === "string" && req.body.label.trim();
    requireValue(
      label && label.length <= 120,
      "Label must be 1–120 characters",
    );
    return gateway.request("sessions.patch", { key: req.params.key, label });
  });
  handle("put", "/sessions/:key/archive", (req) => {
    state.archive(req.params.key, req.body?.archived);
    return { archived: req.body.archived };
  });
  handle("post", "/sessions/:key/compact", (req) => {
    requireValue(
      !state.isRunning(req.params.key),
      "Wait for the current run to finish",
      409,
    );
    return gateway.request("sessions.compact", { key: req.params.key });
  });
  handle(
    "get",
    "/approvals",
    async () => ({ approvals: await state.approvals() }),
    502,
  );
  handle("post", "/approvals/:id", (req) => {
    requireValue(
      decisions.has(req.body?.decision),
      "Unknown approval decision",
    );
    return gateway.request("exec.approval.resolve", {
      id: req.params.id,
      decision: req.body.decision,
    });
  });

  router.post("/attachments", express.json({ limit: "215mb" }), (req, res) => {
    try {
      const files = req.body?.attachments;
      requireValue(
        Array.isArray(files) && files.length > 0,
        "Choose at least one file",
      );
      ok(res, { attachments: attachmentStore.saveMany(files) });
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.post("/sessions/:key/reset", async (req, res) => {
    const agentId =
      typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    try {
      ok(
        res,
        await gateway.request("sessions.reset", {
          key: req.params.key,
          ...(agentId ? { agentId } : {}),
          reason: "new",
        }),
      );
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.delete("/sessions/:key", async (req, res) => {
    const agentId =
      typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    try {
      const result = await gateway.request("sessions.delete", {
        key: req.params.key,
        ...(agentId ? { agentId } : {}),
        deleteTranscript: true,
      });
      executionTargets.delete(req.params.key);
      state.archive(req.params.key, false);
      ok(res, result);
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.get("/sessions/:key/execution-target", async (req, res) => {
    try {
      const devices = await getExecutionDevices();
      ok(res, { target: executionTargets.get(req.params.key), devices });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/sessions/:key/execution-target", async (req, res) => {
    const target =
      typeof req.body?.target === "string" ? req.body.target.trim() : "";
    const agentId =
      typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    try {
      const devices = await getExecutionDevices();
      await patchSessionExecutionTarget(
        req.params.key,
        agentId,
        target,
        devices,
      );
      executionTargets.set(req.params.key, target);
      ok(res, { target, devices });
    } catch (err) {
      fail(res, err, 400);
    }
  });

  router.get("/agents/:agentId/models", async (req, res) => {
    try {
      const [config, catalog] = await Promise.all([
        gateway.request("config.get", {}),
        gateway
          .request("models.list", { view: "configured" })
          .catch(() => ({ models: [] })),
      ]);
      const result = modelOptionsFromConfig(config, req.params.agentId);
      const models = result.models.map((option) => {
        const entry = catalog.models?.find(
          (model) =>
            model.id === option.id ||
            model.provider + "/" + model.id === option.id,
        );
        return typeof entry?.reasoning === "boolean"
          ? { ...option, reasoning: entry.reasoning }
          : option;
      });
      ok(res, { ...result, models });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put("/sessions/:key/model", async (req, res) => {
    const agentId =
      typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    const model =
      typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!agentId || !model) return fail(res, "agentId and model required", 400);
    try {
      const config = await gateway.request("config.get", {});
      if (
        !modelOptionsFromConfig(config, agentId).models.some(
          (entry) => entry.id === model,
        )
      ) {
        return fail(res, "model is not enabled for this agent", 400);
      }
      ok(
        res,
        await gateway.request("sessions.patch", {
          key: req.params.key,
          agentId,
          model,
        }),
      );
    } catch (err) {
      fail(res, err, 400);
    }
  });
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    fail(res, error, error.status ?? 500);
  });
  return router;
}
