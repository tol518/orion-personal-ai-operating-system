import assert from "node:assert/strict";
import test from "node:test";
import { NeuralConnectionEngine } from "./neural-connection-engine.js";

test("high-confidence Luna relationships connect automatically", async () => {
  const memoryList = [
    {
      id: "a",
      title: "Jarvis project",
      body: "the user builds Jarvis.",
      tags: ["project:jarvis"],
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      connections: [],
    },
    {
      id: "b",
      title: "Jarvis engineering",
      body: "the user develops Jarvis.",
      tags: ["project:jarvis"],
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      connections: [],
    },
  ];
  const embeddingRows = new Map();
  const proposed = [];
  let durableWrites = 0;
  const engine = new NeuralConnectionEngine({
    memories: {
      list: () => memoryList,
      graph: () => ({ edges: [] }),
      replaceConnections: async () => {
        durableWrites += 1;
      },
      addRelationship: async () => {
        durableWrites += 1;
      },
    },
    neuralStore: {
      embeddings: () => embeddingRows,
      upsertEmbedding: (entry) => embeddingRows.set(entry.memoryId, {
        contentHash: entry.contentHash,
        model: entry.model,
        vector: entry.vector,
      }),
      removeMissingEmbeddings: () => {},
      coRetrievalCount: () => 0,
      getState: () => new Date().toISOString(),
      setState: () => {},
    },
    proposalStore: {
      createUnique: (kind, payload) => {
        proposed.push({ kind, payload });
        return { created: true, proposal: { kind, payload } };
      },
      findByFingerprint: () => null,
      list: () => [],
      resolve: () => {},
    },
    classifier: {
      runner: { effectiveContextWindow: null },
      classify: async (_source, candidates) => candidates.map(({ memory }) => ({
        targetId: memory.id,
        relationType: "same_project",
        confidence: 0.95,
        sourceSupersedesTarget: false,
        reason: "Same Jarvis project.",
      })),
    },
    consolidation: { findGroups: () => [] },
    embedding: {
      model: "test-embedding",
      generate: ({ id }) => id === "a" ? [1, 0] : [0.9, 0.1],
    },
    retrieval: {
      limit: 40,
      find: (sourceId) => [{ id: sourceId === "a" ? "b" : "a", semanticSimilarity: 0.99 }],
    },
  });

  const status = await engine.runNow();

  assert.equal(status.lastCreatedCandidates, 1);
  assert.equal(proposed.length, 0);
  assert.equal(durableWrites, 1);
});

test("explicit people and institution mentions connect automatically", async () => {
  const memoryList = [
    {
      id: "sampleContact",
      title: "Sample Contact",
      body: "She's Example User's friend and goes to Northbridge College",
      tags: ["person"],
      createdAt: "2026-07-15T15:24:46.447Z",
      updatedAt: "2026-07-15T15:24:46.447Z",
      connections: [],
    },
    {
      id: "exampleUser",
      title: "Me (Example User)",
      body: "I live in London and work as a software engineer.",
      tags: ["person", "identity"],
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T18:00:22.080Z",
      connections: [],
    },
    {
      id: "northbridge-college",
      title: "Northbridge College",
      body: "A leading UK university.",
      tags: [],
      createdAt: "2026-07-13T14:52:22.387Z",
      updatedAt: "2026-07-13T14:52:22.387Z",
      connections: [],
    },
  ];
  const proposed = [];
  const connected = [];
  const engine = new NeuralConnectionEngine({
    memories: {
      list: () => memoryList,
      graph: () => ({ edges: [] }),
      replaceConnections: async () => {},
      addRelationship: async (fromId, toId, metadata) => {
        connected.push({ fromId, toId, metadata });
      },
    },
    neuralStore: {
      embeddings: () => new Map(),
      upsertEmbedding: () => {},
      removeMissingEmbeddings: () => {},
      coRetrievalCount: () => 0,
      getState: (key) => key === "connectionEngineVersion" ? 2 : new Date().toISOString(),
      setState: () => {},
    },
    proposalStore: {
      createUnique: (kind, payload) => {
        proposed.push({ kind, payload });
        return { created: true, proposal: { kind, payload } };
      },
      findByFingerprint: () => null,
      list: () => [],
      resolve: () => {},
    },
    classifier: {
      runner: { effectiveContextWindow: null },
      classify: async (source, candidates) => source.id === "sampleContact"
        ? candidates.map(({ memory }) => ({
            targetId: memory.id,
            relationType: "related",
            confidence: 0.95,
            sourceSupersedesTarget: false,
            reason: "Explicitly referenced in the description.",
          }))
        : [],
    },
    consolidation: { findGroups: () => [] },
  });

  await engine.runNow();

  const sampleContactTargets = connected
    .filter(({ fromId }) => fromId === "sampleContact")
    .map(({ toId }) => toId)
    .sort();
  assert.deepEqual(sampleContactTargets, ["exampleUser", "northbridge-college"]);
  assert.ok(connected.every(({ metadata }) => metadata.tier === "medium"));
  assert.equal(proposed.length, 0);
});
