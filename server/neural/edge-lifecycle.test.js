import assert from "node:assert/strict";
import test from "node:test";
import {
  decayEdge,
  markContradiction,
  mergeDuplicateEdges,
  strengthenEdge,
} from "./edge-lifecycle.js";

function edge(overrides = {}) {
  return {
    source: "a",
    target: "b",
    relationType: "supports",
    weight: 0.6,
    confidence: 0.7,
    creationSource: "neural-luna",
    activationCount: 0,
    lastActivatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

test("duplicate edges merge without replacing protected manual edges", () => {
  const automatic = edge({ weight: 0.82 });
  const duplicate = edge({ weight: 0.91, confidence: 0.9 });
  const manual = edge({ creationSource: "manual", weight: 1, confidence: 1 });

  assert.deepEqual(mergeDuplicateEdges([automatic, duplicate]), [
    edge({ weight: 0.91, confidence: 0.9 }),
  ]);
  assert.deepEqual(mergeDuplicateEdges([automatic, manual, duplicate]), [manual]);
});

test("co-activation strengthens automatic edges and records usage", () => {
  const strengthened = strengthenEdge(edge(), {
    count: 2,
    now: "2026-07-15T10:00:00.000Z",
  });
  assert.ok(strengthened.weight > 0.6);
  assert.equal(strengthened.activationCount, 2);
  assert.equal(strengthened.lastActivatedAt, "2026-07-15T10:00:00.000Z");
  assert.equal(strengthenEdge(edge({ creationSource: "manual" })).weight, 0.6);
});

test("weak unused automatic edges decay and archive while manual edges remain unchanged", () => {
  const weak = edge({ weight: 0.21, createdAt: "2026-01-01T00:00:00.000Z" });
  const decayed = decayEdge(weak, {
    now: "2026-02-01T00:00:00.000Z",
    dailyRate: 0.001,
    archiveBelow: 0.2,
  });
  assert.equal(decayed.archived, true);
  assert.ok(decayed.weight < 0.2);
  assert.deepEqual(decayEdge(edge({ creationSource: "manual" })), edge({ creationSource: "manual" }));
});

test("only high-confidence contradictions supersede an older memory", () => {
  assert.deepEqual(markContradiction({ newerId: "new", olderId: "old", confidence: 0.9 }), {
    memoryId: "old",
    supersededBy: "new",
  });
  assert.equal(markContradiction({ newerId: "new", olderId: "old", confidence: 0.7 }), null);
  assert.equal(markContradiction({ newerId: "same", olderId: "same", confidence: 1 }), null);
});
