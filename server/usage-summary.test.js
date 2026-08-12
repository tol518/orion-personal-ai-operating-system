import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUsageAttribution,
  reportDateBounds,
  summarizeHistoryModelUsage,
  summarizeHistoryUsage,
} from "./usage-summary.js";

test("history totals include cache tokens and only count assistant turns in range", () => {
  const totals = summarizeHistoryUsage(
    [
      { role: "user", timestamp: 15, usage: { totalTokens: 999 } },
      {
        role: "assistant",
        timestamp: 20,
        usage: { input: 10, output: 3, cacheRead: 40, cacheWrite: 2, totalTokens: 55 },
      },
      { role: "assistant", timestamp: 31, usage: { totalTokens: 999 } },
    ],
    10,
    30,
  );

  assert.deepEqual(
    { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, total: totals.totalTokens },
    { input: 10, output: 3, cacheRead: 40, total: 55 },
  );
});

test("history model usage keeps the provider and model needed for pricing", () => {
  const models = summarizeHistoryModelUsage(
    [
      { role: "assistant", timestamp: 20, model: "gpt-5.5", usage: { input: 10 } },
      { role: "assistant", timestamp: 21, model: "gpt-5.5", usage: { output: 2 } },
    ],
    10,
    30,
    { provider: "openai" },
  );
  assert.equal(models.length, 1);
  assert.deepEqual(
    { provider: models[0].provider, model: models[0].model, count: models[0].count },
    { provider: "openai", model: "gpt-5.5", count: 2 },
  );
});

test("attribution supplements missing Codex usage without double-counting gateway rows", () => {
  const report = {
    aggregates: {
      byAgent: [
        { agentId: "main", totals: { input: 10, output: 5, totalTokens: 15 } },
        { agentId: "codex", totals: { input: 3, output: 2, totalTokens: 5 } },
      ],
    },
    sessions: [
      { key: "agent:main:main", agentId: "main", scope: "instance", usage: { totalTokens: 15 } },
      {
        key: "agent:codex:dashboard:native",
        agentId: "codex",
        scope: "instance",
        usage: { totalTokens: 5 },
      },
    ],
  };

  const attribution = buildUsageAttribution(report, [
    { key: "agent:codex:dashboard:native", agentId: "codex", totals: { totalTokens: 5 } },
    {
      key: "agent:codex:dashboard:missing",
      agentId: "codex",
      totals: { input: 7, output: 1, cacheRead: 12, totalTokens: 20 },
    },
  ]);

  assert.equal(attribution.agents.main.totalTokens, 15);
  assert.equal(attribution.agents.codex.totalTokens, 25);
  assert.equal(attribution.combined.totalTokens, 40);
  assert.equal(attribution.sessions.filter((session) => session.agentId === "codex").length, 2);
});

test("report date bounds include the full final UTC day", () => {
  const bounds = reportDateBounds({ startDate: "2026-07-09", endDate: "2026-07-15" });
  assert.equal(bounds?.startMs, Date.parse("2026-07-09T00:00:00.000Z"));
  assert.equal(bounds?.endMs, Date.parse("2026-07-15T23:59:59.999Z"));
});
