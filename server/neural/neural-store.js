import { DatabaseSync } from "node:sqlite";

function pairKey(left, right) {
  return [left, right].sort().join("::");
}

export class NeuralStore {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS neural_memory_embeddings (
        memory_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS neural_co_retrieval (
        pair_key TEXT PRIMARY KEY,
        left_id TEXT NOT NULL,
        right_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        last_retrieved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS neural_engine_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  embeddings() {
    const rows = this.database
      .prepare("SELECT memory_id, content_hash, model, dimensions, vector_json FROM neural_memory_embeddings")
      .all();
    return new Map(rows.map((row) => [row.memory_id, {
      contentHash: row.content_hash,
      model: row.model,
      dimensions: row.dimensions,
      vector: JSON.parse(row.vector_json),
    }]));
  }

  upsertEmbedding({ memoryId, contentHash, model, vector }) {
    this.database.prepare(`
      INSERT INTO neural_memory_embeddings
        (memory_id, content_hash, model, dimensions, vector_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        model = excluded.model,
        dimensions = excluded.dimensions,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at
    `).run(memoryId, contentHash, model, vector.length, JSON.stringify(vector), new Date().toISOString());
  }

  removeMissingEmbeddings(memoryIds) {
    const keep = new Set(memoryIds);
    for (const row of this.database.prepare("SELECT memory_id FROM neural_memory_embeddings").all()) {
      if (!keep.has(row.memory_id)) {
        this.database.prepare("DELETE FROM neural_memory_embeddings WHERE memory_id = ?").run(row.memory_id);
      }
    }
  }

  recordCoRetrieval(memoryIds, now = new Date().toISOString()) {
    const unique = [...new Set(memoryIds.filter(Boolean))];
    for (let leftIndex = 0; leftIndex < unique.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < unique.length; rightIndex += 1) {
        const left = unique[leftIndex];
        const right = unique[rightIndex];
        const [orderedLeft, orderedRight] = [left, right].sort();
        this.database.prepare(`
          INSERT INTO neural_co_retrieval
            (pair_key, left_id, right_id, count, last_retrieved_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(pair_key) DO UPDATE SET
            count = neural_co_retrieval.count + 1,
            last_retrieved_at = excluded.last_retrieved_at
        `).run(pairKey(left, right), orderedLeft, orderedRight, now);
      }
    }
  }

  coRetrievalCount(left, right) {
    const row = this.database
      .prepare("SELECT count FROM neural_co_retrieval WHERE pair_key = ?")
      .get(pairKey(left, right));
    return Number(row?.count ?? 0);
  }

  setState(key, value) {
    this.database.prepare(`
      INSERT INTO neural_engine_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getState(key, fallback = null) {
    const row = this.database.prepare("SELECT value_json FROM neural_engine_state WHERE key = ?").get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }
}
