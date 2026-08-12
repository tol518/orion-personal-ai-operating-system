import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class ProposalStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('memory', 'relationship')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        session_key TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `);
  }

  create(kind, payload, sessionKey = null) {
    if (kind !== "memory" && kind !== "relationship") throw new Error("invalid proposal kind");
    const proposal = {
      id: randomUUID(),
      kind,
      payload,
      status: "pending",
      sessionKey,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO memory_proposals
          (id, kind, payload_json, status, session_key, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.kind,
        JSON.stringify(proposal.payload),
        proposal.status,
        proposal.sessionKey,
        proposal.createdAt,
        proposal.resolvedAt,
      );
    return proposal;
  }

  createUnique(kind, payload, sessionKey = null) {
    const fingerprint = String(payload?.fingerprint ?? "").trim();
    if (!fingerprint) return { proposal: this.create(kind, payload, sessionKey), created: true };
    const existing = this.findByFingerprint(kind, fingerprint);
    if (existing) return { proposal: existing, created: false };
    return { proposal: this.create(kind, payload, sessionKey), created: true };
  }

  findByFingerprint(kind, fingerprint) {
    return this.#all().find(
      (proposal) => proposal.kind === kind && proposal.payload?.fingerprint === fingerprint,
    ) ?? null;
  }

  list(status = "pending") {
    const rows = this.database
      .prepare(
        `SELECT id, kind, payload_json, status, session_key, created_at, resolved_at
         FROM memory_proposals
         WHERE status = ?
         ORDER BY created_at DESC`,
      )
      .all(status);
    return rows.map(toProposal);
  }

  get(id) {
    const row = this.database
      .prepare(
        `SELECT id, kind, payload_json, status, session_key, created_at, resolved_at
         FROM memory_proposals WHERE id = ?`,
      )
      .get(id);
    return row ? toProposal(row) : null;
  }

  resolve(id, status) {
    if (status !== "approved" && status !== "rejected") throw new Error("invalid proposal status");
    const current = this.get(id);
    if (!current) throw Object.assign(new Error("proposal not found"), { statusCode: 404 });
    if (current.status !== "pending") {
      throw Object.assign(new Error("proposal has already been resolved"), { statusCode: 409 });
    }
    const resolvedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE memory_proposals SET status = ?, resolved_at = ? WHERE id = ?")
      .run(status, resolvedAt, id);
    return { ...current, status, resolvedAt };
  }

  #all() {
    return this.database
      .prepare(
        `SELECT id, kind, payload_json, status, session_key, created_at, resolved_at
         FROM memory_proposals
         ORDER BY created_at DESC`,
      )
      .all()
      .map(toProposal);
  }
}

function toProposal(row) {
  return {
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    sessionKey: row.session_key,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
