// Canonical storage for learning sessions, learned workflows, and their run history.
//
// Two stores, two jobs, and the split is deliberate. Obsidian holds the readable recipe, because
// that is what "Jarvis memory" means in this app and a person has to be able to correct it. This
// SQLite database holds the executable spec and the run log, because a replay needs exact enums
// and a history table, and neither belongs in prose. `learned_workflows.memory_id` is the link
// between them, so a note always names the spec it describes.
//
// Lives in the same jarvis.sqlite as every other store; no new database, no JSON sidecars.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const SESSION_STATUSES = ["recording", "captured", "extracted", "saved", "abandoned"];
export const RUN_STATUSES = ["running", "awaiting_confirmation", "completed", "failed", "cancelled"];

export class WorkflowStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS learning_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('recording', 'captured', 'extracted', 'saved', 'abandoned')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        include_audio INTEGER NOT NULL DEFAULT 0,
        digest_json TEXT,
        draft_json TEXT,
        workflow_id TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS learned_workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        memory_id TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS learned_workflows_name ON learned_workflows (name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')),
        variables_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        detail TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS workflow_runs_workflow ON workflow_runs (workflow_id, started_at DESC);
    `);
  }

  // ---- learning sessions ---------------------------------------------------

  /**
   * Mark the start of a window. Screenpipe is already recording; a session is Jarvis's bookmark
   * into that continuous stream, which is why nothing is captured until the window is closed.
   */
  startSession({ title, includeAudio = false, startedAt = new Date().toISOString() }) {
    const session = {
      id: randomUUID(),
      title: String(title ?? "").trim().slice(0, 120) || "Untitled workflow recording",
      status: "recording",
      startedAt,
      endedAt: null,
      includeAudio: Boolean(includeAudio),
      digest: null,
      draft: null,
      workflowId: null,
      error: null,
    };
    this.database
      .prepare(
        `INSERT INTO learning_sessions (id, title, status, started_at, ended_at, include_audio, digest_json, draft_json, workflow_id, error)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(session.id, session.title, session.status, session.startedAt, session.includeAudio ? 1 : 0);
    return session;
  }

  activeSession() {
    const row = this.database
      .prepare(`SELECT * FROM learning_sessions WHERE status = 'recording' ORDER BY started_at DESC LIMIT 1`)
      .get();
    return row ? toSession(row) : null;
  }

  getSession(id) {
    const row = this.database.prepare("SELECT * FROM learning_sessions WHERE id = ?").get(id);
    return row ? toSession(row) : null;
  }

  listSessions(limit = 25) {
    return this.database
      .prepare("SELECT * FROM learning_sessions ORDER BY started_at DESC LIMIT ?")
      .all(limit)
      .map(toSession);
  }

  /** Patch a session. Only the fields present are written, so a failed extract keeps its digest. */
  updateSession(id, patch) {
    const current = this.getSession(id);
    if (!current) throw Object.assign(new Error("learning session not found"), { statusCode: 404 });
    if (patch.status && !SESSION_STATUSES.includes(patch.status)) throw new Error("invalid session status");
    const next = { ...current, ...patch };
    this.database
      .prepare(
        `UPDATE learning_sessions
            SET title = ?, status = ?, ended_at = ?, include_audio = ?, digest_json = ?, draft_json = ?, workflow_id = ?, error = ?
          WHERE id = ?`,
      )
      .run(
        next.title,
        next.status,
        next.endedAt ?? null,
        next.includeAudio ? 1 : 0,
        next.digest ? JSON.stringify(next.digest) : null,
        next.draft ? JSON.stringify(next.draft) : null,
        next.workflowId ?? null,
        next.error ?? null,
        id,
      );
    return this.getSession(id);
  }

  // ---- learned workflows ---------------------------------------------------

  /**
   * Save or replace a workflow spec.
   *
   * Keyed by name as well as id: re-learning "Submit monthly invoice" should improve the one
   * workflow the user already has rather than leaving two rows the runner cannot choose between.
   */
  saveWorkflow(spec, { sessionId = null, memoryId = null } = {}) {
    const now = new Date().toISOString();
    const existing = this.getWorkflow(spec.id) ?? this.findWorkflowByName(spec.name);
    const id = existing?.id ?? spec.id;
    const stored = { ...spec, id };
    if (existing) {
      this.database
        .prepare(
          `UPDATE learned_workflows SET name = ?, spec_json = ?, memory_id = ?, session_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(stored.name, JSON.stringify(stored), memoryId ?? existing.memoryId, sessionId ?? existing.sessionId, now, id);
    } else {
      this.database
        .prepare(
          `INSERT INTO learned_workflows (id, name, spec_json, memory_id, session_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, stored.name, JSON.stringify(stored), memoryId, sessionId, now, now);
    }
    return this.getWorkflow(id);
  }

  getWorkflow(id) {
    if (!id) return null;
    const row = this.database.prepare("SELECT * FROM learned_workflows WHERE id = ?").get(id);
    return row ? toWorkflow(row) : null;
  }

  findWorkflowByName(name) {
    const row = this.database
      .prepare("SELECT * FROM learned_workflows WHERE name = ? COLLATE NOCASE")
      .get(String(name ?? ""));
    return row ? toWorkflow(row) : null;
  }

  listWorkflows() {
    return this.database
      .prepare("SELECT * FROM learned_workflows ORDER BY updated_at DESC")
      .all()
      .map(toWorkflow);
  }

  setWorkflowMemory(id, memoryId) {
    this.database
      .prepare("UPDATE learned_workflows SET memory_id = ?, updated_at = ? WHERE id = ?")
      .run(memoryId, new Date().toISOString(), id);
    return this.getWorkflow(id);
  }

  deleteWorkflow(id) {
    const existing = this.getWorkflow(id);
    if (!existing) throw Object.assign(new Error("workflow not found"), { statusCode: 404 });
    this.database.prepare("DELETE FROM workflow_runs WHERE workflow_id = ?").run(id);
    this.database.prepare("DELETE FROM learned_workflows WHERE id = ?").run(id);
    return existing;
  }

  // ---- runs ---------------------------------------------------------------

  startRun({ workflowId, variables }) {
    const run = {
      id: randomUUID(),
      workflowId,
      status: "running",
      variables: variables ?? {},
      results: [],
      detail: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, status, variables_json, results_json, detail, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(run.id, run.workflowId, run.status, JSON.stringify(run.variables), JSON.stringify(run.results), run.startedAt);
    return run;
  }

  getRun(id) {
    const row = this.database.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  updateRun(id, patch) {
    const current = this.getRun(id);
    if (!current) throw Object.assign(new Error("workflow run not found"), { statusCode: 404 });
    if (patch.status && !RUN_STATUSES.includes(patch.status)) throw new Error("invalid run status");
    const next = { ...current, ...patch };
    const finishedAt =
      next.finishedAt ??
      (next.status === "completed" || next.status === "failed" || next.status === "cancelled"
        ? new Date().toISOString()
        : null);
    this.database
      .prepare("UPDATE workflow_runs SET status = ?, results_json = ?, detail = ?, finished_at = ? WHERE id = ?")
      .run(next.status, JSON.stringify(next.results ?? []), next.detail ?? null, finishedAt, id);
    return this.getRun(id);
  }

  listRuns(workflowId, limit = 20) {
    return this.database
      .prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(workflowId, limit)
      .map(toRun);
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toSession(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    includeAudio: row.include_audio === 1,
    digest: parseJson(row.digest_json, null),
    draft: parseJson(row.draft_json, null),
    workflowId: row.workflow_id,
    error: row.error,
  };
}

function toWorkflow(row) {
  return {
    id: row.id,
    name: row.name,
    spec: parseJson(row.spec_json, null),
    memoryId: row.memory_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    variables: parseJson(row.variables_json, {}),
    results: parseJson(row.results_json, []),
    detail: row.detail,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
