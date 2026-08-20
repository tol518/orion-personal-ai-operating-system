// Workflow learning: record a task once, review what Jarvis understood, then replay it.
//
// The screen is deliberately three panels in a line, because that is the whole loop:
//   Record  — mark a window in Screenpipe's continuous recording
//   Review  — read and correct the draft before anything is saved
//   Replay  — supply this run's values and answer the checkpoints
//
// The review step is not a formality. A draft is written by a model from OCR of the user's screen,
// so it is shown in full, editable, with every confirmation gate visible, and nothing reaches the
// workflow store or Jarvis memory until the user presses Save.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleStop,
  Circle,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { useStreamEvent } from "../hooks/useStreamEvent";
import HoloPanel from "./HoloPanel";
import {
  WORKFLOW_ACTION_TYPES,
  type LearnedWorkflow,
  type LearningSession,
  type ScreenpipeStatus,
  type StoredWorkflow,
  type WorkflowRun,
} from "../lib/workflow-types";

function timeOf(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

function riskTone(level: LearnedWorkflow["safety"]["riskLevel"]): string {
  if (level === "high") return "text-red-300";
  if (level === "medium") return "text-amber-300";
  return "text-emerald-300";
}

export default function WorkflowsPage() {
  const [screenpipe, setScreenpipe] = useState<ScreenpipeStatus | null>(null);
  const [sessions, setSessions] = useState<LearningSession[]>([]);
  const [active, setActive] = useState<LearningSession | null>(null);
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>([]);
  const [title, setTitle] = useState("");
  const [includeAudio, setIncludeAudio] = useState(false);
  const [draft, setDraft] = useState<{ spec: LearnedWorkflow; sessionId: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const results = await Promise.allSettled([api.screenpipeStatus(), api.learningSessions(), api.workflows()]);
    if (results[0].status === "fulfilled") setScreenpipe(results[0].value.screenpipe);
    if (results[1].status === "fulfilled") {
      setSessions(results[1].value.sessions ?? []);
      setActive(results[1].value.active ?? null);
    }
    if (results[2].status === "fulfilled") setWorkflows(results[2].value.workflows ?? []);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useStreamEvent("workflow.session.changed", () => load());
  useStreamEvent("workflow.changed", () => load());

  async function run<T>(key: string, work: () => Promise<T>): Promise<T | null> {
    setBusy(key);
    setError(null);
    try {
      return await work();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      return null;
    } finally {
      setBusy(null);
      await load();
    }
  }

  const startRecording = () =>
    run("start", async () => {
      await api.startLearningSession(title.trim() || "Untitled workflow recording", includeAudio);
      setNotice("Recording. Do the task once, at a normal pace, then press Stop.");
    });

  const stopRecording = (session: LearningSession) =>
    run("stop", async () => {
      const { session: stopped } = await api.stopLearningSession(session.id);
      setNotice(
        stopped.digest?.segments?.length
          ? `Captured ${stopped.digest.segments.length} screen segments across ${stopped.digest.apps.length} app(s).`
          : "Screenpipe returned nothing for that window. Was it recording?",
      );
    });

  const extract = (session: LearningSession) =>
    run("extract", async () => {
      const { draft: extracted } = await api.extractWorkflow(session.id);
      setDraft({ spec: extracted, sessionId: session.id });
      setNotice("Draft ready. Read every step, correct anything wrong, then save it.");
    });

  const saveDraft = () =>
    run("save", async () => {
      if (!draft) return;
      const { workflow, memory } = await api.saveWorkflow(draft.spec, draft.sessionId);
      setDraft(null);
      setSelectedId(workflow.id);
      setNotice(
        memory.saved
          ? `Saved. The recipe is now a page in ORION memory, so the agent can find it in chat.`
          : `Saved to the workflow store. The Obsidian memory note could not be written: ${memory.error}`,
      );
    });

  const selected = workflows.find((workflow) => workflow.id === selectedId) ?? null;
  const capturable = sessions.filter((session) => session.status === "captured" || session.status === "extracted");

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3 px-1 pb-1">
        <div>
          <h1 className="m-0 text-[clamp(1.85rem,3vw,2.55rem)] font-semibold leading-none text-[#e8f7fc]">
            Workflows
          </h1>
          <p className="mt-2 font-mono text-[0.72rem] text-[#7e91a5]">
            Record a task once · Screenpipe observes · a model writes the recipe · you approve it · J.A.R.V.I.S. replays it
          </p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[0.68rem] text-[#a9bac9]">
          <span
            className={`h-2 w-2 rounded-full ${
              screenpipe?.readable
                ? "animate-core-pulse bg-emerald-400"
                : screenpipe?.running
                  ? "bg-amber-400"
                  : "bg-red-500"
            }`}
          />
          <span>
            {screenpipe
              ? screenpipe.readable
                ? `Screenpipe up · ${screenpipe.baseUrl}`
                : screenpipe.running
                  ? `Screenpipe running but not readable · ${screenpipe.baseUrl}`
                  : `Screenpipe unreachable · ${screenpipe.baseUrl}`
              : "checking Screenpipe…"}
          </span>
          <button
            onClick={load}
            className="btn-hud ml-2 flex items-center gap-1 px-2 py-1 text-[0.62rem] uppercase tracking-[0.12em]"
          >
            <RefreshCw size={12} /> refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 font-mono text-xs text-red-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="rounded-lg border border-hudborder bg-accent/5 p-3 font-mono text-xs text-gray-300">{notice}</div>
      )}
      {screenpipe && !screenpipe.running && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 font-mono text-xs text-amber-200">
          Screenpipe is not answering ({screenpipe.detail}). Start it with <code>npx screenpipe record</code> — nothing
          can be learned until it is recording.
        </div>
      )}
      {screenpipe?.running && !screenpipe.readable && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 font-mono text-xs text-amber-200">
          Screenpipe is recording but will not let J.A.R.V.I.S. read it: {screenpipe.detail}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <RecordPanel
          active={active}
          title={title}
          includeAudio={includeAudio}
          busy={busy}
          screenpipeUp={Boolean(screenpipe?.readable)}
          onTitle={setTitle}
          onIncludeAudio={setIncludeAudio}
          onStart={startRecording}
          onStop={stopRecording}
        />
        <SessionsPanel
          sessions={capturable}
          busy={busy}
          onExtract={extract}
          onOpenDraft={(session) => session.draft && setDraft({ spec: session.draft, sessionId: session.id })}
          onAbandon={(session) => run("abandon", () => api.abandonLearningSession(session.id))}
        />
      </div>

      {draft && (
        <DraftEditor
          spec={draft.spec}
          saving={busy === "save"}
          onChange={(spec) => setDraft({ ...draft, spec })}
          onCancel={() => setDraft(null)}
          onSave={saveDraft}
        />
      )}

      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <HoloPanel title="Saved workflows" right={<span className="font-mono text-xs text-accent">{workflows.length}</span>}>
          {workflows.length === 0 ? (
            <p className="font-mono text-xs text-gray-500">
              Nothing learned yet. Record a task above and J.A.R.V.I.S. will write its first recipe.
            </p>
          ) : (
            <ul className="space-y-2">
              {workflows.map((workflow) => (
                <li key={workflow.id}>
                  <button
                    onClick={() => setSelectedId(workflow.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      selectedId === workflow.id
                        ? "border-hudborder-light bg-accent/10"
                        : "border-hudborder hover:bg-surface-3"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-gray-200">{workflow.name}</span>
                      <span className={`font-mono text-[0.6rem] uppercase ${riskTone(workflow.spec.safety.riskLevel)}`}>
                        {workflow.spec.safety.riskLevel}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[0.6rem] text-gray-500">
                      {workflow.spec.steps.length} steps · {workflow.spec.variables.length} inputs
                      {workflow.memoryId ? " · in memory" : " · not in memory"}
                      {workflow.lastRun ? ` · last ${workflow.lastRun.status}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </HoloPanel>

        {selected ? (
          <RunPanel
            key={selected.id}
            workflow={selected}
            onDelete={() =>
              run("delete", async () => {
                await api.deleteWorkflow(selected.id);
                setSelectedId(null);
                setNotice("Workflow removed. Its page in your Obsidian vault was left untouched.");
              })
            }
          />
        ) : (
          <HoloPanel title="Replay">
            <p className="font-mono text-xs text-gray-500">Select a workflow to fill in its inputs and run it.</p>
          </HoloPanel>
        )}
      </div>
    </div>
  );
}

function RecordPanel({
  active,
  title,
  includeAudio,
  busy,
  screenpipeUp,
  onTitle,
  onIncludeAudio,
  onStart,
  onStop,
}: {
  active: LearningSession | null;
  title: string;
  includeAudio: boolean;
  busy: string | null;
  screenpipeUp: boolean;
  onTitle: (value: string) => void;
  onIncludeAudio: (value: boolean) => void;
  onStart: () => void;
  onStop: (session: LearningSession) => void;
}) {
  return (
    <HoloPanel title="1 · Record workflow">
      {active ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 font-mono text-xs text-red-300">
            <Circle size={10} className="animate-core-pulse fill-current" />
            recording since {timeOf(active.startedAt)}
          </div>
          <div className="text-sm text-gray-200">{active.title}</div>
          <p className="font-mono text-[0.65rem] leading-relaxed text-gray-500">
            Screenpipe is already recording continuously; this only marks the window to read back.
            {active.includeAudio ? " Your narration will be included." : " Audio is not being read for this window."}
          </p>
          <button
            onClick={() => onStop(active)}
            disabled={busy === "stop"}
            className="btn-hud flex items-center gap-2 px-3 py-2 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
          >
            {busy === "stop" ? <Loader2 size={14} className="animate-spin" /> : <CircleStop size={14} />} stop
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="hud-label">what are you about to do?</span>
            <input
              value={title}
              onChange={(event) => onTitle(event.target.value)}
              placeholder="Submit monthly invoice"
              className="mt-1 w-full rounded-lg border border-hudborder bg-surface-1/60 px-3 py-2 text-sm text-gray-200 outline-none focus:border-hudborder-light"
            />
          </label>
          <label className="flex cursor-pointer items-start gap-2 font-mono text-[0.65rem] leading-relaxed text-gray-400">
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(event) => onIncludeAudio(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              Read my spoken narration for this recording. Off by default: transcripts stay in Screenpipe unless you
              ask for them here. Screenshots are never read either way.
            </span>
          </label>
          <button
            onClick={onStart}
            disabled={busy === "start" || !screenpipeUp}
            className="btn-hud flex items-center gap-2 px-3 py-2 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
          >
            {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <Circle size={14} />} record workflow
          </button>
        </div>
      )}
    </HoloPanel>
  );
}

function SessionsPanel({
  sessions,
  busy,
  onExtract,
  onOpenDraft,
  onAbandon,
}: {
  sessions: LearningSession[];
  busy: string | null;
  onExtract: (session: LearningSession) => void;
  onOpenDraft: (session: LearningSession) => void;
  onAbandon: (session: LearningSession) => void;
}) {
  return (
    <HoloPanel title="2 · Captured sessions">
      {sessions.length === 0 ? (
        <p className="font-mono text-xs text-gray-500">
          No captured recording waiting. Stop a recording and it appears here.
        </p>
      ) : (
        <ul className="space-y-3">
          {sessions.map((session) => (
            <li key={session.id} className="rounded-lg border border-hudborder p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-gray-200">{session.title}</div>
                  <div className="mt-1 font-mono text-[0.6rem] text-gray-500">
                    {timeOf(session.startedAt)} → {timeOf(session.endedAt)} · {session.digest?.segments.length ?? 0}{" "}
                    segments · {session.digest?.apps.join(", ") || "no app identified"}
                  </div>
                  {session.digest && (
                    <div className="mt-1 font-mono text-[0.6rem] text-gray-600">
                      {session.digest.stats.redactions} redacted · {session.digest.stats.excludedItems} excluded ·{" "}
                      {session.digest.stats.duplicateLines} duplicate lines dropped
                      {session.digest.unavailable.length
                        ? ` · missing: ${session.digest.unavailable.map((entry) => entry.contentType).join(", ")}`
                        : ""}
                    </div>
                  )}
                  {session.error && (
                    <div className="mt-1 font-mono text-[0.6rem] text-amber-300">{session.error}</div>
                  )}
                </div>
                <button
                  onClick={() => onAbandon(session)}
                  title="Discard this capture"
                  className="rounded p-1 text-gray-600 hover:text-red-300"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => onExtract(session)}
                  disabled={busy === "extract"}
                  className="btn-hud flex items-center gap-1.5 px-2.5 py-1.5 text-[0.62rem] uppercase tracking-[0.12em] disabled:opacity-50"
                >
                  {busy === "extract" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  {session.draft ? "extract again" : "extract workflow"}
                </button>
                {session.draft && (
                  <button
                    onClick={() => onOpenDraft(session)}
                    className="btn-hud px-2.5 py-1.5 text-[0.62rem] uppercase tracking-[0.12em]"
                  >
                    review draft
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </HoloPanel>
  );
}

/** The gate before anything is stored: the full draft, editable, with every checkpoint visible. */
function DraftEditor({
  spec,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  spec: LearnedWorkflow;
  saving: boolean;
  onChange: (spec: LearnedWorkflow) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const gates = spec.steps.filter((step) => step.requiresUserConfirmation).length;
  const patchStep = (index: number, patch: Partial<LearnedWorkflow["steps"][number]>) =>
    onChange({ ...spec, steps: spec.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)) });

  return (
    <HoloPanel
      title="3 · Review before saving"
      right={
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.1em] text-gray-500">
          nothing is saved until you press save
        </span>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="hud-label">name</span>
            <input
              value={spec.name}
              onChange={(event) => onChange({ ...spec, name: event.target.value })}
              className="mt-1 w-full rounded-lg border border-hudborder bg-surface-1/60 px-3 py-2 text-sm text-gray-200 outline-none focus:border-hudborder-light"
            />
          </label>
          <label className="block">
            <span className="hud-label">intent</span>
            <input
              value={spec.description}
              onChange={(event) => onChange({ ...spec, description: event.target.value })}
              className="mt-1 w-full rounded-lg border border-hudborder bg-surface-1/60 px-3 py-2 text-sm text-gray-200 outline-none focus:border-hudborder-light"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono text-[0.65rem] text-gray-400">
          <span className={riskTone(spec.safety.riskLevel)}>risk {spec.safety.riskLevel}</span>
          <span>·</span>
          <span>{gates} confirmation checkpoint(s)</span>
          <span>·</span>
          <span>learned from {spec.source.apps.join(", ") || "an unidentified app"}</span>
          <label className="ml-auto flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={spec.safety.requiresConfirmationBeforeRun}
              onChange={(event) =>
                onChange({
                  ...spec,
                  safety: { ...spec.safety, requiresConfirmationBeforeRun: event.target.checked },
                })
              }
            />
            <span>ask me before the first step</span>
          </label>
        </div>

        <div>
          <div className="hud-label mb-2">inputs supplied at run time</div>
          {spec.variables.length === 0 ? (
            <p className="font-mono text-xs text-gray-500">None; this workflow runs the same way every time.</p>
          ) : (
            <ul className="space-y-2">
              {spec.variables.map((variable, index) => (
                <li key={variable.name} className="grid gap-2 md:grid-cols-[10rem_1fr_auto]">
                  <code className="rounded bg-surface-3 px-2 py-1 font-mono text-xs text-accent">{variable.name}</code>
                  <input
                    value={variable.description}
                    onChange={(event) =>
                      onChange({
                        ...spec,
                        variables: spec.variables.map((entry, at) =>
                          at === index ? { ...entry, description: event.target.value } : entry,
                        ),
                      })
                    }
                    className="rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1 text-xs text-gray-300 outline-none focus:border-hudborder-light"
                  />
                  <label className="flex items-center gap-1.5 font-mono text-[0.6rem] text-gray-500">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(event) =>
                        onChange({
                          ...spec,
                          variables: spec.variables.map((entry, at) =>
                            at === index ? { ...entry, required: event.target.checked } : entry,
                          ),
                        })
                      }
                    />
                    required
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="hud-label mb-2">steps</div>
          <ol className="space-y-3">
            {spec.steps.map((step, index) => (
              <li key={`${step.id}-${index}`} className="rounded-lg border border-hudborder p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-1 font-mono text-xs text-accent">{index + 1}</span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <textarea
                      value={step.instruction}
                      onChange={(event) => patchStep(index, { instruction: event.target.value })}
                      rows={2}
                      className="w-full resize-y rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1.5 text-sm text-gray-200 outline-none focus:border-hudborder-light"
                    />
                    <div className="grid gap-2 md:grid-cols-3">
                      <select
                        value={step.actionType}
                        onChange={(event) =>
                          patchStep(index, { actionType: event.target.value as LearnedWorkflow["steps"][number]["actionType"] })
                        }
                        className="rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1 font-mono text-[0.65rem] text-gray-300 outline-none"
                      >
                        {WORKFLOW_ACTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                      <input
                        value={step.target?.text ?? ""}
                        onChange={(event) =>
                          patchStep(index, { target: { ...step.target, text: event.target.value } })
                        }
                        placeholder="text anchor"
                        className="rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1 font-mono text-[0.65rem] text-gray-300 outline-none focus:border-hudborder-light"
                      />
                      <input
                        value={step.input ?? ""}
                        onChange={(event) => patchStep(index, { input: event.target.value })}
                        placeholder="value to enter, {{variable}} allowed"
                        className="rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1 font-mono text-[0.65rem] text-gray-300 outline-none focus:border-hudborder-light"
                      />
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <input
                        value={step.successCheck ?? ""}
                        onChange={(event) => patchStep(index, { successCheck: event.target.value })}
                        placeholder="success check: text the page must show"
                        className="rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1 font-mono text-[0.65rem] text-gray-300 outline-none focus:border-hudborder-light"
                      />
                      <input
                        value={step.fallback ?? ""}
                        onChange={(event) => patchStep(index, { fallback: event.target.value })}
                        placeholder="fallback if the UI differs"
                        className="rounded-lg border border-hudborder bg-surface-1/60 px-2 py-1 font-mono text-[0.65rem] text-gray-300 outline-none focus:border-hudborder-light"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-3 font-mono text-[0.6rem] text-gray-500">
                      {step.url && <span className="truncate text-gray-400">{step.url}</span>}
                      {step.app && <span>{step.app}</span>}
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={step.requiresUserConfirmation === true}
                          onChange={(event) => patchStep(index, { requiresUserConfirmation: event.target.checked })}
                        />
                        <span className={step.requiresUserConfirmation ? "text-amber-300" : ""}>
                          ask me before this step
                        </span>
                      </label>
                      <button
                        onClick={() => onChange({ ...spec, steps: spec.steps.filter((_, at) => at !== index) })}
                        className="ml-auto flex items-center gap-1 text-gray-600 hover:text-red-300"
                      >
                        <Trash2 size={11} /> remove step
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <button
            onClick={() =>
              onChange({
                ...spec,
                steps: [
                  ...spec.steps,
                  {
                    id: `step-${spec.steps.length + 1}`,
                    instruction: "",
                    actionType: "custom",
                    requiresUserConfirmation: false,
                  },
                ],
              })
            }
            className="btn-hud mt-3 flex items-center gap-1.5 px-2.5 py-1.5 text-[0.62rem] uppercase tracking-[0.12em]"
          >
            <Plus size={12} /> add step
          </button>
        </div>

        <div className="rounded-lg border border-hudborder bg-surface-1/40 p-3">
          <div className="hud-label mb-1.5">never allowed, in this or any workflow</div>
          <ul className="space-y-0.5 font-mono text-[0.6rem] text-gray-500">
            {spec.safety.blockedActions.map((action) => (
              <li key={action}>· {action}</li>
            ))}
          </ul>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onSave}
            disabled={saving || !spec.name.trim() || spec.steps.length === 0}
            className="btn-hud flex items-center gap-2 px-3 py-2 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} save to jarvis memory
          </button>
          <button onClick={onCancel} className="btn-hud px-3 py-2 text-xs uppercase tracking-[0.12em]">
            discard draft
          </button>
        </div>
      </div>
    </HoloPanel>
  );
}

function RunPanel({ workflow, onDelete }: { workflow: StoredWorkflow; onDelete: () => void }) {
  const spec = workflow.spec;
  const [values, setValues] = useState<Record<string, string>>({});
  const [run, setRun] = useState<WorkflowRun | null>(workflow.lastRun ?? null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = useMemo(
    () => spec.variables.filter((variable) => variable.required && !values[variable.name]?.trim()).map((v) => v.name),
    [spec.variables, values],
  );

  const refreshRuns = useCallback(async () => {
    try {
      const { runs: history } = await api.workflowDetail(workflow.id);
      setRuns(history ?? []);
    } catch {
      // History is informational; a failure here must not block starting a run.
    }
  }, [workflow.id]);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useStreamEvent("workflow.run.changed", (payload: WorkflowRun) => {
    if (payload?.workflowId === workflow.id) setRun(payload);
  });

  async function act(work: () => Promise<{ run: WorkflowRun }>) {
    setBusy(true);
    setError(null);
    try {
      const { run: next } = await work();
      setRun(next);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
      await refreshRuns();
    }
  }

  const waiting = run?.status === "awaiting_confirmation";

  return (
    <HoloPanel
      title={`Replay · ${spec.name}`}
      right={
        <span className={`font-mono text-[0.6rem] uppercase tracking-[0.1em] ${riskTone(spec.safety.riskLevel)}`}>
          risk {spec.safety.riskLevel}
        </span>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-300">{spec.description}</p>

        {spec.variables.length > 0 && (
          <div className="space-y-2">
            <div className="hud-label">this run’s values</div>
            {spec.variables.map((variable) => (
              <label key={variable.name} className="block">
                <span className="font-mono text-[0.62rem] text-gray-500">
                  {variable.name}
                  {variable.required ? " *" : ""} — {variable.description}
                </span>
                <input
                  value={values[variable.name] ?? ""}
                  onChange={(event) => setValues({ ...values, [variable.name]: event.target.value })}
                  placeholder={variable.example ?? ""}
                  className="mt-1 w-full rounded-lg border border-hudborder bg-surface-1/60 px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-hudborder-light"
                />
              </label>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => act(() => api.runWorkflow(workflow.id, values))}
            disabled={busy || missing.length > 0 || waiting}
            title={missing.length ? `Still needs: ${missing.join(", ")}` : undefined}
            className="btn-hud flex items-center gap-2 px-3 py-2 text-xs uppercase tracking-[0.12em] disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} run workflow
          </button>
          {run && (run.status === "running" || waiting) && (
            <button
              onClick={() => act(() => api.cancelWorkflowRun(run.id))}
              className="btn-hud px-3 py-2 text-xs uppercase tracking-[0.12em]"
            >
              cancel run
            </button>
          )}
          <button
            onClick={onDelete}
            className="btn-hud ml-auto flex items-center gap-1.5 px-3 py-2 text-xs uppercase tracking-[0.12em]"
          >
            <Trash2 size={13} /> delete
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 font-mono text-xs text-red-200">
            {error}
          </div>
        )}

        {waiting && run && (
          <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3">
            <div className="flex items-start gap-2 text-sm text-amber-100">
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <span>{run.detail}</span>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => act(() => api.continueWorkflowRun(run.id, true))}
                disabled={busy}
                className="btn-hud flex items-center gap-1.5 px-2.5 py-1.5 text-[0.62rem] uppercase tracking-[0.12em] disabled:opacity-50"
              >
                <Check size={12} /> yes, continue
              </button>
              <button
                onClick={() => act(() => api.continueWorkflowRun(run.id, false))}
                disabled={busy}
                className="btn-hud flex items-center gap-1.5 px-2.5 py-1.5 text-[0.62rem] uppercase tracking-[0.12em] disabled:opacity-50"
              >
                <X size={12} /> no, stop here
              </button>
            </div>
          </div>
        )}

        {run && (
          <div>
            <div className="hud-label mb-2">
              current run · {run.status} · started {timeOf(run.startedAt)}
            </div>
            <ol className="space-y-1.5">
              {spec.steps.map((step, index) => {
                const result = run.results.find((entry) => entry.index === index);
                const tone =
                  result?.status === "ok"
                    ? "text-emerald-300"
                    : result?.status === "failed"
                      ? "text-red-300"
                      : result?.status === "awaiting_confirmation"
                        ? "text-amber-300"
                        : "text-gray-600";
                return (
                  <li key={`${step.id}-${index}`} className="font-mono text-[0.65rem] leading-relaxed">
                    <span className={tone}>
                      {index + 1}. {step.instruction}
                      {step.requiresUserConfirmation ? " (gated)" : ""}
                    </span>
                    {result?.detail && <div className="pl-4 text-gray-500">{result.detail}</div>}
                  </li>
                );
              })}
            </ol>
            {run.detail && !waiting && (
              <p className="mt-2 font-mono text-[0.62rem] text-gray-400">{run.detail}</p>
            )}
          </div>
        )}

        {runs.length > 0 && (
          <div>
            <div className="hud-label mb-1.5">execution history</div>
            <ul className="space-y-0.5 font-mono text-[0.6rem] text-gray-500">
              {runs.slice(0, 8).map((entry) => (
                <li key={entry.id}>
                  {timeOf(entry.startedAt)} · {entry.status}
                  {entry.detail ? ` — ${entry.detail}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="font-mono text-[0.58rem] leading-relaxed text-gray-600">
          {workflow.memoryId
            ? "This recipe is a page in ORION memory, so asking in chat — “run the invoice workflow for Client X” — finds it."
            : "This workflow is not in ORION memory yet; re-save it to write the note."}
        </p>
      </div>
    </HoloPanel>
  );
}
