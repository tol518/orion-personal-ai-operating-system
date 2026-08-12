// Extraction catalogue: read-only index of the price-comparison CSVs the agent
// writes into the OpenClaw workspace (neutral ProviderA-ProviderE runs).
// Session folders live under Extraction_Live_Workspace/<day>/<session>/, and a
// few one-off comparison CSVs sit at the workspace root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SESSION_ROOT = "Extraction_Live_Workspace";
const MAX_PREVIEW_ROWS = 500;
const MAX_CSV_BYTES = 32 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 4000;

// Progress contract: an extraction script drops `extraction-run.json` in its
// session folder before the first request and stamps `finishedAt` at the end.
// Everything else is derived — a date counts as extracted once its
// `results-<date>.csv` exists, which is what the script writes per date.
const RUN_FILE = "extraction-run.json";
// Jarvis owns the control file; the script polls it. Writing a command here is
// how pause/resume/stop and the run window reach a running extraction.
const CONTROL_FILE = "extraction-control.json";
// Workspace-level default, adopted by runs the agent starts later — the window
// has to be choosable before the run it applies to exists.
const DEFAULT_SCHEDULE_FILE = "extraction-schedule.json";
const RUN_COMMANDS = ["run", "pause", "stop"];
const MAX_RUNS = 20;
// Liveness is judged by work landing on disk, because the pid cannot be
// trusted: an agent running in a sandbox records a pid from its own namespace,
// which is invisible here (and could even collide with an unrelated host
// process). A working run touches its files every few seconds.
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;

// Filenames carry the platform; the CSV "Platform" column agrees but reading
// every file just to label the list would cost a full scan of the workspace.
const PLATFORM_PATTERNS = [
  { platform: "ProviderA", test: /(^|[^a-z])provider[-_ ]?a([^a-z]|$)/i },
  { platform: "ProviderB", test: /(^|[^a-z])provider[-_ ]?b([^a-z]|$)/i },
  { platform: "ProviderC", test: /(^|[^a-z])provider[-_ ]?c([^a-z]|$)/i },
  { platform: "ProviderD", test: /(^|[^a-z])provider[-_ ]?d([^a-z]|$)/i },
  { platform: "ProviderE", test: /(^|[^a-z])provider[-_ ]?e([^a-z]|$)/i },
];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  // Write-then-rename so the polling script never reads a half-written file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function normalizeCommand(value) {
  return RUN_COMMANDS.includes(value) ? value : "run";
}

function parseHhMm(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : hours * 60 + minutes;
}

// Mirrors the workspace runtime's rule: anything that is not a usable window
// degrades to "anytime". A malformed or zero-length window would otherwise
// pause a run forever with no way for the script to notice.
function normalizeSchedule(value) {
  if (value?.mode !== "window") return { mode: "anytime", start: null, end: null };
  const start = parseHhMm(value.start);
  const end = parseHhMm(value.end);
  if (start === null || end === null || start === end) {
    return { mode: "anytime", start: null, end: null };
  }
  return { mode: "window", start: value.start, end: value.end };
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Windows may wrap midnight (22:00-06:00 does, 00:00-08:00 does not). */
export function isWindowOpen(schedule, now = new Date()) {
  if (schedule?.mode !== "window") return true;
  const start = parseHhMm(schedule.start);
  const end = parseHhMm(schedule.end);
  if (start === null || end === null) return true;
  const current = minutesOfDay(now);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Milliseconds until the window reopens; 0 while it is open. */
export function msUntilWindowOpens(schedule, now = new Date()) {
  if (isWindowOpen(schedule, now)) return 0;
  const start = parseHhMm(schedule.start);
  const opensAt = new Date(now);
  opensAt.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (opensAt <= now) opensAt.setDate(opensAt.getDate() + 1);
  return opensAt.getTime() - now.getTime();
}

function defaultRoot() {
  return process.env.JARVIS_EXTRACTION_DIR || path.join(os.homedir(), ".openclaw", "workspace");
}

function matchPlatforms(value) {
  return PLATFORM_PATTERNS.filter((entry) => entry.test.test(value)).map((entry) => entry.platform);
}

// The filename wins over the folder: a `providerA.csv` inside a
// `providerA-providerC-batches/` session is a single-platform file.
function platformOf(relPath) {
  const fileName = path.basename(relPath, ".csv");
  const matches = matchPlatforms(fileName).length > 0 ? matchPlatforms(fileName) : matchPlatforms(relPath);
  if (matches.length === 0) return "Unknown";
  return matches.length > 1 ? "Multi" : matches[0];
}

// Ids are the workspace-relative path, url-safe so they survive a path segment.
function encodeId(relPath) {
  return Buffer.from(relPath, "utf8").toString("base64url");
}

function decodeId(id) {
  return Buffer.from(String(id), "base64url").toString("utf8");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export class ExtractionCatalog {
  constructor({ root = defaultRoot() } = {}) {
    this.root = path.resolve(root);
  }

  status() {
    return { root: this.root, available: fs.existsSync(this.root) };
  }

  // Absolute path for an id, refusing anything that escapes the workspace or is
  // not a CSV — ids arrive from the browser.
  resolve(id) {
    let relPath;
    try {
      relPath = decodeId(id);
    } catch {
      return null;
    }
    if (!relPath || !relPath.toLowerCase().endsWith(".csv")) return null;
    const absPath = path.resolve(this.root, relPath);
    const prefix = `${this.root}${path.sep}`;
    if (!absPath.startsWith(prefix)) return null;
    const realPath = this.#containedRealPath(absPath);
    if (!realPath) return null;
    return { relPath, absPath: realPath };
  }

  list() {
    if (!fs.existsSync(this.root)) return [];
    const files = [
      ...this.#csvFilesIn(this.root, 0),
      ...this.#csvFilesIn(path.join(this.root, SESSION_ROOT), 3),
    ];
    return files
      .map((absPath) => this.#describe(absPath))
      .filter(Boolean)
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  // Progress for every session folder that published an extraction-run.json,
  // newest first. `now` is injectable so elapsed/eta stay testable.
  runs({ now = Date.now() } = {}) {
    const sessionsRoot = path.join(this.root, SESSION_ROOT);
    if (!fs.existsSync(sessionsRoot)) return [];
    const found = [];
    for (const day of this.#subdirectories(sessionsRoot)) {
      for (const session of this.#subdirectories(path.join(sessionsRoot, day))) {
        const run = this.#describeRun(path.join(sessionsRoot, day, session), now);
        if (run) found.push(run);
      }
    }
    return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_RUNS);
  }

  // Session folder for a run id, refusing anything that is not a real session
  // publishing a run file — ids arrive from the browser.
  resolveRun(id) {
    let relPath;
    try {
      relPath = decodeId(id);
    } catch {
      return null;
    }
    if (!relPath) return null;
    const absPath = path.resolve(this.root, relPath);
    if (!absPath.startsWith(`${this.root}${path.sep}`)) return null;
    const realPath = this.#containedRealPath(absPath);
    if (!realPath) return null;
    try {
      const manifest = fs.lstatSync(path.join(realPath, RUN_FILE));
      if (!manifest.isFile() || manifest.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return realPath;
  }

  /**
   * Point a run at a new command and/or window. The script picks it up at its
   * next checkpoint. Workspace manifests are agent-writable, so their PIDs are
   * never used for process signaling.
   */
  control(id, { command, schedule } = {}) {
    const sessionDir = this.resolveRun(id);
    if (!sessionDir) return null;
    const controlFile = path.join(sessionDir, CONTROL_FILE);
    const current = readJson(controlFile) ?? {};
    const next = {
      command: command === undefined ? normalizeCommand(current.command) : normalizeCommand(command),
      schedule: normalizeSchedule(schedule === undefined ? current.schedule : schedule),
      updatedAt: new Date().toISOString(),
    };
    writeJson(controlFile, next);

    if (next.command === "stop") {
      const runFile = path.join(sessionDir, RUN_FILE);
      const plan = readJson(runFile);
      // Stop is an operator decision, not a request the panel waits to observe.
      // Marking it terminal immediately fixes orphaned agent turns with no
      // remaining process, while a live script still sees the control command.
      if (plan && typeof plan === "object") {
        writeJson(runFile, {
          ...plan,
          state: "stopped",
          finishedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        });
      }
    }
    return this.runs().find((run) => run.id === id) ?? null;
  }

  /** The window new runs adopt when the agent starts them unattended. */
  defaultSchedule() {
    return normalizeSchedule(readJson(path.join(this.root, DEFAULT_SCHEDULE_FILE))?.schedule);
  }

  setDefaultSchedule(schedule) {
    const normalized = normalizeSchedule(schedule);
    writeJson(path.join(this.root, DEFAULT_SCHEDULE_FILE), {
      schedule: normalized,
      updatedAt: new Date().toISOString(),
    });
    return normalized;
  }

  read(id, { limit = MAX_PREVIEW_ROWS } = {}) {
    const target = this.resolve(id);
    if (!target || !fs.existsSync(target.absPath)) return null;
    const stat = fs.statSync(target.absPath);
    if (!stat.isFile() || stat.size > MAX_CSV_BYTES) return null;
    const rows = parseCsv(fs.readFileSync(target.absPath, "utf8"));
    const columns = rows[0] ?? [];
    const dataRows = rows.slice(1);
    return {
      extraction: this.#describe(target.absPath),
      columns,
      rows: dataRows.slice(0, limit),
      totalRows: dataRows.length,
      truncated: dataRows.length > limit,
    };
  }

  #subdirectories(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  #containedRealPath(candidate) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) return null;
      const root = fs.realpathSync.native(this.root);
      const resolved = fs.realpathSync.native(candidate);
      return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
    } catch {
      return null;
    }
  }

  #describeRun(sessionDir, now) {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(sessionDir, RUN_FILE), "utf8"));
    } catch {
      return null;
    }
    const dates = Array.isArray(plan.dates) ? plan.dates.filter((d) => typeof d === "string") : [];
    if (dates.length === 0) return null;

    const extracted = dates.filter((date) => fs.existsSync(path.join(sessionDir, `results-${date}.csv`)));
    const remaining = dates.filter((date) => !extracted.includes(date));
    const startedAt = typeof plan.startedAt === "string" ? plan.startedAt : new Date(now).toISOString();
    const finishedAt = typeof plan.finishedAt === "string" ? plan.finishedAt : null;
    const startedMs = Date.parse(startedAt);
    const endedMs = finishedAt ? Date.parse(finishedAt) : now;
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, endedMs - startedMs) : 0;

    const control = readJson(path.join(sessionDir, CONTROL_FILE)) ?? {};
    const alive = this.#isAlive({ plan, sessionDir, now });
    const status = this.#runStatus({
      state: plan.state,
      finishedAt,
      alive,
      hasRemaining: remaining.length > 0,
    });
    // Per-date cost so far is the only honest basis for the estimate; before
    // the first date lands there is nothing to extrapolate from. Anything not
    // actively working — paused, waiting for its window, stalled, done — has
    // no meaningful finish time to promise.
    const etaMs =
      status === "running" && extracted.length > 0
        ? Math.round((elapsedMs / extracted.length) * remaining.length)
        : null;

    return {
      id: encodeId(path.relative(this.root, sessionDir)),
      session: path.basename(sessionDir),
      platform: typeof plan.platform === "string" ? plan.platform : platformOf(sessionDir),
      destination: typeof plan.destination === "string" ? plan.destination : null,
      nights: Number.isFinite(plan.nights) ? plan.nights : null,
      status,
      // What the operator asked for, which can differ from `status` until the
      // script reaches its next checkpoint and acts on it.
      command: normalizeCommand(control.command),
      schedule: normalizeSchedule(control.schedule ?? plan.schedule),
      windowOpensAt: typeof plan.windowOpensAt === "string" ? plan.windowOpensAt : null,
      // Commands travel through the control file in the shared workspace, not
      // through the pid, so anything still working can be paused or stopped —
      // including a run inside an agent sandbox. A run that has just finished
      // still looks "alive" by file recency, but there is nothing left to
      // command, so terminal states are excluded.
      controllable: alive && status !== "complete" && status !== "stopped",
      totalDates: dates.length,
      extractedDates: extracted.length,
      remainingDates: remaining.length,
      // The date being worked on now is the first one without a CSV.
      currentDate: remaining[0] ?? null,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      startedAt,
      finishedAt,
      elapsedMs,
      etaMs,
    };
  }

  #runStatus({ state, finishedAt, alive, hasRemaining }) {
    // Stopped is terminal and must not read as "complete": the operator ended
    // the run early and the dates that never ran are not coming.
    if (state === "stopped") return "stopped";
    if (finishedAt || !hasRemaining) return "complete";
    // No grace period is needed for a starting run: publishing the run file is
    // itself activity, so a run that has only just begun already reads alive.
    // Keeping status and `controllable` on the same signal is what stops the
    // panel from claiming a run is going while refusing to let it be stopped.
    if (!alive) return "stalled";
    // A live script reports its own state; paused and waiting are deliberate
    // holds, not failures.
    if (state === "paused" || state === "waiting") return state;
    return "running";
  }

  /**
   * Alive if the script says so recently, or if its pid is genuinely ours, or
   * if work is still landing on disk. The pid is only ever positive evidence:
   * an agent sandbox has its own PID namespace, so "pid not found here" says
   * nothing about a run that is plainly still writing files.
   */
  #isAlive({ plan, sessionDir, now }) {
    const heartbeat = Date.parse(plan.heartbeatAt ?? "");
    if (Number.isFinite(heartbeat) && now - heartbeat < ACTIVE_WINDOW_MS) return true;
    if (Number.isInteger(plan.pid) && this.#processAlive(plan.pid)) return true;
    // A paused or waiting run writes nothing, so only its own state file can
    // vouch for it; that is what heartbeatAt above is for.
    return now - this.#lastActivityAt(sessionDir) < ACTIVE_WINDOW_MS;
  }

  /**
   * Newest write anywhere in the session. Directory mtimes stand in for their
   * contents so a run with hundreds of cached pages costs a handful of stats.
   */
  #lastActivityAt(sessionDir) {
    const candidates = [sessionDir, path.join(sessionDir, RUN_FILE)];
    const scraped = path.join(sessionDir, ".scraped");
    candidates.push(scraped, ...this.#subdirectories(scraped).map((name) => path.join(scraped, name)));
    let newest = 0;
    for (const candidate of candidates) {
      try {
        newest = Math.max(newest, fs.statSync(candidate).mtimeMs);
      } catch {
        // Missing paths simply do not contribute.
      }
    }
    return newest;
  }

  #processAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the pid exists but belongs to another user.
      return err?.code === "EPERM";
    }
  }

  #csvFilesIn(dir, depth) {
    if (!fs.existsSync(dir)) return [];
    const found = [];
    const queue = [{ dir, depth }];
    while (queue.length > 0 && found.length < MAX_SCAN_ENTRIES) {
      const current = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const absPath = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth > 0) queue.push({ dir: absPath, depth: current.depth - 1 });
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
          found.push(absPath);
        }
      }
    }
    return found;
  }

  #describe(absPath) {
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return null;
    }
    const relPath = path.relative(this.root, absPath);
    const segments = relPath.split(path.sep);
    const inSessions = segments[0] === SESSION_ROOT;
    // Most session folders are dated; a few older ones are named by theme, so
    // only a real YYYY-MM-DD becomes the extraction day (the UI groups on it).
    const dayFolder = inSessions && /^\d{4}-\d{2}-\d{2}$/.test(segments[1] ?? "") ? segments[1] : null;
    return {
      id: encodeId(relPath),
      name: path.basename(absPath),
      relPath,
      day: dayFolder,
      session: inSessions ? segments.slice(dayFolder ? 2 : 1, -1).join("/") || null : null,
      platform: platformOf(relPath),
      combined: /combined/i.test(path.basename(absPath)),
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }
}

export const __testing = {
  parseCsv,
  platformOf,
  encodeId,
  decodeId,
  normalizeSchedule,
  RUN_FILE,
  CONTROL_FILE,
  DEFAULT_SCHEDULE_FILE,
};
