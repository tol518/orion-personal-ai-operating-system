import assert from "node:assert/strict";
import test from "node:test";
import { ScreenpipeClient } from "./screenpipe-client.js";
import {
  buildObservationDigest,
  digestToPromptText,
  isNearDuplicate,
  redactSecrets,
} from "./observation-window.js";
import { mockScreenpipe } from "./test-support.js";

async function invoiceDigest(options = {}) {
  const client = new ScreenpipeClient({ fetchImpl: mockScreenpipe().fetchImpl });
  const capture = await client.captureWindow({
    startTime: "2026-07-29T09:00:00Z",
    endTime: "2026-07-29T09:05:00Z",
    includeAudio: true,
  });
  return buildObservationDigest(capture, options);
}

test("credential-shaped text is masked but its label survives", () => {
  const password = redactSecrets("Sign in — password: hunter2-northwind");
  assert.equal(password.redacted, true);
  assert.ok(!password.text.includes("hunter2"));
  assert.match(password.text, /password: \[redacted\]/);

  assert.equal(redactSecrets("card 4242 4242 4242 4242").text, "card [redacted]");
  assert.equal(redactSecrets("Authorization: Bearer abc.def.ghi").redacted, true);
  // A short digit run is a date or a total, not a card number, and must survive.
  assert.equal(redactSecrets("Invoice total £4,820.00 on 29/07/2026").redacted, false);
});

test("a password manager window never reaches the digest", async () => {
  const digest = await invoiceDigest();
  const text = JSON.stringify(digest);
  assert.ok(!digest.apps.includes("1Password"));
  assert.ok(!text.includes("4242"));
  assert.ok(!text.includes("vault entry"));
  assert.equal(digest.stats.excludedItems, 1);
});

test("an operator can exclude further apps from ever being observed", async () => {
  const digest = await invoiceDigest({ excludeApps: ["Slack"] });
  assert.ok(!JSON.stringify(digest).includes("standup"));
  assert.ok(!digest.apps.includes("Slack"));
});

test("the timeline is ordered, segmented by window, and deduplicated", async () => {
  const digest = await invoiceDigest();
  // Screenpipe returns each content type as its own page run, so ordering has to be restored.
  const timestamps = digest.segments.map((segment) => segment.startedAt);
  assert.deepEqual(timestamps, [...timestamps].sort());
  // "Ledgerly — Dashboard" was OCR'd twice with identical text; the second copy adds nothing.
  const dashboard = digest.segments.find((segment) => segment.window === "Ledgerly — Dashboard");
  assert.deepEqual(dashboard.lines, ["Ledgerly — Dashboard", "New invoice"]);
  assert.equal(digest.stats.duplicateLines, 1);
  // A new window is a new segment, which is the unit a replayed step targets.
  const windows = digest.segments.map((segment) => segment.window);
  assert.ok(windows.includes("Ledgerly — New invoice"));
  assert.ok(windows.includes("Ledgerly — Review invoice"));
});

test("a re-read of the same screen is dropped even when OCR jitters", async () => {
  // Real capture, not a hypothetical: live OCR returns one blob of the whole screen per frame, and
  // consecutive blobs differ only by a mis-read glyph or a moved caret. Exact-match dedupe let
  // every one of them through and they filled the prompt.
  const words = (value) => new Set(value.toLowerCase().match(/[a-z0-9]{2,}/g));
  const first = "Anl System Settings Edit View Window Help Workflow learning from screen recordings openclaw Home Code New Artifacts Customize";
  const jittered = "AnI System Settings Edit View Window Help Workflow learning from screen recordings openclaw Home Code New Artifacts Customise";
  assert.equal(isNearDuplicate(jittered, [words(first)]), true);

  // A genuinely different screen survives. On live capture these pairs peak at 0.39 overlap,
  // well below the 0.7 threshold, which is why the threshold can be this permissive.
  const different = "Invoice total 4,820.00 Review before sending Send invoice Save as draft";
  assert.equal(isNearDuplicate(different, [words(first)]), false);
  assert.equal(isNearDuplicate("", [words("anything at all")]), false);
});

test("near-duplicate screen reads collapse instead of filling the segment", async () => {
  const blob = (suffix) => ({
    type: "OCR",
    content: {
      text: `Ledgerly New invoice Client name Period Attach file Save draft ${suffix}`,
      timestamp: `2026-07-29T09:00:${String(10 + suffix.length).padStart(2, "0")}Z`,
      app_name: "Ledgerly",
      window_name: "Ledgerly — New invoice",
    },
  });
  const digest = buildObservationDigest({
    items: [blob("a"), blob("bb"), blob("ccc"), blob("dddd")],
    counts: {},
    unavailable: [],
  });
  assert.equal(digest.segments[0].lines.length, 1, "four reads of one screen are one line");
  assert.equal(digest.stats.duplicateLines, 3);
});

test("window management is not treated as a task step", async () => {
  // Live capture emits these between real clicks; listing them made alt-tabbing look like part of
  // the workflow. An unrecognised event type is kept, because losing a real click is worse.
  const event = (eventType, element) => ({
    type: "Input",
    content: {
      event_type: eventType,
      element_name: element,
      timestamp: "2026-07-29T09:00:05Z",
      app_name: "Ledgerly",
      window_title: "Ledgerly — New invoice",
    },
  });
  const digest = buildObservationDigest({
    items: [event("app_switch", "shell"), event("click", "Save"), event("window_focus", "shell"), event("mouse_down", "Total")],
    counts: {},
    unavailable: [],
  });
  assert.deepEqual(
    digest.segments.flatMap((segment) => segment.actions.map((action) => action.eventType)),
    ["click", "mouse_down"],
  );
});

test("an over-long recording keeps both ends and drops the middle", async () => {
  // Keeping the first N threw away the end of the recording — which for a workflow is the review
  // screen and the submit. A draft missing its final step looks complete and is not.
  const items = Array.from({ length: 200 }, (_, index) => ({
    type: "OCR",
    content: {
      text: `screen number ${index} unique words ${index}`,
      timestamp: `2026-07-29T09:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
      app_name: `App${index}`,
      window_name: `Window ${index}`,
    },
  }));
  const digest = buildObservationDigest({ items, counts: {}, unavailable: [] });
  assert.equal(digest.segments.length, 60);
  assert.ok(digest.segmentsDropped > 0);
  assert.match(digest.segments[0].app, /^App0$/, "the start of the recording survives");
  assert.match(digest.segments.at(-1).app, /^App199$/, "the END of the recording survives — the submit step");

  const prompt = digestToPromptText(digest);
  assert.match(prompt, /segments from the MIDDLE of this recording were dropped/);
  assert.match(prompt, /leave a gap rather than inventing the steps/);
});

test("the URL of a browser segment is carried through for the replay to navigate to", async () => {
  const digest = await invoiceDigest();
  assert.deepEqual(digest.urls, ["https://app.ledgerly.example/invoices/new/review"]);
});

test("recorded media never travels with the digest", async () => {
  const digest = await invoiceDigest();
  const text = JSON.stringify(digest);
  assert.ok(!text.includes(".screenpipe/data"));
  assert.ok(!text.includes("frame-9001"));
  assert.ok(!text.includes("file_path"));
});

test("a coordinates-only click is labelled as such rather than dressed up as an anchor", async () => {
  const digest = await invoiceDigest();
  const actions = digest.segments.flatMap((segment) => segment.actions);
  const blind = actions.find((action) => action.coordinatesOnly);
  assert.ok(blind, "the fixture's element-less click should be marked coordinatesOnly");
  assert.equal(blind.element, null);
  const named = actions.find((action) => action.element === "Client name");
  assert.equal(named.text, "Northwind Trading");
});

test("narration is kept separate and only when it was captured", async () => {
  const withAudio = await invoiceDigest();
  const narration = withAudio.segments.flatMap((segment) => segment.narration);
  assert.deepEqual(narration, ["I always check the totals here before I send it to the client."]);

  const prompt = digestToPromptText({ ...withAudio, includeAudio: false });
  assert.match(prompt, /Audio narration was NOT captured; do not claim the user said anything\./);
});

test("the prompt text is a readable timeline and states what was redacted", async () => {
  const digest = await invoiceDigest();
  const prompt = digestToPromptText(digest);
  assert.match(prompt, /TIMELINE/);
  assert.match(prompt, /url: https:\/\/app\.ledgerly\.example/);
  assert.match(prompt, /input events:/);
  assert.match(prompt, /text fragments were redacted as credentials/);
  assert.ok(!prompt.includes("hunter2"));
});

test("the digest is deterministic, so extraction is reproducible", async () => {
  assert.equal(JSON.stringify(await invoiceDigest()), JSON.stringify(await invoiceDigest()));
});
