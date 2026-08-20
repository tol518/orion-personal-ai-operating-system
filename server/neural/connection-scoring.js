import { explicitReferenceStrength } from "./reference-matching.js";

const WORD = /[\p{L}\p{N}]+/gu;
const ENTITY = /\b[\p{Lu}][\p{L}'-]+(?:\s+[\p{Lu}][\p{L}'-]+){0,3}\b/gu;
const PROJECT_TAG = /^(?:project|context|workspace)[:/-](.+)$/i;

const WEIGHTS = Object.freeze({
  semanticSimilarity: 0.34,
  explicitReference: 0.28,
  sharedEntities: 0.12,
  sharedTopics: 0.1,
  projectContext: 0.06,
  temporalCloseness: 0.04,
  coRetrieval: 0.06,
});

function normalizedSet(values) {
  return new Set(values.map((value) => String(value).trim().toLocaleLowerCase("en")).filter(Boolean));
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const value of left) if (right.has(value)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function entities(memory) {
  const text = `${memory.title ?? ""}\n${memory.body ?? ""}`;
  return normalizedSet(text.match(ENTITY) ?? []);
}

function topics(memory) {
  const tags = Array.isArray(memory.tags) ? memory.tags : [];
  const titleWords = String(memory.title ?? "").match(WORD) ?? [];
  return normalizedSet([...tags, ...titleWords.filter((word) => word.length > 3)]);
}

function projectContexts(memory) {
  const result = [];
  for (const tag of memory.tags ?? []) {
    const match = String(tag).match(PROJECT_TAG);
    if (match) result.push(match[1]);
  }
  return normalizedSet(result);
}

function temporalCloseness(left, right) {
  const leftTime = Date.parse(left.updatedAt || left.createdAt || "");
  const rightTime = Date.parse(right.updatedAt || right.createdAt || "");
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
  const days = Math.abs(leftTime - rightTime) / 86_400_000;
  return Math.exp(-days / 180);
}

export function scoreConnection({ source, target, semanticSimilarity, coRetrievalCount = 0 }) {
  const factors = {
    semanticSimilarity: Math.max(0, Math.min(1, semanticSimilarity)),
    explicitReference: explicitReferenceStrength(source, target),
    sharedEntities: overlap(entities(source), entities(target)),
    sharedTopics: overlap(topics(source), topics(target)),
    projectContext: overlap(projectContexts(source), projectContexts(target)),
    temporalCloseness: temporalCloseness(source, target),
    coRetrieval: Math.min(1, Math.log1p(Math.max(0, coRetrievalCount)) / Math.log(8)),
  };
  const score = Object.entries(WEIGHTS).reduce(
    (sum, [factor, weight]) => sum + factors[factor] * weight,
    0,
  );
  return { score: Math.max(0, Math.min(1, score)), factors };
}

export const CONNECTION_THRESHOLDS = Object.freeze({
  strongestCandidate: 0.34,
  mediumConfidence: 0.58,
  highConfidence: 0.82,
  archive: 0.2,
  nearestNeighborFloor: 0.35,
  maxAutomaticPerNode: 8,
  maxLlmCandidates: 10,
});
