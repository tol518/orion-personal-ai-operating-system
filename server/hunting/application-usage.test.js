import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationUsageMeter, diffQuota } from "./application-usage.js";

test("an oauth run reports plan quota and prices tokens as a list-price equivalent", async () => {
  const gateway = fakeGateway({ authType: "oauth", plan: "plus ($0.00)", percentBefore: 4, percentAfter: 5 });
  const meter = new ApplicationUsageMeter({ gateway, settleTimeoutMs: 50, pollMs: 5 });
  await meter.begin({ sessionKeys: ["app", "letter"] });

  gateway.setSession("letter", { inputTokens: 6000, outputTokens: 500, totalTokens: 6500 });
  await meter.recordTurn({ phase: "cover_letter", sessionKey: "letter" });
  gateway.setSession("app", { inputTokens: 4000, outputTokens: 300, totalTokens: 4300 });
  await meter.recordTurn({ phase: "opening_form", sessionKey: "app" });

  const usage = await meter.finish();
  assert.equal(usage.tokens.input, 10_000);
  assert.equal(usage.tokens.output, 800);
  assert.equal(usage.tokens.total, 10_800);
  assert.equal(usage.authType, "oauth");
  // gpt-5.6-terra: $2.50/M input, $15/M output.
  assert.equal(usage.cost.amount, round(10_000 * 2.5e-6 + 800 * 15e-6));
  // A subscription is not charged per token, and the label has to say so.
  assert.equal(usage.cost.basis, "api_list_price_equivalent");
  assert.equal(usage.quota.reported, true);
  assert.deepEqual(usage.quota.windows[0], {
    label: "168h",
    usedPercentBefore: 4,
    usedPercentAfter: 5,
    deltaPoints: 1,
    resetAt: 1785614778000,
  });
  assert.deepEqual(usage.turns.map((turn) => turn.phase), ["cover_letter", "opening_form"]);
});

test("an api-key run reports a charge and no percentage at all", async () => {
  const gateway = fakeGateway({ authType: "api_key", plan: null, percentBefore: null, percentAfter: null });
  const meter = new ApplicationUsageMeter({ gateway, settleTimeoutMs: 50, pollMs: 5 });
  await meter.begin({ sessionKeys: ["app"] });
  gateway.setSession("app", { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 });
  await meter.recordTurn({ phase: "opening_form", sessionKey: "app" });

  const usage = await meter.finish();
  assert.equal(usage.authType, "api_key");
  assert.equal(usage.cost.basis, "estimated_charge");
  // Percentages are for plan quotas; per-token billing has none to show.
  assert.equal(usage.quota, null);
});

test("only the tokens spent during the run are counted", async () => {
  // The session already carries history; a run must not bill itself for earlier turns.
  const gateway = fakeGateway({ authType: "oauth" });
  gateway.setSession("app", { inputTokens: 999, outputTokens: 999, totalTokens: 50_000 });
  const meter = new ApplicationUsageMeter({ gateway, settleTimeoutMs: 50, pollMs: 5 });
  await meter.begin({ sessionKeys: ["app"] });
  gateway.setSession("app", { inputTokens: 1200, outputTokens: 340, totalTokens: 56_000 });
  await meter.recordTurn({ phase: "filling_verified_fields", sessionKey: "app" });

  const usage = await meter.finish();
  assert.equal(usage.tokens.input, 1200);
  assert.equal(usage.tokens.output, 340);
  // Cumulative growth is kept separately: it includes context replayed on each turn.
  assert.equal(usage.tokens.sessionTokenDelta, 6000);
});

test("a turn whose counters never move is still reported, flagged unsettled", async () => {
  const gateway = fakeGateway({ authType: "oauth" });
  gateway.setSession("app", { inputTokens: 10, outputTokens: 5, totalTokens: 100 });
  const meter = new ApplicationUsageMeter({ gateway, settleTimeoutMs: 30, pollMs: 5 });
  await meter.begin({ sessionKeys: ["app"] });
  const turn = await meter.recordTurn({ phase: "opening_form", sessionKey: "app" });
  assert.equal(turn.settled, false);
  assert.equal(turn.sessionTokenDelta, 0);
});

test("quota granularity is stated rather than implied", () => {
  const quota = diffQuota(
    { windows: [{ label: "168h", usedPercent: 5, resetAt: 1 }] },
    { windows: [{ label: "168h", usedPercent: 5, resetAt: 1 }] },
  );
  assert.equal(quota.windows[0].deltaPoints, 0);
  assert.equal(quota.granularity, "whole percent");
  // A window the provider did not report before cannot claim a movement.
  const fresh = diffQuota(null, { windows: [{ label: "5h", usedPercent: 12 }] });
  assert.equal(fresh.windows[0].usedPercentBefore, null);
  assert.equal(fresh.windows[0].deltaPoints, null);
});

function round(value) {
  return Math.round(value * 10_000) / 10_000;
}

function fakeGateway({ authType, plan = "plus ($0.00)", percentBefore = 4, percentAfter = 5 }) {
  const sessions = new Map();
  let authCalls = 0;
  return {
    setSession(key, row) {
      sessions.set(key, { key, model: "gpt-5.6-terra", modelProvider: "openai", ...row });
    },
    async request(method) {
      if (method === "sessions.list") {
        return { sessions: [...sessions.values()] };
      }
      if (method === "models.authStatus") {
        authCalls += 1;
        const percent = authCalls === 1 ? percentBefore : percentAfter;
        return {
          providers: [
            {
              provider: "openai",
              profiles: [{ profileId: "openai:default", type: authType }],
              usage:
                percent === null
                  ? null
                  : { plan, windows: [{ label: "168h", usedPercent: percent, resetAt: 1785614778000 }] },
            },
          ],
        };
      }
      return {};
    },
  };
}
