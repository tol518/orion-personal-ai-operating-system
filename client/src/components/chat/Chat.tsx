import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { agentIdFromSessionKey } from "../../lib/chat/messages";
import type { AgentRoomSession, AgentRoomAgent } from "../AgentRoom";
import { ConversationRail } from "./ConversationRail";
import { Conversation } from "./Conversation";
import { useApprovals } from "./useApprovals";
import { api } from "../../lib/api";
import { useStreamEvent } from "../../hooks/useStreamEvent";
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
      onSelectAgent={async (id) => {
        await onSelectAgent?.(id);
        setArchived(false);
      }}
    />
  );
  if (!showSessions) return conversation;
  return (
    <div className="grid h-full min-h-0 gap-3 md:grid-cols-[16rem_minmax(0,1fr)]">
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
        onSelectSession={archived ? setArchivedKey : onSelectSession}
        onNewChat={async () => {
          await onNewChat?.();
          setArchived(false);
          setListed(null);
        }}
        onRemoveSession={async (s) => {
          await onRemoveSession?.(s);
          if (s.key === sessionKey) setReset((n) => n + 1);
        }}
      />
      <div className="min-h-0">{conversation}</div>
    </div>
  );
}
