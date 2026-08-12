import {
  Activity,
  BrainCircuit,
  BriefcaseBusiness,
  CircleHelp,
  Cpu,
  FileSpreadsheet,
  MessageSquare,
  Monitor,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type View =
  | "overview"
  | "agent-room"
  | "chat"
  | "extraction"
  | "hunting"
  | "memory"
  | "nodes"
  | "screens"
  | "usage"
  | "workflows";

export const NAV: { key: View; icon: LucideIcon; label: string }[] = [
  { key: "overview", icon: Activity, label: "Overview" },
  { key: "agent-room", icon: Users, label: "Agent Room" },
  { key: "chat", icon: MessageSquare, label: "Chat" },
  { key: "hunting", icon: BriefcaseBusiness, label: "Hunting" },
  { key: "extraction", icon: FileSpreadsheet, label: "Extraction" },
  { key: "memory", icon: BrainCircuit, label: "Memory" },
  { key: "workflows", icon: Workflow, label: "Workflows" },
  { key: "nodes", icon: Cpu, label: "Nodes" },
  { key: "screens", icon: Monitor, label: "Screens" },
  { key: "usage", icon: Zap, label: "Usage" },
];

export function navPresentation(item: (typeof NAV)[number], huntingUnlocked: boolean, memoryUnlocked: boolean) {
  return ((item.key === "hunting" && !huntingUnlocked) || (item.key === "memory" && !memoryUnlocked))
    ? { icon: CircleHelp, label: "?" }
    : { icon: item.icon, label: item.label };
}

export default function Sidebar({
  connected,
  active,
  onNavigate,
  huntingUnlocked,
  memoryUnlocked,
}: {
  connected: boolean;
  active: View;
  onNavigate: (v: View) => void;
  huntingUnlocked: boolean;
  memoryUnlocked: boolean;
}) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-hudborder bg-surface-1/80 backdrop-blur md:flex">
      <div className="border-b border-hudborder p-4">
        <div className="wordmark text-lg text-accent text-glow">J.A.R.V.I.S</div>
        <div className="hud-label mt-1 text-[0.55rem]">OPENCLAW CONTROL</div>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {NAV.map((it) => {
          const presentation = navPresentation(it, huntingUnlocked, memoryUnlocked);
          const Icon = presentation.icon;
          return (
            <button
              key={it.key}
              onClick={() => onNavigate(it.key)}
              aria-label={
                ((it.key === "hunting" && !huntingUnlocked) || (it.key === "memory" && !memoryUnlocked))
                  ? "Open restricted section"
                  : presentation.label
              }
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                active === it.key
                  ? "bg-accent/10 text-accent-hover shadow-glow-sm"
                  : "text-gray-400 hover:bg-surface-3 hover:text-gray-200"
              }`}
            >
              <Icon size={18} />
              <span>{presentation.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="border-t border-hudborder p-4">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? "animate-core-pulse bg-emerald-400" : "bg-red-500"
            }`}
          />
          <span className="text-gray-400">{connected ? "Gateway online" : "Gateway offline"}</span>
        </div>
      </div>
    </aside>
  );
}
