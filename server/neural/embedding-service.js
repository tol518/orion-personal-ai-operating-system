import { createHash } from "node:crypto";

const DEFAULT_DIMENSIONS = 384;
const TOKEN = /[\p{L}\p{N}]+/gu;
const SYNONYMS = new Map([
  ["developer", "software"],
  ["engineer", "software"],
  ["coding", "software"],
  ["programming", "software"],
  ["job", "work"],
  ["career", "work"],
  ["employed", "work"],
  ["resides", "location"],
  ["living", "location"],
  ["lives", "location"],
  ["born", "birth"],
  ["birthday", "birth"],
]);

function normalizeToken(token) {
  const lower = token.toLocaleLowerCase("en");
  const stem = lower.length > 5
    ? lower.replace(/(ing|edly|edly|ed|es|s)$/u, "")
    : lower;
  return SYNONYMS.get(stem) ?? stem;
}

function tokensFor(memory) {
  const title = String(memory.title ?? "");
  const body = String(memory.body ?? "");
  const tags = Array.isArray(memory.tags) ? memory.tags.join(" ") : "";
  const raw = `${title} ${title} ${tags} ${tags} ${body}`.match(TOKEN) ?? [];
  return raw.map(normalizeToken).filter((token) => token.length > 1);
}

function hashFeature(feature) {
  let hash = 2166136261;
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function memoryContentHash(memory) {
  return createHash("sha256")
    .update(JSON.stringify({
      title: memory.title ?? "",
      body: memory.body ?? "",
      tags: memory.tags ?? [],
      createdAt: memory.createdAt ?? "",
    }))
    .digest("hex");
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

export class EmbeddingService {
  constructor({ dimensions = DEFAULT_DIMENSIONS } = {}) {
    this.dimensions = dimensions;
    this.model = `local-feature-hash-v1-${dimensions}`;
  }

  generate(memory) {
    const tokens = tokensFor(memory);
    const vector = new Array(this.dimensions).fill(0);
    const features = [...tokens];
    for (let index = 0; index < tokens.length - 1; index += 1) {
      features.push(`${tokens[index]}::${tokens[index + 1]}`);
    }
    for (const feature of features) {
      const hash = hashFeature(feature);
      const bucket = hash % this.dimensions;
      const sign = hash & 0x80000000 ? -1 : 1;
      vector[bucket] += sign * (feature.includes("::") ? 0.7 : 1);
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm ? vector.map((value) => value / norm) : vector;
  }
}
