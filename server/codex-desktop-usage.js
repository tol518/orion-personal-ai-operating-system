import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { addUsageTotals, emptyUsageTotals } from "./usage-summary.js";
import { estimateModelUsage } from "./model-pricing.js";

const rolloutCache = new Map();

function safeTimestamp(value) {
  const timestamp = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

function usageFromTokenCount(payload) {
  const usage = payload?.info?.last_token_usage;
  if (!usage || typeof usage !== "object") return null;
  const rawInput = Math.max(0, Number(usage.input_tokens) || 0);
  const cacheRead = Math.max(0, Number(usage.cached_input_tokens) || 0);
  const input = Math.max(0, rawInput - cacheRead);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  const totalTokens = input + cacheRead + output;
  return totalTokens > 0 ? { input, output, cacheRead, cacheWrite: 0, totalTokens } : null;
}

function weeklyLimitFromTokenCount(payload, timestamp) {
  const primary = payload?.rate_limits?.primary;
  const windowMinutes = Number(primary?.window_minutes);
  const usedPercent = Number(primary?.used_percent);
  const resetsAtSeconds = Number(primary?.resets_at);
  if (
    !Number.isFinite(windowMinutes) ||
    windowMinutes < 7 * 24 * 60 ||
    !Number.isFinite(usedPercent)
  ) {
    return null;
  }
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
    windowMinutes,
    resetsAt: Number.isFinite(resetsAtSeconds) ? resetsAtSeconds * 1000 : null,
    updatedAt: timestamp,
    planType: typeof payload.rate_limits?.plan_type === "string" ? payload.rate_limits.plan_type : null,
  };
}

function createRolloutParser() {
  const rollout = { id: null, originator: null, events: [], weeklyLimits: [] };
  let model = null;

  return {
    accept(line) {
      if (
        !line.includes('"type":"session_meta"') &&
        !line.includes('"type":"turn_context"') &&
        !line.includes('"type":"token_count"')
      ) {
        return;
      }
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        return;
      }
      if (row.type === "session_meta") {
        rollout.id = row.payload?.id ?? row.payload?.session_id ?? rollout.id;
        rollout.originator = row.payload?.originator ?? rollout.originator;
        return;
      }
      if (row.type === "turn_context") {
        model = typeof row.payload?.model === "string" ? row.payload.model : model;
        return;
      }
      if (row.type !== "event_msg" || row.payload?.type !== "token_count") return;
      const timestamp = safeTimestamp(row.timestamp);
      if (timestamp !== null) {
        const weeklyLimit = weeklyLimitFromTokenCount(row.payload, timestamp);
        if (weeklyLimit) rollout.weeklyLimits.push(weeklyLimit);
      }
      const totals = usageFromTokenCount(row.payload);
      if (timestamp === null || !totals) return;
      rollout.events.push({ timestamp, provider: "openai", model, totals });
    },
    finish() {
      return rollout;
    },
  };
}

export function selectLatestWeeklyLimit(rollouts) {
  let latest = null;
  for (const rollout of Array.isArray(rollouts) ? rollouts : []) {
    if (rollout?.originator !== "Codex Desktop") continue;
    for (const limit of rollout.weeklyLimits ?? []) {
      if (!latest || limit.updatedAt > latest.updatedAt) latest = limit;
    }
  }
  return latest;
}

export function parseCodexRollout(text) {
  const parser = createRolloutParser();
  for (const line of String(text).split("\n")) parser.accept(line);
  return parser.finish();
}

async function parseCodexRolloutFile(file) {
  const stat = await fs.promises.stat(file);
  const cached = rolloutCache.get(file);
  if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.rollout;

  const parser = createRolloutParser();
  const lines = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) parser.accept(line);
  const rollout = parser.finish();
  rolloutCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, rollout });
  return rollout;
}

function dateDirectories(startMs, endMs) {
  const directories = [];
  const cursor = new Date(startMs);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= endMs) {
    directories.push(
      path.join(
        String(cursor.getUTCFullYear()),
        String(cursor.getUTCMonth() + 1).padStart(2, "0"),
        String(cursor.getUTCDate()).padStart(2, "0"),
      ),
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return directories;
}

async function rolloutFiles(codexHome, startMs, endMs) {
  const files = [];
  for (const relative of dateDirectories(startMs, endMs)) {
    const directory = path.join(codexHome, "sessions", relative);
    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          files.push(path.join(directory, entry.name));
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const archived = path.join(codexHome, "archived_sessions");
  try {
    const entries = await fs.promises.readdir(archived, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const file = path.join(archived, entry.name);
      const stat = await fs.promises.stat(file);
      if (stat.mtimeMs >= startMs && stat.mtimeMs <= endMs) files.push(file);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files;
}

function summarizeRollout(rollout, startMs, endMs) {
  if (rollout.originator !== "Codex Desktop") return null;
  const models = new Map();
  for (const event of rollout.events) {
    if (event.timestamp < startMs || event.timestamp > endMs) continue;
    const key = `${event.provider}::${event.model ?? "unknown"}`;
    const current = models.get(key) ?? {
      provider: event.provider,
      model: event.model,
      count: 0,
      totals: emptyUsageTotals(),
    };
    current.count += 1;
    current.totals = addUsageTotals(current.totals, event.totals);
    models.set(key, current);
  }
  const modelUsage = [...models.values()];
  if (!modelUsage.length) return null;
  const estimate = estimateModelUsage(modelUsage);
  return {
    key: `codex-desktop:${rollout.id ?? "unknown"}`,
    agentId: "codex",
    totals: estimate.totals,
    modelUsage,
    pricedModels: estimate.pricedModels,
    unpricedModels: estimate.unpricedModels,
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function loadCodexDesktopUsage({
  startMs,
  endMs,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
}) {
  const files = await rolloutFiles(codexHome, startMs, endMs);
  const rollouts = await mapWithConcurrency(files, 4, parseCodexRolloutFile);
  const sessions = rollouts
    .map((rollout) => summarizeRollout(rollout, startMs, endMs))
    .filter(Boolean);
  let totals = emptyUsageTotals();
  const pricedModels = new Set();
  const unpricedModels = new Set();
  for (const session of sessions) {
    totals = addUsageTotals(totals, session.totals);
    for (const model of session.pricedModels) pricedModels.add(model);
    for (const model of session.unpricedModels) unpricedModels.add(model);
  }
  return {
    totals,
    sessions,
    weeklyLimit: selectLatestWeeklyLimit(rollouts),
    pricedModels: [...pricedModels].toSorted(),
    unpricedModels: [...unpricedModels].toSorted(),
  };
}
