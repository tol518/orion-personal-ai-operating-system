import type {
  AgentRoomAgent,
  AgentRoomSession,
} from "../../components/AgentRoom";
import type { ExecutionTargetState, StoredAttachment } from "../api";
export type MemoryCitation = { id: string; title: string };
export type LearnedLesson = { id?: string; title: string };
export type SavedMemory = { id: string; title: string };
export type Msg = {
  time?: number;
  id?: string;
  role: "user" | "agent";
  text: string;
  memoryCitations?: MemoryCitation[];
  savedMemories?: SavedMemory[];
  learnedLessons?: LearnedLesson[];
  attachments?: StoredAttachment[];
};

export const CITATION_MARKER =
  /<!--\s*jarvis-memory-citations\s*:\s*([\s\S]*?)-->/i;
export const ALL_HIDDEN_MARKERS =
  /<!--\s*jarvis-(?:memory-(?:citations|proposals)|managed-memory-upserts)\s*:[\s\S]*?-->/gi;
export const MEMORY_CONTEXT_PREFIX = "<jarvis-memory-context>";
export const ATTACHMENT_CONTEXT =
  /<jarvis-attachments>\n([\s\S]*?)\n<\/jarvis-attachments>/i;
export const EMPTY_EXECUTION_STATE: ExecutionTargetState = {
  target: "neutral",
  devices: {
    mac: { name: "Mac", nodeId: null, available: false },
    windows: { name: "Windows", nodeId: null, available: false },
  },
};
export const CHAT_AGENT_NAMES: Record<string, string> = {
  main: "J.A.R.V.I.S.",
  codex: "WALL-E",
};

export function chatAgentName(agent: AgentRoomAgent): string {
  return (
    CHAT_AGENT_NAMES[agent.id] ||
    agent.identity?.name?.trim() ||
    agent.name?.trim() ||
    agent.id
  );
}

export function isPrimarySession(key: string): boolean {
  return key === "main" || key === "global" || /^agent:[^:]+:main$/.test(key);
}

export function agentIdFromSessionKey(key: string | null): string {
  if (!key || key === "main" || key === "global") return "main";
  return /^agent:([^:]+):/.exec(key)?.[1] ?? "main";
}

export function sessionTitle(session: AgentRoomSession): string {
  if (session.label?.trim()) return session.label.trim();
  if (isPrimarySession(session.key)) return "Main conversation";
  if (session.derivedTitle?.trim()) return session.derivedTitle.trim();
  if (session.displayName?.trim()) return session.displayName.trim();
  return "Untitled conversation";
}

export function formatTokens(value?: number): string {
  if (!Number.isFinite(value)) return "—";
  const amount = value ?? 0;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}k`;
  return String(Math.round(amount));
}

export function contextPercent(session?: AgentRoomSession): number | null {
  const used = session?.totalTokens;
  const limit = session?.contextTokens;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || (limit ?? 0) <= 0)
    return null;
  return Math.min(
    100,
    Math.max(0, Math.round(((used ?? 0) / (limit ?? 1)) * 100)),
  );
}

export function textFromMessage(message: unknown): string {
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

export function messageText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  return textFromMessage((event as { message?: unknown }).message);
}

export function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function unwrapUserMessage(text: string): string {
  if (!text.startsWith(MEMORY_CONTEXT_PREFIX)) return text;
  const userMarker = "\n\nUser message:\n";
  const rulesMarker = "\n\nMemory rules:\n";
  const start = text.indexOf(userMarker);
  const end = text.indexOf(rulesMarker, start + userMarker.length);
  if (start === -1 || end === -1) return text;
  return text.slice(start + userMarker.length, end);
}

export function historyMessage(value: unknown): Msg | null {
  if (!value || typeof value !== "object") return null;
  const message = value as { role?: unknown; timestamp?: string | number };
  if (message.role !== "user" && message.role !== "assistant") return null;
  const time =
    message.timestamp == null
      ? undefined
      : new Date(message.timestamp).getTime();
  const rawText = textFromMessage(message);
  if (!rawText.trim()) return null;

  if (message.role === "user") {
    const match = rawText.match(ATTACHMENT_CONTEXT);
    const parsed = match ? parseJsonArrayObject(match[1]) : null;
    return {
      role: "user",
      time,
      text: unwrapUserMessage(rawText),
      attachments: Array.isArray(parsed?.user)
        ? (parsed.user as StoredAttachment[])
        : [],
    };
  }

  const citationMatch = rawText.match(CITATION_MARKER);
  const memoryCitations = citationMatch
    ? parseJsonArray(citationMatch[1]).map((id) => ({
        id: String(id),
        title: String(id),
      }))
    : [];
  return {
    role: "agent",
    time,
    text: rawText.replace(ALL_HIDDEN_MARKERS, "").trimEnd(),
    memoryCitations,
  };
}

export function parseJsonArrayObject(
  value: string,
): { user?: unknown[] } | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function historyMessages(payload: unknown): Msg[] {
  if (!payload || typeof payload !== "object") return [];
  const messages = (payload as { messages?: unknown }).messages;
  return Array.isArray(messages)
    ? messages
        .map(historyMessage)
        .filter((message): message is Msg => message !== null)
    : [];
}
