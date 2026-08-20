import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit,
  Clock3,
  Laptop,
  LoaderCircle,
  MessageSquarePlus,
  MonitorCog,
  Network,
  Paperclip,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type ExecutionDevice,
  type AgentModels,
  type ExecutionTarget,
  type ExecutionTargetState,
  type StoredAttachment,
} from "../lib/api";
import { useStreamEvent } from "../hooks/useStreamEvent";
import { ATTACHMENT_ACCEPT, useAttachmentDrop } from "../hooks/useAttachmentDrop";
import type { AgentRoomAgent, AgentRoomSession } from "./AgentRoom";

type MemoryCitation = { id: string; title: string };
type LearnedLesson = { id?: string; title: string };
type SavedMemory = { id: string; title: string };
type Msg = {
  role: "user" | "agent";
  text: string;
  memoryCitations?: MemoryCitation[];
  savedMemories?: SavedMemory[];
  learnedLessons?: LearnedLesson[];
  attachments?: StoredAttachment[];
};

type Props = {
  sessionKey: string | null;
  sessions?: AgentRoomSession[];
  agents?: AgentRoomAgent[];
  showSessions?: boolean;
  onSelectSession?: (sessionKey: string) => void;
  onSelectAgent?: (agentId: string) => Promise<void>;
  onNewChat?: () => Promise<void>;
  onRemoveSession?: (session: AgentRoomSession) => Promise<void>;
};

const CITATION_MARKER = /<!--\s*jarvis-memory-citations\s*:\s*([\s\S]*?)-->/i;
const ALL_HIDDEN_MARKERS = /<!--\s*jarvis-(?:memory-(?:citations|proposals)|managed-memory-upserts)\s*:[\s\S]*?-->/gi;
const MEMORY_CONTEXT_PREFIX = "<jarvis-memory-context>";
const ATTACHMENT_CONTEXT = /<jarvis-attachments>\n([\s\S]*?)\n<\/jarvis-attachments>/i;
const EMPTY_EXECUTION_STATE: ExecutionTargetState = {
  target: "neutral",
  devices: {
    mac: { name: "Mac", nodeId: null, available: false },
    windows: { name: "Windows", nodeId: null, available: false },
  },
};
const CHAT_AGENT_NAMES: Record<string, string> = {
  main: "J.A.R.V.I.S.",
  codex: "WALL-E",
};

function chatAgentName(agent: AgentRoomAgent): string {
  return CHAT_AGENT_NAMES[agent.id] || agent.identity?.name?.trim() || agent.name?.trim() || agent.id;
}

function isPrimarySession(key: string): boolean {
  return key === "main" || key === "global" || /^agent:[^:]+:main$/.test(key);
}

function agentIdFromSessionKey(key: string | null): string {
  if (!key || key === "main" || key === "global") return "main";
  return /^agent:([^:]+):/.exec(key)?.[1] ?? "main";
}

function isJarvisChat(session: AgentRoomSession, activeKey: string | null): boolean {
  return (
    session.key === activeKey ||
    isPrimarySession(session.key) ||
    session.key.includes(":dashboard:")
  );
}

function sessionTitle(session: AgentRoomSession): string {
  if (session.label?.trim()) return session.label.trim();
  if (isPrimarySession(session.key)) return "Main conversation";
  if (session.derivedTitle?.trim()) return session.derivedTitle.trim();
  if (session.displayName?.trim()) return session.displayName.trim();
  return "Untitled conversation";
}

function formatSessionTime(updatedAt?: number): string {
  if (!updatedAt) return "Fresh context";
  const date = new Date(updatedAt);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatTokens(value?: number): string {
  if (!Number.isFinite(value)) return "—";
  const amount = value ?? 0;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}k`;
  return String(Math.round(amount));
}

function contextPercent(session?: AgentRoomSession): number | null {
  const used = session?.totalTokens;
  const limit = session?.contextTokens;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || (limit ?? 0) <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((used ?? 0) / (limit ?? 1)) * 100)));
}

function textFromMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const value = message as { text?: unknown; content?: unknown };
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map((item) => {
        if (typeof item === "string") return item;
        if (!item || typeof item !== "object") return "";
        const block = item as { text?: unknown };
        return typeof block.text === "string" ? block.text : "";
      })
      .join("");
  }
  return "";
}

function messageText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  return textFromMessage((event as { message?: unknown }).message);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function unwrapUserMessage(text: string): string {
  if (!text.startsWith(MEMORY_CONTEXT_PREFIX)) return text;
  const userMarker = "\n\nUser message:\n";
  const rulesMarker = "\n\nMemory rules:\n";
  const start = text.indexOf(userMarker);
  const end = text.indexOf(rulesMarker, start + userMarker.length);
  if (start === -1 || end === -1) return text;
  return text.slice(start + userMarker.length, end);
}

function historyMessage(value: unknown): Msg | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { role?: unknown };
  if (message.role !== "user" && message.role !== "assistant") return null;
  const rawText = textFromMessage(message);
  if (!rawText.trim()) return null;

  if (message.role === "user") {
    const match = rawText.match(ATTACHMENT_CONTEXT);
    const parsed = match ? parseJsonArrayObject(match[1]) : null;
    return {
      role: "user",
      text: unwrapUserMessage(rawText),
      attachments: Array.isArray(parsed?.user) ? parsed.user as StoredAttachment[] : [],
    };
  }

  const citationMatch = rawText.match(CITATION_MARKER);
  const memoryCitations = citationMatch
    ? parseJsonArray(citationMatch[1]).map((id) => ({ id: String(id), title: String(id) }))
    : [];
  return {
    role: "agent",
    text: rawText.replace(ALL_HIDDEN_MARKERS, "").trimEnd(),
    memoryCitations,
  };
}

function parseJsonArrayObject(value: string): { user?: unknown[] } | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function historyMessages(payload: unknown): Msg[] {
  if (!payload || typeof payload !== "object") return [];
  const messages = (payload as { messages?: unknown }).messages;
  return Array.isArray(messages)
    ? messages.map(historyMessage).filter((message): message is Msg => message !== null)
    : [];
}

export default function Chat({
  sessionKey,
  sessions = [],
  agents = [],
  showSessions = false,
  onSelectSession,
  onSelectAgent,
  onNewChat,
  onRemoveSession,
}: Props) {
  const visibleSessions = useMemo(
    () =>
      sessions
        .filter((session) => isJarvisChat(session, sessionKey))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [sessionKey, sessions],
  );

  const activeSession = sessions.find((session) => session.key === sessionKey);
  const sessionModel = activeSession?.model;
  const agentId = agentIdFromSessionKey(sessionKey);
  const chatAgents = useMemo(() => {
    const available = agents.filter((agent) => agent.id.trim());
    if (available.some((agent) => agent.id === agentId)) return available;
    return [...available, { id: agentId }];
  }, [agentId, agents]);

  if (!showSessions) {
    return (
      <Conversation
        sessionKey={sessionKey}
        sessionModel={sessionModel}
        session={activeSession}
        agentId={agentId}
        chatAgents={chatAgents}
        onSelectAgent={onSelectAgent}
      />
    );
  }

  return (
    <div className="grid h-full min-h-0 gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
      <ConversationRail
        sessions={visibleSessions}
        sessionKey={sessionKey}
        onSelectSession={onSelectSession}
        onNewChat={onNewChat}
        onRemoveSession={onRemoveSession}
      />
      <div className="min-h-0">
        <Conversation
          sessionKey={sessionKey}
          sessionModel={sessionModel}
          session={activeSession}
          agentId={agentId}
          chatAgents={chatAgents}
          onSelectAgent={onSelectAgent}
        />
      </div>
    </div>
  );
}

function ConversationRail({
  sessions,
  sessionKey,
  onSelectSession,
  onNewChat,
  onRemoveSession,
}: {
  sessions: AgentRoomSession[];
  sessionKey: string | null;
  onSelectSession?: (sessionKey: string) => void;
  onNewChat?: () => Promise<void>;
  onRemoveSession?: (session: AgentRoomSession) => Promise<void>;
}) {
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createChat() {
    if (!onNewChat || actionKey) return;
    setActionKey("new");
    setError(null);
    try {
      await onNewChat();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a new chat");
    } finally {
      setActionKey(null);
    }
  }

  async function removeChat(session: AgentRoomSession) {
    if (!onRemoveSession || actionKey) return;
    const primary = isPrimarySession(session.key);
    const confirmed = window.confirm(
      primary
        ? "Clear the main conversation and start it with a fresh context?"
        : `Delete “${sessionTitle(session)}” and its transcript? This cannot be undone.`,
    );
    if (!confirmed) return;
    setActionKey(session.key);
    setError(null);
    try {
      await onRemoveSession(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this conversation");
    } finally {
      setActionKey(null);
    }
  }

  return (
    <aside className="holo-panel hud-frame flex min-h-0 flex-col p-3 max-md:max-h-44">
      <button
        type="button"
        className="btn-hud flex w-full items-center justify-center gap-2 px-3 py-2 font-mono text-xs uppercase tracking-[0.12em] disabled:opacity-50"
        onClick={createChat}
        disabled={!onNewChat || actionKey !== null}
      >
        {actionKey === "new" ? (
          <LoaderCircle size={14} className="animate-spin" />
        ) : (
          <MessageSquarePlus size={14} />
        )}
        New chat
      </button>

      <div className="hud-label mb-2 mt-4 flex items-center justify-between">
        <span>Conversations</span>
        <span className="text-[0.6rem] text-gray-500">{sessions.length}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {sessions.map((session) => {
          const active = session.key === sessionKey;
          const primary = isPrimarySession(session.key);
          const removable = primary || session.key.includes(":dashboard:");
          return (
            <div
              key={session.key}
              className={`group flex items-center gap-1 rounded-lg border transition-colors ${
                active
                  ? "border-accent/45 bg-accent/10"
                  : "border-transparent hover:border-hudborder hover:bg-white/[0.025]"
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 px-2.5 py-2 text-left"
                onClick={() => onSelectSession?.(session.key)}
              >
                <span className={`block truncate text-xs ${active ? "text-accent-hover" : "text-gray-300"}`}>
                  {sessionTitle(session)}
                </span>
                <span className="mt-1 flex items-center gap-1 font-mono text-[0.58rem] uppercase tracking-[0.08em] text-gray-600">
                  <Clock3 size={9} /> {formatSessionTime(session.updatedAt)}
                  {contextPercent(session) !== null
                    ? ` · ${contextPercent(session)}% context`
                    : ""}
                </span>
              </button>
              {removable && (
                <button
                  type="button"
                  className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-gray-600 opacity-70 transition hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100 disabled:opacity-40"
                  aria-label={primary ? `Clear ${sessionTitle(session)}` : `Delete ${sessionTitle(session)}`}
                  title={primary ? "Clear conversation" : "Delete conversation"}
                  onClick={() => removeChat(session)}
                  disabled={actionKey !== null}
                >
                  {actionKey === session.key ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : primary ? (
                    <RotateCcw size={13} />
                  ) : (
                    <Trash2 size={13} />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="mt-2 rounded border border-red-500/25 bg-red-500/5 p-2 text-[0.65rem] text-red-300">{error}</div>}
    </aside>
  );
}

function Conversation({
  sessionKey,
  sessionModel,
  session,
  agentId,
  chatAgents,
  onSelectAgent,
}: {
  sessionKey: string | null;
  sessionModel?: string;
  session?: AgentRoomSession;
  agentId: string;
  chatAgents: AgentRoomAgent[];
  onSelectAgent?: (agentId: string) => Promise<void>;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<StoredAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [executionState, setExecutionState] = useState<ExecutionTargetState>(
    EMPTY_EXECUTION_STATE,
  );
  const [targetBusy, setTargetBusy] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [agentModels, setAgentModels] = useState<AgentModels | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const accRef = useRef("");
  const activityRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useStreamEvent("chat", (event) => {
    if (!event) return;
    if (sessionKey && event.sessionKey && event.sessionKey !== sessionKey) return;
    if (event.state === "delta") {
      activityRef.current += 1;
      accRef.current += event.deltaText ?? "";
      setStreaming(accRef.current);
    } else if (event.state === "final" || event.state === "aborted" || event.state === "error") {
      activityRef.current += 1;
      const text = messageText(event) || accRef.current || event.errorMessage || "(no reply)";
      setMsgs((messages) => [
        ...messages,
        {
          role: "agent",
          text,
          memoryCitations: Array.isArray(event.memoryCitations) ? event.memoryCitations : [],
          savedMemories: Array.isArray(event.savedMemories) ? event.savedMemories : [],
          learnedLessons: Array.isArray(event.learnedLessons) ? event.learnedLessons : [],
        },
      ]);
      setStreaming(null);
      accRef.current = "";
      setBusy(false);
    }
  });

  useEffect(() => {
    let active = true;
    activityRef.current += 1;
    const requestActivity = activityRef.current;
    setMsgs([]);
    setStreaming(null);
    setBusy(false);
    setHistoryError(null);
    setExecutionState(EMPTY_EXECUTION_STATE);
    setTargetBusy(false);
    setTargetError(null);
    setAgentModels(null);
    setModelOverride(null);
    setModelBusy(false);
    setModelError(null);
    setAgentBusy(false);
    setAgentError(null);
    accRef.current = "";
    if (!sessionKey) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    Promise.allSettled([
      api.history(sessionKey),
      api.executionTarget(sessionKey),
      api.agentModels(agentId),
    ]).then(
      ([historyResult, targetResult, modelResult]) => {
        if (!active) return;
        if (historyResult.status === "fulfilled") {
          if (activityRef.current === requestActivity) {
            setMsgs(historyMessages(historyResult.value));
          }
        } else {
          setHistoryError(historyResult.reason?.message ?? "Could not load chat history");
        }
        if (targetResult.status === "fulfilled") {
          setExecutionState(targetResult.value);
        } else {
          setTargetError(targetResult.reason?.message ?? "Could not load device routing");
        }
        if (modelResult.status === "fulfilled") {
          setAgentModels(modelResult.value);
        } else {
          setModelError(modelResult.reason?.message ?? "Could not load model choices");
        }
        setLoading(false);
      },
    );

    return () => {
      active = false;
    };
  }, [agentId, sessionKey]);

  async function selectAgent(nextAgentId: string) {
    if (!onSelectAgent || agentBusy || nextAgentId === agentId) return;
    setAgentBusy(true);
    setAgentError(null);
    try {
      await onSelectAgent(nextAgentId);
    } catch (cause) {
      setAgentError(cause instanceof Error ? cause.message : "Could not switch agent");
    } finally {
      setAgentBusy(false);
    }
  }

  async function selectExecutionTarget(target: ExecutionTarget) {
    if (!sessionKey || targetBusy || target === executionState.target) return;
    setTargetBusy(true);
    setTargetError(null);
    try {
      setExecutionState(await api.setExecutionTarget(sessionKey, target));
    } catch (cause) {
      setTargetError(cause instanceof Error ? cause.message : "Could not change device routing");
    } finally {
      setTargetBusy(false);
    }
  }

  async function selectModel(model: string) {
    if (!sessionKey || modelBusy || model === sessionModel) return;
    setModelBusy(true);
    setModelError(null);
    try {
      await api.setSessionModel(sessionKey, agentId, model);
      setModelOverride(model);
      setAgentModels((current) => (current ? { ...current, current: model } : current));
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : "Could not change model");
    } finally {
      setModelBusy(false);
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, streaming]);

  async function send() {
    const text = input.trim();
    if ((!text && !attachments.length) || !sessionKey || busy || uploading) return;
    const sentAttachments = attachments;
    activityRef.current += 1;
    setMsgs((messages) => [...messages, { role: "user", text, attachments: sentAttachments }]);
    setInput("");
    setAttachments([]);
    setBusy(true);
    accRef.current = "";
    try {
      await api.chat(sessionKey, text, undefined, sentAttachments.map(({ id }) => id));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Message failed";
      setMsgs((messages) => [...messages, { role: "agent", text: `⚠️ ${message}` }]);
      setBusy(false);
    }
  }

  async function addFiles(files: FileList | File[] | null) {
    if (!files?.length || uploading) return;
    setUploading(true);
    try {
      const response = await api.uploadAttachments(Array.from(files));
      setAttachments((current) => [...current, ...response.attachments].slice(0, 5));
    } catch (cause) {
      setMsgs((messages) => [...messages, { role: "agent", text: cause instanceof Error ? cause.message : "File upload failed" }]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // The console owns the unfocused paste: it is the surface a screenshot is nearly always meant for.
  const { isDragging, dropProps, pasteProps } = useAttachmentDrop({
    onFiles: addFiles,
    disabled: !sessionKey || busy || uploading,
    pasteWhenUnfocused: true,
  });

  return (
    <div
      {...dropProps}
      {...pasteProps}
      className={`holo-panel hud-frame flex h-full min-h-0 flex-col p-4${isDragging ? " attachment-dropzone" : ""}`}
    >
      <div className="chat-console-header mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="chat-console-status flex min-w-0 items-center gap-3">
          <div className="hud-label">CONSOLE</div>
          <ContextWindow session={session} />
        </div>
        <div className="chat-console-controls flex min-w-0 items-center gap-2">
          {loading && (
            <span className="hidden items-center gap-1.5 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-gray-500 lg:flex">
              <LoaderCircle size={11} className="animate-spin" /> Restoring
            </span>
          )}
          <select
            aria-label="Chat agent"
            className="chat-console-agent-select rounded-lg border border-hudborder bg-black/25 px-2 py-1.5 font-mono text-[0.65rem] text-gray-200 outline-none focus:border-accent/60 disabled:opacity-50"
            value={agentId}
            disabled={!onSelectAgent || agentBusy || loading}
            onChange={(event) => selectAgent(event.target.value)}
          >
            {chatAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {chatAgentName(agent)}
              </option>
            ))}
          </select>
          <ExecutionTargetSwitch
            value={executionState.target}
            devices={executionState.devices}
            busy={targetBusy || loading}
            disabled={!sessionKey}
            onChange={selectExecutionTarget}
          />
          {agentModels && agentModels.models.length > 1 ? (
            <select
              aria-label="Agent model"
              className="chat-console-model-select rounded-lg border border-hudborder bg-black/25 px-2 py-1.5 font-mono text-[0.65rem] text-gray-200 outline-none focus:border-accent/60 disabled:opacity-50"
              value={modelOverride ?? sessionModel ?? agentModels.current ?? ""}
              disabled={!sessionKey || loading || modelBusy}
              onChange={(event) => selectModel(event.target.value)}
            >
              {agentModels.models.map((model) => (
                <option key={model.id} value={model.id}>{model.label}</option>
              ))}
            </select>
          ) : null}
        </div>
      </div>
      {targetError && (
        <div className="mb-2 rounded border border-amber-400/20 bg-amber-400/5 px-2.5 py-1.5 font-mono text-[0.65rem] text-amber-200">
          {targetError}
        </div>
      )}
      {agentError && (
        <div className="mb-2 rounded border border-amber-400/20 bg-amber-400/5 px-2.5 py-1.5 font-mono text-[0.65rem] text-amber-200">
          {agentError}
        </div>
      )}
      {modelError && (
        <div className="mb-2 rounded border border-amber-400/20 bg-amber-400/5 px-2.5 py-1.5 font-mono text-[0.65rem] text-amber-200">
          {modelError}
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {!loading && msgs.length === 0 && !streaming && !historyError && (
          <div className="mt-6 text-center font-mono text-xs text-gray-600">
            {sessionKey ? "Fresh context. Speak to the agent…" : "No session available yet."}
          </div>
        )}
        {historyError && (
          <div className="mx-auto mt-6 max-w-md rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-center font-mono text-xs text-red-300">
            {historyError}
          </div>
        )}
        {msgs.map((message, index) => (
          <Bubble
            key={index}
            role={message.role}
            text={message.text}
            memoryCitations={message.memoryCitations}
            savedMemories={message.savedMemories}
            learnedLessons={message.learnedLessons}
            attachments={message.attachments}
          />
        ))}
        {streaming !== null && <Bubble role="agent" text={streaming || "…"} streaming />}
        <div ref={endRef} />
      </div>
      {attachments.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {attachments.map((attachment) => (
            <span key={attachment.id} className="flex max-w-full items-center gap-1 rounded border border-hudborder bg-black/25 px-2 py-1 font-mono text-[0.65rem] text-gray-300">
              <Paperclip size={11} /><span className="truncate">{attachment.fileName}</span>
              <button type="button" aria-label={`Remove ${attachment.fileName}`} onClick={() => setAttachments((current) => current.filter(({ id }) => id !== attachment.id))}><X size={11} /></button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!sessionKey || busy || uploading} className="btn-hud flex h-9 w-9 items-center justify-center disabled:opacity-40" aria-label="Attach files" title="Attach files">
          {uploading ? <LoaderCircle className="animate-spin" size={16} /> : <Paperclip size={16} />}
        </button>
        <input ref={fileInputRef} className="sr-only" type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={(event) => void addFiles(event.target.files)} />
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send()}
          placeholder={sessionKey ? "Give a command…" : "waiting for session…"}
          disabled={!sessionKey || busy || uploading}
          className="min-w-0 flex-1 rounded-lg border border-hudborder bg-surface-2 px-3 py-2 font-mono text-sm text-gray-200 outline-none placeholder:text-gray-600 focus:border-accent/60"
        />
        <button
          type="button"
          onClick={send}
          disabled={!sessionKey || busy || uploading || (!input.trim() && !attachments.length)}
          className="btn-hud flex h-9 w-9 items-center justify-center disabled:opacity-40"
          aria-label="send"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

function ContextWindow({ session }: { session?: AgentRoomSession }) {
  const percent = contextPercent(session);
  const used = session?.totalTokens;
  const limit = session?.contextTokens;
  const label =
    percent === null
      ? "Context unavailable"
      : `${formatTokens(used)} of ${formatTokens(limit)} context tokens used (${percent}%)`;
  return (
    <div
      className="min-w-[8.5rem] rounded-md border border-hudborder bg-black/20 px-2 py-1"
      title={label}
      aria-label={label}
    >
      <div className="flex items-center justify-between gap-2 font-mono text-[0.55rem] uppercase tracking-[0.08em]">
        <span className="text-gray-500">Context</span>
        <span className={percent === null ? "text-gray-600" : "text-accent"}>
          {percent === null ? "—" : `${formatTokens(used)} / ${formatTokens(limit)} · ${percent}%`}
        </span>
      </div>
      <div
        className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className="block h-full rounded-full bg-accent shadow-[0_0_8px_rgb(var(--hud-accent)/0.65)] transition-[width]"
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>
    </div>
  );
}

function ExecutionTargetSwitch({
  value,
  devices,
  busy,
  disabled,
  onChange,
}: {
  value: ExecutionTarget;
  devices: { mac: ExecutionDevice; windows: ExecutionDevice };
  busy: boolean;
  disabled: boolean;
  onChange: (target: ExecutionTarget) => void;
}) {
  const choices: Array<{
    value: ExecutionTarget;
    label: string;
    ariaLabel: string;
    icon: typeof Laptop;
    available: boolean;
    title: string;
  }> = [
    {
      value: "mac",
      label: "Mac",
      ariaLabel: "Use Mac only",
      icon: Laptop,
      available: devices.mac.available,
      title: devices.mac.available ? `Route work to ${devices.mac.name}` : "Mac node is offline",
    },
    {
      value: "neutral",
      label: "Both",
      ariaLabel: "Use both machines",
      icon: Network,
      available: true,
      title: "Let the agent use Mac, Windows, or both",
    },
    {
      value: "windows",
      label: "Windows",
      ariaLabel: "Use Windows only",
      icon: MonitorCog,
      available: devices.windows.available,
      title: devices.windows.available
        ? `Route work to ${devices.windows.name}`
        : "Windows node is offline",
    },
  ];

  return (
    <div
      className="chat-execution-target flex items-center rounded-lg border border-hudborder bg-black/25 p-0.5"
      role="group"
      aria-label="Agent execution target"
    >
      {choices.map((choice) => {
        const active = choice.value === value;
        const Icon = choice.icon;
        return (
          <button
            key={choice.value}
            type="button"
            aria-label={choice.ariaLabel}
            aria-pressed={active}
            title={choice.title}
            disabled={disabled || busy || !choice.available}
            onClick={() => onChange(choice.value)}
            className={`flex h-7 items-center gap-1 rounded-md px-2 font-mono text-[0.58rem] uppercase tracking-[0.08em] transition sm:px-2.5 ${
              active
                ? "bg-accent/15 text-accent-hover shadow-[0_0_12px_rgb(var(--hud-accent)/0.12)]"
                : "text-gray-500 hover:bg-white/[0.035] hover:text-gray-300"
            } disabled:cursor-not-allowed disabled:opacity-35`}
          >
            {busy && active ? <LoaderCircle size={11} className="animate-spin" /> : <Icon size={11} />}
            <span>{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Bubble({
  role,
  text,
  streaming,
  memoryCitations = [],
  savedMemories = [],
  learnedLessons = [],
  attachments = [],
}: {
  role: "user" | "agent";
  text: string;
  streaming?: boolean;
  memoryCitations?: MemoryCitation[];
  savedMemories?: SavedMemory[];
  learnedLessons?: LearnedLesson[];
  attachments?: StoredAttachment[];
}) {
  const mine = role === "user";
  const visibleText = text.replace(ALL_HIDDEN_MARKERS, "").trimEnd();
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 font-mono text-sm ${
          mine
            ? "border border-hudborder-light bg-accent/10 text-accent-hover"
            : "border border-hudborder bg-surface-2 text-gray-200"
        } ${streaming ? "opacity-90" : ""}`}
      >
        {visibleText}
        {attachments.length ? <AttachmentList attachments={attachments} /> : null}
        {streaming && <span className="ml-0.5 animate-pulse text-accent">▍</span>}
        {!streaming && memoryCitations.length ? (
          <div className="chat-memory-citations">
            <span>
              <BrainCircuit size={12} /> Memories used
            </span>
            <div>
              {memoryCitations.map((citation) => (
                <a key={citation.id} href={`#memory?id=${encodeURIComponent(citation.id)}`}>
                  {citation.title}
                </a>
              ))}
            </div>
          </div>
        ) : null}
        {!streaming && savedMemories.length ? (
          <div className="chat-memory-citations">
            <span><BrainCircuit size={12} /> Memory saved</span>
            <div>
              {savedMemories.map((memory) => (
                <a key={memory.id} href={`#memory?id=${encodeURIComponent(memory.id)}`}>{memory.title}</a>
              ))}
            </div>
          </div>
        ) : null}
        {!streaming && learnedLessons.length ? (
          <div className="chat-memory-citations">
            <span>
              <BrainCircuit size={12} /> Shared brain learned
            </span>
            <div>
              {learnedLessons.map((lesson) => lesson.id ? (
                <a key={lesson.id} href={`#memory?id=${encodeURIComponent(lesson.id)}`}>{lesson.title}</a>
              ) : (
                <span key={lesson.title}>{lesson.title}</span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AttachmentList({ attachments }: { attachments: StoredAttachment[] }) {
  return (
    <div className="mt-2 grid gap-2">
      {attachments.map((attachment) => attachment.mimeType.startsWith("image/") ? (
        <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded border border-hudborder">
          <img src={attachment.url} alt={attachment.fileName} className="max-h-64 w-full object-contain" />
        </a>
      ) : attachment.mimeType.startsWith("video/") ? (
        <video key={attachment.id} src={attachment.url} controls className="max-h-64 w-full rounded border border-hudborder" />
      ) : (
        <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded border border-hudborder bg-black/20 px-2 py-1.5 text-xs text-accent-hover">
          <Paperclip size={12} /><span className="truncate">{attachment.fileName}</span>
        </a>
      ))}
    </div>
  );
}
