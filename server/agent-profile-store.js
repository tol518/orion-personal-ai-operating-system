import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ANIMATION_SPEC, parseAnimationSpec } from "./agent-appearance-generator.js";

export class AgentProfileStore {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        appearance_attachment_id TEXT NOT NULL,
        reference_attachment_ids TEXT NOT NULL,
        appearance_prompt TEXT NOT NULL,
        animation_spec TEXT,
        appearance_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_appearance_analyses (
        attachment_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        animation_spec TEXT NOT NULL,
        prompt TEXT NOT NULL,
        analyzed_at TEXT NOT NULL
      );
    `);
    ensureColumn(this.database, "agent_profiles", "animation_spec", "TEXT");
    ensureColumn(this.database, "agent_profiles", "appearance_model", "TEXT");
  }

  get(agentId) {
    const row = this.database
      .prepare("SELECT * FROM agent_profiles WHERE agent_id = ?")
      .get(String(agentId));
    return row ? publicProfile(row) : null;
  }

  set(input) {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_profiles (
        agent_id, role, appearance_attachment_id, reference_attachment_ids,
        appearance_prompt, animation_spec, appearance_model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        role = excluded.role,
        appearance_attachment_id = excluded.appearance_attachment_id,
        reference_attachment_ids = excluded.reference_attachment_ids,
        appearance_prompt = excluded.appearance_prompt,
        animation_spec = excluded.animation_spec,
        appearance_model = excluded.appearance_model,
        updated_at = excluded.updated_at
    `).run(
      input.agentId,
      input.role,
      input.appearanceAttachmentId,
      JSON.stringify(input.referenceAttachmentIds ?? []),
      input.appearancePrompt ?? "",
      JSON.stringify(input.animationSpec ?? DEFAULT_ANIMATION_SPEC),
      input.appearanceModel ?? null,
      now,
      now,
    );
    return this.get(input.agentId);
  }

  remove(agentId) {
    this.database.prepare("DELETE FROM agent_profiles WHERE agent_id = ?").run(String(agentId));
  }

  setAnalysis(input) {
    const analyzedAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_appearance_analyses (
        attachment_id, provider, model, animation_spec, prompt, analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(attachment_id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        animation_spec = excluded.animation_spec,
        prompt = excluded.prompt,
        analyzed_at = excluded.analyzed_at
    `).run(
      input.attachmentId,
      input.provider,
      input.model,
      JSON.stringify(input.animationSpec),
      input.prompt,
      analyzedAt,
    );
    return this.getAnalysis(input.attachmentId);
  }

  getAnalysis(attachmentId) {
    const row = this.database
      .prepare("SELECT * FROM agent_appearance_analyses WHERE attachment_id = ?")
      .get(String(attachmentId));
    if (!row) return null;
    try {
      return {
        attachmentId: row.attachment_id,
        provider: row.provider,
        model: row.model,
        animationSpec: parseAnimationSpec(row.animation_spec),
        prompt: row.prompt,
        analyzedAt: row.analyzed_at,
      };
    } catch {
      return null;
    }
  }
}

function publicProfile(row) {
  let referenceAttachmentIds = [];
  try {
    const parsed = JSON.parse(row.reference_attachment_ids);
    if (Array.isArray(parsed)) referenceAttachmentIds = parsed.map(String).filter(Boolean);
  } catch {
    referenceAttachmentIds = [];
  }
  return {
    agentId: row.agent_id,
    role: row.role,
    appearanceAttachmentId: row.appearance_attachment_id,
    referenceAttachmentIds,
    appearancePrompt: row.appearance_prompt,
    animationSpec: storedAnimationSpec(row.animation_spec),
    appearanceModel: row.appearance_model || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storedAnimationSpec(value) {
  try {
    return value ? parseAnimationSpec(value) : DEFAULT_ANIMATION_SPEC;
  } catch {
    return DEFAULT_ANIMATION_SPEC;
  }
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
