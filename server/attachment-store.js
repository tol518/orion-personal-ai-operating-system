import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const MAX_FILES = 5;
const MAX_BYTES = 20 * 1024 * 1024;

export class AttachmentStore {
  constructor(databasePath, directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_attachments (
        memory_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, attachment_id)
      );
      CREATE INDEX IF NOT EXISTS memory_attachments_memory_idx
        ON memory_attachments (memory_id, created_at);
    `);
  }

  saveMany(values) {
    if (!Array.isArray(values) || values.length === 0) return [];
    if (values.length > MAX_FILES) throw badRequest(`Attach at most ${MAX_FILES} files at a time`);
    return values.map((value) => this.#save(value));
  }

  get(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(String(id));
    return row ? publicAttachment(row) : null;
  }

  list(ids) {
    return [...new Set((ids ?? []).map(String).filter(Boolean))]
      .map((id) => this.get(id))
      .filter(Boolean);
  }

  gatewayPayloads(ids) {
    return this.list(ids).map((attachment) => ({
      type: attachment.mimeType.startsWith("image/") ? "image" : "file",
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      content: fs.readFileSync(this.#path(attachment.id)).toString("base64"),
    }));
  }

  file(id) {
    const attachment = this.get(id);
    if (!attachment) return null;
    return { attachment, path: this.#path(attachment.id) };
  }

  setForMemory(memoryId, ids) {
    const attachmentIds = this.list(ids).map(({ id }) => id);
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM memory_attachments WHERE memory_id = ?").run(memoryId);
      const insert = this.database.prepare(
        "INSERT INTO memory_attachments (memory_id, attachment_id, created_at) VALUES (?, ?, ?)",
      );
      const now = new Date().toISOString();
      for (const id of attachmentIds) insert.run(memoryId, id, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.forMemory(memoryId);
  }

  forMemory(memoryId) {
    const rows = this.database.prepare(`
      SELECT a.* FROM attachments a
      JOIN memory_attachments ma ON ma.attachment_id = a.id
      WHERE ma.memory_id = ? ORDER BY ma.created_at, a.file_name
    `).all(memoryId);
    return rows.map(publicAttachment);
  }

  forMemories(memoryIds) {
    return [...new Set((memoryIds ?? []).flatMap((id) => this.forMemory(id).map(({ id: attachmentId }) => attachmentId)))];
  }

  removeMemory(memoryId) {
    this.database.prepare("DELETE FROM memory_attachments WHERE memory_id = ?").run(memoryId);
  }

  #save(value) {
    const fileName = safeFileName(value?.fileName);
    const mimeType = String(value?.mimeType ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
    const content = String(value?.content ?? "").replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
    if (!content || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw badRequest(`${fileName}: invalid file content`);
    const bytes = Buffer.from(content, "base64");
    if (!bytes.length) throw badRequest(`${fileName}: file is empty`);
    if (bytes.length > MAX_BYTES) throw badRequest(`${fileName}: file exceeds the 20 MB limit`);
    const id = randomUUID();
    const extension = path.extname(fileName).slice(0, 16);
    const storagePath = path.join(this.directory, `${id}${extension}`);
    fs.writeFileSync(storagePath, bytes, { flag: "wx", mode: 0o600 });
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO attachments (id, file_name, mime_type, size_bytes, sha256, storage_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, fileName, mimeType || "application/octet-stream", bytes.length, createHash("sha256").update(bytes).digest("hex"), storagePath, createdAt);
    return this.get(id);
  }

  #path(id) {
    const row = this.database.prepare("SELECT storage_path FROM attachments WHERE id = ?").get(id);
    if (!row) throw Object.assign(new Error("attachment not found"), { statusCode: 404 });
    return row.storage_path;
  }
}

function safeFileName(value) {
  const name = path.basename(String(value ?? "").trim()).replace(/[\u0000-\u001f]/g, "").slice(0, 180);
  if (!name || name === "." || name === "..") throw badRequest("file name is required");
  return name;
}

function publicAttachment(row) {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    url: `/api/attachments/${encodeURIComponent(row.id)}`,
  };
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
