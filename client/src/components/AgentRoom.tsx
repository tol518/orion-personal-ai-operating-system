import {
  Activity,
  ArrowUpRight,
  BriefcaseBusiness,
  Clock3,
  Cpu,
  ChevronDown,
  LoaderCircle,
  MousePointer2,
  Radio,
  Save,
  Sparkles,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, type AgentAnimationSpec, type AgentModels } from "../lib/api";
import CreateAgentDialog from "./CreateAgentDialog";

export type AgentRoomAgent = {
  id: string;
  name?: string;
  role?: string;
  identity?: { name?: string };
  model?: { primary?: string };
  appearance?: {
    spriteSheetUrl: string;
    attachmentId: string;
    source: "uploaded";
    model: string | null;
    animationSpec: AgentAnimationSpec;
  };
};

export type AgentRoomSession = {
  key: string;
  kind?: string;
  updatedAt?: number;
  status?: string;
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
  model?: string;
  totalTokens?: number;
  contextTokens?: number;
  lastMessagePreview?: string;
  displayName?: string;
  label?: string;
  derivedTitle?: string;
};

type AgentState = "ready" | "running" | "needs-input" | "offline";
type MotionState = "working" | "walking" | "sitting" | "chilling";
type Facing = "left" | "right";

type RoomAgent = {
  id: string;
  name: string;
  role: string;
  state: AgentState;
  stateLabel: string;
  task: string;
  model: string;
  tokens: string;
  updatedAt: number | null;
  session: AgentRoomSession | null;
  sessions: AgentRoomSession[];
  variant: number;
  appearance: AgentRoomAgent["appearance"];
};

type Props = {
  agents: AgentRoomAgent[];
  sessions: AgentRoomSession[];
  connected: boolean;
  onOpenSession: (sessionKey: string) => void;
  onAgentCreated: () => Promise<void> | void;
};

type Waypoint = { x: number; y: number };

const FAILED_STATES = new Set(["failed", "killed", "timeout", "error"]);
const ROLE_BY_AGENT_ID: Record<string, string> = {
  main: "MAIN ORCHESTRATOR",
  codex: "CODE SPECIALIST",
  "black-noir": "EXTRACTION SPECIALIST",
};
const NAME_BY_AGENT_ID: Record<string, string> = {
  main: "J.A.R.V.I.S.",
  codex: "WALL-E",
  "black-noir": "BLACK NOIR",
};
const CODEX_AGENT_ID = "codex";
const BLACK_NOIR_AGENT_ID = "black-noir";
const DEFAULT_ANIMATION_SPEC: AgentAnimationSpec = {
  columns: 4,
  rows: 2,
  animations: {
    idle: [0],
    walking: [1, 2],
    sitting: [3],
    working: [4, 5],
    dancing: [6, 7],
  },
};

// The planning table occupies the center of the background (roughly x: 43–64%,
// y: 46–73%). This route stays outside its expanded visual collision boundary,
// so a full-size character and nameplate always pass around it rather than over it.
const IDLE_ROUTE: Waypoint[] = [
  { x: 24, y: 34 },
  { x: 16, y: 52 },
  { x: 20, y: 82 },
  { x: 40, y: 84 },
  { x: 70, y: 84 },
  { x: 84, y: 79 },
  { x: 84, y: 48 },
  { x: 74, y: 34 },
];

const WORK_POSITIONS: Waypoint[] = [
  { x: 27, y: 37 },
  { x: 57, y: 37 },
  { x: 84, y: 37 },
  { x: 84, y: 64 },
  { x: 39, y: 70 },
  { x: 24, y: 68 },
];

function agentIdFromSessionKey(key: string): string | null {
  const match = /^agent:([^:]+):/.exec(key);
  return match?.[1] ?? null;
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(result);
}

function formatTokens(value?: number): string {
  if (!Number.isFinite(value)) return "—";
  if ((value ?? 0) >= 1_000_000) return `${((value ?? 0) / 1_000_000).toFixed(1)}M`;
  if ((value ?? 0) >= 1_000) return `${((value ?? 0) / 1_000).toFixed(1)}k`;
  return String(Math.round(value ?? 0));
}

function formatAge(value: number | null): string {
  if (!value) return "No activity";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function configuredModelId(model: string | undefined, choices: AgentModels | null): string | null {
  if (!model || !choices) return null;
  const matches = choices.models.filter(
    (choice) => choice.id === model || choice.id.endsWith(`/${model}`),
  );
  return matches.length === 1 ? matches[0].id : null;
}

function resolveState(sessions: AgentRoomSession[], connected: boolean): AgentState {
  if (!connected) return "offline";
  if (
    sessions.some(
      (session) =>
        session.abortedLastRun === true ||
        (session.status != null && FAILED_STATES.has(session.status)),
    )
  ) {
    return "needs-input";
  }
  if (sessions.some((session) => session.hasActiveRun || session.status === "running")) {
    return "running";
  }
  return "ready";
}

function stateLabel(state: AgentState): string {
  if (state === "running") return "RUNNING";
  if (state === "needs-input") return "NEEDS INPUT";
  if (state === "offline") return "LINK DOWN";
  return "READY";
}

function resolveTask(agentId: string, session: AgentRoomSession | null, state: AgentState): string {
  if (state === "ready") {
    return agentId === "main" ? "Standing by to orchestrate" : "Standing by for instructions";
  }
  if (state === "offline") return "Waiting for the gateway link";
  return (
    session?.displayName?.trim() ||
    session?.label?.trim() ||
    session?.lastMessagePreview?.trim() ||
    (state === "running" ? "Working on an active session" : "A session needs attention")
  );
}

function resolveRoomAgents(
  agents: AgentRoomAgent[],
  sessions: AgentRoomSession[],
  connected: boolean,
): RoomAgent[] {
  return agents.map((agent) => {
    const agentSessions = sessions
      .filter((session) => agentIdFromSessionKey(session.key) === agent.id)
      .sort(
        (a, b) =>
          Number(Boolean(b.hasActiveRun)) - Number(Boolean(a.hasActiveRun)) ||
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      );
    const session = agentSessions[0] ?? null;
    const state = resolveState(agentSessions, connected);

    return {
      id: agent.id,
      name:
        NAME_BY_AGENT_ID[agent.id] ||
        agent.identity?.name?.trim() ||
        agent.name?.trim() ||
        agent.id.toUpperCase(),
      role: ROLE_BY_AGENT_ID[agent.id] || agent.role?.trim() || "SPECIALIST",
      state,
      stateLabel: stateLabel(state),
      task: resolveTask(agent.id, session, state),
      model: agent.model?.primary || session?.model || "Default model",
      tokens: formatTokens(session?.totalTokens),
      updatedAt: session?.updatedAt ?? null,
      session,
      sessions: agentSessions,
      variant: hash(agent.id) % 4,
      appearance: agent.appearance,
    };
  });
}

function CustomAgentSprite({
  url,
  animationSpec = DEFAULT_ANIMATION_SPEC,
  motion = "chilling",
  facing = "right",
  compact = false,
}: {
  url: string;
  animationSpec?: AgentAnimationSpec;
  motion?: MotionState | "dancing";
  facing?: Facing;
  compact?: boolean;
}) {
  const frames = motion === "chilling" ? animationSpec.animations.idle : animationSpec.animations[motion];
  const columns = Math.max(1, animationSpec.columns);
  const rows = Math.max(1, animationSpec.rows);

  return (
    <span
      className={`custom-agent-sprite custom-agent-sprite--${motion} custom-agent-sprite--${facing} ${compact ? "custom-agent-sprite--compact" : ""}`}
      aria-hidden="true"
    >
      {frames.map((frame, index) => (
        <span
          key={`${frame}-${index}`}
          className={`custom-agent-sprite__frame custom-agent-sprite__frame--${frames.length === 1 ? "single" : index === 0 ? "a" : "b"}`}
          style={{
            "--custom-sprite-url": `url("${url}")`,
            "--custom-grid-size": `${columns * 100}% ${rows * 100}%`,
            "--custom-frame-x": `${columns === 1 ? 0 : ((frame % columns) / (columns - 1)) * 100}%`,
            "--custom-frame-y": `${rows === 1 ? 0 : (Math.floor(frame / columns) / (rows - 1)) * 100}%`,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}

function CodexPet({
  motion = "chilling",
  facing = "right",
  compact = false,
}: {
  motion?: MotionState | "dancing";
  facing?: Facing;
  compact?: boolean;
}) {
  const row =
    motion === "walking"
      ? facing === "left"
        ? 2
        : 1
      : motion === "working"
        ? 7
        : motion === "dancing"
          ? 3
          : 0;

  return (
    <span
      className={`codex-pet ${compact ? "codex-pet--compact" : ""} codex-pet--${motion}`}
      style={{ "--codex-pet-row": String(row) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function BlackNoirPet({
  motion = "chilling",
  facing = "right",
  compact = false,
}: {
  motion?: MotionState | "dancing";
  facing?: Facing;
  compact?: boolean;
}) {
  const row = motion === "walking" ? 1 : motion === "working" || motion === "dancing" ? 2 : motion === "sitting" ? 3 : 0;
  return (
    <span
      className={`black-noir-pet ${compact ? "black-noir-pet--compact" : ""} black-noir-pet--${motion} black-noir-pet--${facing}`}
      style={{ "--black-noir-row": String(row) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function AgentPortrait({ agent, compact = false }: { agent: RoomAgent; compact?: boolean }) {
  if (agent.appearance?.spriteSheetUrl) {
    return <CustomAgentSprite url={agent.appearance.spriteSheetUrl} animationSpec={agent.appearance.animationSpec} compact={compact} />;
  }
  if (agent.id === CODEX_AGENT_ID) return <CodexPet compact={compact} />;
  if (agent.id === BLACK_NOIR_AGENT_ID) return <BlackNoirPet compact={compact} />;

  const portraitStyle = {
    "--agent-hue": agent.id === "main" ? "0deg" : `${agent.variant * 42 + 34}deg`,
  } as CSSProperties;

  return (
    <img
      className={`room-agent-art ${compact ? "room-agent-art--compact" : ""}`}
      src="/agent-room/jarvis-cropped.png"
      alt=""
      draggable={false}
      style={portraitStyle}
    />
  );
}

function AgentSprite({
  agent,
  motion,
  facing,
}: {
  agent: RoomAgent;
  motion: MotionState | "dancing";
  facing: Facing;
}) {
  if (agent.appearance?.spriteSheetUrl) {
    return <CustomAgentSprite url={agent.appearance.spriteSheetUrl} animationSpec={agent.appearance.animationSpec} motion={motion} facing={facing} />;
  }
  if (agent.id === CODEX_AGENT_ID) {
    return <CodexPet motion={motion} facing={facing} />;
  }
  if (agent.id === BLACK_NOIR_AGENT_ID) {
    return <BlackNoirPet motion={motion} facing={facing} />;
  }

  const spriteStyle = {
    "--agent-hue": agent.id === "main" ? "0deg" : `${agent.variant * 42 + 34}deg`,
  } as CSSProperties;
  const frameSet =
    motion === "walking"
      ? ["jarvis-walk-a.png", "jarvis-walk-b.png"]
      : motion === "working"
        ? ["jarvis-work-a.png", "jarvis-work-b.png"]
        : motion === "sitting"
          ? ["jarvis-sit.png"]
          : ["jarvis-stand.png"];
  const effectiveFacing = motion === "working" ? "right" : facing;

  return (
    <span
      className={`room-agent-frames room-agent-frames--${motion} room-agent-frames--${effectiveFacing}`}
      style={spriteStyle}
      aria-hidden="true"
    >
      {frameSet.map((frame, frameIndex) => (
        <img
          key={frame}
          className={`room-agent-frame room-agent-frame--${frameSet.length === 1 ? "single" : frameIndex === 0 ? "a" : "b"}`}
          src={`/agent-room/${frame}`}
          alt=""
          draggable={false}
        />
      ))}
    </span>
  );
}

function RoomCharacter({
  agent,
  index,
  selected,
  onSelect,
}: {
  agent: RoomAgent;
  index: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const startIndex = hash(agent.id) % IDLE_ROUTE.length;
  const [waypointIndex, setWaypointIndex] = useState(startIndex);
  const [motion, setMotion] = useState<MotionState>(agent.state === "ready" ? "chilling" : "working");
  const [dancing, setDancing] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [facing, setFacing] = useState<Facing>("right");

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (agent.state !== "ready" || reduceMotion) {
      setMotion(agent.state === "running" ? "working" : "chilling");
      return;
    }

    let timer: ReturnType<typeof setTimeout>;
    const walk = () => {
      setMotion("walking");
      setWaypointIndex((current) => {
        const next = (current + 1) % IDLE_ROUTE.length;
        setFacing(IDLE_ROUTE[next].x < IDLE_ROUTE[current].x ? "left" : "right");
        return next;
      });
      timer = setTimeout(() => {
        setMotion((current) => (current === "walking" ? "chilling" : current));
        timer = setTimeout(walk, 2600 + (hash(agent.id) % 1100));
      }, 4800 + (hash(`${agent.id}:walk`) % 1200));
    };

    // Hold the first idle pose long enough to read as a real rest, then rejoin
    // the room route. J.A.R.V.I.S. starts at the lounge-side sitting point.
    timer = setTimeout(walk, 4200 + (hash(`${agent.id}:start`) % 1200));
    return () => clearTimeout(timer);
  }, [agent.id, agent.state, reduceMotion]);

  const point =
    agent.state === "ready" && !reduceMotion
      ? IDLE_ROUTE[waypointIndex]
      : WORK_POSITIONS[index % WORK_POSITIONS.length];
  const style = {
    "--agent-x": `${point.x}%`,
    "--agent-y": `${point.y}%`,
    "--move-seconds": motion === "walking" ? "5.2s" : "0.8s",
  } as CSSProperties;
  const restingMotion: MotionState =
    motion === "chilling" && waypointIndex === 1 ? "sitting" : motion;
  const visibleMotion = dancing ? "dancing" : restingMotion;
  const activityLabel =
    dancing
      ? "DANCE MODE"
      : visibleMotion === "walking"
        ? "WALKING"
        : visibleMotion === "sitting"
          ? "SITTING"
          : visibleMotion === "working"
            ? "WORKING"
            : "CHILLING";

  return (
    <button
      type="button"
      className={`room-character room-character--${visibleMotion} room-character--${agent.state} ${
        selected ? "room-character--selected" : ""
      }`}
      style={style}
      aria-pressed={selected}
      aria-label={`${agent.name}, ${agent.role}, ${agent.stateLabel}. Hover or focus to make the agent dance.`}
      onClick={() => {
        onSelect();
        setDancing(true);
        window.setTimeout(() => setDancing(false), 2200);
      }}
      onPointerEnter={() => setDancing(true)}
      onPointerLeave={() => setDancing(false)}
      onFocus={() => setDancing(true)}
      onBlur={() => setDancing(false)}
    >
      {agent.state === "running" || agent.state === "needs-input" ? (
        <span className="room-character__bubble">{agent.task}</span>
      ) : null}
      <span className="room-character__hint" aria-hidden="true">
        {dancing ? "DANCE MODE" : "HOVER TO DANCE"}
      </span>
      <span className="room-character__sprite">
        <AgentSprite agent={agent} motion={visibleMotion} facing={facing} />
      </span>
      <span className="room-character__plate">
        <strong>{agent.name}</strong>
        <small>{agent.role}</small>
        <em className={`room-character__status room-character__status--${agent.state}`}>
          <i />
          {activityLabel}
        </em>
      </span>
    </button>
  );
}

export default function AgentRoom({ agents, sessions, connected, onOpenSession, onAgentCreated }: Props) {
  const roomAgents = useMemo(
    () => resolveRoomAgents(agents, sessions, connected),
    [agents, sessions, connected],
  );
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [modelChoices, setModelChoices] = useState<Record<string, AgentModels>>({});
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [modelLoadingFor, setModelLoadingFor] = useState<string | null>(null);
  const [modelSavingFor, setModelSavingFor] = useState<string | null>(null);
  const [defaultSavingFor, setDefaultSavingFor] = useState<string | null>(null);
  const [defaultSavedFor, setDefaultSavedFor] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);

  useEffect(() => {
    if (!roomAgents.length) {
      setSelectedAgentId(null);
      return;
    }
    if (!roomAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(
        roomAgents.find((agent) => agent.state === "needs-input")?.id ||
          roomAgents.find((agent) => agent.state === "running")?.id ||
          roomAgents[0].id,
      );
    }
  }, [roomAgents, selectedAgentId]);

  const selectedAgent =
    roomAgents.find((agent) => agent.id === selectedAgentId) ?? roomAgents[0] ?? null;
  const selectedModelChoices = selectedAgent ? modelChoices[selectedAgent.id] : null;
  const selectedSessionModel = configuredModelId(
    selectedAgent?.session?.model,
    selectedModelChoices,
  );
  const selectedModel = selectedAgent
    ? modelOverrides[selectedAgent.id] ||
      selectedSessionModel ||
      selectedModelChoices?.current ||
      selectedAgent.model
    : "";
  const defaultModelChanged = Boolean(
    selectedModelChoices?.current && selectedModel !== selectedModelChoices.current,
  );
  const runningCount = roomAgents.filter((agent) => agent.state === "running").length;
  const needsInputCount = roomAgents.filter((agent) => agent.state === "needs-input").length;

  useEffect(() => {
    if (!selectedAgentId || modelChoices[selectedAgentId]) return;

    let active = true;
    setModelLoadingFor(selectedAgentId);
    setModelError(null);
    api.agentModels(selectedAgentId)
      .then((models) => {
        if (!active) return;
        setModelChoices((current) => ({ ...current, [selectedAgentId]: models }));
      })
      .catch((cause) => {
        if (!active) return;
        setModelError(cause instanceof Error ? cause.message : "Could not load model choices");
      })
      .finally(() => {
        if (active) setModelLoadingFor(null);
      });

    return () => {
      active = false;
    };
  }, [modelChoices, selectedAgentId]);

  async function selectModel(model: string) {
    if (!selectedAgent?.session || modelSavingFor) return;
    if (model === selectedModel) return;

    const agentId = selectedAgent.id;
    const previousModel = selectedModel;
    setModelSavingFor(selectedAgent.id);
    setModelError(null);
    setDefaultSavedFor(null);
    setModelOverrides((current) => ({ ...current, [agentId]: model }));
    try {
      await api.setSessionModel(selectedAgent.session.key, agentId, model);
    } catch (cause) {
      setModelOverrides((current) => ({ ...current, [agentId]: previousModel }));
      setModelError(cause instanceof Error ? cause.message : "Could not change model");
    } finally {
      setModelSavingFor(null);
    }
  }

  async function saveDefaultModel() {
    if (!selectedAgent || !selectedModel || defaultSavingFor || !defaultModelChanged) return;

    const agentId = selectedAgent.id;
    setDefaultSavingFor(agentId);
    setDefaultSavedFor(null);
    setModelError(null);
    try {
      const saved = await api.saveAgentModel(agentId, selectedModel);
      setModelChoices((current) => ({ ...current, [agentId]: saved }));
      setDefaultSavedFor(agentId);
    } catch (cause) {
      setModelError(cause instanceof Error ? cause.message : "Could not save default model");
    } finally {
      setDefaultSavingFor(null);
    }
  }

  return (
    <>
    <section className="agent-room-page">
      <header className="agent-room-heading">
        <div className="agent-room-titleline">
          <h1>Agent Room</h1>
          <span className="agent-room-count agent-room-count--active">{runningCount} active</span>
          <i>•</i>
          <span className="agent-room-count agent-room-count--alert">
            {needsInputCount} needs input
          </span>
        </div>
        <div className="agent-room-heading__actions">
          <button
            type="button"
            className="agent-room-create-agent"
            onClick={() => setCreateAgentOpen(true)}
          >
            <UserPlus size={16} />
            Create agent
          </button>
          <button
            type="button"
            className="agent-room-view-sessions"
            disabled={!selectedAgent?.session}
            onClick={() => selectedAgent?.session && onOpenSession(selectedAgent.session.key)}
          >
            View sessions
            <ArrowUpRight size={17} />
          </button>
        </div>
      </header>

      <div className="agent-room-shell">
        <div className="agent-room-scene" aria-label="Live OpenClaw agent room">
          <img
            className="agent-room-scene__background"
            src="/agent-room/industrial-office.png"
            alt=""
            draggable={false}
          />

          {roomAgents.map((agent, index) => (
            <RoomCharacter
              key={agent.id}
              agent={agent}
              index={index}
              selected={agent.id === selectedAgent?.id}
              onSelect={() => setSelectedAgentId(agent.id)}
            />
          ))}

          {!roomAgents.length ? (
            <div className="agent-room-empty" role="status">
              <Users size={38} />
              <strong>{connected ? "NO AGENTS CONFIGURED" : "GATEWAY LINK DOWN"}</strong>
              <span>
                {connected
                  ? "Configured OpenClaw agents will enter the room here."
                  : "The room will reconnect automatically."}
              </span>
            </div>
          ) : null}

          <div className="agent-room-interaction-tip">
            <MousePointer2 size={13} />
            HOVER AN AGENT TO DANCE
          </div>
        </div>

        <aside className="agent-room-inspector" aria-label="Selected agent telemetry">
          {selectedAgent ? (
            <>
              <div className="agent-room-inspector__top">
                <div className="agent-room-inspector__portrait">
                  <AgentPortrait agent={selectedAgent} compact />
                </div>
                <div className="agent-room-inspector__identity">
                  <h2>{selectedAgent.name}</h2>
                  <span className="agent-room-role">{selectedAgent.role}</span>
                  <span className={`agent-room-state agent-room-state--${selectedAgent.state}`}>
                    <i />
                    {selectedAgent.stateLabel}
                  </span>
                </div>
                <Activity className="agent-room-pulse-icon" size={29} aria-hidden="true" />
              </div>

              <div className="agent-room-task">
                <span>Current task</span>
                <p>{selectedAgent.task}</p>
              </div>

              <dl className="agent-room-facts">
                <div>
                  <dt><BriefcaseBusiness size={14} /> Role</dt>
                  <dd>{selectedAgent.role}</dd>
                </div>
                <div>
                  <dt><Cpu size={14} /> Model</dt>
                  <dd className="agent-room-model">
                    {modelLoadingFor === selectedAgent.id ? (
                      <span className="agent-room-model__loading">
                        <LoaderCircle size={12} /> Loading
                      </span>
                    ) : selectedModelChoices?.models.length ? (
                      <span className="agent-room-model__control">
                        <select
                          aria-label={`${selectedAgent.name} model`}
                          value={selectedModel}
                          disabled={!selectedAgent.session || modelSavingFor === selectedAgent.id}
                          onChange={(event) => selectModel(event.target.value)}
                        >
                          {selectedModelChoices.models.map((model) => (
                            <option key={model.id} value={model.id}>{model.label}</option>
                          ))}
                        </select>
                        {modelSavingFor === selectedAgent.id ? (
                          <LoaderCircle className="agent-room-model__spinner" size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )}
                      </span>
                    ) : (
                      selectedModel
                    )}
                  </dd>
                </div>
                <div>
                  <dt><Sparkles size={14} /> Tokens</dt>
                  <dd>{selectedAgent.tokens}</dd>
                </div>
                <div>
                  <dt><Clock3 size={14} /> Updated</dt>
                  <dd>{formatAge(selectedAgent.updatedAt)}</dd>
                </div>
                <div>
                  <dt><Radio size={14} /> Sessions</dt>
                  <dd>{selectedAgent.sessions.length}</dd>
                </div>
              </dl>

              {modelError ? (
                <p className="agent-room-model__error" role="alert">{modelError}</p>
              ) : null}

              <button
                type="button"
                className="agent-room-save-model"
                disabled={!defaultModelChanged || defaultSavingFor === selectedAgent.id}
                onClick={saveDefaultModel}
              >
                {defaultSavingFor === selectedAgent.id ? (
                  <LoaderCircle className="agent-room-model__spinner" size={14} />
                ) : (
                  <Save size={14} />
                )}
                {defaultSavingFor === selectedAgent.id
                  ? "Saving default"
                  : defaultSavedFor === selectedAgent.id
                    ? "Default saved"
                    : "Save as default"}
              </button>

              <button
                type="button"
                className="agent-room-open"
                disabled={!selectedAgent.session}
                onClick={() =>
                  selectedAgent.session && onOpenSession(selectedAgent.session.key)
                }
              >
                Open session
                <ArrowUpRight size={16} />
              </button>

              <div className="agent-room-activity">
                <h3>Activity trace</h3>
                {selectedAgent.sessions.length ? (
                  <ol>
                    {selectedAgent.sessions.slice(0, 5).map((session) => (
                      <li key={session.key}>
                        <i className={session.hasActiveRun ? "is-running" : ""} />
                        <time>{formatAge(session.updatedAt ?? null)}</time>
                        <strong>
                          {session.displayName ||
                            session.label ||
                            session.lastMessagePreview ||
                            "OpenClaw session"}
                        </strong>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>NO RECENT SESSION ACTIVITY</p>
                )}
              </div>
            </>
          ) : (
            <div className="agent-room-inspector__empty">
              <Users size={34} />
              <strong>NO AGENT SELECTED</strong>
              <span>Select an agent in the room to inspect its live work.</span>
            </div>
          )}
        </aside>
      </div>
    </section>
    <CreateAgentDialog
      open={createAgentOpen}
      onClose={() => setCreateAgentOpen(false)}
      onCreated={onAgentCreated}
    />
    </>
  );
}
