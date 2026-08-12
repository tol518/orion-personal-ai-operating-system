import { CONNECTION_THRESHOLDS } from "./connection-scoring.js";

export function edgeKey(source, target, relationType = "related") {
  return `${source}::${target}::${relationType}`;
}

export function isManualEdge(edge) {
  return edge.creationSource === "manual";
}

export function mergeDuplicateEdges(edges) {
  const merged = new Map();
  for (const edge of edges) {
    const key = edgeKey(edge.source, edge.target, edge.relationType);
    const current = merged.get(key);
    if (!current || (isManualEdge(edge) && !isManualEdge(current))) {
      merged.set(key, { ...edge });
      continue;
    }
    if (isManualEdge(current)) continue;
    merged.set(key, {
      ...current,
      weight: Math.max(current.weight, edge.weight),
      confidence: Math.max(current.confidence, edge.confidence),
      activationCount: Math.max(current.activationCount, edge.activationCount),
      lastActivatedAt: [current.lastActivatedAt, edge.lastActivatedAt].filter(Boolean).sort().at(-1) ?? null,
    });
  }
  return [...merged.values()];
}

export function strengthenEdge(edge, { count = 1, now = new Date().toISOString() } = {}) {
  if (isManualEdge(edge) || edge.archived) return edge;
  const activationCount = edge.activationCount + Math.max(1, count);
  const gain = Math.min(0.12, 0.035 * Math.max(1, count));
  return {
    ...edge,
    weight: Math.min(1, edge.weight + gain * (1 - edge.weight)),
    activationCount,
    lastActivatedAt: now,
  };
}

export function decayEdge(
  edge,
  { now = new Date().toISOString(), dailyRate = 0.006, archiveBelow = CONNECTION_THRESHOLDS.archive } = {},
) {
  if (isManualEdge(edge) || edge.archived) return edge;
  const origin = Date.parse(edge.lastActivatedAt || edge.createdAt || now);
  const elapsedDays = Math.max(0, (Date.parse(now) - origin) / 86_400_000);
  if (elapsedDays < 1) return edge;
  const weight = Math.max(0, edge.weight - elapsedDays * dailyRate);
  return { ...edge, weight, archived: weight < archiveBelow };
}

export function markContradiction({ newerId, olderId, confidence }) {
  if (!newerId || !olderId || newerId === olderId) return null;
  return confidence >= CONNECTION_THRESHOLDS.highConfidence
    ? { memoryId: olderId, supersededBy: newerId }
    : null;
}
