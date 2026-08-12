import assert from "node:assert/strict";
import test from "node:test";
import { CandidateRetrievalService } from "./candidate-retrieval.js";
import { cosineSimilarity, EmbeddingService, memoryContentHash } from "./embedding-service.js";

test("generates stable normalized embeddings for every memory", () => {
  const service = new EmbeddingService();
  const memory = {
    title: "Software engineering career",
    body: "the user works as a developer in London.",
    tags: ["identity", "work"],
    createdAt: "2026-07-15T00:00:00.000Z",
  };
  const first = service.generate(memory);
  const second = service.generate(memory);
  const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));

  assert.equal(first.length, 384);
  assert.deepEqual(first, second);
  assert.ok(Math.abs(norm - 1) < 1e-10);
  assert.equal(cosineSimilarity(first, second), 1);
  assert.equal(memoryContentHash(memory), memoryContentHash({ ...memory }));
});

test("candidate retrieval returns the strongest semantic matches and clamps its limit", () => {
  const service = new CandidateRetrievalService({ limit: 100 });
  const embeddings = new Map([
    ["source", [1, 0]],
    ["strong", [0.9, 0.1]],
    ["weak", [0.1, 0.9]],
  ]);

  assert.equal(service.limit, 50);
  assert.deepEqual(service.find("source", embeddings).map(({ id }) => id), ["strong", "weak"]);
});
