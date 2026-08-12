import { addUsageTotals, emptyUsageTotals, normalizeUsageTotals } from "./usage-summary.js";

const MILLION = 1_000_000;

export const PRICING_METADATA = {
  currency: "USD",
  estimated: true,
  verifiedAt: "2026-07-15",
  sources: [
    { provider: "openai", url: "https://developers.openai.com/api/docs/models" },
    { provider: "anthropic", url: "https://www.anthropic.com/pricing" },
    { provider: "google", url: "https://ai.google.dev/gemini-api/docs/pricing" },
  ],
  assumptions: [
    "Standard pay-as-you-go API rates in USD",
    "Anthropic cache writes use the standard 5-minute cache rate",
    "Regional, batch, priority, and long-context adjustments are not included",
  ],
};

const RATES = new Map(
  [
    ["openai/gpt-5.4", 2.5, 0.25, 15],
    ["openai/gpt-5.4-mini", 0.75, 0.075, 4.5],
    ["openai/gpt-5.5", 5, 0.5, 30],
    ["openai/gpt-5.6", 5, 0.5, 30, 6.25],
    ["openai/gpt-5.6-sol", 5, 0.5, 30, 6.25],
    ["openai/gpt-5.6-terra", 2.5, 0.25, 15, 3.125],
    ["openai/gpt-5.6-luna", 1, 0.1, 6],
    ["anthropic/claude-haiku-4-5", 1, 0.1, 5, 1.25],
    ["google/gemini-3.5-flash", 1.5, 0.15, 9],
  ].map(([key, input, cacheRead, output, cacheWrite]) => [
    key,
    { input, cacheRead, output, ...(cacheWrite === undefined ? {} : { cacheWrite }) },
  ]),
);

function normalizedKey(provider, model) {
  const rawProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  let rawModel = typeof model === "string" ? model.trim().toLowerCase() : "";
  let inferredProvider = rawProvider;
  if (rawModel.includes("/")) {
    const [prefix, ...rest] = rawModel.split("/");
    inferredProvider ||= prefix;
    rawModel = rest.join("/");
  }
  if (inferredProvider === "openai-codex") inferredProvider = "openai";
  if (inferredProvider === "google-gemini") inferredProvider = "google";
  return `${inferredProvider}/${rawModel}`;
}

function componentCost(tokens, rate) {
  return rate === undefined ? 0 : (tokens * rate) / MILLION;
}

export function estimateModelUsage(entries) {
  let totals = emptyUsageTotals();
  const pricedModels = new Set();
  const unpricedModels = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const usage = normalizeUsageTotals(entry?.totals);
    if (usage.totalTokens <= 0) continue;
    const key = normalizedKey(entry?.provider, entry?.model);
    const rate = RATES.get(key);
    const missingComponentRate =
      !rate ||
      (usage.input > 0 && rate.input === undefined) ||
      (usage.output > 0 && rate.output === undefined) ||
      (usage.cacheRead > 0 && rate.cacheRead === undefined) ||
      (usage.cacheWrite > 0 && rate.cacheWrite === undefined);
    if (missingComponentRate) unpricedModels.add(key);
    if (!rate) {
      const missing = { ...usage, missingCostEntries: Math.max(1, Number(entry?.count) || 1) };
      totals = addUsageTotals(totals, missing);
      continue;
    }

    pricedModels.add(key);
    const inputCost = componentCost(usage.input, rate.input);
    const outputCost = componentCost(usage.output, rate.output);
    const cacheReadCost = componentCost(usage.cacheRead, rate.cacheRead);
    const cacheWriteCost = componentCost(usage.cacheWrite, rate.cacheWrite);
    totals = addUsageTotals(totals, {
      ...usage,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWriteCost,
      totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
      missingCostEntries: missingComponentRate ? Math.max(1, Number(entry?.count) || 1) : 0,
    });
  }

  return {
    totals,
    pricedModels: [...pricedModels].toSorted(),
    unpricedModels: [...unpricedModels].toSorted(),
  };
}

function costOnly(totals) {
  const value = normalizeUsageTotals(totals);
  return {
    totalCost: value.totalCost,
    inputCost: value.inputCost,
    outputCost: value.outputCost,
    cacheReadCost: value.cacheReadCost,
    cacheWriteCost: value.cacheWriteCost,
    missingCostEntries: value.missingCostEntries,
  };
}

export function applyPricingToUsageReport(report) {
  const agentCosts = new Map();
  let reportCosts = emptyUsageTotals();
  const pricedModels = new Set();
  const unpricedModels = new Set();

  const sessions = (report?.sessions ?? []).map((session) => {
    const estimate = estimateModelUsage(session?.usage?.modelUsage);
    for (const model of estimate.pricedModels) pricedModels.add(model);
    for (const model of estimate.unpricedModels) unpricedModels.add(model);
    const usage = { ...session.usage, ...costOnly(estimate.totals) };
    if (session.scope !== "family") {
      reportCosts = addUsageTotals(reportCosts, costOnly(estimate.totals));
      if (session.agentId) {
        agentCosts.set(
          session.agentId,
          addUsageTotals(agentCosts.get(session.agentId), costOnly(estimate.totals)),
        );
      }
    }
    return { ...session, usage };
  });

  const byAgent = (report?.aggregates?.byAgent ?? []).map((entry) => ({
    ...entry,
    totals: { ...entry.totals, ...costOnly(agentCosts.get(entry.agentId)) },
  }));
  const byModel = (report?.aggregates?.byModel ?? []).map((entry) => ({
    ...entry,
    totals: { ...entry.totals, ...costOnly(estimateModelUsage([entry]).totals) },
  }));

  return {
    report: {
      ...report,
      sessions,
      totals: { ...report?.totals, ...costOnly(reportCosts) },
      aggregates: { ...report?.aggregates, byAgent, byModel },
    },
    pricing: {
      ...PRICING_METADATA,
      pricedModels: [...pricedModels].toSorted(),
      unpricedModels: [...unpricedModels].toSorted(),
    },
  };
}
