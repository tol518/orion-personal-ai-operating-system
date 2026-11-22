import { api, type StoredAttachment } from "../../lib/api";
import { ConversationPreferences } from "./ConversationPreferences";
import { historyActivity } from "../../lib/chat/history";
import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { useStreamEvent } from "../../hooks/useStreamEvent";
import type { AgentRoomAgent, AgentRoomSession } from "../AgentRoom";
import {
  type Msg,
  messageText,
  historyMessages,
} from "../../lib/chat/messages";
import {
  type Approval,
  type Decision,
  type RunActivity,
  type ToolEvent,
  foldTool,
  followBottom,
} from "../../lib/chat/workspace";
import { Timeline } from "./Timeline";
import { Composer, useComposer } from "./Composer";
export function Conversation({
  sessionKey,
  approvals,
  resolve,
  sessionModel,
  session,
  agentId,
  chatAgents,
  onSelectAgent,
}: {
  sessionKey: string | null;
  approvals: Approval[];
  resolve: (id: string, decision: Decision) => Promise<void>;
  sessionModel?: string;
  session?: AgentRoomSession;
  agentId: string;
  chatAgents: AgentRoomAgent[];
  onSelectAgent?: (agentId: string) => Promise<void>;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(Boolean(session?.hasActiveRun));
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const accRef = useRef("");
  const liveRevision = useRef(0);
  const reconnecting = useRef(false);
  const sequence = useRef(0);
  const sentAt = useRef<number>();
  const activeAtMount = useRef(Boolean(session?.hasActiveRun));
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [jump, setJump] = useState(false);
  const [runs, setRuns] = useState<RunActivity[]>([]);
  const runId = useRef<string>();
  const finished = useRef(new Set<string>());
  const redirected = useRef(new Set<string>());
  /** The run a follow-up is steering right now; its abort may arrive before the reply. */
  const steering = useRef<string>();
  /**
   * OpenClaw steers by interrupting the running reply and starting a new run that includes
   * the follow-up. The interrupted run is redirected, not stopped: keep what it had written,
   * without a "stopped" notice. Idempotent, since the abort and the steer reply can race.
   */
  function redirect(previous: string) {
    if (redirected.current.has(previous)) return;
    redirected.current.add(previous);
    finished.current.add(previous);
    const partial = accRef.current;
    if (partial) {
      setMsgs((rows) => [
        ...rows,
        { role: "agent", id: "reply-" + previous, text: partial, time: Date.now() },
      ]);
    }
    accRef.current = "";
    setStreaming(null);
    const endedAt = Date.now();
    setRuns((rows) => rows.map((r) => (r.id === previous ? { ...r, endedAt } : r)));
    if (runId.current === previous) runId.current = undefined;
  }
  const queued = useRef<string[]>([]);
  const [stopping, setStopping] = useState(false);
  const [note, setNote] = useState("");
  function startRun(id: string, time: number) {
    const provisional = runId.current?.startsWith("local:")
      ? runId.current
      : undefined;
    runId.current = id;
    setRuns((rows) => {
      if (rows.some((r) => r.id === id)) return rows;
      if (provisional && rows.some((r) => r.id === provisional))
        return rows.map((r) => (r.id === provisional ? { ...r, id } : r));
      return [...rows, { id, time, tools: [] }];
    });
  }
  useStreamEvent("chat.tool", (tool: ToolEvent) => {
    if (tool.sessionKey !== sessionKey) return;
    liveRevision.current++;
    const id = tool.runId ?? runId.current ?? "local:" + tool.startedAt;
    if (finished.current.has(id) || redirected.current.has(id)) {
      setRuns((rows) => foldTool(rows, tool, id));
      return;
    }
    startRun(id, sentAt.current ?? tool.startedAt);
    setBusy(true);
    setRuns((rows) => foldTool(rows, tool, id));
  });

  useStreamEvent("chat", (event) => {
    if (!event) return;
    if (!sessionKey || event.sessionKey !== sessionKey) return;
    liveRevision.current++;
    const time = Date.now();
    const id = event.runId ?? runId.current ?? "local:" + time;
    const older =
      runId.current &&
      !runId.current.startsWith("local:") &&
      runId.current !== id &&
      event.state !== "delta";
    if (event.state === "aborted" && steering.current && id === steering.current) {
      redirect(id);
      return;
    }
    if (finished.current.has(id) || redirected.current.has(id)) return;
    if (!older) startRun(id, sentAt.current ?? time);
    if (event.state === "delta") {
      setBusy(true);
      accRef.current =
        messageText(event) ||
        (event.replace ? "" : accRef.current) + (event.deltaText ?? "");
      setStreaming(accRef.current);
    } else if (
      event.state === "final" ||
      event.state === "aborted" ||
      event.state === "error"
    ) {
      finished.current.add(id);
      queued.current = queued.current.filter((next) => next !== id);
      const text =
        messageText(event) ||
        (!older && accRef.current) ||
        event.errorMessage ||
        (event.state === "aborted" ? "Reply stopped." : "(no reply)");
      setMsgs((messages) => [
        ...messages,
        {
          role: "agent",
          time,
          id: "reply-" + id,
          text,
          memoryCitations: Array.isArray(event.memoryCitations)
            ? event.memoryCitations
            : [],
          savedMemories: Array.isArray(event.savedMemories)
            ? event.savedMemories
            : [],
          learnedLessons: Array.isArray(event.learnedLessons)
            ? event.learnedLessons
            : [],
        },
      ]);
      setRuns((rows) =>
        rows.map((r) => (r.id === id ? { ...r, endedAt: time } : r)),
      );
      if (older) return;
      setStreaming(null);
      accRef.current = "";
      sentAt.current = undefined;
      runId.current = undefined;
      setStopping(false);
      const next = queued.current.shift();
      if (next) {
        startRun(next, time);
        setBusy(true);
      } else setBusy(false);
    }
  });

  useEffect(() => {
    let active = true;
    const revision = liveRevision.current;
    if (!sessionKey) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    api
      .history(sessionKey)
      .then((historyResult) => {
        if (!active) return;

        if (revision === liveRevision.current && historyResult.hasActiveRun) {
          setBusy(true);
          runId.current = historyResult.activeRunId;
        }
        const history = historyMessages(historyResult);
        setMsgs((live) => [
          ...history,
          ...live.filter(
            (m) =>
              !history.some(
                (h) =>
                  h.role === m.role &&
                  h.text === m.text &&
                  Math.abs((h.time ?? 0) - (m.time ?? 0)) < 2000,
              ),
          ),
        ]);
        const restored = historyActivity(
          historyResult.messages ?? [],
          sessionKey,
          activeAtMount.current,
        );
        setRuns((live) => [
          ...restored.filter(
            (r) =>
              !live.some((l) => l.id === r.id) && (r.endedAt || !live.length),
          ),
          ...live,
        ]);
      })
      .catch((error) => {
        if (active)
          setHistoryError(error.message ?? "Could not load chat history");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [agentId, sessionKey]);

  useStreamEvent("stream.reconnected", () =>
    reloadHistory(true).catch((cause) => setHistoryError(String(cause))),
  );
  useStreamEvent("gateway.status", (status) => {
    if (!status.connected) {
      reconnecting.current = true;
      return;
    }
    if (reconnecting.current) {
      reconnecting.current = false;
      reloadHistory(true).catch((cause) => setHistoryError(String(cause)));
    }
  });
  async function reloadHistory(recover = false) {
    if (!sessionKey) return;
    const revision = liveRevision.current;
    const history = await api.history(sessionKey);
    if (revision !== liveRevision.current) return;
    if (recover) {
      setBusy(history.hasActiveRun === true);
      setStopping(false);
      runId.current = history.activeRunId;
      setStreaming(null);
      accRef.current = "";
    }
    setMsgs(historyMessages(history));
    setRuns(
      historyActivity(
        history.messages ?? [],
        sessionKey,
        history.hasActiveRun === true,
      ),
    );
  }
  async function stop() {
    if (!sessionKey || !busy || stopping) return;
    setStopping(true);
    try {
      await api.abort(
        sessionKey,
        runId.current?.startsWith("local:") ? undefined : runId.current,
      );
    } catch (error) {
      setStopping(false);
      setNote(String(error));
    }
  }
  async function send(text: string, attachments: StoredAttachment[]) {
    if (!sessionKey) throw new Error("Select a conversation");
    const id = "prompt-" + ++sequence.current;
    if (!busy) {
      sentAt.current = Date.now();
      startRun("local:" + id, sentAt.current);
    }
    setMsgs((rows) => [
      ...rows,
      { id, role: "user", text, attachments, time: Date.now() },
    ]);
    setNote("");
    setBusy(true);
    steering.current = busy ? runId.current : undefined;
    // The steered run starts after the follow-up, so its activity sorts below it.
    if (busy) sentAt.current = Date.now();
    try {
      const result = await api.chat(
        sessionKey,
        text,
        undefined,
        attachments.map((file) => file.id),
        busy ? "steer" : undefined,
      );
      const nextId = result.ack?.runId;
      if (busy && result.delivered === "turn")
        setNote("Queued as the next turn.");
      // OpenClaw steers by interrupting the running reply and starting a new run that
      // includes the follow-up. Follow the new run, and treat the old one as redirected
      // rather than stopped: keep what it had written, without a "stopped" notice.
      if (result.delivered === "steer" && nextId && nextId !== steering.current) {
        if (steering.current) redirect(steering.current);
        runId.current = undefined;
        sentAt.current = Date.now();
        startRun(nextId, sentAt.current);
        setBusy(true);
      }
      if (
        result.delivered === "turn" &&
        nextId &&
        !finished.current.has(nextId)
      ) {
        if (busy && runId.current && runId.current !== nextId)
          queued.current.push(nextId);
        else {
          startRun(nextId, sentAt.current ?? Date.now());
          setBusy(true);
        }
      }
    } catch (error) {
      setMsgs((rows) => rows.filter((m) => m.id !== id));
      if (runId.current === "local:" + id) {
        setRuns((rows) => rows.filter((r) => r.id !== "local:" + id));
        setBusy(false);
        runId.current = undefined;
        sentAt.current = undefined;
      }
      throw error;
    } finally {
      steering.current = undefined;
    }
  }
  const draft = useComposer(!sessionKey || loading, send);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [msgs, streaming, runs, approvals]);

  return (
    <div
      {...draft.dropProps}
      {...draft.pasteProps}
      className={`holo-panel hud-frame flex h-full min-h-0 flex-col p-4 ${draft.isDragging ? "attachment-dropzone" : ""}`}
    >
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = followBottom(
            el.scrollHeight,
            el.scrollTop,
            el.clientHeight,
          );
          setJump(!following.current);
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1"
      >
        {!loading && msgs.length === 0 && !streaming && !historyError && (
          <div className="mt-6 text-center font-mono text-xs text-gray-600">
            {sessionKey
              ? "Fresh context. Speak to the agent…"
              : "No session available yet."}
          </div>
        )}
        {historyError && (
          <div className="mx-auto mt-6 max-w-md rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-center font-mono text-xs text-red-300">
            {historyError}
          </div>
        )}
        <Timeline
          messages={msgs}
          runs={runs}
          approvals={approvals}
          resolve={resolve}
          streaming={streaming}
          runId={runId.current}
        />
      </div>
      {jump && (
        <button
          className="btn-hud self-center"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Jump to latest
        </button>
      )}
      {note && (
        <div role="status" className="text-xs text-amber-200">
          {note}
        </div>
      )}
      <Composer
        fields={draft.fields}
        busy={busy}
        stopping={stopping}
        stop={stop}
      />
      <ConversationPreferences
        {...{
          sessionKey,
          session,
          sessionModel,
          agentId,
          chatAgents,
          onSelectAgent,
          busy,
        }}
        onCompact={reloadHistory}
      />
    </div>
  );
}
