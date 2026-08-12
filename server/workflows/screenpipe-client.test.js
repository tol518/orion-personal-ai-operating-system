import assert from "node:assert/strict";
import test from "node:test";
import { AUDIO_CONTENT_TYPE, CONTENT_TYPES, ScreenpipeClient, WORKFLOW_CONTENT_TYPES } from "./screenpipe-client.js";
import { mockScreenpipe } from "./test-support.js";

test("every requested content type is one the API actually accepts", () => {
  // An invalid value is a 400 `unknown variant`, not an empty result — asking for "ui" instead of
  // "accessibility" silently cost the whole accessibility layer until a live call caught it. The
  // request word and the response tag differ on purpose: ask `accessibility`, get rows typed `UI`.
  for (const contentType of [...WORKFLOW_CONTENT_TYPES, AUDIO_CONTENT_TYPE]) {
    assert.ok(CONTENT_TYPES.includes(contentType), `${contentType} is not an accepted content_type`);
  }
  assert.ok(!WORKFLOW_CONTENT_TYPES.includes("ui"), '"ui" is rejected by the API; use "accessibility"');
});

test("health reports reachability and readability separately", async () => {
  const up = new ScreenpipeClient({ ...mockScreenpipe(), baseUrl: "http://127.0.0.1:3030" });
  assert.deepEqual(await up.health(), {
    running: true,
    readable: true,
    baseUrl: "http://127.0.0.1:3030",
    detail: null,
  });

  const down = new ScreenpipeClient({ ...mockScreenpipe({ health: 500 }) });
  const result = await down.health();
  assert.equal(result.running, false);
  assert.equal(result.readable, false);
  assert.match(result.detail, /HTTP 500/);
});

test("a recorder that is up but unauthorized is reported as running and unreadable", async () => {
  // The failure this exists for: /health needs no token and /search does, so reachability alone
  // would enable recording and then fail the capture after the user had done the whole task.
  const client = new ScreenpipeClient({ ...mockScreenpipe({ requireAuth: true }) });
  const health = await client.health();
  assert.equal(health.running, true);
  assert.equal(health.readable, false);
  assert.match(health.detail, /npx screenpipe auth token/);
  assert.match(health.detail, /SCREENPIPE_API_KEY/);
});

test("the local API key is sent as a bearer token when one is configured", async () => {
  const mock = mockScreenpipe({ requireAuth: true });
  const client = new ScreenpipeClient({ ...mock, apiKey: "sp-local-test-key" });
  const health = await client.health();
  assert.equal(health.readable, true, "a configured key must satisfy the auth check");
  assert.deepEqual([...new Set(mock.headers.map((header) => header?.Authorization))], [
    "Bearer sp-local-test-key",
  ]);
});

test("a rejected key says the key is wrong, not that the recorder is down", async () => {
  const client = new ScreenpipeClient({ ...mockScreenpipe({ requireAuth: true }), apiKey: "stale-key" });
  const result = await client.search({ contentType: "ocr" });
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected the API key/);
});

test("a capture window asks for text layers only and never for frames", async () => {
  const mock = mockScreenpipe();
  const client = new ScreenpipeClient({ fetchImpl: mock.fetchImpl });
  const capture = await client.captureWindow({
    startTime: "2026-07-29T09:00:00Z",
    endTime: "2026-07-29T09:05:00Z",
  });

  const searches = mock.calls.filter((url) => url.pathname === "/search");
  assert.deepEqual(
    [...new Set(searches.map((url) => url.searchParams.get("content_type")))],
    WORKFLOW_CONTENT_TYPES,
  );
  // The privacy boundary: no frame bytes are ever requested, and /frames is never called.
  assert.ok(searches.every((url) => !url.searchParams.has("include_frames")));
  assert.ok(mock.calls.every((url) => url.pathname !== "/frames"));
  for (const url of searches) {
    assert.equal(url.searchParams.get("start_time"), "2026-07-29T09:00:00Z");
    assert.equal(url.searchParams.get("end_time"), "2026-07-29T09:05:00Z");
  }
  assert.ok(capture.items.length > 0);
  assert.equal(capture.includeAudio, false);
});

test("audio is requested only when the user opted into narration", async () => {
  const withoutAudio = mockScreenpipe();
  await new ScreenpipeClient({ fetchImpl: withoutAudio.fetchImpl }).captureWindow({
    startTime: "a",
    endTime: "b",
  });
  assert.ok(withoutAudio.calls.every((url) => url.searchParams.get("content_type") !== "audio"));

  const withAudio = mockScreenpipe();
  const capture = await new ScreenpipeClient({ fetchImpl: withAudio.fetchImpl }).captureWindow({
    startTime: "a",
    endTime: "b",
    includeAudio: true,
  });
  assert.ok(withAudio.calls.some((url) => url.searchParams.get("content_type") === "audio"));
  assert.equal(capture.includeAudio, true);
});

test("a content layer that fails is reported, not fatal", async () => {
  const client = new ScreenpipeClient({
    fetchImpl: async (url) => {
      if (url.searchParams.get("content_type") === "input") {
        return { ok: false, status: 404, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [], pagination: {} }) };
    },
  });
  const capture = await client.captureWindow({ startTime: "a", endTime: "b" });
  assert.deepEqual(
    capture.unavailable.map((entry) => entry.contentType),
    ["input"],
  );
  assert.match(capture.unavailable[0].reason, /HTTP 404/);
});

test("a recorder that is not running is a result, not an exception", async () => {
  const client = new ScreenpipeClient({
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
  });
  const result = await client.search({ contentType: "ocr" });
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch failed/);
});
