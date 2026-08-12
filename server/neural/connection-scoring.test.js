import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTION_THRESHOLDS, scoreConnection } from "./connection-scoring.js";

const source = {
  title: "Project Jarvis London",
  body: "Example User builds Jarvis in London.",
  tags: ["project:jarvis", "software"],
  updatedAt: "2026-07-15T00:00:00.000Z",
};

test("connection scoring combines semantic, entity, topic, project, time, and co-retrieval signals", () => {
  const related = scoreConnection({
    source,
    target: {
      title: "Jarvis Engineering",
      body: "Example User maintains Jarvis from London.",
      tags: ["project:jarvis", "software"],
      updatedAt: "2026-07-14T00:00:00.000Z",
    },
    semanticSimilarity: 0.9,
    coRetrievalCount: 7,
  });
  const unrelated = scoreConnection({
    source,
    target: {
      title: "Cooking notes",
      body: "A recipe for soup.",
      tags: ["food"],
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
    semanticSimilarity: 0.05,
  });

  assert.ok(related.score > CONNECTION_THRESHOLDS.highConfidence);
  assert.equal(related.factors.projectContext, 1);
  assert.equal(related.factors.coRetrieval, 1);
  assert.ok(unrelated.score < CONNECTION_THRESHOLDS.strongestCandidate);
});

test("thresholds distinguish accepted medium results from high-confidence results", () => {
  assert.ok(CONNECTION_THRESHOLDS.strongestCandidate < CONNECTION_THRESHOLDS.mediumConfidence);
  assert.ok(CONNECTION_THRESHOLDS.mediumConfidence < CONNECTION_THRESHOLDS.highConfidence);
  assert.equal(CONNECTION_THRESHOLDS.maxAutomaticPerNode, 8);
  assert.equal(CONNECTION_THRESHOLDS.maxLlmCandidates, 10);
});

test("explicit description references reach the neural shortlist threshold", () => {
  const sampleContact = {
    title: "Sample Contact",
    body: "She's Example User's friend and goes to Northbridge College",
    tags: ["person"],
    updatedAt: "2026-07-15T15:24:46.447Z",
  };
  const exampleUser = scoreConnection({
    source: sampleContact,
    target: {
      title: "Me (Example User)",
      body: "I live in London and work as a software engineer.",
      tags: ["person", "identity"],
      updatedAt: "2026-07-13T18:00:22.080Z",
    },
    semanticSimilarity: 0.12,
  });
  const universityMatch = scoreConnection({
    source: sampleContact,
    target: {
      title: "Northbridge College",
      body: "A leading UK university.",
      tags: [],
      updatedAt: "2026-07-13T14:52:22.387Z",
    },
    semanticSimilarity: 0.18,
  });

  assert.equal(exampleUser.factors.explicitReference, 1);
  assert.equal(universityMatch.factors.explicitReference, 1);
  assert.ok(exampleUser.score >= CONNECTION_THRESHOLDS.strongestCandidate);
  assert.ok(universityMatch.score >= CONNECTION_THRESHOLDS.strongestCandidate);
});
