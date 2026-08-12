import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexRollout, selectLatestWeeklyLimit } from "./codex-desktop-usage.js";

function line(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test("parses Codex desktop token events without double-counting cached input", () => {
  const rollout = parseCodexRollout(
    [
      line("2026-07-15T10:00:00.000Z", "session_meta", {
        id: "thread-1",
        originator: "Codex Desktop",
      }),
      line("2026-07-15T10:00:01.000Z", "turn_context", { model: "gpt-5.6-sol" }),
      line("2026-07-15T10:00:02.000Z", "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 },
        },
      }),
      line("2026-07-15T10:00:03.000Z", "event_msg", {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 150, cached_input_tokens: 110, output_tokens: 8 },
          last_token_usage: { input_tokens: 50, cached_input_tokens: 30, output_tokens: 3 },
        },
      }),
    ].join("\n"),
  );

  assert.equal(rollout.id, "thread-1");
  assert.equal(rollout.originator, "Codex Desktop");
  assert.deepEqual(rollout.events.map((event) => event.totals), [
    { input: 20, output: 5, cacheRead: 80, cacheWrite: 0, totalTokens: 105 },
    { input: 20, output: 3, cacheRead: 30, cacheWrite: 0, totalTokens: 53 },
  ]);
  assert.deepEqual(rollout.events.map((event) => event.model), ["gpt-5.6-sol", "gpt-5.6-sol"]);
});

test("ignores malformed and synthetic zero-component token events", () => {
  const rollout = parseCodexRollout(
    [
      "not-json",
      line("2026-07-15T10:00:00.000Z", "session_meta", { originator: "Codex Desktop" }),
      line("2026-07-15T10:00:01.000Z", "event_msg", {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 258_400 } },
      }),
    ].join("\n"),
  );
  assert.deepEqual(rollout.events, []);
});

test("selects the latest provider-reported weekly Codex limit", () => {
  const first = parseCodexRollout(
    [
      line("2026-07-15T10:00:00.000Z", "session_meta", { originator: "Codex Desktop" }),
      line("2026-07-15T10:00:01.000Z", "event_msg", {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 19, window_minutes: 10_080, resets_at: 1_784_703_512 },
          plan_type: "plus",
        },
      }),
    ].join("\n"),
  );
  const second = parseCodexRollout(
    [
      line("2026-07-15T10:01:00.000Z", "session_meta", { originator: "Codex Desktop" }),
      line("2026-07-15T10:01:01.000Z", "event_msg", {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 23, window_minutes: 10_080, resets_at: 1_784_703_512 },
          plan_type: "plus",
        },
      }),
    ].join("\n"),
  );
  const weekly = selectLatestWeeklyLimit([first, second]);
  assert.deepEqual(weekly, {
    usedPercent: 23,
    remainingPercent: 77,
    windowMinutes: 10_080,
    resetsAt: 1_784_703_512_000,
    updatedAt: Date.parse("2026-07-15T10:01:01.000Z"),
    planType: "plus",
  });
});
