import assert from "node:assert/strict";
import test from "node:test";
import { ConsolidationService, stronglyConnectedGroups } from "./consolidation-service.js";

const memories = ["a", "b", "c", "d"].map((id) => ({
  id,
  title: `Memory ${id}`,
  body: `Body ${id}`,
  tags: ["project:jarvis"],
}));

test("consolidation finds dense high-weight groups and ignores weak bridges", () => {
  const groups = stronglyConnectedGroups(memories, [
    { source: "a", target: "b", weight: 0.9, archived: false },
    { source: "b", target: "c", weight: 0.8, archived: false },
    { source: "c", target: "d", weight: 0.3, archived: false },
  ]);
  assert.deepEqual(groups, [["a", "b", "c"]]);
});

test("consolidation summary stays an approval-ready memory proposal", async () => {
  const service = new ConsolidationService({
    runner: {
      run: async () => JSON.stringify({
        title: "Jarvis architecture",
        body: "A summary grounded in the connected memories.",
        tags: ["architecture"],
      }),
    },
  });
  const summary = await service.summarize(memories.slice(0, 3));
  assert.equal(summary.title, "Jarvis architecture");
  assert.deepEqual(summary.links, ["a", "b", "c"]);
  assert.deepEqual(summary.tags, ["summary", "consolidation", "architecture"]);
});

test("approved consolidation memories cannot seed recursive summaries", () => {
  const service = new ConsolidationService({ runner: { run: async () => "" } });
  const summary = {
    id: "summary",
    title: "Summary",
    body: "Summary body",
    tags: ["summary", "consolidation"],
    consolidationMembers: ["a", "b", "c"],
  };
  const groups = service.findGroups([...memories, summary], [
    { source: "a", target: "b", weight: 0.9, archived: false },
    { source: "b", target: "c", weight: 0.9, archived: false },
    { source: "summary", target: "a", weight: 0.9, archived: false },
    { source: "summary", target: "b", weight: 0.9, archived: false },
    { source: "summary", target: "c", weight: 0.9, archived: false },
  ]);

  assert.deepEqual(groups, [["a", "b", "c"]]);
});
