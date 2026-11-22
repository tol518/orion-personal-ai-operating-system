import { useMemo, useState, useEffect, useCallback, useRef, useId, useSyncExternalStore } from "react";
import { List, ChevronDown } from "lucide-react";
import { agentIdFromSessionKey, chatAgentName, sessionTitle } from "../../lib/chat/messages";
import type { AgentRoomSession, AgentRoomAgent } from "../AgentRoom";
import { ConversationRail } from "./ConversationRail";
import { Conversation } from "./Conversation";
import { useApprovals } from "./useApprovals";
import { api } from "../../lib/api";
import { useStreamEvent } from "../../hooks/useStreamEvent";
import { ChatSheet } from "./ChatSheet";
import "./workspace.css";

const desktopQuery = window.matchMedia("(min-width: 768px)");
const isMobile = () => !desktopQuery.matches;
function subscribeToLayout(callback: () => void) {
  desktopQuery.addEventListener("change", callback);
  return () => desktopQuery.removeEventListener("change", callback);
}

type Props = {
  sessionKey: string | null;
  sessions?: AgentRoomSession[];
  agents?: AgentRoomAgent[];
  showSessions?: boolean;
  onSelectSession?: (sessionKey: string) => void;
  onSelectAgent?: (agentId: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onNewChat?: () => Promise<void>;
  onRemoveSession?: (session: AgentRoomSession) => Promise<void>;
};

export default function Chat({
  sessionKey: selectedKey,
  sessions = [],
  agents = [],
  showSessions = false,
  onSelectSession,
  onSelectAgent,
  onNewChat,
  onRefresh,
  onRemoveSession,
}: Props) {
  const { approvals, resolve } = useApprovals();
  const mobile = useSyncExternalStore(subscribeToLayout, isMobile);
  const conversations = useRef<HTMLDialogElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const conversationTitleId = useId();
  const mobileWorkspace = showSessions && mobile;
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = workspace.current?.closest<HTMLElement>(".orion-shell");
    if (!mobileWorkspace || !viewport || !shell) return;

    // iOS changes the visual viewport when the keyboard opens without resizing 100dvh.
    const heightProperty = "--orion-chat-viewport-height";
    const resize = () => {
      if (viewport.scale === 1) shell.style.setProperty(heightProperty, viewport.height + "px");
      else shell.style.removeProperty(heightProperty);
    };
    resize();
    viewport.addEventListener("resize", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      shell.style.removeProperty(heightProperty);
    };
  }, [mobileWorkspace]);
  const [archived, setArchived] = useState(false);
  const [archivedKey, setArchivedKey] = useState<string | null>(null);
  const [listed, setListed] = useState<AgentRoomSession[] | null>(null);
  const [reset, setReset] = useState(0);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!showSessions) return;
    if (!archived) return onRefresh?.();
    const generation = ++request.current;
    const data = await api.sessions(100, archived);
    if (generation === request.current) setListed(data.sessions);
  }, [archived, showSessions, onRefresh]);
  useEffect(() => {
    if (!showSessions) return;
    if (!archived) {
      setListed(null);
      return;
    }
    const read = () => refresh().catch(() => {});
    read();
    const timer = setInterval(read, 10000);
    return () => {
      request.current++;
      clearInterval(timer);
    };
  }, [archived, showSessions, refresh]);
  useStreamEvent("sessions.changed", () => {
    if (archived) void refresh().catch(() => {});
  });
  const rows = archived ? (listed ?? []) : sessions;
  const sessionKey = archived
    ? (rows.find((s) => s.key === archivedKey)?.key ?? rows[0]?.key ?? null)
    : selectedKey;
  const activeSession = rows.find((session) => session.key === sessionKey);
  const sessionModel = activeSession?.model;
  const agentId = agentIdFromSessionKey(sessionKey);
  const chatAgents = useMemo(() => {
    const available = agents.filter((agent) => agent.id.trim());
    if (available.some((agent) => agent.id === agentId)) return available;
    return [...available, { id: agentId }];
  }, [agentId, agents]);

  const conversation = (
    <Conversation
      key={String(sessionKey) + "/" + reset}
      approvals={approvals.filter(
        (a) => !a.sessionKey || a.sessionKey === sessionKey,
      )}
      resolve={resolve}
      sessionKey={sessionKey}
      sessionModel={sessionModel}
      session={activeSession}
      agentId={agentId}
      chatAgents={chatAgents}
      workspaceHeader={mobileWorkspace ? (
        <button
          type="button"
          className="orion-chat-picker"
          aria-label="Conversations"
          aria-describedby={conversationTitleId}
          aria-haspopup="dialog"
          onClick={() => conversations.current?.showModal()}
        >
          <List size={19} aria-hidden="true" />
          <span className="orion-chat-picker-copy">
            <span>{chatAgentName(chatAgents.find((agent) => agent.id === agentId) ?? { id: agentId })}</span>
            <strong id={conversationTitleId}>{activeSession ? sessionTitle(activeSession) : "Conversations"}</strong>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
      ) : undefined}
      onSelectAgent={async (id) => {
        await onSelectAgent?.(id);
        setArchived(false);
      }}
    />
  );
  if (!showSessions) return conversation;
  const rail = (
    <ConversationRail
      agents={agents}
      sessions={rows.filter((s) => !s.internal)}
      approvals={approvals}
      archived={archived}
      refresh={refresh}
      toggle={() => {
        setListed(null);
        setArchived(!archived);
      }}
      sessionKey={sessionKey}
      onSelectSession={(key) => {
        if (archived) setArchivedKey(key);
        else onSelectSession?.(key);
        conversations.current?.close();
      }}
      onNewChat={async () => {
        await onNewChat?.();
        setArchived(false);
        setListed(null);
        conversations.current?.close();
      }}
      onRemoveSession={async (s) => {
        await onRemoveSession?.(s);
        if (s.key === sessionKey) setReset((n) => n + 1);
      }}
    />
  );
  return (
    <div ref={workspace} className="orion-chat-workspace grid h-full min-h-0 gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
      {mobileWorkspace ? (
        <ChatSheet dialogRef={conversations} title="Conversations">
          {rail}
        </ChatSheet>
      ) : rail}
      <div className="min-h-0 min-w-0">{conversation}</div>
    </div>
  );
}
