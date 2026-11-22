import { LoaderCircle, SlidersHorizontal } from "lucide-react";
import {
  api,
  type ExecutionTarget,
  type ExecutionTargetState,
  type AgentModels,
} from "../../lib/api";
import {
  ContextWindow,
  ExecutionTargetSwitch,
  SessionControls,
} from "./Controls";
import { useEffect, useRef, useState } from "react";
import type { AgentRoomSession, AgentRoomAgent } from "../AgentRoom";
import { chatAgentName, EMPTY_EXECUTION_STATE } from "../../lib/chat/messages";
import { ChatSheet, closeChatSheet } from "./ChatSheet";

export function ConversationPreferences({
  sessionKey,
  session,
  sessionModel,
  agentId,
  chatAgents,
  onSelectAgent,
  busy,
  onCompact,
  sheet,
}: {
  sessionKey: string | null;
  session?: AgentRoomSession;
  sessionModel?: string;
  agentId: string;
  chatAgents: AgentRoomAgent[];
  onSelectAgent?: (id: string) => Promise<void>;
  busy: boolean;
  onCompact: () => Promise<void>;
  sheet: boolean;
}) {
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
  const settings = useRef<HTMLDialogElement>(null);
  const [details, setDetails] = useState(() => {
    try {
      return localStorage.getItem("orion.chat.details") !== "false";
    } catch {
      return true;
    }
  });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!sessionKey) {
      setLoading(false);
      return;
    }
    let active = true;
    Promise.allSettled([
      api.executionTarget(sessionKey),
      api.agentModels(agentId),
    ]).then(([targetResult, modelResult]) => {
      if (!active) return;
      if (targetResult.status === "fulfilled") {
        setExecutionState(targetResult.value);
      } else {
        setTargetError(
          targetResult.reason?.message ?? "Could not load device routing",
        );
      }
      if (modelResult.status === "fulfilled") {
        setAgentModels(modelResult.value);
      } else {
        setModelError(
          modelResult.reason?.message ?? "Could not load model choices",
        );
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [sessionKey, agentId]);
  async function selectAgent(nextAgentId: string) {
    if (!onSelectAgent || agentBusy || nextAgentId === agentId) return;
    setAgentBusy(true);
    setAgentError(null);
    try {
      if (sheet) await closeChatSheet(settings.current);
      await onSelectAgent(nextAgentId);
    } catch (cause) {
      setAgentError(
        cause instanceof Error ? cause.message : "Could not switch agent",
      );
      if (sheet && settings.current && !settings.current.open) {
        settings.current.showModal();
      }
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
      setTargetError(
        cause instanceof Error
          ? cause.message
          : "Could not change device routing",
      );
    } finally {
      setTargetBusy(false);
    }
  }

  async function selectModel(model: string) {
    if (!sessionKey || modelBusy || model === (modelOverride ?? sessionModel))
      return;
    setModelBusy(true);
    setModelError(null);
    try {
      await api.setSessionModel(sessionKey, agentId, model);
      setModelOverride(model);
      setAgentModels((current) =>
        current ? { ...current, current: model } : current,
      );
    } catch (cause) {
      setModelError(
        cause instanceof Error ? cause.message : "Could not change model",
      );
    } finally {
      setModelBusy(false);
    }
  }

  const selectedModel = modelOverride ?? sessionModel ?? agentModels?.current;
  const modelReasoning = agentModels?.models.find(
    (model) => model.id === selectedModel,
  )?.reasoning;
  const errors = (
    <>
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
    </>
  );
  const controls = (
    <div className="chat-console-header mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="chat-console-status flex min-w-0 items-center gap-3">
        <ContextWindow session={session} />
      </div>
      <div className="chat-console-controls flex flex-wrap min-w-0 items-center gap-2">
        {loading && (
          <span className="hidden items-center gap-1.5 font-mono text-[0.58rem] uppercase tracking-[0.1em] text-gray-500 lg:flex">
            <LoaderCircle size={11} className="animate-spin" /> Restoring
          </span>
        )}
        <label className={sheet ? "orion-chat-setting-field" : "contents"}>
          {sheet && <span>Agent</span>}
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
        </label>
        <SessionControls
          session={{
            ...chatAgents.find((agent) => agent.id === agentId),
            ...session,
            supportsThinking: modelReasoning ?? session?.supportsThinking,
            key: sessionKey ?? "",
            model: modelOverride ?? sessionModel,
          }}
          sessionKey={sessionKey}
          busy={busy}
          onError={setModelError}
          onCompact={onCompact}
          showLabels={sheet}
        />
        <div className={sheet ? "orion-chat-setting-field orion-chat-setting-wide" : "contents"}>
          {sheet && <span>Execution device</span>}
          <ExecutionTargetSwitch
            value={executionState.target}
            devices={executionState.devices}
            busy={targetBusy || loading}
            disabled={!sessionKey}
            onChange={selectExecutionTarget}
          />
        </div>
        {agentModels && agentModels.models.length > 1 ? (
          <label className={sheet ? "orion-chat-setting-field orion-chat-setting-wide" : "contents"}>
            {sheet && <span>Model</span>}
            <select
              aria-label="Agent model"
              className="chat-console-model-select rounded-lg border border-hudborder bg-black/25 px-2 py-1.5 font-mono text-[0.65rem] text-gray-200 outline-none focus:border-accent/60 disabled:opacity-50"
              value={
                modelOverride ?? sessionModel ?? agentModels.current ?? ""
              }
              disabled={!sessionKey || loading || modelBusy}
              onChange={(event) => selectModel(event.target.value)}
            >
              {agentModels.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );

  if (sheet) {
    return (
      <>
        <button
          type="button"
          className="orion-chat-icon-button"
          aria-label="Chat settings"
          aria-haspopup="dialog"
          onClick={() => settings.current?.showModal()}
        >
          <SlidersHorizontal size={19} aria-hidden="true" />
        </button>
        <ChatSheet dialogRef={settings} title="Chat settings">
          <div className="orion-chat-settings">
            {errors}
            {controls}
          </div>
        </ChatSheet>
      </>
    );
  }

  return (
    <>
      {errors}
      <details
        open={details}
        onToggle={(e) => {
          setDetails(e.currentTarget.open);
          try {
            localStorage.setItem(
              "orion.chat.details",
              String(e.currentTarget.open),
            );
          } catch {
            /* Storage unavailable */
          }
        }}
      >
        <summary className="hud-label cursor-pointer py-1">Details</summary>
        {controls}
      </details>
    </>
  );
}
