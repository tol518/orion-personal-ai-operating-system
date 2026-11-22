import { useState, useEffect } from "react";
import { thinkingLevels } from "../../lib/chat/workspace";
import { api } from "../../lib/api";
import { Laptop, Network, MonitorCog, LoaderCircle } from "lucide-react";
import type { ExecutionDevice, ExecutionTarget } from "../../lib/api";
import type { AgentRoomSession } from "../AgentRoom";
import { formatTokens, contextPercent } from "../../lib/chat/messages";
export function ContextWindow({ session }: { session?: AgentRoomSession }) {
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
          {percent === null
            ? "—"
            : `${formatTokens(used)} / ${formatTokens(limit)} · ${percent}%`}
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

export function ExecutionTargetSwitch({
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
      title: devices.mac.available
        ? `Route work to ${devices.mac.name}`
        : "Mac node is offline",
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
            {busy && active ? (
              <LoaderCircle size={11} className="animate-spin" />
            ) : (
              <Icon size={11} />
            )}
            <span>{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SessionControls({
  session,
  sessionKey,
  busy,
  onError,
  onCompact,
  showLabels,
}: {
  session?: Parameters<typeof thinkingLevels>[0] & {
    key: string;
    model?: string;
  };
  sessionKey: string | null;
  busy: boolean;
  onError: (error: string) => void;
  onCompact: () => Promise<void>;
  showLabels: boolean;
}) {
  const [level, setLevel] = useState(session?.thinkingLevel ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(
    () => setLevel(session?.thinkingLevel ?? ""),
    [session?.thinkingLevel, session?.model],
  );
  const options = thinkingLevels(session);
  const explanation =
    "Replace this conversation with a summary so later messages use less context";
  async function change(next?: string) {
    if (!sessionKey || saving) return;
    if (!next && !window.confirm(explanation + "?")) return;
    setSaving(true);
    onError("");
    try {
      if (next) {
        await api.thinking(sessionKey, next);
        setLevel(next);
      } else {
        await api.compact(sessionKey);
        await onCompact();
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "Session update failed");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      {options.length > 0 && (
        <label className={showLabels ? "orion-chat-setting-field" : "contents"}>
          {showLabels && <span>Thinking level</span>}
          <select
            className="rounded border border-hudborder bg-surface-2 p-1 text-xs"
            aria-label="Thinking level"
            disabled={!sessionKey || saving}
            value={level}
            onChange={(e) => change(e.target.value)}
          >
            <option value="" disabled>
              Thinking level
            </option>
            {options.map((option) => (
              <option key={option}>{option}</option>
            ))}
          </select>
        </label>
      )}
      <button
        className="btn-hud px-2 py-1 text-xs"
        disabled={!sessionKey || saving || busy}
        title={explanation}
        onClick={() => change()}
      >
        Compact
      </button>
    </>
  );
}
