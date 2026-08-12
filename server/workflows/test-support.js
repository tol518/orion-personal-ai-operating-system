// Test-only fakes for the workflow-learning feature. Imported by *.test.js files, never by the
// server: a mocked Screenpipe and a mocked gateway are what let the whole feature be verified
// without a real recording, a real vault, or a model call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const INVOICE_SESSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "screenpipe-invoice-session.json"), "utf8"),
);
export const DEMO_WORKFLOW = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "demo-invoice-workflow.json"), "utf8"),
);

/**
 * A stand-in for a running Screenpipe. Records every URL and header so tests can assert what was
 * asked and with what credentials.
 *
 * `requireAuth` mirrors the real 0.4.32 behaviour that the published API reference omits: /health
 * is open, /search answers 401 without a bearer token. `sharedKey` is the token it accepts.
 */
export function mockScreenpipe({
  health = 200,
  body = INVOICE_SESSION,
  requireAuth = false,
  sharedKey = "sp-local-test-key",
} = {}) {
  const calls = [];
  const headers = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(new URL(url));
    headers.push(init.headers ?? null);
    if (url.pathname === "/health") {
      return { ok: health === 200, status: health, text: async () => "ok" };
    }
    if (requireAuth && init.headers?.Authorization !== `Bearer ${sharedKey}`) {
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: "unauthorized: API access requires authentication." }),
      };
    }
    const contentType = url.searchParams.get("content_type");
    const offset = Number(url.searchParams.get("offset") ?? 0);
    // Only the first page ever has data, so paging terminates the way the real API does.
    const data = offset > 0 ? [] : body.data.filter((entry) => matchesType(entry, contentType));
    return { ok: true, status: 200, text: async () => JSON.stringify({ ...body, data }) };
  };
  return { fetchImpl, calls, headers };
}

function matchesType(entry, contentType) {
  if (!contentType || contentType === "all") return true;
  const wanted = { ocr: "OCR", ui: "UI", input: "Input", audio: "Audio", accessibility: "UI" }[contentType];
  return entry.type === wanted;
}

/**
 * A gateway that answers one chat turn with `reply`.
 *
 * runSessionTurn waits for a `chat` event with state "final" on the session key, so the fake
 * emits exactly that after chat.send — the same contract the real gateway meets.
 */
export function mockGateway({ reply = "{}", replies = null } = {}) {
  const queue = replies ? [...replies] : null;
  const requests = [];
  const listeners = new Set();
  return {
    requests,
    on(_event, handler) {
      listeners.add(handler);
    },
    off(_event, handler) {
      listeners.delete(handler);
    },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "chat.abort") return { ok: true, aborted: false };
      if (method === "chat.send") {
        const text = queue?.length ? queue.shift() : reply;
        // Deliver on a later tick: the waiter is registered before chat.send resolves.
        setTimeout(() => {
          for (const handler of [...listeners]) {
            handler("chat", { sessionKey: params.sessionKey, state: "final", message: { text } });
          }
        }, 0);
        return { ok: true };
      }
      return { ok: true };
    },
  };
}

/**
 * A BrowserControl stand-in over a scripted page.
 *
 * Opened tabs are tracked and returned from tabs() with `type: "page"`, because
 * openApplicationTab() validates a freshly opened tab against the live tab list and pageTabs()
 * filters on that field. A mock that skipped it would pass while the real path failed.
 */
export function mockBrowser({ snapshot = "", failAct = false, failOpen = false } = {}) {
  const calls = [];
  const openTabs = [];
  return {
    calls,
    openTabs,
    async request(method, urlPath, options = {}) {
      calls.push({ method, path: urlPath, body: options.body });
      if (urlPath === "/act" && options.body?.kind === "evaluate") {
        return { ok: true, payload: { result: { href: "https://app.ledgerly.example/", ready: "complete" } } };
      }
      if (urlPath === "/act") {
        return failAct ? { ok: false, error: "act refused" } : { ok: true, payload: { result: "ok" } };
      }
      return { ok: true, payload: {} };
    },
    async snapshot({ targetId }) {
      calls.push({ method: "GET", path: "/snapshot", body: { targetId } });
      return { ok: true, payload: { snapshot, url: "https://app.ledgerly.example/invoices/new" } };
    },
    async evaluate() {
      return { ok: true, payload: { result: { href: "https://app.ledgerly.example/", ready: "complete" } } };
    },
    async openTab(url, label) {
      calls.push({ method: "POST", path: "/tabs/open", body: { url, label } });
      if (failOpen) return { ok: false, error: "no browser" };
      const targetId = `tab-${openTabs.length + 1}`;
      openTabs.push({ targetId, url, type: "page" });
      return { ok: true, payload: { targetId, url } };
    },
    async focusTab(targetId) {
      calls.push({ method: "POST", path: "/tabs/focus", body: { targetId } });
      return { ok: true, payload: {} };
    },
    async tabs() {
      return { ok: true, payload: { tabs: openTabs } };
    },
  };
}
