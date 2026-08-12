import { cosineSimilarity } from "./embedding-service.js";
import { explicitReferenceStrength } from "./reference-matching.js";

export class CandidateRetrievalService {
  constructor({ limit = 40 } = {}) {
    this.limit = Math.max(30, Math.min(50, limit));
  }

  find(sourceId, embeddings, memories = []) {
    const source = embeddings.get(sourceId);
    if (!source) return [];
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    const sourceMemory = byId.get(sourceId);
    return [...embeddings.entries()]
      .filter(([id]) => id !== sourceId)
      .map(([id, vector]) => ({
        id,
        semanticSimilarity: cosineSimilarity(source, vector),
        explicitReference: sourceMemory && byId.has(id)
          ? explicitReferenceStrength(sourceMemory, byId.get(id))
          : 0,
      }))
      // Named people, organizations, and places must survive the semantic shortlist.
      .sort((left, right) =>
        right.explicitReference - left.explicitReference ||
        right.semanticSimilarity - left.semanticSimilarity
      )
      .slice(0, this.limit);
  }
}
