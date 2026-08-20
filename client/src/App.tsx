import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Bot, Code2, Cpu, Gauge, Layers, Sigma, Zap } from "lucide-react";
import { api, type UsageAttribution, type UsageReport, type UsageTotals } from "./lib/api";
import { useStreamEvent } from "./hooks/useStreamEvent";
import Sidebar, { NAV, navPresentation, type View } from "./components/Sidebar";
import JarvisCore from "./components/JarvisCore";
import HoloPanel from "./components/HoloPanel";
import StatTile from "./components/StatTile";
import NodesPanel from "./components/NodesPanel";
import AgentRoom, {
  type AgentRoomAgent,
  type AgentRoomSession,
} from "./components/AgentRoom";
import Chat from "./components/Chat";
import MemoryPage from "./components/MemoryPage";
import HuntingAccessDialog from "./components/HuntingAccessDialog";
import MemoryAccessDialog from "./components/MemoryAccessDialog";

const ExtractionPage = lazy(() => import("./components/ExtractionPage"));
const ScreensPage = lazy(() => import("./components/ScreensPage"));
const HuntingPage = lazy(() => import("./components/HuntingPage"));
const WorkflowsPage = lazy(() => import("./components/WorkflowsPage"));

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function normalizedTotals(value?: Partial<UsageTotals>): UsageTotals {
  const totals = emptyTotals();
  for (const key of Object.keys(totals) as Array<keyof UsageTotals>) {
    const next = value?.[key];
    totals[key] = typeof next === "number" && Number.isFinite(next) ? next : 0;
  }
  return totals;
}

function contextSummary(session?: AgentRoomSession): { value: string; sub: string } {
  const used = Number(session?.totalTokens);
  const limit = Number(session?.contextTokens);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return { value: "—", sub: "context unavailable" };
  }
  const percent = Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
  return { value: `${percent}%`, sub: `${fmt(used)} of ${fmt(limit)}` };
}

function codexWeeklySummary(
  limit?: UsageAttribution["codexWeeklyLimit"],
): { value: string; sub: string } {
  if (!limit || typeof limit.remainingPercent !== "number") {
    return { value: "—", sub: "limit unavailable" };
  }
  const reset =
    typeof limit.resetsAt === "number"
      ? new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(
          new Date(limit.resetsAt),
        )
      : "reset time unavailable";
  return { value: `${Math.round(limit.remainingPercent)}%`, sub: `left · resets ${reset}` };
}

const NAV_KEYS = NAV.map((n) => n.key);
const SELECTED_CHAT_KEY = "jarvis-selected-chat";

function viewFromHash(): View {
  const h = window.location.hash.slice(1).split("?")[0] as View;
  return NAV_KEYS.includes(h) ? h : "overview";
}

function agentIdFromSessionKey(key: string | null): string {
  if (!key || key === "main" || key === "global") return "main";
  return /^agent:([^:]+):/.exec(key)?.[1] ?? "main";
}

function isPrimarySession(key: string): boolean {
  return key === "main" || key === "global" || /^agent:[^:]+:main$/.test(key);
}

function chatAgentLabel(agentId: string, agents: AgentRoomAgent[]): string {
  if (agentId === "main") return "J.A.R.V.I.S.";
  if (agentId === "codex") return "WALL-E";
  const agent = agents.find((entry) => entry.id === agentId);
  return agent?.identity?.name?.trim() || agent?.name?.trim() || agentId;
}

export default function App() {
  const [view, setView] = useState<View>(viewFromHash);
  const [connected, setConnected] = useState(false);
  const [server, setServer] = useState<any>(null);
  const [nodes, setNodes] = useState<any[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [sessions, setSessions] = useState<AgentRoomSession[]>([]);
  const [agents, setAgents] = useState<AgentRoomAgent[]>([]);
  const [huntingUnlocked, setHuntingUnlocked] = useState<boolean | null>(null);
  const [huntingAccessOpen, setHuntingAccessOpen] = useState(false);
  const [memoryUnlocked, setMemoryUnlocked] = useState<boolean | null>(null);
  const [memoryAccessOpen, setMemoryAccessOpen] = useState(false);
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(() =>
    window.localStorage.getItem(SELECTED_CHAT_KEY),
  );
  const mobileNavBar = useRef<HTMLElement | null>(null);
  const activeMobileNavItem = useRef<HTMLButtonElement | null>(null);

  const navigate = useCallback((v: View) => {
    setView(v);
    window.location.hash = v;
  }, []);

  const requestNavigation = useCallback(
    (nextView: View) => {
      if (nextView === "hunting" && huntingUnlocked !== true) {
        setHuntingAccessOpen(true);
        return;
      }
      if (nextView === "memory" && memoryUnlocked !== true) {
        setMemoryAccessOpen(true);
        return;
      }
      navigate(nextView);
    },
    [huntingUnlocked, memoryUnlocked, navigate],
  );

  useEffect(() => {
    const onHash = () => {
      const nextView = viewFromHash();
      if (nextView === "hunting" && huntingUnlocked === false) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#overview`);
        setView("overview");
        return;
      }
      if (nextView === "memory" && memoryUnlocked === false) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#overview`);
        setView("overview");
        return;
      }
      setView(nextView);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [huntingUnlocked, memoryUnlocked]);

  useEffect(() => {
    let cancelled = false;
    api.huntingAccess()
      .then(({ unlocked }) => {
        if (cancelled) return;
        setHuntingUnlocked(unlocked);
        if (!unlocked && viewFromHash() === "hunting") {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#overview`);
          setView("overview");
        }
      })
      .catch(() => {
        if (!cancelled) setHuntingUnlocked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.memoryAccess()
      .then(({ unlocked }) => {
        if (cancelled) return;
        setMemoryUnlocked(unlocked);
        if (!unlocked && viewFromHash() === "memory") {
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#overview`);
          setView("overview");
        }
      })
      .catch(() => {
        if (!cancelled) setMemoryUnlocked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const nav = mobileNavBar.current;
    const item = activeMobileNavItem.current;
    if (!nav || !item) return;
    nav.scrollTo({
      left: Math.max(0, item.offsetLeft - (nav.clientWidth - item.offsetWidth) / 2),
    });
  }, [view]);

  useEffect(() => {
    if (selectedSessionKey) window.localStorage.setItem(SELECTED_CHAT_KEY, selectedSessionKey);
    else window.localStorage.removeItem(SELECTED_CHAT_KEY);
  }, [selectedSessionKey]);

  const load = useCallback(async () => {
    try {
      const s = await api.status();
      setConnected(Boolean(s.status?.connected));
      setServer(s.status?.server ?? null);
    } catch {
      setConnected(false);
    }
    const results = await Promise.allSettled([
      api.nodes(),
      api.usage("7d"),
      api.sessions(100),
      api.agents(),
    ]);
    if (results[0].status === "fulfilled") setNodes(results[0].value.nodes ?? []);
    if (results[1].status === "fulfilled") setUsage(results[1].value ?? null);
    if (results[2].status === "fulfilled") setSessions(results[2].value.sessions ?? []);
    if (results[3].status === "fulfilled") setAgents(results[3].value.agents ?? []);
  }, []);

  const deleteNode = useCallback(
    async (nodeId: string) => {
      await api.deleteNode(nodeId);
      await load();
    },
    [load],
  );

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  useStreamEvent("gateway.status", (st) => {
    setConnected(Boolean(st?.connected));
    setServer(st?.server ?? null);
  });
  useStreamEvent("sessions.changed", () => load());
  useStreamEvent("agents.changed", () => load());

  const onlineNodes = nodes.filter((n) => n?.connected).length;
  const gatewayTotals = normalizedTotals(usage?.totals);
  const jarvisUsage = normalizedTotals(usage?.attribution?.agents.main ?? gatewayTotals);
  const codexUsage = normalizedTotals(usage?.attribution?.agents.codex);
  const codexGatewayUsage = normalizedTotals(usage?.attribution?.sources?.codexGateway);
  const codexDesktopUsage = normalizedTotals(usage?.attribution?.sources?.codexDesktop);
  const combinedUsage = normalizedTotals(usage?.attribution?.combined ?? gatewayTotals);
  const codexWeekly = codexWeeklySummary(usage?.attribution?.codexWeeklyLimit);
  const selectedSessionExists = sessions.some((session) => session.key === selectedSessionKey);
  const defaultSession =
    sessions.find((session) => isPrimarySession(session.key)) ??
    sessions.find((session) => session.key.includes(":dashboard:")) ??
    sessions[0];
  const sessionKey =
    (selectedSessionExists || sessions.length === 0 ? selectedSessionKey : null) ??
    defaultSession?.key ??
    null;
  const activeSessionKeys = new Set(
    sessions
      .filter((session) => session.hasActiveRun || session.status === "running")
      .map((session) => session.key),
  );
  // A selected chat remains active between requests even though the gateway marks its last run done.
  if (sessionKey) activeSessionKeys.add(sessionKey);
  const activeCount = activeSessionKeys.size;
  const activeSession = sessions.find((session) => session.key === sessionKey);
  const selectedSessionUsage = normalizedTotals(
    usage?.attribution?.sessions.find((session) => session.key === sessionKey)?.totals,
  );
  const selectedContext = contextSummary(activeSession);
  const statusLabel = connected
    ? server?.version
      ? `core v${server.version}`
      : "STANDBY"
    : "LINK DOWN";

  async function createChat() {
    const agentId = agentIdFromSessionKey(sessionKey);
    const timestamp = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
    const created = await api.createSession(agentId, `Chat · ${timestamp}`);
    if (typeof created.key !== "string") throw new Error("Gateway did not return a session key");
    setSelectedSessionKey(created.key);
    await load();
  }

  async function selectChatAgent(agentId: string) {
    const existing = sessions
      .filter((session) => agentIdFromSessionKey(session.key) === agentId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    if (existing) {
      setSelectedSessionKey(existing.key);
      return;
    }

    const created = await api.createSession(agentId, chatAgentLabel(agentId, agents));
    if (typeof created.key !== "string") throw new Error("Gateway did not return a session key");
    setSelectedSessionKey(created.key);
    await load();
  }

  async function removeChat(session: AgentRoomSession) {
    const agentId = agentIdFromSessionKey(session.key);
    if (isPrimarySession(session.key)) await api.resetSession(session.key, agentId);
    else await api.deleteSession(session.key, agentId);

    if (session.key === sessionKey) {
      const next = sessions.find(
        (candidate) =>
          candidate.key !== session.key &&
          (isPrimarySession(candidate.key) || candidate.key.includes(":dashboard:")),
      );
      setSelectedSessionKey(next?.key ?? (isPrimarySession(session.key) ? session.key : null));
    }
    await load();
  }

  function renderView() {
    switch (view) {
      case "agent-room":
        return (
          <AgentRoom
            agents={agents}
            sessions={sessions}
            connected={connected}
            onOpenSession={(key) => {
              setSelectedSessionKey(key);
              navigate("chat");
            }}
            onAgentCreated={load}
          />
        );
      case "chat":
        return (
          <div className="h-[calc(100vh-8rem)] md:h-[calc(100vh-4rem)]">
            <Chat
              sessionKey={sessionKey}
              sessions={sessions}
              agents={agents}
              showSessions
              onSelectSession={setSelectedSessionKey}
              onSelectAgent={selectChatAgent}
              onNewChat={createChat}
              onRemoveSession={removeChat}
            />
          </div>
        );
      case "memory":
        if (memoryUnlocked !== true) return null;
        return <MemoryPage />;
      case "workflows":
        return (
          <Suspense fallback={<div className="p-4 font-mono text-xs text-gray-500">Preparing workflow workspace…</div>}>
            <WorkflowsPage />
          </Suspense>
        );
      case "extraction":
        return (
          <Suspense fallback={<div className="p-4 font-mono text-xs text-gray-500">Loading extractions…</div>}>
            <ExtractionPage agents={agents} />
          </Suspense>
        );
      case "hunting":
        if (huntingUnlocked !== true) return null;
        return (
          <Suspense fallback={<div className="hunting-route-loading">Preparing Hunting workspace…</div>}>
            <HuntingPage />
          </Suspense>
        );
      case "nodes":
        return (
          <HoloPanel
            title="Nodes"
            right={
              <span className="font-mono text-xs text-accent">
                {onlineNodes}/{nodes.length} online
              </span>
            }
          >
            <NodesPanel nodes={nodes} onDelete={deleteNode} />
          </HoloPanel>
        );
      case "screens":
        return (
          <Suspense fallback={<div className="screens-route-loading">Preparing secure screen view…</div>}>
            <ScreensPage nodes={nodes} />
          </Suspense>
        );
      case "usage":
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatTile
                label="Session · 7d"
                value={fmt(selectedSessionUsage.totalTokens)}
                sub="selected chat · incl. cache"
                icon={<Cpu size={16} />}
              />
              <StatTile
                label="J.A.R.V.I.S. · 7d"
                value={fmt(jarvisUsage.totalTokens)}
                sub="OpenClaw agent · incl. cache"
                icon={<Bot size={16} />}
              />
              <StatTile
                label="WALL-E + Codex · 7d"
                value={fmt(codexUsage.totalTokens)}
                sub="agent + desktop app · incl. cache"
                icon={<Code2 size={16} />}
              />
              <StatTile
                label="Combined · 7d"
                value={fmt(combinedUsage.totalTokens)}
                sub="both agents · incl. cache"
                icon={<Sigma size={16} />}
              />
              <StatTile
                label="Codex weekly"
                value={codexWeekly.value}
                sub={codexWeekly.sub}
                icon={<Gauge size={16} />}
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <UsagePanel
                title="Selected session · 7d"
                subtitle={`${selectedContext.value} context · ${selectedContext.sub}`}
                totals={selectedSessionUsage}
              />
              <UsagePanel
                title="J.A.R.V.I.S. / OpenClaw · 7d"
                subtitle="agent: main"
                totals={jarvisUsage}
              />
              <UsagePanel
                title="OpenClaw WALL-E agent · 7d"
                subtitle="gateway agent: codex"
                totals={codexGatewayUsage}
              />
              <UsagePanel
                title="Codex desktop app · 7d"
                subtitle="local Codex tasks"
                totals={codexDesktopUsage}
              />
              <UsagePanel
                title="WALL-E + Codex usage · 7d"
                subtitle="OpenClaw agent + desktop app"
                totals={codexUsage}
              />
              <UsagePanel
                title="Everything · 7d"
                subtitle="J.A.R.V.I.S. + WALL-E + Codex"
                totals={combinedUsage}
              />
            </div>
          </div>
        );
      default:
        return renderOverview();
    }
  }

  function renderOverview() {
    return (
      <>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatTile label="Active" value={activeCount} sub="current chat + running" icon={<Zap size={16} />} />
          <StatTile label="Sessions" value={sessions.length} sub="tracked" icon={<Layers size={16} />} />
          <StatTile
            label="Both agents · 7d"
            value={fmt(combinedUsage.totalTokens)}
            sub="incl. cache tokens"
            icon={<Sigma size={16} />}
          />
          <StatTile
            label="Session context"
            value={selectedContext.value}
            sub={selectedContext.sub}
            icon={<Cpu size={16} />}
          />
          <StatTile
            label="Codex weekly"
            value={codexWeekly.value}
            sub={codexWeekly.sub}
            icon={<Gauge size={16} />}
          />
        </div>

        <div className="mt-4 grid items-stretch gap-4 xl:grid-cols-[1fr_auto_1fr]">
          <HoloPanel title="Usage · 7d" className="order-2 xl:order-1">
            <UsageCompact
              session={selectedSessionUsage}
              jarvis={jarvisUsage}
              codex={codexUsage}
              combined={combinedUsage}
            />
          </HoloPanel>

          <div className="order-1 flex items-center justify-center xl:order-2">
            <JarvisCore connected={connected} working={activeCount} statusLabel={statusLabel} />
          </div>

          <HoloPanel
            title="Nodes"
            className="order-3"
            right={
              <span className="font-mono text-xs text-accent">
                {onlineNodes}/{nodes.length} online
              </span>
            }
          >
            <NodesPanel nodes={nodes} onDelete={deleteNode} />
          </HoloPanel>
        </div>

        <div className="mt-4 h-[26rem]">
          <Chat
            sessionKey={sessionKey}
            sessions={sessions}
            agents={agents}
            onSelectAgent={selectChatAgent}
          />
        </div>
      </>
    );
  }

  return (
    <div className="orion-shell flex h-screen overflow-hidden">
      <Sidebar
        connected={connected}
        active={view}
        onNavigate={requestNavigation}
        huntingUnlocked={huntingUnlocked === true}
        memoryUnlocked={memoryUnlocked === true}
      />
      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* mobile header + nav */}
        <div className="md:hidden">
          <div className="orion-mobile-header mb-3 flex items-center justify-between">
            <div className="orion-brand orion-brand--mobile">
              <span className="orion-brand__emblem" aria-hidden="true">
                <img src="/brand/orion-identity.png" alt="" />
              </span>
              <div>
                <div className="wordmark text-base text-accent text-glow">ORION</div>
                <div className="hud-label">OPENCLAW CONTROL</div>
              </div>
            </div>
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                connected ? "animate-core-pulse bg-emerald-400" : "bg-red-500"
              }`}
            />
          </div>
          <nav ref={mobileNavBar} className="mb-4 flex gap-2 overflow-x-auto pb-1">
            {NAV.map((it) => {
              const presentation = navPresentation(it, huntingUnlocked === true, memoryUnlocked === true);
              const Icon = presentation.icon;
              return (
                <button
                  key={it.key}
                  ref={view === it.key ? activeMobileNavItem : undefined}
                  onClick={() => requestNavigation(it.key)}
                  aria-label={
                    ((it.key === "hunting" && huntingUnlocked !== true) ||
                      (it.key === "memory" && memoryUnlocked !== true))
                      ? "Open restricted section"
                      : presentation.label
                  }
                  className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    view === it.key
                      ? "border-hudborder-light bg-accent/10 text-accent-hover"
                      : "border-hudborder text-gray-400"
                  }`}
                >
                  <Icon size={14} />
                  <span>{presentation.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {renderView()}
      </main>
      <HuntingAccessDialog
        open={huntingAccessOpen}
        onClose={() => setHuntingAccessOpen(false)}
        onUnlocked={() => {
          setHuntingUnlocked(true);
          setHuntingAccessOpen(false);
          navigate("hunting");
        }}
      />
      <MemoryAccessDialog
        open={memoryAccessOpen}
        onClose={() => setMemoryAccessOpen(false)}
        onUnlocked={() => {
          setMemoryUnlocked(true);
          setMemoryAccessOpen(false);
          navigate("memory");
        }}
      />
    </div>
  );
}

function UsageCompact({
  session,
  jarvis,
  codex,
  combined,
}: {
  session: UsageTotals;
  jarvis: UsageTotals;
  codex: UsageTotals;
  combined: UsageTotals;
}) {
  const rows: Array<[string, string, string]> = [
    ["Selected session", fmt(session.totalTokens), "7d"],
    ["J.A.R.V.I.S.", fmt(jarvis.totalTokens), "OpenClaw"],
    ["WALL-E + Codex", fmt(codex.totalTokens), "agent + desktop"],
    ["Combined", fmt(combined.totalTokens), "incl. cache"],
  ];
  return (
    <div className="space-y-2">
      {rows.map(([label, value, note]) => (
        <div key={label} className="flex items-center justify-between gap-4 font-mono text-sm">
          <span className="min-w-0 text-gray-400">
            {label}{" "}
            <small className="ml-1 text-[0.58rem] uppercase tracking-[0.08em] text-gray-600">
              {note}
            </small>
          </span>
          <span className="text-accent">{value}</span>
        </div>
      ))}
    </div>
  );
}

function UsagePanel({
  title,
  subtitle,
  totals,
}: {
  title: string;
  subtitle: string;
  totals: UsageTotals;
}) {
  const costAvailable = totals.totalCost > 0 || totals.totalTokens === 0;
  const partialCost = totals.missingCostEntries > 0;
  const rows: Array<[string, string]> = [
    ["Uncached input", fmt(totals.input)],
    ["Output", fmt(totals.output)],
    ["Cache read", fmt(totals.cacheRead)],
    ["Cache write", fmt(totals.cacheWrite)],
    ["Provider total", fmt(totals.totalTokens)],
    [
      "Est. cost",
      costAvailable ? `$${totals.totalCost.toFixed(2)}${partialCost ? "*" : ""}` : "—",
    ],
  ];
  return (
    <HoloPanel
      title={title}
      right={
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.08em] text-gray-600">
          {subtitle}
        </span>
      }
    >
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between font-mono text-sm">
            <span className="text-gray-400">{label}</span>
            <span className="text-accent">{value}</span>
          </div>
        ))}
        {!costAvailable || partialCost ? (
          <p className="pt-1 font-mono text-[0.6rem] uppercase tracking-[0.08em] text-amber-300/70">
            {!costAvailable
              ? "Estimate unavailable: model pricing is missing"
              : "* Partial estimate: one or more rates are missing"}
          </p>
        ) : (
          <p className="pt-1 font-mono text-[0.6rem] uppercase tracking-[0.08em] text-gray-600">
            Standard API token rates · USD
          </p>
        )}
      </div>
    </HoloPanel>
  );
}
