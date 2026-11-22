import { useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { AgentRoomAgent, AgentRoomSession } from "../AgentRoom";
import { api } from "../../lib/api";
import {
  CHAT_AGENT_NAMES,
  agentIdFromSessionKey,
  chatAgentName,
  isPrimarySession,
  sessionTitle,
} from "../../lib/chat/messages";
import type { Approval } from "../../lib/chat/workspace";

function age(time?: number) {
  if (!time) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes === 0) return "now";
  if (minutes < 60) return minutes + "m ago";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
  return Math.floor(minutes / 1440) + "d ago";
}

export function ConversationRail({
  sessions,
  sessionKey,
  approvals,
  onSelectSession,
  onNewChat,
  onRemoveSession,
  archived,
  toggle,
  refresh,
  agents = [],
}: {
  agents?: AgentRoomAgent[];
  sessions: AgentRoomSession[];
  sessionKey: string | null;
  approvals: Approval[];
  archived: boolean;
  toggle: () => void;
  refresh: () => Promise<void>;
  onSelectSession?: (key: string) => void;
  onNewChat?: () => Promise<void>;
  onRemoveSession?: (s: AgentRoomSession) => Promise<void>;
}) {
  const [editing, setEditing] = useState("");
  const [label, setLabel] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  async function change(action: () => Promise<unknown>) {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await action();
      await refresh();
      setEditing("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setWorking(false);
    }
  }
  const sorted = [...sessions].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const keys = new Set(sorted.map((s) => s.key));
  const roots = sorted.filter((s) => !s.parentKey || !keys.has(s.parentKey));
  const groups = [...new Set(roots.map((s) => agentIdFromSessionKey(s.key)))];
  const groupName = (id: string) => {
    const agent = agents.find((a) => a.id === id);
    return agent ? chatAgentName(agent) : (CHAT_AGENT_NAMES[id] ?? id);
  };
  function row(s: AgentRoomSession, depth: number): ReactNode {
    const primary = isPrimarySession(s.key);
    const count = approvals.filter(
      (a) => a.status === "pending" && a.sessionKey === s.key,
    ).length;
    return (
      <li
        key={s.key}
        className={depth ? "ml-3 border-l border-hudborder pl-1" : ""}
      >
        <div
          className={
            "rounded border p-2 " +
            (s.key === sessionKey
              ? "border-accent/45 bg-accent/10"
              : "border-transparent hover:border-hudborder")
          }
        >
          {editing === s.key ? (
            <input
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              maxLength={120}
              aria-label="Conversation title"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full rounded bg-surface-2 p-1 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing("");
                if (e.key === "Enter" && !e.nativeEvent.isComposing)
                  void change(() => api.rename(s.key, label));
              }}
            />
          ) : (
            <button
              className="block w-full text-left"
              onClick={() => onSelectSession?.(s.key)}
            >
              <span className="block truncate text-sm">{sessionTitle(s)}</span>
              <span className="block truncate text-xs text-gray-400">
                {s.lastMessagePreview}
              </span>
              <span className="text-[10px] text-gray-400">
                {age(s.updatedAt)}
              </span>
              {count > 0 && (
                <span className="ml-2 rounded bg-amber-500/20 px-1 text-xs text-amber-200">
                  {count} pending
                </span>
              )}
            </button>
          )}
          <div className="mt-1 flex gap-3 text-gray-400">
            <button
              disabled={working}
              title="Rename"
              aria-label={"Rename " + sessionTitle(s)}
              onClick={() => {
                setEditing(s.key);
                setLabel(sessionTitle(s));
              }}
            >
              <Pencil size={13} />
            </button>
            {!primary && (
              <button
                disabled={working}
                title={archived ? "Restore" : "Archive"}
                aria-label={(archived ? "Restore " : "Archive ") + sessionTitle(s)}
                onClick={() => change(() => api.archive(s.key, !archived))}
              >
                {archived ? (
                  <ArchiveRestore size={13} />
                ) : (
                  <Archive size={13} />
                )}
              </button>
            )}
            <button
              disabled={working}
              title={primary ? "Start fresh" : "Delete"}
              aria-label={(primary ? "Start fresh in " : "Delete ") + sessionTitle(s)}
              onClick={() => {
                if (
                  onRemoveSession &&
                  window.confirm(
                    primary
                      ? "Start fresh and clear this conversation?"
                      : "Delete “" + sessionTitle(s) + "” and its transcript?",
                  )
                )
                  void change(() => onRemoveSession(s));
              }}
            >
              {primary ? <RotateCcw size={13} /> : <Trash2 size={13} />}
            </button>
          </div>
        </div>
        {sorted.some((c) => c.parentKey === s.key) && (
          <ul>
            {sorted
              .filter((c) => c.parentKey === s.key)
              .map((c) => row(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <aside className="holo-panel hud-frame flex min-h-0 flex-col p-3 max-md:max-h-52">
      <button
        disabled={!onNewChat || working}
        className="btn-hud flex items-center justify-center gap-2 py-2 text-xs"
        onClick={() => onNewChat && change(onNewChat)}
      >
        <Plus size={14} />
        New conversation
      </button>
      <label className="my-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={archived} onChange={toggle} />
        Show archived
      </label>
      <div className="min-h-0 overflow-auto">
        {groups.map((agent) => (
          <section key={agent}>
            <h3 className="hud-label my-1">{groupName(agent)}</h3>
            <ul>
              {roots
                .filter((s) => agentIdFromSessionKey(s.key) === agent)
                .map((s) => row(s, 0))}
            </ul>
          </section>
        ))}
      </div>
      {error && (
        <div role="alert" className="text-xs text-red-300">
          {error}
        </div>
      )}
    </aside>
  );
}
