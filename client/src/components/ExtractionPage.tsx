// Extraction: the price-comparison CSVs the agent writes into the OpenClaw
// workspace (neutral provider adapters). Read-only on purpose — runs
// are started by the agent, this screen is where the results are found, read,
// and downloaded. Files are listed newest-first and grouped by extraction day.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CircleStop,
  Clock,
  Download,
  FileSpreadsheet,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  type ExtractionDetail,
  type ExtractionFile,
  type ExtractionRun,
  type ExtractionSchedule,
  type ExtractionSource,
  type ExtractionTask,
  type ExtractionTaskInput,
} from "../lib/api";
import type { AgentRoomAgent } from "./AgentRoom";
import HoloPanel from "./HoloPanel";
import ExtractionTaskForm, { weekdaySummary } from "./ExtractionTaskForm";

// While a run is live the counters only move once per date, but elapsed ticks
// every second, so the indicator refreshes on a short interval.
const RUN_POLL_MS = 5_000;
// The file list cannot rely on run counters alone: an extraction Jarvis performs
// itself publishes no run file, so nothing would ever signal that new CSVs
// landed and an open panel would sit stale indefinitely.
const FILE_REFRESH_MS = 30_000;

const PLATFORM_TONE: Record<string, string> = {
  ProviderA: "text-sky-300",
  ProviderC: "text-emerald-300",
  ProviderE: "text-amber-300",
  Multi: "text-fuchsia-300",
};

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

function fmtWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(undefined, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function fmtDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? isoDate
    : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(date);
}

// One line that says what the run is doing right now, phrased the way the
// request is phrased: dates done, dates left.
function runHeadline(run: ExtractionRun): string {
  if (run.status === "complete") return `${run.totalDates} of ${run.totalDates} dates extracted`;
  const noun = run.remainingDates === 1 ? "date" : "dates";
  const left = `${run.remainingDates} ${noun} left`;
  const tail = run.status === "stopped" ? `${left}, not extracted` : left;
  return `${run.extractedDates} of ${run.totalDates} dates extracted · ${tail}`;
}

const STATUS_LABEL: Record<ExtractionRun["status"], string> = {
  running: "running",
  paused: "paused",
  waiting: "outside window",
  stalled: "process gone",
  stopped: "stopped",
  complete: "complete",
};

const ANYTIME: ExtractionSchedule = { mode: "anytime", start: null, end: null };
const DEFAULT_WINDOW: ExtractionSchedule = { mode: "window", start: "00:00", end: "08:00" };

function scheduleSummary(schedule: ExtractionSchedule): string {
  return schedule.mode === "window" ? `${schedule.start}–${schedule.end}` : "anytime";
}

/**
 * Anytime, or a daily start–end window. Editing either time keeps the run in
 * window mode; the caller decides whether that targets one run or the default
 * for runs the agent starts later.
 */
function ScheduleControl({
  schedule,
  disabled,
  onChange,
}: {
  schedule: ExtractionSchedule;
  disabled?: boolean;
  onChange: (next: ExtractionSchedule) => void;
}) {
  const windowed = schedule.mode === "window";
  return (
    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[0.6rem] text-gray-400">
      <Clock size={12} className="text-gray-500" />
      <select
        value={schedule.mode}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value === "window"
              ? {
                  mode: "window",
                  // Keep times already chosen; an anytime schedule carries
                  // nulls, which would normalize straight back to anytime.
                  start: schedule.start ?? DEFAULT_WINDOW.start,
                  end: schedule.end ?? DEFAULT_WINDOW.end,
                }
              : ANYTIME,
          )
        }
        className="rounded border border-hudborder bg-surface-1 px-1 py-0.5 text-gray-300 outline-none disabled:opacity-50"
        aria-label="When this extraction may run"
      >
        <option value="anytime">Run anytime</option>
        <option value="window">Only between</option>
      </select>
      {windowed && (
        <>
          <input
            type="time"
            value={schedule.start ?? DEFAULT_WINDOW.start!}
            disabled={disabled}
            onChange={(event) => onChange({ ...schedule, mode: "window", start: event.target.value })}
            className="rounded border border-hudborder bg-surface-1 px-1 py-0.5 text-gray-300 outline-none disabled:opacity-50"
            aria-label="Window start"
          />
          <span className="text-gray-600">–</span>
          <input
            type="time"
            value={schedule.end ?? DEFAULT_WINDOW.end!}
            disabled={disabled}
            onChange={(event) => onChange({ ...schedule, mode: "window", end: event.target.value })}
            className="rounded border border-hudborder bg-surface-1 px-1 py-0.5 text-gray-300 outline-none disabled:opacity-50"
            aria-label="Window end"
          />
        </>
      )}
    </div>
  );
}

function ExtractionRunIndicator({
  run,
  busy,
  onSelect,
  onCommand,
  onSchedule,
}: {
  run: ExtractionRun;
  busy: boolean;
  onSelect: () => void;
  onCommand: (command: "run" | "pause" | "stop") => void;
  onSchedule: (schedule: ExtractionSchedule) => void;
}) {
  const percent = run.totalDates > 0 ? Math.round((run.extractedDates / run.totalDates) * 100) : 0;
  const finished = run.status === "complete" || run.status === "stopped";
  const tone =
    run.status === "running" || run.status === "waiting"
      ? "border-accent/40 text-accent-hover"
      : run.status === "paused"
        ? "border-sky-400/40 text-sky-300"
        : run.status === "stalled"
          ? "border-amber-400/40 text-amber-300"
          : run.status === "stopped"
            ? "border-red-400/40 text-red-300"
            : "border-emerald-400/30 text-emerald-300";
  const barTone =
    run.status === "stalled"
      ? "bg-amber-400"
      : run.status === "stopped"
        ? "bg-red-400"
        : run.status === "paused"
          ? "bg-sky-400"
          : "bg-accent";

  return (
    <div className={`mb-3 rounded-lg border bg-surface-2 px-3 py-2 ${tone}`}>
      <button
        onClick={onSelect}
        className="w-full text-left"
        aria-label={`${run.session}: ${runHeadline(run)}`}
      >
        <div className="flex items-center gap-2">
          {run.status === "running" ? (
            <Loader2 size={13} className="animate-spin" />
          ) : run.status === "stalled" ? (
            <TriangleAlert size={13} />
          ) : run.status === "paused" || run.status === "waiting" ? (
            <Pause size={13} />
          ) : run.status === "stopped" ? (
            <CircleStop size={13} />
          ) : (
            <span className="h-2 w-2 rounded-full bg-emerald-400" />
          )}
          <span className="truncate font-mono text-xs">
            {run.destination ?? run.session} · {run.platform}
          </span>
          <span className="ml-auto shrink-0 font-mono text-xs">{percent}%</span>
        </div>

        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-1">
          <div className={`h-full rounded-full ${barTone}`} style={{ width: `${percent}%` }} />
        </div>

        <div className="mt-1.5 font-mono text-[0.6rem] text-gray-400">{runHeadline(run)}</div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[0.6rem] text-gray-500">
          <span>
            {fmtDay(run.firstDate)}–{fmtDay(run.lastDate)}
          </span>
          <span>
            {finished ? "took" : "running"} {fmtDuration(run.elapsedMs)}
          </span>
          {run.currentDate && !finished && <span>on {fmtDay(run.currentDate)}</span>}
          {run.etaMs !== null && <span>~{fmtDuration(run.etaMs)} left</span>}
          {run.status !== "running" && run.status !== "complete" && (
            <span className={run.status === "stalled" ? "text-amber-300" : undefined}>
              {STATUS_LABEL[run.status]}
            </span>
          )}
          {run.status === "waiting" && run.windowOpensAt && (
            <span>opens {fmtWhen(run.windowOpensAt)}</span>
          )}
          {run.schedule.mode === "window" && <span>window {scheduleSummary(run.schedule)}</span>}
        </div>
      </button>

      {!finished && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hudborder/60 pt-2">
          {run.status === "paused" ? (
            <button
              onClick={() => onCommand("run")}
              disabled={busy || !run.controllable}
              className="flex items-center gap-1 rounded border border-hudborder px-2 py-0.5 font-mono text-[0.6rem] text-emerald-300 hover:bg-surface-3 disabled:opacity-40"
            >
              <Play size={11} /> Resume
            </button>
          ) : (
            <button
              onClick={() => onCommand("pause")}
              disabled={busy || !run.controllable}
              className="flex items-center gap-1 rounded border border-hudborder px-2 py-0.5 font-mono text-[0.6rem] text-sky-300 hover:bg-surface-3 disabled:opacity-40"
            >
              <Pause size={11} /> Pause
            </button>
          )}
          <button
            onClick={() => onCommand("stop")}
            disabled={busy || !run.controllable}
            className="flex items-center gap-1 rounded border border-hudborder px-2 py-0.5 font-mono text-[0.6rem] text-red-300 hover:bg-surface-3 disabled:opacity-40"
          >
            <CircleStop size={11} /> Stop
          </button>
          <div className="ml-auto">
            <ScheduleControl schedule={run.schedule} disabled={busy || !run.controllable} onChange={onSchedule} />
          </div>
          {!run.controllable && (
            <p className="w-full font-mono text-[0.55rem] text-amber-300">
              The extraction process is gone, so it can no longer be controlled from here.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  agentLabel,
  busy,
  onRunNow,
  onCancel,
  onDelete,
}: {
  task: ExtractionTask;
  agentLabel: string;
  busy: boolean;
  onRunNow: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const nights = task.nights.min === task.nights.max ? `${task.nights.min}` : `${task.nights.min}-${task.nights.max}`;
  const live = task.status === "active";
  const working = Boolean(task.runningSince);
  // "scheduled" is the schedule's state; whether an agent is working right now
  // is a separate thing, and conflating the two read as "it is running".
  const scheduleLabel = task.status === "active" ? "scheduled" : task.status;
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${
        working
          ? "border-accent/40 bg-surface-2"
          : live
            ? "border-hudborder bg-surface-2"
            : "border-hudborder/50 bg-surface-2/50 opacity-70"
      }`}
    >
      <div className="flex items-center gap-2">
        <CalendarClock size={12} className={live ? "text-accent" : "text-gray-500"} />
        <span className="truncate font-mono text-[0.68rem] text-gray-200">{task.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[0.55rem] text-gray-500">{scheduleLabel}</span>
      </div>

      {working && (
        <div className="mt-1 flex items-center gap-1.5 font-mono text-[0.58rem] text-accent-hover">
          <Loader2 size={10} className="animate-spin" />
          <span>agent working since {fmtWhen(task.runningSince!)}</span>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.58rem] text-gray-500">
        <span className="text-sky-300">{agentLabel}</span>
        <span>{task.sites.join(" vs ")}</span>
        <span>
          travel {fmtDay(task.travelStart)}–{fmtDay(task.travelEnd)}
        </span>
        <span>{nights} nights</span>
        {task.departureDays?.length > 0 && (
          <span>dep {weekdaySummary(task.departureDays)}</span>
        )}
        <span>runs {weekdaySummary(task.weekdays)}</span>
        <span>
          until {fmtDay(task.scheduleEnd)}
        </span>
        {task.nextRunDay ? <span className="text-accent">next {fmtDay(task.nextRunDay)}</span> : null}
        {task.runCount > 0 && <span>{task.runCount} run{task.runCount === 1 ? "" : "s"}</span>}
      </div>
      {task.lastRunDetail && (
        <p className="mt-1 line-clamp-2 font-mono text-[0.55rem] text-gray-600">{task.lastRunDetail}</p>
      )}
      <div className="mt-1.5 flex gap-1.5">
        {live && (
          <>
            <button
              onClick={onRunNow}
              disabled={busy || working}
              className="rounded border border-hudborder px-1.5 py-0.5 font-mono text-[0.55rem] text-emerald-300 hover:bg-surface-3 disabled:opacity-40"
            >
              {working ? "Running…" : "Run now"}
            </button>
            <button
              onClick={onCancel}
              disabled={busy}
              className="rounded border border-hudborder px-1.5 py-0.5 font-mono text-[0.55rem] text-amber-300 hover:bg-surface-3 disabled:opacity-40"
            >
              Cancel schedule
            </button>
          </>
        )}
        <button
          onClick={onDelete}
          disabled={busy}
          className="ml-auto rounded border border-hudborder px-1.5 py-0.5 font-mono text-[0.55rem] text-gray-500 hover:bg-surface-3 hover:text-red-300 disabled:opacity-40"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function groupByDay(files: ExtractionFile[]): Array<{ day: string; files: ExtractionFile[] }> {
  const groups = new Map<string, ExtractionFile[]>();
  for (const file of files) {
    const day = file.day ?? file.modifiedAt.slice(0, 10);
    const bucket = groups.get(day);
    if (bucket) bucket.push(file);
    else groups.set(day, [file]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, dayFiles]) => ({ day, files: dayFiles }));
}

export default function ExtractionPage({ agents = [] }: { agents?: AgentRoomAgent[] }) {
  const [files, setFiles] = useState<ExtractionFile[]>([]);
  const [tasks, setTasks] = useState<ExtractionTask[]>([]);
  const [taskBusy, setTaskBusy] = useState(false);
  const [runs, setRuns] = useState<ExtractionRun[]>([]);
  const [defaultSchedule, setDefaultSchedule] = useState<ExtractionSchedule>(ANYTIME);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);
  const [source, setSource] = useState<ExtractionSource | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExtractionDetail | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.extractions();
      setFiles(res.extractions);
      setSource(res.source);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const res = await api.extractionTasks();
      setTasks(res.tasks);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  }, []);

  useEffect(() => {
    load();
    loadTasks();
  }, [load, loadTasks]);

  const createTask = useCallback(
    async (input: ExtractionTaskInput) => {
      setTaskBusy(true);
      try {
        await api.createExtractionTask(input);
        await loadTasks();
        setError(null);
      } finally {
        setTaskBusy(false);
      }
    },
    [loadTasks],
  );

  // The form surfaces its own errors, so these only need to refresh the list.
  const taskAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setTaskBusy(true);
      try {
        await action();
        await loadTasks();
        setError(null);
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      } finally {
        setTaskBusy(false);
      }
    },
    [loadTasks],
  );

  const agentLabel = useCallback(
    (agentId: string) => {
      const agent = agents.find((entry) => entry.id === agentId);
      return agent?.identity?.name?.trim() || agent?.name?.trim() || agentId;
    },
    [agents],
  );

  // Poll the run indicator, and refresh the file list whenever a run's date
  // count moves — that is exactly when a new results-<date>.csv has landed.
  useEffect(() => {
    let cancelled = false;
    let extractedSeen = -1;

    const tick = async () => {
      try {
        const res = await api.extractionRuns();
        if (cancelled) return;
        setRuns(res.runs);
        setDefaultSchedule(res.defaultSchedule);
        const done = res.runs.reduce((sum, run) => sum + run.extractedDates, 0);
        if (extractedSeen >= 0 && done !== extractedSeen) load();
        extractedSeen = done;
        // Tasks poll alongside runs so "agent working" and the reply that ends
        // it appear without the user reloading.
        loadTasks();
      } catch {
        // The indicator is ambient; a failed poll should not disturb the page.
      }
    };

    tick();
    const timer = setInterval(tick, RUN_POLL_MS);
    // Independent slower sweep, so CSVs written by anything at all show up.
    const fileTimer = setInterval(() => {
      if (!cancelled) load();
    }, FILE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(fileTimer);
    };
  }, [load, loadTasks]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    api
      .extraction(selectedId)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error)?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Optimistic: swap in the run the server echoes back so the buttons settle
  // immediately instead of waiting out the poll interval.
  const sendControl = useCallback(
    async (id: string, body: { command?: "run" | "pause" | "stop"; schedule?: ExtractionSchedule }) => {
      setBusyRunId(id);
      try {
        const res = await api.controlExtractionRun(id, body);
        setRuns((current) => current.map((run) => (run.id === id ? res.run : run)));
        setError(null);
      } catch (err) {
        setError(String((err as Error)?.message ?? err));
      } finally {
        setBusyRunId(null);
      }
    },
    [],
  );

  const saveDefaultSchedule = useCallback(async (schedule: ExtractionSchedule) => {
    setDefaultSchedule(schedule);
    try {
      const res = await api.setExtractionSchedule(schedule);
      setDefaultSchedule(res.defaultSchedule);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => file.relPath.toLowerCase().includes(needle));
  }, [files, search]);

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  // Live runs always show; finished ones only the latest, so the indicator
  // stays a status line rather than becoming a second history list.
  const shownRuns = useMemo(() => {
    const active = runs.filter((run) => run.status !== "complete" && run.status !== "stopped");
    const latestFinished = runs.find((run) => run.status === "complete" || run.status === "stopped");
    return active.length > 0 || !latestFinished ? active : [latestFinished];
  }, [runs]);

  // Only a live run can take pause/stop; a stalled one cannot, so the default
  // window stays reachable in that case.
  const hasActiveRun = useMemo(
    () => runs.some((run) => run.controllable && run.status !== "complete" && run.status !== "stopped"),
    [runs],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <HoloPanel
        title="Extractions"
        right={
          <button
            onClick={load}
            className="flex items-center gap-1 font-mono text-xs text-gray-400 hover:text-accent"
            aria-label="Refresh extraction list"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
            {filtered.length}
          </button>
        }
      >
        <ExtractionTaskForm agents={agents} busy={taskBusy} onCreate={createTask} />

        {tasks.length > 0 && (
          <div className="mb-3 space-y-1.5">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                agentLabel={agentLabel(task.agentId)}
                busy={taskBusy}
                onRunNow={() => taskAction(() => api.runExtractionTaskNow(task.id))}
                onCancel={() => taskAction(() => api.setExtractionTaskStatus(task.id, "cancelled"))}
                onDelete={() => taskAction(() => api.deleteExtractionTask(task.id))}
              />
            ))}
          </div>
        )}

        {shownRuns.map((run) => (
          <ExtractionRunIndicator
            key={run.id}
            run={run}
            busy={busyRunId === run.id}
            onSelect={() => setSearch(run.session)}
            onCommand={(command) => sendControl(run.id, { command })}
            onSchedule={(schedule) => sendControl(run.id, { schedule })}
          />
        ))}

        {/* With no run in flight the window still needs choosing, because the
            agent may start the next extraction while nobody is watching. */}
        {!hasActiveRun && (
          <div className="mb-3 rounded-lg border border-hudborder bg-surface-2 px-3 py-2">
            <div className="hud-label mb-1.5 text-[0.55rem]">New runs may work</div>
            <ScheduleControl schedule={defaultSchedule} onChange={saveDefaultSchedule} />
          </div>
        )}

        <label className="mb-3 flex items-center gap-2 rounded-lg border border-hudborder bg-surface-2 px-2 py-1.5">
          <Search size={14} className="text-gray-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="destination, platform, date…"
            className="w-full bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600"
          />
        </label>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {groups.length === 0 && !loading && (
            <p className="font-mono text-xs text-gray-500">
              No extraction CSVs yet{source ? ` under ${source.root}` : ""}.
            </p>
          )}
          {groups.map((group) => (
            <div key={group.day}>
              <div className="hud-label mb-1 text-[0.55rem]">{group.day}</div>
              <div className="space-y-1">
                {group.files.map((file) => (
                  <button
                    key={file.id}
                    onClick={() => setSelectedId(file.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors ${
                      selectedId === file.id
                        ? "bg-accent/10 text-accent-hover shadow-glow-sm"
                        : "text-gray-300 hover:bg-surface-3"
                    }`}
                  >
                    <span className="truncate font-mono text-xs">{file.name}</span>
                    <span className="flex items-center gap-2 font-mono text-[0.6rem] text-gray-500">
                      <span className={PLATFORM_TONE[file.platform] ?? "text-gray-400"}>{file.platform}</span>
                      {file.combined && <span className="text-accent">combined</span>}
                      <span>{fmtSize(file.sizeBytes)}</span>
                      <span>{fmtWhen(file.modifiedAt)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </HoloPanel>

      <HoloPanel
        title={detail ? detail.extraction.name : "Preview"}
        right={
          detail ? (
            <a
              href={api.extractionDownloadUrl(detail.extraction.id)}
              download={detail.extraction.name}
              className="flex items-center gap-1 font-mono text-xs text-gray-400 hover:text-accent"
            >
              <Download size={14} />
              CSV
            </a>
          ) : null
        }
      >
        {error && <p className="mb-3 font-mono text-xs text-red-300">{error}</p>}
        {!detail && !detailLoading && (
          <div className="flex flex-col items-center gap-2 py-16 text-gray-600">
            <FileSpreadsheet size={28} />
            <p className="font-mono text-xs">Select an extraction to compare its rows.</p>
          </div>
        )}
        {detailLoading && <p className="font-mono text-xs text-gray-500">Reading CSV…</p>}
        {detail && !detailLoading && (
          <>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[0.65rem] text-gray-500">
              <span>{detail.totalRows} rows</span>
              <span className={PLATFORM_TONE[detail.extraction.platform] ?? "text-gray-400"}>
                {detail.extraction.platform}
              </span>
              {detail.extraction.session && <span>{detail.extraction.session}</span>}
              <span>{fmtWhen(detail.extraction.modifiedAt)}</span>
              {detail.truncated && (
                <span className="text-amber-300">showing first {detail.rows.length} rows</span>
              )}
            </div>
            <div className="max-h-[70vh] overflow-auto rounded-lg border border-hudborder">
              <table className="min-w-full border-collapse text-left font-mono text-[0.65rem]">
                <thead className="sticky top-0 bg-surface-2">
                  <tr>
                    {detail.columns.map((column, index) => (
                      <th key={`${column}-${index}`} className="whitespace-nowrap px-2 py-1.5 text-gray-400">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-hudborder/50 text-gray-300">
                      {detail.columns.map((_column, cellIndex) => (
                        <td key={cellIndex} className="whitespace-nowrap px-2 py-1">
                          {row[cellIndex] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </HoloPanel>
    </div>
  );
}
