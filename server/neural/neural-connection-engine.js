import { CandidateRetrievalService } from "./candidate-retrieval.js";
import { CONNECTION_THRESHOLDS, scoreConnection } from "./connection-scoring.js";
import { decayEdge, markContradiction, strengthenEdge } from "./edge-lifecycle.js";
import { EmbeddingService, memoryContentHash } from "./embedding-service.js";
import { LUNA_CONTEXT_WINDOW, LUNA_MODEL } from "./relation-classifier.js";

const CONNECTION_ENGINE_VERSION = 4;

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function relationshipFingerprint(source, target, relationType, contentHash) {
  return `neural:${source}:${target}:${relationType}:${contentHash.slice(0, 16)}`;
}

function approvedPairKeys(memories) {
  const keys = new Set();
  for (const memory of memories) {
    for (const connection of memory.connections ?? []) {
      if (connection.archived) continue;
      keys.add([connection.source, connection.target].sort().join("::"));
    }
  }
  return keys;
}

function connectedNodeIds(memories) {
  const ids = new Set();
  for (const memory of memories) {
    for (const connection of memory.connections ?? []) {
      if (connection.archived) continue;
      ids.add(connection.source);
      ids.add(connection.target);
    }
  }
  return ids;
}

export class NeuralConnectionEngine {
  constructor({
    memories,
    neuralStore,
    proposalStore,
    classifier,
    consolidation,
    embedding = new EmbeddingService(),
    retrieval = new CandidateRetrievalService({ limit: 40 }),
    onChange = () => {},
    intervalMs = 15 * 60_000,
  }) {
    this.memories = memories;
    this.neuralStore = neuralStore;
    this.proposalStore = proposalStore;
    this.classifier = classifier;
    this.consolidation = consolidation;
    this.embedding = embedding;
    this.retrieval = retrieval;
    this.onChange = onChange;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = null;
    this.lastRunAt = null;
    this.lastError = null;
    this.lastCreatedCandidates = 0;
  }

  status() {
    return {
      enabled: true,
      running: Boolean(this.running),
      model: LUNA_MODEL,
      authentication: "codex-oauth",
      contextWindow: this.classifier.runner.effectiveContextWindow ?? LUNA_CONTEXT_WINDOW,
      advertisedContextWindow: LUNA_CONTEXT_WINDOW,
      embeddingModel: this.embedding.model,
      candidateLimit: this.retrieval.limit,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastCreatedCandidates: this.lastCreatedCandidates,
    };
  }

  async start() {
    await this.runNow().catch(() => undefined);
    this.timer = setInterval(() => this.runNow().catch(() => undefined), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  runNow() {
    if (this.running) return this.running;
    this.running = this.#reconcile();
    return this.running.finally(() => {
      this.running = null;
    });
  }

  async #reconcile() {
    try {
      let memories = this.memories.list();
      let created = await this.#approvePendingNeuralRelationships();
      if (created) memories = this.memories.list();
      const existing = this.neuralStore.embeddings();
      const engineReady = this.neuralStore.getState("connectionEngineVersion") === CONNECTION_ENGINE_VERSION;
      const changed = [];
      const embeddings = new Map();
      for (const memory of memories) {
        const contentHash = memoryContentHash(memory);
        const cached = existing.get(memory.id);
        const cacheMatches = cached?.contentHash === contentHash && cached.model === this.embedding.model;
        const vector = cacheMatches ? cached.vector : this.embedding.generate(memory);
        embeddings.set(memory.id, vector);
        if (engineReady && cacheMatches) continue;
        changed.push({
          memoryId: memory.id,
          contentHash,
          model: this.embedding.model,
          vector,
        });
      }
      this.neuralStore.removeMissingEmbeddings(memories.map((memory) => memory.id));
      const consideredPairs = approvedPairKeys(memories);
      const connectedIds = connectedNodeIds(memories);
      const isolatedIds = new Set(
        memories.length > 1
          ? memories.filter((memory) => !connectedIds.has(memory.id)).map((memory) => memory.id)
          : [],
      );
      const workIds = [...new Set([...isolatedIds, ...changed.map((entry) => entry.memoryId)])];
      for (const memoryId of workIds) {
        created += await this.#discoverForMemory(
          memoryId,
          memories,
          embeddings,
          consideredPairs,
          isolatedIds.has(memoryId) && !connectedIds.has(memoryId),
          connectedIds,
        );
      }
      await this.#decayIfDue(memories);
      if (changed.length) created += await this.#consolidate(memories);
      // A failed Luna pass must remain retryable, so content hashes commit only after reconciliation succeeds.
      for (const entry of changed) this.neuralStore.upsertEmbedding(entry);
      this.neuralStore.setState("connectionEngineVersion", CONNECTION_ENGINE_VERSION);
      this.lastRunAt = new Date().toISOString();
      this.lastError = null;
      this.lastCreatedCandidates = created;
      this.onChange({ status: this.status(), proposalsChanged: created > 0 });
      return this.status();
    } catch (error) {
      this.lastRunAt = new Date().toISOString();
      this.lastError = error instanceof Error ? error.message : String(error);
      this.onChange({ status: this.status(), proposalsChanged: false });
      throw error;
    }
  }

  async #discoverForMemory(
    sourceId,
    memories,
    embeddings,
    consideredPairs,
    ensureConnection = false,
    connectedIds = new Set(),
  ) {
    const byId = new Map(memories.map((memory) => [memory.id, memory]));
    const source = byId.get(sourceId);
    if (!source) return 0;
    const automaticDegree = memories.reduce(
      (count, memory) => count + (memory.connections ?? []).filter(
        (edge) => !edge.archived && edge.creationSource !== "manual" &&
          (edge.source === sourceId || edge.target === sourceId),
      ).length,
      0,
    );
    const remaining = Math.max(0, CONNECTION_THRESHOLDS.maxAutomaticPerNode - automaticDegree);
    if (!remaining) return 0;

    const allScored = this.retrieval.find(sourceId, embeddings, memories).flatMap((candidate) => {
      const memory = byId.get(candidate.id);
      if (!memory) return [];
      const pair = [sourceId, memory.id].sort().join("::");
      if (consideredPairs.has(pair)) return [];
      const result = scoreConnection({
        source,
        target: memory,
        semanticSimilarity: candidate.semanticSimilarity,
        coRetrievalCount: this.neuralStore.coRetrievalCount(sourceId, memory.id),
      });
      return [{ memory, ...result }];
    }).sort((left, right) => right.score - left.score);
    const scored = (ensureConnection
      ? allScored
      : allScored.filter(({ score }) => score >= CONNECTION_THRESHOLDS.strongestCandidate))
      .slice(0, Math.min(remaining, CONNECTION_THRESHOLDS.maxLlmCandidates));

    // A relationship pair is classified once per reconciliation. This avoids reverse duplicate
    // proposals when both memories are new while retaining the newest memory as the source.
    for (const candidate of scored) {
      consideredPairs.add([sourceId, candidate.memory.id].sort().join("::"));
    }

    const classifications = await this.classifier.classify(source, scored);
    const classifiedById = new Map(classifications.map((item) => [item.targetId, item]));
    let created = 0;
    for (const candidate of scored) {
      const classification = classifiedById.get(candidate.memory.id);
      if (!classification || classification.relationType === "unrelated") continue;
      const combined = candidate.score * 0.55 + classification.confidence * 0.45;
      if (combined < CONNECTION_THRESHOLDS.mediumConfidence) continue;
      const tier = combined >= CONNECTION_THRESHOLDS.highConfidence ? "high" : "medium";
      // Every relation that clears the medium threshold is safe to connect automatically.
      // Contradictions stay gated because approval may also supersede an existing memory.
      const autoConnect = classification.relationType !== "contradicts";
      const contradiction = classification.relationType === "contradicts" && classification.sourceSupersedesTarget
        ? markContradiction({
            newerId: source.id,
            olderId: candidate.memory.id,
            confidence: combined,
          })
        : null;
      const fingerprint = relationshipFingerprint(
        source.id,
        candidate.memory.id,
        classification.relationType,
        memoryContentHash(source),
      );
      const relationship = {
        fingerprint,
        fromId: source.id,
        toId: candidate.memory.id,
        label: classification.relationType,
        relationType: classification.relationType,
        weight: Number(combined.toFixed(4)),
        confidence: Number(classification.confidence.toFixed(4)),
        creationSource: "neural-luna",
        activationCount: 0,
        lastActivatedAt: null,
        tier,
        reason: classification.reason,
        scoreFactors: candidate.factors,
        ...(contradiction ? { supersedesId: contradiction.memoryId } : {}),
      };
      if (autoConnect) {
        await this.memories.addRelationship(source.id, candidate.memory.id, relationship);
        connectedIds.add(source.id);
        connectedIds.add(candidate.memory.id);
        const pending = this.proposalStore.findByFingerprint("relationship", fingerprint);
        if (pending?.status === "pending") this.proposalStore.resolve(pending.id, "approved");
        created += 1;
        continue;
      }
      const result = this.proposalStore.createUnique(
        "relationship",
        relationship,
        "neural-memory-engine",
      );
      if (result.created) created += 1;
    }
    if (ensureConnection && created === 0 && allScored.length > 0) {
      const candidate = allScored[0];
      const semanticSimilarity = candidate.factors.semanticSimilarity;
      const relationship = {
        fingerprint: relationshipFingerprint(
          source.id,
          candidate.memory.id,
          "nearest_neighbor",
          memoryContentHash(source),
        ),
        fromId: source.id,
        toId: candidate.memory.id,
        label: "nearest_neighbor",
        relationType: "nearest_neighbor",
        weight: Number(Math.max(CONNECTION_THRESHOLDS.nearestNeighborFloor, candidate.score).toFixed(4)),
        confidence: Number(Math.max(0.2, semanticSimilarity).toFixed(4)),
        creationSource: "neural-nearest-neighbor",
        activationCount: 0,
        lastActivatedAt: null,
        reason: "Strongest available semantic neighbor; retained so this memory stays reachable in the graph.",
        scoreFactors: candidate.factors,
      };
      await this.memories.addRelationship(source.id, candidate.memory.id, relationship);
      connectedIds.add(source.id);
      connectedIds.add(candidate.memory.id);
      created += 1;
    }
    return created;
  }

  async #approvePendingNeuralRelationships() {
    const pending = this.proposalStore.list?.("pending") ?? [];
    let approved = 0;
    for (const proposal of pending) {
      const payload = proposal.payload ?? {};
      const isNeuralRelationship = proposal.kind === "relationship" &&
        payload.creationSource === "neural-luna" &&
        (payload.tier === "medium" || payload.tier === "high");
      if (!isNeuralRelationship || payload.relationType === "contradicts") continue;
      await this.memories.addRelationship(payload.fromId, payload.toId, payload);
      this.proposalStore.resolve(proposal.id, "approved");
      approved += 1;
    }
    return approved;
  }

  async #consolidate(memories) {
    const groups = this.consolidation.findGroups(memories, this.memories.graph().edges);
    let created = 0;
    for (const group of groups.slice(0, 2)) {
      const fingerprint = `consolidation:${group.join(":")}`;
      if (this.proposalStore.findByFingerprint("memory", fingerprint)) continue;
      const groupMemories = group.map((id) => memories.find((memory) => memory.id === id)).filter(Boolean);
      const summary = await this.consolidation.summarize(groupMemories);
      const result = this.proposalStore.createUnique(
        "memory",
        { fingerprint, ...summary },
        "neural-memory-engine",
      );
      if (result.created) created += 1;
    }
    return created;
  }

  recordRetrieval(memoryIds) {
    this.neuralStore.recordCoRetrieval(memoryIds);
  }

  async recordActivation(memoryIds) {
    const ids = new Set(memoryIds);
    if (ids.size < 2) return;
    this.neuralStore.recordCoRetrieval([...ids]);
    for (const memory of this.memories.list()) {
      const next = (memory.connections ?? []).map((edge) =>
        ids.has(edge.source) && ids.has(edge.target) ? strengthenEdge(edge) : edge,
      );
      if (!sameJson(next, memory.connections)) {
        await this.memories.replaceConnections(memory.id, next, "activate");
      }
    }
  }

  async #decayIfDue(memories) {
    const lastDecayAt = this.neuralStore.getState("lastDecayAt");
    const now = new Date();
    if (lastDecayAt && now.valueOf() - Date.parse(lastDecayAt) < 86_400_000) return;
    const nowIso = now.toISOString();
    for (const memory of memories) {
      const next = (memory.connections ?? []).map((edge) => decayEdge(edge, { now: nowIso }));
      if (!sameJson(next, memory.connections)) {
        await this.memories.replaceConnections(memory.id, next, "decay");
      }
    }
    this.neuralStore.setState("lastDecayAt", nowIso);
  }
}
