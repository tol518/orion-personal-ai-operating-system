// One agent turn on one session key, with the gateway-side run treated as owned state.
//
// The earlier version of this logic simply stopped listening when its timer fired. The
// gateway kept running the turn, so the next message on that session queued behind a run
// nobody was waiting for any more (`reason=queued_behind_active_work`, observed live), and
// every retry inherited the same doomed queue. A turn we stop waiting for must therefore be
// aborted, and any run left over from a previous process must be cleared before sending.
import { randomUUID } from "node:crypto";

const SESSION_CONFLICT_ATTEMPTS = 5;
// OpenClaw's own retrying ingress waits at least five seconds after this store race. A sub-second
// retry repeatedly collides with the same commit and exhausts itself before the store settles.
const SESSION_CONFLICT_BACKOFF_MS = 5_000;
// Long enough for an aborted run to commit its session entry, short enough not to be felt.
const ABORT_SETTLE_MS = 400;

export class SessionTurnTimeoutError extends Error {
  constructor(message, { sessionKey, timeoutMs, aborted }) {
    super(message);
    this.name = "SessionTurnTimeoutError";
    this.code = "session_turn_timeout";
    this.sessionKey = sessionKey;
    this.timeoutMs = timeoutMs;
    this.aborted = aborted;
    this.statusCode = 504;
  }
}

/**
 * Send `message` and resolve with the assistant's final text. On timeout the run is aborted
 * and a SessionTurnTimeoutError is thrown, so the session is left idle and usable.
 */
export async function runSessionTurn({
  gateway,
  sessionKey,
  agentId = "main",
  message,
  attachments = [],
  timeoutMs,
  label = "run",
  conflictBackoffMs = SESSION_CONFLICT_BACKOFF_MS,
}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    // OpenClaw caches failed chat.send results by idempotency key. A session-init conflict occurs
    // before the agent run starts, so retry it with a new key instead of replaying the cached error.
    const idempotencyKey = randomUUID();
    try {
      return await sendAndWait({ gateway, sessionKey, agentId, message, attachments, timeoutMs, label, idempotencyKey });
    } catch (err) {
      // The gateway commits session state optimistically and gives up after one internal retry.
      // Losing that race is transient and says nothing about the prompt, so it is worth retrying
      // rather than failing the whole application with "reply session initialization conflicted".
      if (!isSessionInitConflict(err) || attempt >= SESSION_CONFLICT_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, conflictBackoffMs * attempt));
    }
  }
}

/** True for the gateway's optimistic-concurrency failure on a session entry. */
export function isSessionInitConflict(error) {
  return /session initialization conflicted|stale session snapshot|session state conflict/i.test(
    String(error?.message ?? error),
  );
}

async function sendAndWait({ gateway, sessionKey, agentId, message, attachments, timeoutMs, label, idempotencyKey }) {
  const waiter = waitForFinalText({ gateway, sessionKey, timeoutMs });
  try {
    await gateway.request("chat.send", {
      sessionKey,
      agentId,
      message,
      ...(attachments.length ? { attachments } : {}),
      deliver: false,
      idempotencyKey,
    });
  } catch (err) {
    waiter.cancel();
    throw err;
  }
  try {
    return await waiter.text;
  } catch (err) {
    if (err?.code !== "session_turn_timeout") throw err;
    const abort = await abortSessionRun({ gateway, sessionKey, agentId });
    throw new SessionTurnTimeoutError(
      `${label} did not finish within ${Math.round(timeoutMs / 1000)}s and ${describeAbort(abort)}.`,
      { sessionKey, timeoutMs, aborted: abort.aborted },
    );
  }
}

/**
 * Clear any run still executing on this session. Called before starting a turn because a
 * process restart (or a crash) can leave a run alive that would otherwise swallow the next
 * message. `aborted` distinguishes "stopped a live run" from "there was nothing left to
 * stop" (the gateway answers `{ ok: true, aborted: false, runIds: [] }` for the latter);
 * neither case is a reason to refuse to continue.
 */
export async function abortSessionRun({ gateway, sessionKey, agentId = "main", settleMs = ABORT_SETTLE_MS }) {
  try {
    const payload = await gateway.request("chat.abort", { sessionKey, agentId });
    const aborted = payload?.aborted !== false;
    // A torn-down run finishes writing its own session entry after the abort returns. Mutating
    // the session during that window is what produced the initialization conflict, so give it a
    // moment — but only when something was actually running.
    if (aborted && settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    return { ok: true, aborted };
  } catch (err) {
    return { ok: false, aborted: false, error: String(err?.message ?? err) };
  }
}

function describeAbort(abort) {
  if (!abort.ok) return "was left running because the abort call failed";
  return abort.aborted ? "was aborted" : "had already finished without reporting a result";
}

function waitForFinalText({ gateway, sessionKey, timeoutMs }) {
  let cancel = () => {};
  const text = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error("session turn timed out"), { code: "session_turn_timeout" }));
    }, timeoutMs);
    const onEvent = (event, payload) => {
      if (event !== "chat" || payload?.sessionKey !== sessionKey) return;
      if (payload?.state === "error") {
        cleanup();
        reject(new Error(payload?.errorMessage || "agent run failed"));
        return;
      }
      if (payload?.state !== "final") return;
      cleanup();
      resolve(messageText(payload.message));
    };
    const cleanup = () => {
      clearTimeout(timer);
      gateway.off("event", onEvent);
    };
    cancel = cleanup;
    gateway.on("event", onEvent);
  });
  // A rejected waiter that nobody awaits (send failed) must not surface as unhandled.
  text.catch(() => undefined);
  return { text, cancel: () => cancel() };
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((item) => (typeof item === "string" ? item : (item?.text ?? ""))).join("");
  }
  return "";
}

/** Retry a session-state write that lost the gateway's optimistic-concurrency race. */
export async function withSessionConflictRetry(run, { attempts = SESSION_CONFLICT_ATTEMPTS } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isSessionInitConflict(err) || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, SESSION_CONFLICT_BACKOFF_MS * attempt));
    }
  }
}
