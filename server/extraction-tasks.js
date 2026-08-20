// Extraction task definitions: what to extract, who extracts it, and on which days.
//
// A task is a standing instruction, not a run. It fires on the weekdays the user
// picked, inside the schedule period, and each firing asks the chosen agent to
// perform one extraction over the whole travel-date range. The runs it produces
// report through extractions.js like any other run.
//
// Lives in the same jarvis.sqlite as every other store; no new database, no
// JSON sidecars.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const TASK_STATUSES = ["active", "completed", "cancelled"];
// Sunday-first, matching Date#getDay so the index is the lookup.
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// Only sites with a proven extraction protocol are selectable; the rest are
// offered in the UI as "available soon" and rejected here.
export const SUPPORTED_SITES = ["ProviderA", "ProviderD", "ProviderC", "ProviderB"];
// ProviderB cannot be handed to an agent like the others: it needs the
// headed OpenClaw browser, which only the BFF can drive. The scheduler runs it
// in-process instead of dispatching it.
export const BFF_EXTRACTED_SITES = ["ProviderB"];
const MAX_TRAVEL_DATES = 120;
const MAX_NIGHTS = 28;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ExtractionTaskError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExtractionTaskError";
    this.statusCode = 400;
  }
}

function reject(message) {
  throw new ExtractionTaskError(message);
}

function requireDate(value, label) {
  if (!ISO_DATE.test(String(value ?? "")) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    reject(`${label} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

function singleLine(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/.test(text)) {
    reject(`${label} must be a single line of at most ${maxLength} characters`);
  }
  return text;
}

/** "7" or "7-10" — a single stay length or an inclusive range. */
export function parseNights(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2})\s*(?:-\s*(\d{1,2}))?$/.exec(text);
  if (!match) reject("Nights must be a number like 7, or a range like 7-10");
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (min < 1 || max > MAX_NIGHTS) reject(`Nights must be between 1 and ${MAX_NIGHTS}`);
  if (max < min) reject("Nights range must run low to high, e.g. 7-10");
  return { min, max };
}

export function formatNights({ min, max }) {
  return min === max ? `${min}` : `${min}-${max}`;
}

/**
 * Every departure date in the travel range, inclusive, optionally restricted to
 * certain weekdays. Charter flights run fixed days, so searching dates nothing
 * departs on is pure waste; an empty `departureDays` means every day.
 *
 * Note this is a different question from `weekdays`, which decides when the
 * extraction *runs*. A job can wake on Mondays and search Saturday departures.
 */
export function travelDates({ travelStart, travelEnd, departureDays = [] }) {
  const allowed = Array.isArray(departureDays) ? departureDays : [];
  const dates = [];
  const cursor = new Date(`${travelStart}T00:00:00Z`);
  const end = new Date(`${travelEnd}T00:00:00Z`);
  while (cursor <= end) {
    if (allowed.length === 0 || allowed.includes(WEEKDAYS[cursor.getUTCDay()])) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Is this task due right now? Weekday must be selected, today must fall inside
 * the schedule period, and it must not already have fired today — the guard
 * that keeps a restart or a fast tick from launching the same day twice.
 */
export function isDue(task, now = new Date()) {
  if (task.status !== "active") return false;
  const today = localDayKey(now);
  if (today < task.scheduleStart || today > task.scheduleEnd) return false;
  if (!task.weekdays.includes(WEEKDAYS[now.getDay()])) return false;
  return task.lastRunDay !== today;
}

/** The next local day this task will fire, or null once the period is spent. */
export function nextRunDay(task, now = new Date()) {
  if (task.status !== "active" || task.weekdays.length === 0) return null;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // A day already used today is behind us; start looking tomorrow.
  if (task.lastRunDay === localDayKey(now)) cursor.setDate(cursor.getDate() + 1);
  for (let i = 0; i < 366; i++) {
    const key = localDayKey(cursor);
    if (key > task.scheduleEnd) return null;
    if (key >= task.scheduleStart && task.weekdays.includes(WEEKDAYS[cursor.getDay()])) return key;
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

export function normalizeTaskInput(input = {}, { maxTravelDates = MAX_TRAVEL_DATES } = {}) {
  const agentId = String(input.agentId ?? "").trim();
  if (!agentId) reject("Choose an agent to run the extraction");

  const sites = Array.isArray(input.sites) ? [...new Set(input.sites.map((s) => String(s).trim()))] : [];
  if (sites.length === 0) reject("Choose at least one website");
  const unsupported = sites.filter((site) => !SUPPORTED_SITES.includes(site));
  if (unsupported.length > 0) reject(`Not available yet: ${unsupported.join(", ")}`);

  const travelStart = requireDate(input.travelStart, "Travel start");
  const travelEnd = requireDate(input.travelEnd, "Travel end");
  if (travelEnd < travelStart) reject("Travel end must be on or after travel start");

  // Which weekdays actually have departures worth searching. Empty means all.
  const departureDays = Array.isArray(input.departureDays)
    ? WEEKDAYS.filter((day) => input.departureDays.includes(day))
    : [];

  // Counted after the filter, since that is what will really be searched.
  const dateCount = travelDates({ travelStart, travelEnd, departureDays }).length;
  if (dateCount === 0) {
    reject("No departure dates match the selected departure days in that travel range");
  }
  if (dateCount > maxTravelDates) {
    reject(`Travel range covers ${dateCount} departures; keep it to ${maxTravelDates} or fewer`);
  }

  const nights = parseNights(input.nights);

  const weekdays = Array.isArray(input.weekdays)
    ? WEEKDAYS.filter((day) => input.weekdays.includes(day))
    : [];
  if (weekdays.length === 0) reject("Choose at least one day of the week to run on");

  const scheduleStart = requireDate(input.scheduleStart, "Schedule start");
  const scheduleEnd = requireDate(input.scheduleEnd, "Schedule end");
  if (scheduleEnd < scheduleStart) reject("Schedule end must be on or after schedule start");

  const destination = singleLine(input.destination, "Destination", 80);
  const requestedName = String(input.name ?? "").trim();
  const name = requestedName ? singleLine(requestedName, "Name", 120) : `${destination} · ${sites.join(" vs ")}`;

  return {
    name,
    agentId,
    destination,
    sites,
    travelStart,
    travelEnd,
    departureDays,
    nights,
    weekdays,
    scheduleStart,
    scheduleEnd,
    customExtractorId: String(input.customExtractorId ?? "").trim() || null,
  };
}

function rowToTask(row) {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    destination: row.destination,
    sites: JSON.parse(row.sites_json),
    travelStart: row.travel_start,
    travelEnd: row.travel_end,
    // Absent on tasks created before the filter existed; empty means every day.
    departureDays: row.departure_days_json ? JSON.parse(row.departure_days_json) : [],
    nights: JSON.parse(row.nights_json),
    weekdays: JSON.parse(row.weekdays_json),
    scheduleStart: row.schedule_start,
    scheduleEnd: row.schedule_end,
    status: row.status,
    lastRunDay: row.last_run_day,
    lastRunAt: row.last_run_at,
    lastRunDetail: row.last_run_detail,
    runningSince: row.running_since ?? null,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customExtractorId: row.custom_extractor_id ?? null,
  };
}

export class ExtractionTaskStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS extraction_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        destination TEXT NOT NULL,
        sites_json TEXT NOT NULL,
        travel_start TEXT NOT NULL,
        travel_end TEXT NOT NULL,
        nights_json TEXT NOT NULL,
        weekdays_json TEXT NOT NULL,
        schedule_start TEXT NOT NULL,
        schedule_end TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
        last_run_day TEXT,
        last_run_at TEXT,
        last_run_detail TEXT,
        -- Set when a turn is handed to the agent, cleared when it settles.
        -- Persisted rather than kept in memory so a dispatch cannot vanish
        -- without trace when this process restarts mid-run.
        running_since TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extraction_tasks_status ON extraction_tasks (status, schedule_end);
    `);
    this.#addColumnIfMissing("running_since", "TEXT");
    this.#addColumnIfMissing("departure_days_json", "TEXT");
    this.#addColumnIfMissing("custom_extractor_id", "TEXT");
  }

  // CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so a
  // column added after the first release needs its own step.
  #addColumnIfMissing(column, type) {
    const columns = this.database.prepare("PRAGMA table_info(extraction_tasks)").all();
    if (columns.some((entry) => entry.name === column)) return;
    this.database.exec(`ALTER TABLE extraction_tasks ADD COLUMN ${column} ${type}`);
  }

  /**
   * A task marked running by a process that is gone is not running. Called at
   * startup, where owning the port proves any earlier dispatch died with it.
   */
  recoverInterruptedRuns() {
    const stuck = this.database
      .prepare("SELECT id FROM extraction_tasks WHERE running_since IS NOT NULL")
      .all();
    for (const row of stuck) {
      this.finishRun(row.id, "interrupted: Jarvis restarted while the agent was working");
    }
    return stuck.length;
  }

  list() {
    return this.database
      .prepare("SELECT * FROM extraction_tasks ORDER BY created_at DESC")
      .all()
      .map(rowToTask);
  }

  get(id) {
    const row = this.database.prepare("SELECT * FROM extraction_tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : null;
  }

  create(input, options) {
    const spec = normalizeTaskInput(input, options);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO extraction_tasks
           (id, name, agent_id, destination, sites_json, travel_start, travel_end, departure_days_json,
            nights_json, weekdays_json, schedule_start, schedule_end, custom_extractor_id,
            status, run_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
      )
      .run(
        id,
        spec.name,
        spec.agentId,
        spec.destination,
        JSON.stringify(spec.sites),
        spec.travelStart,
        spec.travelEnd,
        JSON.stringify(spec.departureDays),
        JSON.stringify(spec.nights),
        JSON.stringify(spec.weekdays),
        spec.scheduleStart,
        spec.scheduleEnd,
        spec.customExtractorId,
        now,
        now,
      );
    return this.get(id);
  }

  setStatus(id, status) {
    if (!TASK_STATUSES.includes(status)) reject(`Unknown status: ${status}`);
    this.database
      .prepare("UPDATE extraction_tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.get(id);
  }

  /**
   * Claim today for this task before dispatching. Writing last_run_day first is
   * what stops a slow dispatch, a fast tick, or a restart from firing twice.
   */
  claimRun(id, day) {
    const now = new Date().toISOString();
    const changes = this.database
      .prepare(
        `UPDATE extraction_tasks
            SET last_run_day = ?, last_run_at = ?, run_count = run_count + 1, updated_at = ?
          WHERE id = ? AND status = 'active' AND (last_run_day IS NULL OR last_run_day != ?)`,
      )
      .run(day, now, now, id, day);
    return changes.changes > 0 ? this.get(id) : null;
  }

  /** Mark the agent as working. `lastRunAt` moves here so a manual run is visible too. */
  startRun(id) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        "UPDATE extraction_tasks SET running_since = ?, last_run_at = ?, last_run_detail = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, now, now, id);
    return this.get(id);
  }

  finishRun(id, detail) {
    this.database
      .prepare(
        "UPDATE extraction_tasks SET running_since = NULL, last_run_detail = ?, updated_at = ? WHERE id = ?",
      )
      .run(String(detail ?? "").slice(0, 500), new Date().toISOString(), id);
    return this.get(id);
  }

  /** Active tasks whose period has run out are done; nothing more will fire. */
  expire(now = new Date()) {
    const today = localDayKey(now);
    const expired = this.list().filter((task) => task.status === "active" && task.scheduleEnd < today);
    for (const task of expired) this.setStatus(task.id, "completed");
    return expired.length;
  }

  due(now = new Date()) {
    return this.list().filter((task) => isDue(task, now));
  }

  delete(id) {
    this.database.prepare("DELETE FROM extraction_tasks WHERE id = ?").run(id);
  }
}
