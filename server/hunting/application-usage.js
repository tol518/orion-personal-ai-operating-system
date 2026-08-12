// What one application actually cost, measured rather than guessed.
//
// Measured against the live session counters, whose semantics were checked before this was
// written: `inputTokens`/`outputTokens` on a session row are the **last turn's** usage, while
// `totalTokens` is cumulative for the session. So each model turn is read straight after it
// finishes, and the run's totals are the sum of those readings.
//
// Money is reported differently depending on how the provider is authenticated, because the
// two are not the same kind of number:
//   * api_key  -> tokens are billed, so the figure is an estimated charge.
//   * oauth    -> a subscription already paid for, so the figure is only what the same tokens
//                 would list at API prices, and the meaningful cost is plan quota. Quota
//                 percentages are therefore reported for oauth and omitted for api keys.
import { estimateModelUsage } from "../model-pricing.js";

// The counters land a moment after the final event, so a reading waits for them to move.
const COUNTER_SETTLE_TIMEOUT_MS = 8_000;
const COUNTER_POLL_MS = 500;

export class ApplicationUsageMeter {
  constructor({ gateway, settleTimeoutMs = COUNTER_SETTLE_TIMEOUT_MS, pollMs = COUNTER_POLL_MS }) {
    this.gateway = gateway;
    this.settleTimeoutMs = settleTimeoutMs;
    this.pollMs = pollMs;
    this.turns = [];
    this.baseline = new Map();
    this.quotaBefore = null;
    this.provider = null;
    this.model = null;
  }

  /** Snapshot the sessions this application will spend on, plus the plan's starting quota. */
  async begin({ sessionKeys, provider = "openai" }) {
    this.provider = provider;
    const sessions = await this.#sessions();
    for (const key of sessionKeys) {
      this.baseline.set(key, Number(sessions.get(key)?.totalTokens ?? 0));
    }
    this.quotaBefore = await this.readProviderAuth(provider);
  }

  /**
   * Read one finished turn. Waits briefly for the session's cumulative counter to move so the
   * per-turn numbers belong to the turn that just ran rather than the one before it.
   */
  async recordTurn({ phase, sessionKey }) {
    const previousTotal = this.baseline.get(sessionKey) ?? 0;
    const deadline = Date.now() + this.settleTimeoutMs;
    let row = null;
    while (Date.now() < deadline) {
      const sessions = await this.#sessions();
      row = sessions.get(sessionKey) ?? null;
      if (row && Number(row.totalTokens ?? 0) > previousTotal) break;
      await sleep(this.pollMs);
    }
    if (!row) return null;
    const totalTokens = Number(row.totalTokens ?? 0);
    const turn = {
      phase,
      sessionKey,
      model: row.model ?? null,
      provider: row.modelProvider ?? null,
      inputTokens: Math.max(0, Number(row.inputTokens ?? 0)),
      outputTokens: Math.max(0, Number(row.outputTokens ?? 0)),
      sessionTokenDelta: Math.max(0, totalTokens - previousTotal),
      settled: totalTokens > previousTotal,
    };
    this.baseline.set(sessionKey, totalTokens);
    this.model ??= turn.model;
    this.provider = turn.provider ?? this.provider;
    this.turns.push(turn);
    return turn;
  }

  /** Totals, cost with the right basis, and quota movement when the plan reports it. */
  async finish() {
    const quotaAfter = await this.readProviderAuth(this.provider);
    const tokens = this.turns.reduce(
      (sum, turn) => ({
        input: sum.input + turn.inputTokens,
        output: sum.output + turn.outputTokens,
        sessionDelta: sum.sessionDelta + turn.sessionTokenDelta,
      }),
      { input: 0, output: 0, sessionDelta: 0 },
    );
    const priced = estimateModelUsage([
      {
        provider: this.provider,
        model: this.model,
        totals: { input: tokens.input, output: tokens.output },
        count: this.turns.length,
      },
    ]);
    const authType = quotaAfter?.type ?? this.quotaBefore?.type ?? null;
    const subscription = authType === "oauth";
    return {
      model: this.model,
      provider: this.provider,
      authType,
      plan: quotaAfter?.plan ?? this.quotaBefore?.plan ?? null,
      turns: this.turns.map(({ sessionKey: _ignored, ...turn }) => turn),
      tokens: {
        input: tokens.input,
        output: tokens.output,
        total: tokens.input + tokens.output,
        // Cumulative session growth, which includes context replayed on each turn.
        sessionTokenDelta: tokens.sessionDelta,
      },
      cost: {
        currency: "USD",
        amount: round(priced.totals.totalCost, 4),
        // The label matters: a subscription is not charged per token.
        basis: subscription ? "api_list_price_equivalent" : "estimated_charge",
        estimated: true,
        unpricedModels: priced.unpricedModels,
      },
      // Percentages exist only where a plan quota exists; api keys bill per token instead.
      quota: subscription ? diffQuota(this.quotaBefore, quotaAfter) : null,
      measuredAt: new Date().toISOString(),
    };
  }

  /** Auth type and plan quota for a provider, from the gateway's model auth status. */
  async readProviderAuth(provider) {
    try {
      const status = await this.gateway.request("models.authStatus", {});
      const entry = (status?.providers ?? []).find(
        (candidate) => (candidate.provider ?? candidate.id) === provider,
      );
      if (!entry) return null;
      return {
        type: entry.profiles?.[0]?.type ?? null,
        plan: entry.usage?.plan ?? null,
        windows: Array.isArray(entry.usage?.windows) ? entry.usage.windows : [],
      };
    } catch {
      return null;
    }
  }

  async #sessions() {
    const listed = await this.gateway.request("sessions.list", { agentId: "main" });
    const rows = listed?.sessions ?? listed ?? [];
    return new Map((Array.isArray(rows) ? rows : []).map((row) => [row.key, row]));
  }
}

/**
 * Providers report quota in whole percent, so a single application usually moves the window by
 * less than one point. Both the movement and the standing level are reported, and a zero delta
 * is stated as "under a point" rather than as "nothing".
 */
export function diffQuota(before, after) {
  const windows = (after?.windows ?? []).map((window) => {
    const previous = (before?.windows ?? []).find((candidate) => candidate.label === window.label);
    const usedPercentBefore = previous ? Number(previous.usedPercent) : null;
    const usedPercentAfter = Number(window.usedPercent);
    return {
      label: window.label,
      usedPercentBefore,
      usedPercentAfter,
      deltaPoints: usedPercentBefore === null ? null : round(usedPercentAfter - usedPercentBefore, 2),
      resetAt: window.resetAt ?? null,
    };
  });
  return {
    reported: windows.length > 0,
    granularity: "whole percent",
    windows,
  };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
