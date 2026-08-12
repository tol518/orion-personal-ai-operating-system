// Screenpipe is the raw observation layer: it already records the screen, OCR, accessibility
// text, input events, and audio 24/7 into a local SQLite database. Jarvis never records
// anything itself — it marks a time window and asks Screenpipe what happened in it.
//
// Verified against a live screenpipe 0.4.32 on this machine:
//   GET /health                                        -> 200 while the recorder is up, no auth
//   GET /search ?q&limit&offset&content_type&start_time&end_time&app_name&window_name
//               &include_frames&browser_url&focused&min_length&max_length&device_name
//     -> { data: [{ type: "OCR"|"Audio"|"UI"|"Input"|"Memory", content: {...} }],
//          pagination: { limit, offset, total } }
//
// /search requires a bearer token that the published API reference does not mention; without it
// every call answers 401 `unauthorized: API access requires authentication`. The token is local
// and per-install (`screenpipe auth token`), so it lives in SCREENPIPE_API_KEY like any other
// credential. /health stays open, which is why a reachable recorder can still refuse to be read —
// health() reports that case rather than letting a capture fail four times over.
//
// The /health response body is rich but undocumented, so nothing here reads its fields: a 200
// means the recorder answers, and that is the only claim we make about it.
//
// PRIVACY BOUNDARY. This module is the single place raw observation enters the app, so the
// hard rules live here rather than in a policy note somewhere else:
//   - include_frames is never sent and /frames is never called, so screenshot bytes never
//     leave Screenpipe's database. Only text reaches Jarvis.
//   - Audio transcription is only requested when the caller passes includeAudio, which the UI
//     only sets when the user ticked "include my narration" for that recording.
const DEFAULT_BASE_URL = "http://127.0.0.1:3030";
const DEFAULT_TIMEOUT_MS = 20_000;
// Screenpipe caps a page at 100 in practice and a workflow window is minutes long, so paging
// is bounded rather than unlimited: a runaway window must not pull a day of OCR into memory.
const PAGE_SIZE = 100;
const MAX_PAGES_PER_TYPE = 12;

/**
 * The exact content_type values the API accepts. Anything else is a 400 with
 * `unknown variant`, not an empty result — so the request value and the response `type` are not
 * the same word: you ask for `accessibility` and rows come back tagged `UI`.
 */
export const CONTENT_TYPES = ["all", "ocr", "audio", "input", "accessibility", "memory"];

/** Content types requested for a workflow window, in the order they are most useful. */
export const WORKFLOW_CONTENT_TYPES = ["accessibility", "ocr", "input"];
export const AUDIO_CONTENT_TYPE = "audio";

export class ScreenpipeClient {
  constructor({
    baseUrl = process.env.SCREENPIPE_URL ?? DEFAULT_BASE_URL,
    apiKey = process.env.SCREENPIPE_API_KEY ?? "",
    timeoutMs = Number(process.env.SCREENPIPE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.apiKey = String(apiKey).trim();
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Closed result shape, matching BrowserControl: callers classify `error` rather than
   * catching. A recorder that is not running is an expected state, not an exception.
   */
  async request(path, query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        ...(this.apiKey ? { headers: { Authorization: `Bearer ${this.apiKey}` } } : {}),
      });
      if (!response.ok) {
        // 401 is the one failure worth naming: the recorder is running and reachable, it just will
        // not answer without the local token, and no amount of retrying fixes that.
        if (response.status === 401) {
          return {
            ok: false,
            error: this.apiKey
              ? `screenpipe rejected the API key in SCREENPIPE_API_KEY. Re-read it with \`npx screenpipe auth token\` and restart the BFF.`
              : `screenpipe requires a local API key. Run \`npx screenpipe auth token\`, put it in SCREENPIPE_API_KEY in server/.env, and restart the BFF.`,
          };
        }
        return { ok: false, error: `screenpipe ${path} returned HTTP ${response.status}` };
      }
      // /health may answer with plain text; only /search is required to be JSON.
      const body = await response.text();
      if (!body.trim()) return { ok: true, payload: {} };
      try {
        return { ok: true, payload: JSON.parse(body) };
      } catch {
        return { ok: true, payload: { body: body.slice(0, 500) } };
      }
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return {
        ok: false,
        error: aborted
          ? `screenpipe ${path} did not answer within ${Math.round(this.timeoutMs / 1000)}s`
          : String(err?.message ?? err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Is the recorder reachable, and can we actually read it?
   *
   * Two separate questions, because /health needs no token and /search does: a recorder can be
   * perfectly healthy and still refuse every read. Reporting only reachability would enable the
   * Record button and then fail the capture minutes later, after the user had done the task.
   * The probe is one row, so it costs nothing.
   */
  async health() {
    const reachable = await this.request("/health");
    if (!reachable.ok) return { running: false, readable: false, baseUrl: this.baseUrl, detail: reachable.error };
    const probe = await this.search({ contentType: "ocr", limit: 1 });
    return probe.ok
      ? { running: true, readable: true, baseUrl: this.baseUrl, detail: null }
      : { running: true, readable: false, baseUrl: this.baseUrl, detail: probe.error };
  }

  /**
   * One page of one content type. include_frames is deliberately absent: see the privacy
   * boundary above.
   */
  search({ contentType = "all", startTime, endTime, appName, windowName, q, limit = PAGE_SIZE, offset = 0 }) {
    return this.request("/search", {
      content_type: contentType,
      start_time: startTime,
      end_time: endTime,
      app_name: appName,
      window_name: windowName,
      q,
      limit,
      offset,
    });
  }

  /**
   * Everything Screenpipe holds for one recorded window, as raw items.
   *
   * A content type that fails is reported in `unavailable` instead of failing the capture: a
   * session with OCR but no accessibility tree is still a usable session, and the user needs
   * to be told which layer was missing rather than getting a blank error.
   */
  async captureWindow({ startTime, endTime, includeAudio = false, maxItems = 4_000 }) {
    const types = includeAudio ? [...WORKFLOW_CONTENT_TYPES, AUDIO_CONTENT_TYPE] : [...WORKFLOW_CONTENT_TYPES];
    const items = [];
    const unavailable = [];
    const counts = {};
    for (const contentType of types) {
      let collected = 0;
      for (let page = 0; page < MAX_PAGES_PER_TYPE; page += 1) {
        if (items.length >= maxItems) break;
        const result = await this.search({
          contentType,
          startTime,
          endTime,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        });
        if (!result.ok) {
          unavailable.push({ contentType, reason: result.error });
          break;
        }
        const data = Array.isArray(result.payload?.data) ? result.payload.data : [];
        for (const entry of data) {
          items.push(entry);
          collected += 1;
        }
        if (data.length < PAGE_SIZE) break;
      }
      counts[contentType] = collected;
    }
    return {
      startTime,
      endTime,
      includeAudio,
      items: items.slice(0, maxItems),
      counts,
      unavailable,
      truncated: items.length > maxItems,
    };
  }
}
