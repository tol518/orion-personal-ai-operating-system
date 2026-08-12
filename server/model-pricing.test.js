import test from "node:test";
import assert from "node:assert/strict";
import { applyPricingToUsageReport, estimateModelUsage } from "./model-pricing.js";

test("estimates OpenAI input, cached input, and output independently", () => {
  const result = estimateModelUsage([
    {
      provider: "openai",
      model: "gpt-5.5",
      count: 1,
      totals: { input: 1_000_000, cacheRead: 2_000_000, output: 100_000, totalTokens: 3_100_000 },
    },
  ]);
  assert.equal(result.totals.inputCost, 5);
  assert.equal(result.totals.cacheReadCost, 1);
  assert.equal(result.totals.outputCost, 3);
  assert.equal(result.totals.totalCost, 9);
  assert.equal(result.totals.missingCostEntries, 0);
});

test("uses the standard five-minute Anthropic cache-write rate", () => {
  const result = estimateModelUsage([
    {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      totals: { cacheWrite: 1_000_000, totalTokens: 1_000_000 },
    },
  ]);
  assert.equal(result.totals.cacheWriteCost, 1.25);
  assert.equal(result.totals.totalCost, 1.25);
});

test("marks unknown models as unpriced without inventing a rate", () => {
  const result = estimateModelUsage([
    { provider: "custom", model: "private-model", count: 3, totals: { input: 20, totalTokens: 20 } },
  ]);
  assert.equal(result.totals.totalCost, 0);
  assert.equal(result.totals.missingCostEntries, 3);
  assert.deepEqual(result.unpricedModels, ["custom/private-model"]);
});

test("applies per-session model costs to report and agent totals", () => {
  const { report } = applyPricingToUsageReport({
    totals: { totalTokens: 2_000_000 },
    aggregates: { byAgent: [{ agentId: "codex", totals: { totalTokens: 2_000_000 } }], byModel: [] },
    sessions: [
      {
        key: "agent:codex:test",
        agentId: "codex",
        scope: "instance",
        usage: {
          totalTokens: 2_000_000,
          modelUsage: [
            { provider: "openai", model: "gpt-5.4", count: 1, totals: { input: 1_000_000, output: 1_000_000, totalTokens: 2_000_000 } },
          ],
        },
      },
    ],
  });
  assert.equal(report.sessions[0].usage.totalCost, 17.5);
  assert.equal(report.aggregates.byAgent[0].totals.totalCost, 17.5);
  assert.equal(report.totals.totalCost, 17.5);
});
