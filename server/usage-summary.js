const TOTAL_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "totalCost",
  "inputCost",
  "outputCost",
  "cacheReadCost",
  "cacheWriteCost",
  "missingCostEntries",
];

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptyUsageTotals() {
  return Object.fromEntries(TOTAL_FIELDS.map((field) => [field, 0]));
}

export function normalizeUsageTotals(value) {
  const source = value && typeof value === "object" ? value : {};
  const totals = emptyUsageTotals();
  for (const field of TOTAL_FIELDS) totals[field] = finiteNumber(source[field]);

  const componentTotal = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  if (totals.totalTokens === 0 && componentTotal > 0) totals.totalTokens = componentTotal;

  const nestedCost = finiteNumber(source.cost?.total);
  if (totals.totalCost === 0 && nestedCost > 0) totals.totalCost = nestedCost;
  return totals;
}

export function addUsageTotals(left, right) {
  const sum = emptyUsageTotals();
  const a = normalizeUsageTotals(left);
  const b = normalizeUsageTotals(right);
  for (const field of TOTAL_FIELDS) sum[field] = a[field] + b[field];
  return sum;
}

export function summarizeHistoryUsage(messages, startMs, endMs) {
  let totals = emptyUsageTotals();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "assistant" || !message.usage) continue;
    const timestamp = finiteNumber(message.timestamp);
    if (timestamp < startMs || timestamp > endMs) continue;
    totals = addUsageTotals(totals, message.usage);
  }
  return totals;
}

export function summarizeHistoryModelUsage(messages, startMs, endMs, fallback = {}) {
  const models = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "assistant" || !message.usage) continue;
    const timestamp = finiteNumber(message.timestamp);
    if (timestamp < startMs || timestamp > endMs) continue;
    const provider = message.provider ?? fallback.provider;
    const model = message.model ?? fallback.model;
    const key = `${provider ?? "unknown"}::${model ?? "unknown"}`;
    const current = models.get(key) ?? { provider, model, count: 0, totals: emptyUsageTotals() };
    current.count += 1;
    current.totals = addUsageTotals(current.totals, message.usage);
    models.set(key, current);
  }
  return [...models.values()];
}

function agentIdFromSessionKey(key) {
  if (key === "main" || key === "global") return "main";
  return typeof key === "string" ? /^agent:([^:]+):/.exec(key)?.[1] ?? null : null;
}

export function buildUsageAttribution(report, supplementalSessions = []) {
  const baseAgents = new Map(
    (report?.aggregates?.byAgent ?? []).map((entry) => [
      entry.agentId,
      normalizeUsageTotals(entry.totals),
    ]),
  );
  const sessionTotals = [];
  const baseSessionKeys = new Set();

  for (const session of report?.sessions ?? []) {
    if (session.scope === "family" || !session.key) continue;
    const agentId = session.agentId ?? agentIdFromSessionKey(session.key);
    if (!agentId) continue;
    baseSessionKeys.add(session.key);
    sessionTotals.push({
      key: session.key,
      agentId,
      totals: normalizeUsageTotals(session.usage),
      source: "gateway",
    });
  }

  for (const session of supplementalSessions) {
    if (!session?.key || baseSessionKeys.has(session.key)) continue;
    const agentId = session.agentId ?? agentIdFromSessionKey(session.key);
    if (!agentId) continue;
    const totals = normalizeUsageTotals(session.totals);
    baseAgents.set(agentId, addUsageTotals(baseAgents.get(agentId), totals));
    sessionTotals.push({ key: session.key, agentId, totals, source: "history" });
  }

  const main = normalizeUsageTotals(baseAgents.get("main"));
  const codex = normalizeUsageTotals(baseAgents.get("codex"));
  return {
    basis: "provider-processed",
    includesCache: true,
    agents: { main, codex },
    combined: addUsageTotals(main, codex),
    sessions: sessionTotals,
  };
}

export function reportDateBounds(report) {
  const startMs = Date.parse(`${report?.startDate ?? ""}T00:00:00.000Z`);
  const endStartMs = Date.parse(`${report?.endDate ?? ""}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endStartMs)) return null;
  return { startMs, endMs: endStartMs + 24 * 60 * 60 * 1000 - 1 };
}
