import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PRIMARY_CV_ID = "primary";
const PDF_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_HISTORY_ENTRIES = 20;

export class CvStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS hunting_cvs (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_name TEXT,
        source_format TEXT,
        source_pdf BLOB,
        source_pdf_content_hash TEXT,
        source_pdf_kind TEXT,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    ensureColumn(this.database, "hunting_cvs", "source_pdf", "BLOB");
    ensureColumn(this.database, "hunting_cvs", "source_pdf_content_hash", "TEXT");
    ensureColumn(this.database, "hunting_cvs", "source_pdf_kind", "TEXT");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS hunting_cv_pdf_drafts (
        token TEXT PRIMARY KEY,
        pdf_data BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        source_name TEXT NOT NULL,
        pdf_kind TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    ensureColumn(this.database, "hunting_cv_pdf_drafts", "pdf_kind", "TEXT");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS hunting_cv_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source_name TEXT,
        source_format TEXT,
        source_pdf BLOB,
        source_pdf_content_hash TEXT,
        source_pdf_kind TEXT,
        saved_at TEXT NOT NULL
      )
    `);
  }

  get() {
    const row = this.database
      .prepare(
        `SELECT content, source_name, source_format, version, updated_at,
                source_pdf IS NOT NULL AS has_original_pdf,
                source_pdf_content_hash, source_pdf_kind
         FROM hunting_cvs WHERE id = ?`,
      )
      .get(PRIMARY_CV_ID);
    return row ? { ...toCv(row), canUndo: this.#canUndo() } : null;
  }

  stageOriginalPdf({ pdf, content, sourceName, kind = "original" }) {
    this.#deleteExpiredPdfDrafts();
    const token = randomUUID();
    this.database
      .prepare(
        `INSERT INTO hunting_cv_pdf_drafts
          (token, pdf_data, content_hash, source_name, pdf_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(token, Buffer.from(pdf), contentHash(content), sourceName, kind, Date.now());
    return token;
  }

  sourcePdfFor({ content, draftToken = null }) {
    this.#deleteExpiredPdfDrafts();
    const hash = contentHash(content);
    if (draftToken) {
      const draft = this.database
        .prepare(
          `SELECT pdf_data, source_name, pdf_kind FROM hunting_cv_pdf_drafts
           WHERE token = ? AND content_hash = ?`,
        )
        .get(draftToken, hash);
      if (draft) return { data: Buffer.from(draft.pdf_data), sourceName: draft.source_name, kind: draft.pdf_kind ?? "original" };
    }
    const saved = this.database
      .prepare(
        `SELECT source_pdf, source_name, source_pdf_kind FROM hunting_cvs
         WHERE id = ? AND source_pdf_content_hash = ? AND source_pdf IS NOT NULL`,
      )
      .get(PRIMARY_CV_ID, hash);
    return saved ? { data: Buffer.from(saved.source_pdf), sourceName: saved.source_name, kind: saved.source_pdf_kind ?? "original" } : null;
  }

  sourcePdf() {
    const row = this.database
      .prepare(`SELECT source_pdf, source_name, source_pdf_kind FROM hunting_cvs WHERE id = ? AND source_pdf IS NOT NULL`)
      .get(PRIMARY_CV_ID);
    return row ? { data: Buffer.from(row.source_pdf), sourceName: row.source_name, kind: row.source_pdf_kind ?? "original" } : null;
  }

  linkSourcePdfs() {
    const history = this.database
      .prepare(
        `SELECT source_pdf FROM hunting_cv_history
         WHERE source_pdf IS NOT NULL ORDER BY sequence DESC LIMIT ?`,
      )
      .all(MAX_HISTORY_ENTRIES);
    return history.map((row) => Buffer.from(row.source_pdf));
  }

  save({
    content,
    sourceName = null,
    sourceFormat = null,
    sourcePdfToken = null,
    expectedVersion = 0,
  }) {
    const current = this.get();
    const currentVersion = current?.version ?? 0;
    if (expectedVersion !== currentVersion) {
      throw Object.assign(new Error("CV changed in another session; reload before saving"), {
        statusCode: 409,
      });
    }

    const storedSource = this.database
      .prepare(
        `SELECT source_pdf, source_pdf_content_hash, source_pdf_kind FROM hunting_cvs WHERE id = ?`,
      )
      .get(PRIMARY_CV_ID);
    let sourcePdf = storedSource?.source_pdf ?? null;
    let sourcePdfContentHash = storedSource?.source_pdf_content_hash ?? null;
    let sourcePdfKind = storedSource?.source_pdf_kind ?? null;
    if (sourcePdfToken) {
      const draft = this.database
        .prepare(
          `SELECT pdf_data, content_hash, pdf_kind FROM hunting_cv_pdf_drafts WHERE token = ?`,
        )
        .get(sourcePdfToken);
      if (!draft) throw new Error("The original PDF upload expired; upload it again before saving");
      sourcePdf = draft.pdf_data;
      sourcePdfContentHash = draft.content_hash;
      sourcePdfKind = draft.pdf_kind ?? "original";
    } else if (sourceFormat !== "pdf") {
      sourcePdf = null;
      sourcePdfContentHash = null;
      sourcePdfKind = null;
    }

    const next = {
      content,
      sourceName,
      sourceFormat,
      hasOriginalPdf:
        Boolean(sourcePdf) && sourcePdfContentHash === contentHash(content),
      pdfKind: sourcePdfKind,
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (current) this.#pushHistory();
      this.database
        .prepare(
          `INSERT INTO hunting_cvs
          (id, content, source_name, source_format, source_pdf,
           source_pdf_content_hash, source_pdf_kind, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           source_name = excluded.source_name,
           source_format = excluded.source_format,
           source_pdf = excluded.source_pdf,
           source_pdf_content_hash = excluded.source_pdf_content_hash,
           source_pdf_kind = excluded.source_pdf_kind,
           version = excluded.version,
           updated_at = excluded.updated_at`,
        )
        .run(
          PRIMARY_CV_ID,
          next.content,
          next.sourceName,
          next.sourceFormat,
          sourcePdf,
          sourcePdfContentHash,
          sourcePdfKind,
          next.version,
          next.updatedAt,
        );
      this.#trimHistory();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    if (sourcePdfToken) {
      this.database.prepare(`DELETE FROM hunting_cv_pdf_drafts WHERE token = ?`).run(sourcePdfToken);
    }
    return { ...next, canUndo: this.#canUndo() };
  }

  undo({ expectedVersion }) {
    const current = this.get();
    if (!current) throw Object.assign(new Error("No canonical CV exists"), { statusCode: 404 });
    if (expectedVersion !== current.version) {
      throw Object.assign(new Error("CV changed in another session; reload before going back"), {
        statusCode: 409,
      });
    }
    const previous = this.database
      .prepare(`SELECT * FROM hunting_cv_history ORDER BY sequence DESC LIMIT 1`)
      .get();
    if (!previous) throw Object.assign(new Error("There is no earlier CV version"), { statusCode: 409 });

    const nextVersion = current.version + 1;
    const updatedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `UPDATE hunting_cvs SET
             content = ?, source_name = ?, source_format = ?, source_pdf = ?,
             source_pdf_content_hash = ?, source_pdf_kind = ?, version = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          previous.content,
          previous.source_name,
          previous.source_format,
          previous.source_pdf,
          previous.source_pdf_content_hash,
          previous.source_pdf_kind,
          nextVersion,
          updatedAt,
          PRIMARY_CV_ID,
        );
      this.database.prepare(`DELETE FROM hunting_cv_history WHERE sequence = ?`).run(previous.sequence);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get();
  }

  #canUndo() {
    return Boolean(
      this.database.prepare(`SELECT 1 AS present FROM hunting_cv_history LIMIT 1`).get()?.present,
    );
  }

  #pushHistory() {
    this.database
      .prepare(
        `INSERT INTO hunting_cv_history
          (content, source_name, source_format, source_pdf, source_pdf_content_hash, source_pdf_kind, saved_at)
         SELECT content, source_name, source_format, source_pdf, source_pdf_content_hash, source_pdf_kind, updated_at
         FROM hunting_cvs WHERE id = ?`,
      )
      .run(PRIMARY_CV_ID);
  }

  #trimHistory() {
    this.database
      .prepare(
        `DELETE FROM hunting_cv_history WHERE sequence NOT IN (
           SELECT sequence FROM hunting_cv_history ORDER BY sequence DESC LIMIT ?
         )`,
      )
      .run(MAX_HISTORY_ENTRIES);
  }

  #deleteExpiredPdfDrafts() {
    this.database
      .prepare(`DELETE FROM hunting_cv_pdf_drafts WHERE created_at < ?`)
      .run(Date.now() - PDF_DRAFT_MAX_AGE_MS);
  }
}

function toCv(row) {
  return {
    content: row.content,
    sourceName: row.source_name,
    sourceFormat: row.source_format,
    hasOriginalPdf:
      Boolean(row.has_original_pdf) && row.source_pdf_content_hash === contentHash(row.content),
    pdfKind: row.source_pdf_kind ?? null,
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function ensureColumn(database, table, column, type) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
