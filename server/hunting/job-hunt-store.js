import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PROFILE_ID = "primary";
const JOB_STATUSES = new Set(["new", "shortlisted", "dismissed"]);
const DISCOVERY_RUN_STATUSES = new Set(["running", "complete", "failed"]);

// Application checkpoint states. Each transition is persisted with a machine-readable
// reason plus an attempt row, so a resumed run reads what happened instead of asking
// the model to reconstruct it.
export const APPLICATION_STATUSES = new Set([
  "queued",
  "preparing_cv",
  "opening_form",
  "uploading_cv",
  "filling_verified_fields",
  "needs_human_action",
  "ready_for_review",
  "submitted",
  "failed",
]);
const ACTIVE_APPLICATION_STATUSES = new Set([
  "queued",
  "preparing_cv",
  "opening_form",
  "uploading_cv",
  "filling_verified_fields",
]);
// Retired statuses from the single-phase runner. Runtime only reads the states above;
// these map forward once, at open time.
const LEGACY_APPLICATION_STATUSES = new Map([
  ["running", "failed"],
  ["needs_input", "needs_human_action"],
]);
export const UPLOAD_OUTCOMES = new Set([
  "pending",
  "uploaded",
  "not_required",
  "input_not_found",
  "artifact_unavailable",
  "tool_unavailable",
  "rejected",
  "verification_failed",
]);
// ready_for_review claims the form is complete, so it stays unreachable unless the CV
// upload was verified or the form provably asks for no CV.
const VERIFIED_UPLOAD_OUTCOMES = new Set(["uploaded", "not_required"]);
// Must stay in step with HUMAN_ACTION_KINDS in job-application-runner.js: a kind the runner can
// produce but the store rejects turns a normal checkpoint into "failed | unexpected_error", which
// is how a legal_acceptance checkpoint destroyed a run that had otherwise filled the form.
export const MANUAL_ACTION_KINDS = new Set([
  "sign_in",
  "captcha",
  "verification",
  "upload",
  "answer_question",
  "legal_acceptance",
  "review",
  "other",
]);
// What happens to an application after it leaves the robot's hands.
export const OUTCOME_STAGES = new Set(["applied", "interview", "offer", "rejected", "withdrawn"]);
// Ordered by how far through the process each one is; used to pick the current stage.
const STAGE_ORDER = ["applied", "interview", "offer"];
const TERMINAL_STAGES = new Set(["rejected", "withdrawn"]);
// `email` is a proposal derived from an inbox and is never confirmed on arrival.
export const OUTCOME_SOURCES = new Set(["manual", "email", "system"]);
const ATTEMPT_PHASES = new Set([
  "preparing_cv",
  "opening_form",
  "uploading_cv",
  "filling_verified_fields",
  "guidance",
  "cancelled",
  "usage",
  "submitted",
]);

// Freshness windows. A verified listing date decides "current"; anything older, or any
// row that has not been re-observed recently, degrades so the queue cannot present a
// stale listing as if it were live.
const CURRENT_LISTING_DAYS = 14;
const REVALIDATE_AFTER_DAYS = 3;
const DAY_MS = 86_400_000;

// Query-string keys that only carry campaign/tracking state. Everything else stays in
// the canonical URL because boards such as Indeed keep the job id in a query param.
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referer",
  "referrer",
  "refid",
  "refid_",
  "trk",
  "trkinfo",
  "traceid",
  "trackingid",
  "originalsubdomain",
  "position",
  "pagenum",
  "eblc",
  "ebp",
  "src",
  "source",
  "sourceid",
  "src_trk",
  "savedsearchid",
  "alid",
  "from",
  "campaignid",
  "vjs",
  "tk",
  "xkcb",
  "xpse",
  "sessionid",
]);

// Host families used for source diversification and coverage checks. Spelling variants
// of the same board must collapse to one family so a per-source cap cannot be bypassed.
const SOURCE_FAMILY_HOSTS = [
  ["linkedin", ["linkedin.com"]],
  ["indeed", ["indeed.com", "indeed.co.uk", "uk.indeed.com"]],
  ["reed", ["reed.co.uk"]],
  ["totaljobs", ["totaljobs.com"]],
  ["cv-library", ["cv-library.co.uk"]],
  ["glassdoor", ["glassdoor.com", "glassdoor.co.uk"]],
  ["otta", ["otta.com", "welcometothejungle.com"]],
  ["greenhouse", ["greenhouse.io"]],
  ["lever", ["lever.co"]],
  ["ashby", ["ashbyhq.com"]],
  ["workable", ["workable.com"]],
  ["smartrecruiters", ["smartrecruiters.com"]],
  ["workday", ["myworkdayjobs.com", "workday.com"]],
  ["teamtailor", ["teamtailor.com"]],
  ["targetjobs", ["targetjobs.co.uk"]],
  ["wellfound", ["wellfound.com", "angel.co"]],
  ["monster", ["monster.co.uk", "monster.com"]],
  ["jobserve", ["jobserve.com"]],
  ["technojobs", ["technojobs.co.uk"]],
];
// Applicant-tracking hosts are still third-party boards, but a listing there is the
// employer's own posting, so coverage treats them as first-party reach.
const FIRST_PARTY_ATS_FAMILIES = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "smartrecruiters",
  "workday",
  "teamtailor",
]);

/**
 * Is this application over, so its browser tab can be closed?
 *
 * The dangerous mistake would be closing a tab the user still needs. A checkpoint waiting on him is
 * not finished — that tab is the one he takes over — and neither is one he is reviewing before
 * submitting. Only submitted and failed runs have nothing left to look at.
 */
export function isFinishedApplication(application) {
  return application?.status === "submitted" || application?.status === "failed";
}

export class JobHuntStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS hunting_search_profiles (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        locations_json TEXT NOT NULL,
        work_modes_json TEXT NOT NULL,
        minimum_salary INTEGER,
        salary_currency TEXT NOT NULL,
        job_types_json TEXT NOT NULL,
        excluded_keywords_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hunting_jobs (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        location TEXT NOT NULL,
        source TEXT NOT NULL,
        work_mode TEXT,
        salary TEXT,
        listed_at TEXT,
        description_excerpt TEXT NOT NULL,
        match_score INTEGER NOT NULL,
        match_reasons_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('new', 'shortlisted', 'dismissed')),
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hunting_discovery_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary TEXT NOT NULL DEFAULT '',
        source_status_json TEXT NOT NULL DEFAULT '[]',
        observed_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS hunting_application_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        detail TEXT,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hunting_application_attempts_job_idx
        ON hunting_application_attempts (job_id, created_at DESC);

      -- What happened after submitting: interview, offer, rejection. Kept separate from
      -- the status column, which tracks how far the robot got, and kept as an event log rather
      -- than one mutable column so history survives and an email-derived proposal can be
      -- appended, reviewed, then accepted or discarded without destroying what came before.
      CREATE TABLE IF NOT EXISTS hunting_application_outcomes (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        note TEXT,
        source TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hunting_application_outcomes_job_idx
        ON hunting_application_outcomes (job_id, occurred_at DESC);

      -- Standing permission to accept a named policy on a named host. It lives here rather than
      -- in a memory note because memory is written by the model: a permission the model can
      -- author is not a permission the user gave.
      CREATE TABLE IF NOT EXISTS hunting_site_consents (
        host TEXT NOT NULL,
        gate TEXT NOT NULL,
        phrase TEXT NOT NULL DEFAULT '',
        granted_at TEXT NOT NULL,
        PRIMARY KEY (host, gate)
      );
    `);
    // Applications first: the job dedupe below prefers rows that already own a checkpoint.
    this.#migrateApplications();
    this.#migrateJobColumns();
  }

  #migrateJobColumns() {
    const columns = new Set(
      this.database.prepare("PRAGMA table_info(hunting_jobs)").all().map((column) => column.name),
    );
    if (!columns.has("listed_at")) this.database.exec("ALTER TABLE hunting_jobs ADD COLUMN listed_at TEXT");
    if (!columns.has("canonical_url")) {
      this.database.exec("ALTER TABLE hunting_jobs ADD COLUMN canonical_url TEXT");
    }
    if (!columns.has("source_family")) {
      this.database.exec("ALTER TABLE hunting_jobs ADD COLUMN source_family TEXT");
    }
    if (!columns.has("first_seen_at")) {
      this.database.exec("ALTER TABLE hunting_jobs ADD COLUMN first_seen_at TEXT");
    }
    if (!columns.has("last_seen_at")) {
      this.database.exec("ALTER TABLE hunting_jobs ADD COLUMN last_seen_at TEXT");
    }
    if (!columns.has("last_run_id")) {
      this.database.exec("ALTER TABLE hunting_jobs ADD COLUMN last_run_id TEXT");
    }
    for (const row of this.database.prepare("SELECT id, url FROM hunting_jobs WHERE canonical_url IS NULL").all()) {
      this.database
        .prepare("UPDATE hunting_jobs SET canonical_url = ?, source_family = ? WHERE id = ?")
        .run(canonicalizeJobUrl(row.url), sourceFamilyForUrl(row.url), row.id);
    }
    this.database.exec(`
      UPDATE hunting_jobs SET first_seen_at = discovered_at WHERE first_seen_at IS NULL;
      UPDATE hunting_jobs SET last_seen_at = updated_at WHERE last_seen_at IS NULL;
    `);
    // Rows stored before canonicalization can collide. Keep the row that already owns an
    // application checkpoint, then the earliest sighting, so no checkpoint is orphaned.
    const collisions = this.database
      .prepare("SELECT canonical_url FROM hunting_jobs GROUP BY canonical_url HAVING COUNT(*) > 1")
      .all();
    for (const collision of collisions) {
      const rows = this.database
        .prepare(`
          SELECT j.id,
                 (SELECT COUNT(*) FROM hunting_applications a WHERE a.job_id = j.id) AS applications
          FROM hunting_jobs j
          WHERE j.canonical_url = ?
          ORDER BY applications DESC, j.first_seen_at ASC
        `)
        .all(collision.canonical_url);
      for (const row of rows.slice(1)) {
        this.database.prepare("DELETE FROM hunting_jobs WHERE id = ?").run(row.id);
      }
    }
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS hunting_jobs_canonical_url_idx
        ON hunting_jobs (canonical_url);
    `);
  }

  #migrateApplications() {
    const existing = this.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hunting_applications'")
      .get();
    const currentSchema = `
      CREATE TABLE hunting_applications (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued', 'preparing_cv', 'opening_form', 'uploading_cv',
          'filling_verified_fields', 'needs_human_action', 'ready_for_review', 'submitted', 'failed')),
        session_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        reason_code TEXT,
        current_url TEXT,
        browser_target_id TEXT,
        filled_fields_json TEXT NOT NULL,
        unresolved_fields_json TEXT NOT NULL,
        -- Optional fields nobody could answer. Recorded, but never a reason to stop.
        skipped_fields_json TEXT NOT NULL DEFAULT '[]',
        manual_action TEXT,
        manual_action_kind TEXT,
        used_memory_ids_json TEXT NOT NULL,
        tailored_cv_name TEXT,
        -- The text behind the attached PDF. A resumed run needs the exact wording that was
        -- staged; regenerating it would drift from the file the form already holds.
        tailored_cv_content TEXT,
        upload_outcome TEXT NOT NULL DEFAULT 'pending',
        upload_attempts INTEGER NOT NULL DEFAULT 0,
        upload_verified_at TEXT,
        upload_evidence_json TEXT NOT NULL DEFAULT '{}',
        artifact_json TEXT NOT NULL DEFAULT '{}',
        -- The saved cover letter for this application, kept for interview preparation.
        cover_letter_json TEXT NOT NULL DEFAULT '{}',
        -- Tokens, cost basis, and plan quota movement for this application.
        usage_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
    if (!existing) {
      this.database.exec(currentSchema);
      return;
    }
    const existingSql = String(existing.sql);
    if (existingSql.includes("'filling_verified_fields'") && existingSql.includes("usage_json")) return;

    // The status CHECK is part of the table definition, so widening the state machine
    // means a real table rebuild. Retired statuses map forward here, never at runtime.
    this.database.exec("ALTER TABLE hunting_applications RENAME TO hunting_applications_legacy");
    this.database.exec(currentSchema);
    const legacyColumns = new Set(
      this.database
        .prepare("PRAGMA table_info(hunting_applications_legacy)")
        .all()
        .map((column) => column.name),
    );
    const insert = this.database.prepare(`
      INSERT INTO hunting_applications
        (job_id, status, session_key, summary, current_url, filled_fields_json,
         unresolved_fields_json, manual_action, used_memory_ids_json, tailored_cv_name,
         upload_outcome, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of this.database.prepare("SELECT * FROM hunting_applications_legacy").all()) {
      const status = LEGACY_APPLICATION_STATUSES.get(row.status) ?? row.status;
      insert.run(
        row.job_id,
        APPLICATION_STATUSES.has(status) ? status : "failed",
        row.session_key,
        row.summary,
        legacyColumns.has("current_url") ? row.current_url : null,
        row.filled_fields_json ?? "[]",
        row.unresolved_fields_json ?? "[]",
        row.manual_action ?? null,
        row.used_memory_ids_json ?? "[]",
        legacyColumns.has("tailored_cv_name") ? row.tailored_cv_name : null,
        // No pre-migration checkpoint carries verified upload evidence.
        "pending",
        row.started_at,
        row.updated_at,
      );
    }
    this.database.exec("DROP TABLE hunting_applications_legacy");
  }

  /**
   * Mark work that no process owns any more as failed.
   *
   * Call this only once the caller knows it is the single live instance — the server calls it
   * after it owns its port. Doing it in the constructor meant any short-lived process that
   * opened this database (a launch that dies on EADDRINUSE, a script, a test) declared the
   * running instance's in-flight discovery run and applications "restarted" underneath it.
   */
  recoverInterruptedWork() {
    const now = new Date().toISOString();
    const active = [...ACTIVE_APPLICATION_STATUSES].map((status) => `'${status}'`).join(", ");
    this.database
      .prepare(`
        UPDATE hunting_applications
        SET status = 'failed',
            reason_code = 'service_restarted',
            summary = 'The J.A.R.V.I.S. service restarted before this application reached a checkpoint.',
            manual_action = 'Review the application page, then resume with J.A.R.V.I.S.',
            manual_action_kind = 'review',
            updated_at = ?
        WHERE status IN (${active})
      `)
      .run(now);
    this.database
      .prepare(`
        UPDATE hunting_discovery_runs
        SET status = 'failed', finished_at = ?, error = 'service restarted during discovery'
        WHERE status = 'running'
      `)
      .run(now);
  }

  getProfile() {
    const row = this.database
      .prepare(`SELECT * FROM hunting_search_profiles WHERE id = ?`)
      .get(PROFILE_ID);
    return row ? toProfile(row) : null;
  }

  saveProfile(input, expectedVersion = 0) {
    const profile = normalizeProfile(input);
    const current = this.getProfile();
    const currentVersion = current?.version ?? 0;
    if (expectedVersion !== currentVersion) {
      throw Object.assign(new Error("Search brief changed in another session; reload before saving"), {
        statusCode: 409,
      });
    }
    const next = {
      ...profile,
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO hunting_search_profiles
          (id, query, locations_json, work_modes_json, minimum_salary, salary_currency,
           job_types_json, excluded_keywords_json, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          query = excluded.query,
          locations_json = excluded.locations_json,
          work_modes_json = excluded.work_modes_json,
          minimum_salary = excluded.minimum_salary,
          salary_currency = excluded.salary_currency,
          job_types_json = excluded.job_types_json,
          excluded_keywords_json = excluded.excluded_keywords_json,
          version = excluded.version,
          updated_at = excluded.updated_at
      `)
      .run(
        PROFILE_ID,
        next.query,
        JSON.stringify(next.locations),
        JSON.stringify(next.workModes),
        next.minimumSalary,
        next.salaryCurrency,
        JSON.stringify(next.jobTypes),
        JSON.stringify(next.excludedKeywords),
        next.version,
        next.updatedAt,
      );
    return next;
  }

  startDiscoveryRun() {
    const run = { id: randomUUID(), status: "running", startedAt: new Date().toISOString() };
    this.database
      .prepare("INSERT INTO hunting_discovery_runs (id, status, started_at) VALUES (?, ?, ?)")
      .run(run.id, run.status, run.startedAt);
    return this.getDiscoveryRun(run.id);
  }

  finishDiscoveryRun(runId, { status, summary = "", sourceStatus = [], observedCount = 0, newCount = 0, error = null }) {
    if (!DISCOVERY_RUN_STATUSES.has(status)) throw new Error("invalid discovery run status");
    this.database
      .prepare(`
        UPDATE hunting_discovery_runs
        SET status = ?, finished_at = ?, summary = ?, source_status_json = ?,
            observed_count = ?, new_count = ?, error = ?
        WHERE id = ?
      `)
      .run(
        status,
        new Date().toISOString(),
        cleanText(summary, 1_000),
        JSON.stringify(normalizeSourceStatus(sourceStatus)),
        Math.max(0, Math.round(Number(observedCount) || 0)),
        Math.max(0, Math.round(Number(newCount) || 0)),
        cleanOptionalText(error, 500),
        runId,
      );
    return this.getDiscoveryRun(runId);
  }

  getDiscoveryRun(runId) {
    const row = this.database.prepare("SELECT * FROM hunting_discovery_runs WHERE id = ?").get(runId);
    return row ? toDiscoveryRun(row) : null;
  }

  latestDiscoveryRun() {
    const row = this.database
      .prepare("SELECT * FROM hunting_discovery_runs WHERE status = 'complete' ORDER BY started_at DESC LIMIT 1")
      .get();
    return row ? toDiscoveryRun(row) : null;
  }

  listDiscoveryRuns(limit = 10) {
    return this.database
      .prepare("SELECT * FROM hunting_discovery_runs ORDER BY started_at DESC LIMIT ?")
      .all(boundedLimit(limit, 50))
      .map(toDiscoveryRun);
  }

  /**
   * Compact "do not return these again" payload for the next discovery prompt. Without
   * it the model has no way to know which listings the queue already holds, so every
   * run drifts back to the same high-ranking boards.
   */
  buildDiscoveryExclusions({ urlLimit = 60, keyLimit = 60 } = {}) {
    const recent = this.database
      .prepare(`
        SELECT canonical_url, company, title, status, source_family
        FROM hunting_jobs ORDER BY last_seen_at DESC LIMIT ?
      `)
      .all(boundedLimit(urlLimit, 200));
    const dismissed = this.database
      .prepare(`
        SELECT company, title FROM hunting_jobs WHERE status = 'dismissed'
        ORDER BY updated_at DESC LIMIT ?
      `)
      .all(boundedLimit(keyLimit, 200));
    const sourceFamilyCounts = {};
    for (const row of recent) {
      const family = row.source_family || "unknown";
      sourceFamilyCounts[family] = (sourceFamilyCounts[family] ?? 0) + 1;
    }
    return {
      knownUrls: recent.map((row) => row.canonical_url).filter(Boolean),
      knownRoleKeys: [...new Set(recent.map((row) => roleKey(row.company, row.title)))],
      dismissedRoleKeys: [...new Set(dismissed.map((row) => roleKey(row.company, row.title)))],
      sourceFamilyCounts,
    };
  }

  upsertJobs(jobs, { runId = null } = {}) {
    const now = new Date().toISOString();
    const insert = this.database.prepare(`
      INSERT INTO hunting_jobs
        (id, url, canonical_url, source_family, title, company, location, source, work_mode, salary,
         listed_at, description_excerpt, match_score, match_reasons_json, status,
         discovered_at, updated_at, first_seen_at, last_seen_at, last_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)
    `);
    const update = this.database.prepare(`
      UPDATE hunting_jobs
      SET url = ?, source_family = ?, title = ?, company = ?, location = ?, source = ?, work_mode = ?,
          salary = ?, listed_at = ?, description_excerpt = ?, match_score = ?, match_reasons_json = ?,
          updated_at = ?, last_seen_at = ?, last_run_id = ?
      WHERE id = ?
    `);
    const saved = [];
    for (const input of jobs) {
      const job = normalizeJob(input);
      const existing = this.database
        .prepare("SELECT id FROM hunting_jobs WHERE canonical_url = ?")
        .get(job.canonicalUrl);
      if (existing) {
        update.run(
          job.url,
          job.sourceFamily,
          job.title,
          job.company,
          job.location,
          job.source,
          job.workMode,
          job.salary,
          job.listedAt,
          job.descriptionExcerpt,
          job.matchScore,
          JSON.stringify(job.matchReasons),
          now,
          now,
          runId,
          existing.id,
        );
        saved.push(this.getJob(existing.id));
        continue;
      }
      const id = randomUUID();
      insert.run(
        id,
        job.url,
        job.canonicalUrl,
        job.sourceFamily,
        job.title,
        job.company,
        job.location,
        job.source,
        job.workMode,
        job.salary,
        job.listedAt,
        job.descriptionExcerpt,
        job.matchScore,
        JSON.stringify(job.matchReasons),
        now,
        now,
        now,
        now,
        runId,
      );
      saved.push(this.getJob(id));
    }
    return saved;
  }

  /**
   * scope "run" returns what the latest completed run observed, "current" narrows that to
   * listings still presentable as live, and "all" is the historical audit view. The default
   * is deliberately not "all": returning the whole table made every repeat hunt look
   * identical regardless of what the run actually found.
   */
  listJobs({ scope = "current", includeDismissed = true, limit = 100, runId = null } = {}) {
    const latestRunId = runId ?? this.latestDiscoveryRun()?.id ?? null;
    const now = Date.now();
    const rows = this.database
      .prepare(`SELECT * FROM hunting_jobs ${includeDismissed ? "" : "WHERE status != 'dismissed'"}`)
      .all()
      .map((row) => {
        const job = toJob(row);
        return { ...job, freshness: classifyJobFreshness(job, { latestRunId, now }) };
      });
    const scoped =
      scope === "all"
        ? rows
        : scope === "run"
          ? rows.filter((job) => job.freshness !== "historical")
          : rows.filter((job) => job.freshness === "new" || job.freshness === "current");
    return scoped.sort(compareJobsForQueue).slice(0, boundedLimit(limit, 250));
  }

  getJob(id) {
    const row = this.database.prepare("SELECT * FROM hunting_jobs WHERE id = ?").get(id);
    if (!row) return null;
    const job = toJob(row);
    return {
      ...job,
      freshness: classifyJobFreshness(job, {
        latestRunId: this.latestDiscoveryRun()?.id ?? null,
        now: Date.now(),
      }),
    };
  }

  setJobStatus(id, status) {
    if (!JOB_STATUSES.has(status)) throw Object.assign(new Error("invalid job status"), { statusCode: 400 });
    if (!this.getJob(id)) throw Object.assign(new Error("job not found"), { statusCode: 404 });
    this.database
      .prepare("UPDATE hunting_jobs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.getJob(id);
  }

  listApplications() {
    return this.database
      .prepare("SELECT * FROM hunting_applications ORDER BY updated_at DESC")
      .all()
      .map(toApplication);
  }

  getApplication(jobId) {
    const row = this.database
      .prepare("SELECT * FROM hunting_applications WHERE job_id = ?")
      .get(jobId);
    return row ? toApplication(row) : null;
  }

  saveApplication(jobId, input) {
    if (!this.getJob(jobId)) throw Object.assign(new Error("job not found"), { statusCode: 404 });
    const status = String(input?.status ?? "");
    if (!APPLICATION_STATUSES.has(status)) {
      throw Object.assign(new Error("invalid application status"), { statusCode: 400 });
    }
    const current = this.getApplication(jobId);
    const uploadOutcome = input?.uploadOutcome ?? current?.uploadOutcome ?? "pending";
    if (!UPLOAD_OUTCOMES.has(uploadOutcome)) {
      throw Object.assign(new Error("invalid upload outcome"), { statusCode: 400 });
    }
    if (status === "ready_for_review" && !VERIFIED_UPLOAD_OUTCOMES.has(uploadOutcome)) {
      throw Object.assign(
        new Error("ready_for_review requires a verified CV upload or a form that needs no CV"),
        { statusCode: 400 },
      );
    }
    const manualActionKind = input?.manualActionKind ?? null;
    if (manualActionKind !== null && !MANUAL_ACTION_KINDS.has(manualActionKind)) {
      throw Object.assign(new Error("invalid manual action kind"), { statusCode: 400 });
    }
    const now = new Date().toISOString();
    const application = {
      jobId,
      status,
      sessionKey: cleanText(input?.sessionKey || current?.sessionKey, 240),
      summary: cleanText(input?.summary, 500),
      reasonCode: cleanOptionalText(input?.reasonCode, 80),
      currentUrl: normalizeOptionalUrl(input?.currentUrl),
      browserTargetId: cleanOptionalText(input?.browserTargetId ?? current?.browserTargetId, 120),
      filledFields: cleanFieldAudit(input?.filledFields),
      unresolvedFields: cleanFieldNotes(input?.unresolvedFields, true),
      skippedFields: cleanFieldNotes(input?.skippedFields, false),
      manualAction: cleanOptionalText(input?.manualAction, 500),
      manualActionKind,
      usedMemoryIds: cleanList(input?.usedMemoryIds, 10, 160),
      tailoredCvName: cleanOptionalText(input?.tailoredCvName || current?.tailoredCvName, 180),
      tailoredCvContent: optionalLongText(input?.tailoredCvContent ?? current?.tailoredCvContent, 200_000),
      uploadOutcome,
      uploadAttempts: Math.max(0, Math.round(Number(input?.uploadAttempts ?? current?.uploadAttempts ?? 0))),
      uploadVerifiedAt: cleanOptionalText(
        input?.uploadVerifiedAt ?? (uploadOutcome === "uploaded" ? current?.uploadVerifiedAt : null),
        40,
      ),
      uploadEvidence: plainObject(input?.uploadEvidence ?? current?.uploadEvidence),
      artifact: plainObject(input?.artifact ?? current?.artifact),
      coverLetter: plainObject(input?.coverLetter ?? current?.coverLetter),
      usage: plainObject(input?.usage ?? current?.usage),
      startedAt: current?.startedAt ?? now,
      updatedAt: now,
    };
    if (!application.sessionKey) throw new Error("application session key is required");
    this.database
      .prepare(`
        INSERT INTO hunting_applications
          (job_id, status, session_key, summary, reason_code, current_url, browser_target_id,
           filled_fields_json, unresolved_fields_json, skipped_fields_json, manual_action,
           manual_action_kind, used_memory_ids_json, tailored_cv_name, tailored_cv_content,
           upload_outcome, upload_attempts, upload_verified_at, upload_evidence_json,
           artifact_json, cover_letter_json, usage_json, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          status = excluded.status,
          session_key = excluded.session_key,
          summary = excluded.summary,
          reason_code = excluded.reason_code,
          current_url = excluded.current_url,
          browser_target_id = excluded.browser_target_id,
          filled_fields_json = excluded.filled_fields_json,
          unresolved_fields_json = excluded.unresolved_fields_json,
          skipped_fields_json = excluded.skipped_fields_json,
          manual_action = excluded.manual_action,
          manual_action_kind = excluded.manual_action_kind,
          used_memory_ids_json = excluded.used_memory_ids_json,
          tailored_cv_name = excluded.tailored_cv_name,
          tailored_cv_content = excluded.tailored_cv_content,
          upload_outcome = excluded.upload_outcome,
          upload_attempts = excluded.upload_attempts,
          upload_verified_at = excluded.upload_verified_at,
          upload_evidence_json = excluded.upload_evidence_json,
          artifact_json = excluded.artifact_json,
          cover_letter_json = excluded.cover_letter_json,
          usage_json = excluded.usage_json,
          updated_at = excluded.updated_at
      `)
      .run(
        application.jobId,
        application.status,
        application.sessionKey,
        application.summary,
        application.reasonCode,
        application.currentUrl,
        application.browserTargetId,
        JSON.stringify(application.filledFields),
        JSON.stringify(application.unresolvedFields),
        JSON.stringify(application.skippedFields),
        application.manualAction,
        application.manualActionKind,
        JSON.stringify(application.usedMemoryIds),
        application.tailoredCvName,
        application.tailoredCvContent,
        application.uploadOutcome,
        application.uploadAttempts,
        application.uploadVerifiedAt,
        JSON.stringify(application.uploadEvidence),
        JSON.stringify(application.artifact),
        JSON.stringify(application.coverLetter),
        JSON.stringify(application.usage),
        application.startedAt,
        application.updatedAt,
      );
    return this.getApplication(jobId);
  }

  recordAttempt(jobId, { phase, outcome, reasonCode = null, detail = null, evidence = {} }) {
    if (!ATTEMPT_PHASES.has(phase)) throw new Error("invalid application attempt phase");
    const attempt = {
      id: randomUUID(),
      jobId,
      phase,
      outcome: cleanText(outcome, 80),
      reasonCode: cleanOptionalText(reasonCode, 80),
      detail: cleanOptionalText(detail, 800),
      evidence: plainObject(evidence),
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO hunting_application_attempts
          (id, job_id, phase, outcome, reason_code, detail, evidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attempt.id,
        attempt.jobId,
        attempt.phase,
        attempt.outcome,
        attempt.reasonCode,
        attempt.detail,
        JSON.stringify(attempt.evidence),
        attempt.createdAt,
      );
    return attempt;
  }

  /** Record that the user cleared one named acceptance on one host. Re-granting is idempotent. */
  grantSiteConsent({ host, gate, phrase = "" }) {
    const grant = {
      host: cleanText(host, 200).toLowerCase(),
      gate: cleanText(gate, 60),
      phrase: cleanOptionalText(phrase, 200) ?? "",
      grantedAt: new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO hunting_site_consents (host, gate, phrase, granted_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (host, gate) DO UPDATE SET phrase = excluded.phrase, granted_at = excluded.granted_at
      `)
      .run(grant.host, grant.gate, grant.phrase, grant.grantedAt);
    return grant;
  }

  /**
   * Hosts where one application has already been driven to a verified, fully answered state.
   *
   * This is the evidence auto-submit ramps on, so it is computed from stored checkpoints rather
   * than read from a memory note: a permission the model can write is not proof it earned.
   * The job asking is excluded, so a resumed application can never count itself as its own proof.
   */
  hostsWithVerifiedRun({ excludeJobId = null } = {}) {
    const hosts = new Set();
    for (const application of this.listApplications()) {
      if (excludeJobId && application.jobId === excludeJobId) continue;
      const complete =
        (application.status === "ready_for_review" || application.status === "submitted") &&
        ["uploaded", "not_required"].includes(application.uploadOutcome) &&
        (application.unresolvedFields ?? []).filter((field) => field.required !== false).length === 0;
      if (!complete) continue;
      const host = hostOf(application.currentUrl);
      if (host) hosts.add(host);
    }
    return [...hosts];
  }

  /**
   * Record one thing that happened to an application.
   *
   * `confirmed` false is a proposal awaiting the user's approval — the shape the Gmail reader needs,
   * so an email that looks like a rejection never silently rewrites his pipeline.
   */
  recordOutcome(jobId, { stage, occurredAt = null, note = null, source = "manual", confirmed = true }) {
    if (!OUTCOME_STAGES.has(stage)) {
      throw Object.assign(new Error("invalid application outcome stage"), { statusCode: 400 });
    }
    if (!OUTCOME_SOURCES.has(source)) {
      throw Object.assign(new Error("invalid application outcome source"), { statusCode: 400 });
    }
    const event = {
      id: randomUUID(),
      jobId,
      stage,
      occurredAt: occurredAt ?? new Date().toISOString(),
      note: cleanOptionalText(note, 600),
      source,
      confirmed: confirmed === true,
      createdAt: new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO hunting_application_outcomes
          (id, job_id, stage, occurred_at, note, source, confirmed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.jobId,
        event.stage,
        event.occurredAt,
        event.note,
        event.source,
        event.confirmed ? 1 : 0,
        event.createdAt,
      );
    return event;
  }

  listOutcomes(jobId) {
    return this.database
      .prepare(`
        SELECT id, stage, occurred_at, note, source, confirmed
        FROM hunting_application_outcomes WHERE job_id = ? ORDER BY occurred_at ASC, created_at ASC
      `)
      .all(jobId)
      .map((row) => ({
        id: row.id,
        stage: row.stage,
        occurredAt: row.occurred_at,
        note: row.note,
        source: row.source,
        confirmed: row.confirmed === 1,
      }));
  }

  /** Confirm or discard a proposed outcome. Returns false when it was already decided or absent. */
  resolveProposedOutcome(id, { accept }) {
    if (accept) {
      const result = this.database
        .prepare("UPDATE hunting_application_outcomes SET confirmed = 1 WHERE id = ? AND confirmed = 0")
        .run(id);
      return result.changes > 0;
    }
    const result = this.database
      .prepare("DELETE FROM hunting_application_outcomes WHERE id = ? AND confirmed = 0")
      .run(id);
    return result.changes > 0;
  }

  /**
   * Where an application stands now. A terminal stage wins outright; otherwise the furthest one
   * reached does, because "interview" after "applied" is progress, not a correction.
   */
  currentStage(jobId) {
    const confirmed = this.listOutcomes(jobId).filter((event) => event.confirmed);
    if (!confirmed.length) return null;
    const terminal = confirmed.find((event) => TERMINAL_STAGES.has(event.stage));
    if (terminal) return terminal.stage;
    return confirmed.reduce(
      (furthest, event) => (STAGE_ORDER.indexOf(event.stage) > STAGE_ORDER.indexOf(furthest) ? event.stage : furthest),
      confirmed[0].stage,
    );
  }

  /** One row per stage for the pipeline view, plus anything still awaiting approval. */
  outcomeSummary() {
    const counts = Object.fromEntries([...OUTCOME_STAGES].map((stage) => [stage, 0]));
    for (const row of this.database.prepare("SELECT DISTINCT job_id FROM hunting_application_outcomes").all()) {
      const stage = this.currentStage(row.job_id);
      if (stage) counts[stage] += 1;
    }
    const pending = this.database
      .prepare(`
        SELECT id, job_id, stage, occurred_at, note, source
        FROM hunting_application_outcomes WHERE confirmed = 0 ORDER BY occurred_at DESC
      `)
      .all()
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        stage: row.stage,
        occurredAt: row.occurred_at,
        note: row.note,
        source: row.source,
      }));
    return { counts, pending };
  }

  listSiteConsents(host) {
    return this.database
      .prepare("SELECT gate, phrase, granted_at FROM hunting_site_consents WHERE host = ? ORDER BY gate")
      .all(cleanText(host, 200).toLowerCase())
      .map((row) => ({ gate: row.gate, phrase: row.phrase, grantedAt: row.granted_at }));
  }

  revokeSiteConsent({ host, gate }) {
    const result = this.database
      .prepare("DELETE FROM hunting_site_consents WHERE host = ? AND gate = ?")
      .run(cleanText(host, 200).toLowerCase(), cleanText(gate, 60));
    return result.changes > 0;
  }

  listAttempts(jobId, limit = 50) {
    return this.database
      .prepare(`
        SELECT * FROM hunting_application_attempts WHERE job_id = ?
        ORDER BY created_at DESC LIMIT ?
      `)
      .all(jobId, boundedLimit(limit, 200))
      .map(toAttempt);
  }

  /** A click-like final-submit outcome is permanent, even after later audit rows push it off UI history. */
  hasFinalSubmitAttempt(jobId) {
    return Boolean(
      this.database
        .prepare(`
          SELECT 1 FROM hunting_application_attempts
          WHERE job_id = ?
            AND phase = 'submitted'
            AND outcome NOT IN ('not_attempted', 'control_not_found')
          LIMIT 1
        `)
        .get(jobId),
    );
  }
}

/** Drop tracking noise so the same listing shared through different links dedupes. */
export function canonicalizeJobUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ""));
  } catch {
    return cleanText(value, 2_000).toLowerCase();
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.protocol = "https:";
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const search = parsed.searchParams.toString();
  return collapseKnownJobIdForms(parsed.hostname, pathname, search);
}

/**
 * LinkedIn and Indeed serve one posting under locale subdomains and slugged paths, so the
 * generic rules above would keep several rows for the same job. Both expose a stable id:
 * LinkedIn in the last path segment, Indeed in the jk query parameter.
 */
function collapseKnownJobIdForms(hostname, pathname, search) {
  const withoutSearch = (host, path) => `${host}${path}`;
  if (hostname === "linkedin.com" || hostname.endsWith(".linkedin.com")) {
    const viewId = /^\/jobs\/view\/(?:.*-)?(\d{6,})$/u.exec(pathname);
    if (viewId) return withoutSearch("linkedin.com", `/jobs/view/${viewId[1]}`);
    return `linkedin.com${pathname}${search ? `?${search}` : ""}`;
  }
  if (hostname === "indeed.com" || /(^|\.)indeed\.(com|co\.uk)$/u.test(hostname)) {
    const jobKey = new URLSearchParams(search).get("jk");
    if (jobKey) return withoutSearch("indeed.com", `/viewjob?jk=${jobKey}`);
    return `indeed.com${pathname}${search ? `?${search}` : ""}`;
  }
  return `${hostname}${pathname}${search ? `?${search}` : ""}`;
}

/** Collapse a listing host to the board family used for caps and coverage checks. */
export function sourceFamilyForUrl(value) {
  let hostname;
  try {
    hostname = new URL(String(value ?? "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
  for (const [family, hosts] of SOURCE_FAMILY_HOSTS) {
    if (hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return family;
  }
  return `first-party:${hostname}`;
}

/** True when a family counts as employer-owned reach rather than aggregator reach. */
export function isFirstPartyFamily(family) {
  return String(family ?? "").startsWith("first-party:") || FIRST_PARTY_ATS_FAMILIES.has(family);
}

/**
 * new: first observed by the latest run. current: re-observed and still within the
 * verified-listing window. stale: re-observed but the listing date (or the last sighting)
 * is too old to present as live. historical: the latest run did not see it at all.
 */
export function classifyJobFreshness(job, { latestRunId, now = Date.now() } = {}) {
  if (!latestRunId || job.lastRunId !== latestRunId) return "historical";
  if (job.firstSeenAt && job.firstSeenAt === job.lastSeenAt) return "new";
  const listedAge = ageInDays(job.listedAt, now);
  if (listedAge !== null) return listedAge <= CURRENT_LISTING_DAYS ? "current" : "stale";
  const sightingAge = ageInDays(job.lastSeenAt, now);
  return sightingAge !== null && sightingAge <= REVALIDATE_AFTER_DAYS ? "current" : "stale";
}

/**
 * Verified recent listings rank first, then by posting date, then by score. An undated
 * listing can never displace a listing whose date was actually read from the posting.
 */
export function compareJobsForQueue(left, right) {
  const leftVerified = hasVerifiedRecentListing(left) ? 0 : 1;
  const rightVerified = hasVerifiedRecentListing(right) ? 0 : 1;
  if (leftVerified !== rightVerified) return leftVerified - rightVerified;
  if (left.listedAt && right.listedAt && left.listedAt !== right.listedAt) {
    return left.listedAt < right.listedAt ? 1 : -1;
  }
  if (left.matchScore !== right.matchScore) return right.matchScore - left.matchScore;
  return String(right.lastSeenAt ?? "").localeCompare(String(left.lastSeenAt ?? ""));
}

function hasVerifiedRecentListing(job) {
  const age = ageInDays(job.listedAt, Date.now());
  return age !== null && age <= CURRENT_LISTING_DAYS;
}

function ageInDays(value, now) {
  if (!value) return null;
  const timestamp = Date.parse(String(value).length === 10 ? `${value}T00:00:00.000Z` : String(value));
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, (now - timestamp) / DAY_MS);
}

function roleKey(company, title) {
  return `${cleanText(company, 80).toLowerCase()}::${cleanText(title, 120).toLowerCase()}`;
}

export function normalizeProfile(input) {
  const query = cleanText(input?.query, 3_000);
  if (query.length < 10) throw Object.assign(new Error("Describe the jobs you want in at least 10 characters"), { statusCode: 400 });
  const salary = input?.minimumSalary === null || input?.minimumSalary === ""
    ? null
    : Number(input?.minimumSalary);
  if (salary !== null && (!Number.isInteger(salary) || salary < 0 || salary > 10_000_000)) {
    throw Object.assign(new Error("minimum salary must be a valid whole number"), { statusCode: 400 });
  }
  return {
    query,
    locations: cleanList(input?.locations, 10, 100),
    workModes: cleanList(input?.workModes, 3, 20),
    minimumSalary: salary,
    salaryCurrency: cleanText(input?.salaryCurrency || "GBP", 3).toUpperCase(),
    jobTypes: cleanList(input?.jobTypes, 6, 40),
    excludedKeywords: cleanList(input?.excludedKeywords, 20, 80),
  };
}

export function normalizeJob(input) {
  const url = cleanText(input?.url, 2_000);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("job result has an invalid URL");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("job URL must use HTTP or HTTPS");
  const title = cleanText(input?.title, 180);
  const company = cleanText(input?.company, 180);
  if (!title || !company) throw new Error("job result is missing a title or company");
  return {
    url: parsed.toString(),
    canonicalUrl: canonicalizeJobUrl(parsed.toString()),
    sourceFamily: sourceFamilyForUrl(parsed.toString()),
    title,
    company,
    location: cleanText(input?.location || "Location not stated", 180),
    source: cleanText(input?.source || parsed.hostname, 80),
    workMode: cleanOptionalText(input?.workMode, 30),
    salary: cleanOptionalText(input?.salary, 120),
    listedAt: normalizeListedAt(input?.listedAt),
    descriptionExcerpt: cleanText(input?.descriptionExcerpt || "No description excerpt returned.", 1_000),
    matchScore: Math.max(0, Math.min(100, Math.round(Number(input?.matchScore) || 0))),
    matchReasons: cleanList(input?.matchReasons, 5, 180),
  };
}

export function normalizeSourceStatus(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const statuses = [];
  for (const entry of value) {
    const source = cleanText(entry?.source, 40).toLowerCase();
    if (!source || seen.has(source)) continue;
    seen.add(source);
    statuses.push({
      source,
      status: entry?.status === "covered" ? "covered" : "unavailable",
      reason: cleanOptionalText(entry?.reason, 300),
      count: Math.max(0, Math.round(Number(entry?.count) || 0)),
    });
  }
  return statuses.slice(0, 12);
}

function normalizeListedAt(value) {
  const date = cleanOptionalText(value, 20);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  const normalized = Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString().slice(0, 10);
  return normalized === date ? normalized : null;
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
  const text = cleanText(value, maxLength);
  return text || null;
}

/** Keeps newlines: CV text is stored verbatim, unlike the single-line audit fields. */
function optionalLongText(value, maxLength) {
  const text = typeof value === "string" ? value.slice(0, maxLength) : "";
  return text.trim() ? text : null;
}

function normalizeOptionalUrl(value) {
  const text = cleanOptionalText(value, 2_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return new Set(["http:", "https:"]).has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanList(value, maxItems, maxLength) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values.map((entry) => cleanText(entry, maxLength)).filter(Boolean))].slice(0, maxItems);
}

/** Every automated answer carries the verified source that authorised it. */
function cleanFieldAudit(value) {
  if (!Array.isArray(value)) return [];
  const audit = [];
  for (const entry of value) {
    const field = cleanText(typeof entry === "string" ? entry : entry?.field, 160);
    if (!field) continue;
    // The committed option is the reviewable part of a dropdown answer, so it is kept.
    const selectedOption = cleanText(entry?.selectedOption, 160);
    const sourceFact = cleanText(entry?.sourceFact, 240);
    audit.push({
      field,
      source: cleanText(entry?.source || "unstated", 60),
      ...(sourceFact ? { sourceFact } : {}),
      ...(selectedOption ? { selectedOption } : {}),
    });
    if (audit.length >= 80) break;
  }
  return audit;
}

/**
 * Unresolved and skipped fields carry a reason and whether the form required them. Strings are
 * accepted so an older payload (or a terse model) still lands in the same shape.
 */
function cleanFieldNotes(value, requiredDefault) {
  if (!Array.isArray(value)) return [];
  const notes = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const [field, ...rest] = entry.split(":");
      const label = cleanText(field, 160);
      if (!label) continue;
      notes.push({
        field: label,
        reason: cleanText(rest.join(":"), 300) || "no reason given",
        required: requiredDefault,
      });
    } else {
      const field = cleanText(entry?.field, 160);
      if (!field) continue;
      notes.push({
        field,
        reason: cleanText(entry?.reason, 300) || "no reason given",
        required: typeof entry?.required === "boolean" ? entry.required : requiredDefault,
      });
    }
    if (notes.length >= 40) break;
  }
  return notes;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedLimit(value, max) {
  return Math.max(1, Math.min(max, Number(value) || max));
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function toProfile(row) {
  return {
    query: row.query,
    locations: JSON.parse(row.locations_json),
    workModes: JSON.parse(row.work_modes_json),
    minimumSalary: row.minimum_salary === null ? null : Number(row.minimum_salary),
    salaryCurrency: row.salary_currency,
    jobTypes: JSON.parse(row.job_types_json),
    excludedKeywords: JSON.parse(row.excluded_keywords_json),
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

function toDiscoveryRun(row) {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    sourceStatus: parseJson(row.source_status_json, []),
    observedCount: Number(row.observed_count),
    newCount: Number(row.new_count),
    error: row.error,
  };
}

function toJob(row) {
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    sourceFamily: row.source_family,
    title: row.title,
    company: row.company,
    location: row.location,
    source: row.source,
    workMode: row.work_mode,
    salary: row.salary,
    listedAt: row.listed_at,
    descriptionExcerpt: row.description_excerpt,
    matchScore: Number(row.match_score),
    matchReasons: JSON.parse(row.match_reasons_json),
    status: row.status,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastRunId: row.last_run_id,
  };
}

function toApplication(row) {
  return {
    jobId: row.job_id,
    status: row.status,
    sessionKey: row.session_key,
    summary: row.summary,
    reasonCode: row.reason_code,
    currentUrl: row.current_url,
    browserTargetId: row.browser_target_id,
    filledFields: parseJson(row.filled_fields_json, []),
    unresolvedFields: parseJson(row.unresolved_fields_json, []),
    skippedFields: parseJson(row.skipped_fields_json, []),
    manualAction: row.manual_action,
    manualActionKind: row.manual_action_kind,
    usedMemoryIds: parseJson(row.used_memory_ids_json, []),
    tailoredCvName: row.tailored_cv_name,
    tailoredCvContent: row.tailored_cv_content,
    uploadOutcome: row.upload_outcome,
    uploadAttempts: Number(row.upload_attempts),
    uploadVerifiedAt: row.upload_verified_at,
    uploadEvidence: parseJson(row.upload_evidence_json, {}),
    artifact: parseJson(row.artifact_json, {}),
    coverLetter: parseJson(row.cover_letter_json, {}),
    usage: parseJson(row.usage_json, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    phase: row.phase,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    detail: row.detail,
    evidence: parseJson(row.evidence_json, {}),
    createdAt: row.created_at,
  };
}

function hostOf(value) {
  try {
    return new URL(String(value ?? "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
