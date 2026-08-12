import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserTakeover, browserMediaCandidates, readBrowserMedia } from "./browser-takeover.js";
import { waitForPageReady } from "./browser-control.js";

test("starting a takeover pins the viewport before the first frame", async () => {
  // Clicks arrive as ratios, so the viewport has to be a known size for them to land.
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  const frame = await takeover.start({ targetId: "T1" });
  const resize = browser.calls.find((call) => call.body?.kind === "resize");
  assert.deepEqual(resize.body, { targetId: "T1", kind: "resize", width: 1024, height: 700 });
  assert.equal(frame.width, 1024);
  assert.equal(frame.height, 700);
  assert.match(frame.image, /^data:image\/jpeg;base64,/);
  assert.equal(frame.url, "https://example.com/challenge");
});

test("starting with a saved tab alias resolves it before the first action", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  const frame = await takeover.start({ targetId: "apply" });
  assert.equal(frame.targetId, "T1");
  assert.deepEqual(browser.calls.find((call) => call.body?.kind === "resize").body, {
    targetId: "T1",
    kind: "resize",
    width: 1024,
    height: 700,
  });
});

test("a stale saved target rebinds to the live tab with the same application URL", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  const frame = await takeover.start({
    targetId: "CLOSED-TARGET",
    url: "https://example.com/challenge",
  });
  assert.equal(frame.targetId, "T1");
  assert.equal(browser.calls.some((call) => call.path === "/tabs/open"), false);
});

test("a stale saved target reopens the application when no controlled tab remains", async () => {
  const browser = fakeBrowser({ pageTabs: [], openedTargetId: "T2" });
  const takeover = new BrowserTakeover({ browser });
  const frame = await takeover.start({
    targetId: "CLOSED-TARGET",
    url: "https://jobs.example.com/monzo/apply",
  });
  assert.equal(frame.targetId, "T2");
  assert.deepEqual(browser.calls.find((call) => call.path === "/tabs/open"), {
    method: "POST",
    path: "/tabs/open",
    body: { url: "https://jobs.example.com/monzo/apply", label: "jarvis-human-takeover" },
  });
});

test("a click ratio becomes a coordinate inside the pinned viewport", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  await takeover.input({ targetId: "T1", action: "click", xRatio: 0.5, yRatio: 0.25 });
  const click = browser.calls.at(-1).body;
  assert.deepEqual(click, { targetId: "T1", kind: "clickCoords", x: 512, y: 175 });

  // Edges stay inside the viewport rather than one pixel past it.
  const edge = new BrowserTakeover({ browser: fakeBrowser() });
  await edge.input({ targetId: "T1", action: "click", xRatio: 1, yRatio: 1 });
  assert.deepEqual(edge.browser.calls.at(-1).body, { targetId: "T1", kind: "clickCoords", x: 1023, y: 699 });
});

test("input resolves a saved tab alias before sending a mutating action", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  await takeover.input({ targetId: "apply", action: "click", xRatio: 0.5, yRatio: 0.25 });
  assert.deepEqual(browser.calls.at(-1).body, {
    targetId: "T1",
    kind: "clickCoords",
    x: 512,
    y: 175,
  });
});

test("coordinates outside the frame are refused, without consuming the throttle slot", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  await assert.rejects(() => takeover.input({ targetId: "T1", action: "click", xRatio: 1.4, yRatio: 0.5 }), /ratios/);
  await assert.rejects(() => takeover.input({ targetId: "T1", action: "click", xRatio: -0.1, yRatio: 0.5 }), /ratios/);
  assert.equal(browser.calls.length, 0);
  // A rejected request must not delay the input the user actually meant.
  await takeover.input({ targetId: "T1", action: "click", xRatio: 0.5, yRatio: 0.5 });
  assert.equal(browser.calls.length, 1);
});

test("typing, key presses, and scrolling map onto the act contract", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  // The act `type` kind needs a ref or selector, so it cannot reach whatever the user clicked
  // into. Typing therefore goes through the keyboard, one key at a time.
  const typed = await takeover.input({ targetId: "T1", action: "type", text: "hi you" });
  assert.equal(typed.steps, 6);
  assert.equal(typed.targetId, "T1");
  assert.deepEqual(
    browser.calls.map((call) => call.body.key),
    ["h", "i", "Space", "y", "o", "u"],
  );
  assert.equal(browser.calls.every((call) => call.body.kind === "press"), true);
  await pause();
  await takeover.input({ targetId: "T1", action: "press", key: "Enter" });
  assert.deepEqual(browser.calls.at(-1).body, { targetId: "T1", kind: "press", key: "Enter" });
  await pause();
  // The act contract has no scroll kind, so scrolling is expressed as the key that does it.
  await takeover.input({ targetId: "T1", action: "scroll", deltaY: 1 });
  assert.deepEqual(browser.calls.at(-1).body, { targetId: "T1", kind: "press", key: "PageDown" });
  await pause();
  await takeover.input({ targetId: "T1", action: "scroll", deltaY: -1 });
  assert.deepEqual(browser.calls.at(-1).body, { targetId: "T1", kind: "press", key: "PageUp" });
});

test("unsupported or incomplete input is rejected before it reaches the browser", async () => {
  const browser = fakeBrowser();
  const takeover = new BrowserTakeover({ browser });
  await assert.rejects(() => takeover.input({ targetId: "T1", action: "evaluate" }), /unsupported/);
  await assert.rejects(() => takeover.input({ targetId: "T1", action: "type", text: "" }), /text is required/);
  await assert.rejects(() => takeover.input({ targetId: "T1", action: "press", key: "" }), /key is required/);
  await assert.rejects(
    () => takeover.input({ targetId: "T1", action: "type", text: "x".repeat(200) }),
    /at most 120 characters/,
  );
  assert.equal(browser.calls.length, 0);
});

test("a burst of human input is spaced rather than dropped", async () => {
  // Rejecting the second fast input lost it silently, which on an image-grid challenge looks like
  // a tile that will not select. Inputs are now spaced instead; only a flood is refused.
  const takeover = new BrowserTakeover({ browser: fakeBrowser() });
  const started = Date.now();
  await takeover.input({ targetId: "T1", action: "press", key: "Enter" });
  await takeover.input({ targetId: "T1", action: "press", key: "Enter" });
  // Spacing means the second call waited its turn rather than failing.
  assert.ok(Date.now() - started >= 35, "the second input was spaced, not rejected");
});

test("a runaway client is still refused", async () => {
  // The flood protection has to survive: only its shape changed, from "drop" to "bound the queue".
  const takeover = new BrowserTakeover({ browser: fakeBrowser() });
  const results = await Promise.allSettled(
    Array.from({ length: 24 }, () => takeover.input({ targetId: "T1", action: "press", key: "Enter" })),
  );
  const refused = results.filter((r) => r.status === "rejected");
  assert.ok(refused.length > 0, "a 24-deep burst is not accepted wholesale");
  assert.equal(refused[0].reason.statusCode, 429);
});

test("only page tabs are offered for takeover", async () => {
  const takeover = new BrowserTakeover({ browser: fakeBrowser() });
  assert.deepEqual(await takeover.listTabs(), [
    { targetId: "T1", tabId: "t1", label: "apply", title: "Challenge", url: "https://example.com/challenge" },
  ]);
});

test("a closed tab surfaces as 404 so the UI can re-list tabs", async () => {
  const browser = fakeBrowser({ actError: "tab not found" });
  const takeover = new BrowserTakeover({ browser });
  await assert.rejects(
    () => takeover.input({ targetId: "gone", action: "press", key: "Enter" }),
    (error) => {
      assert.equal(error.statusCode, 404);
      return true;
    },
  );
});

test("an unreadable frame explains the locality problem instead of returning nothing", async () => {
  const browser = fakeBrowser({ framePath: "/home/node/.openclaw/media/browser/missing.jpg", writeFrame: false });
  const takeover = new BrowserTakeover({ browser });
  await assert.rejects(() => takeover.frame({ targetId: "T1" }), /cannot read.*Map the browser's media directory/s);
});

test("frames are found through the shared config directory and removed after reading", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-takeover-"));
  try {
    const dir = path.join(home, ".openclaw", "media", "browser");
    fs.mkdirSync(dir, { recursive: true });
    const hostPath = path.join(dir, "frame.jpg");
    fs.writeFileSync(hostPath, Buffer.from([0xff, 0xd8, 0xff]));

    // The browser reports its own container path; the host reaches it via ~/.openclaw.
    const bytes = readBrowserMedia("/home/node/.openclaw/media/browser/frame.jpg", { homeDir: home });
    assert.equal(bytes.length, 3);
    assert.equal(fs.existsSync(hostPath), false, "the frame should not accumulate in media");

    assert.deepEqual(browserMediaCandidates("/home/node/.openclaw/media/browser/x.jpg", "/Users/example"), [
      "/home/node/.openclaw/media/browser/x.jpg",
      "/Users/example/.openclaw/media/browser/x.jpg",
    ]);
    assert.deepEqual(browserMediaCandidates("/var/other/x.jpg", "/Users/example"), ["/var/other/x.jpg"]);
    assert.deepEqual(browserMediaCandidates("", "/Users/example"), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 45));
}

function fakeBrowser({
  framePath = null,
  writeFrame = true,
  actError = null,
  pageTabs = null,
  openedTargetId = "T2",
} = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-frames-"));
  const dir = path.join(home, ".openclaw", "media", "browser");
  fs.mkdirSync(dir, { recursive: true });
  const resolved = framePath ?? path.join(dir, "frame.jpg");
  if (writeFrame) fs.writeFileSync(resolved, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  const calls = [];
  return {
    calls,
    async tabs() {
      return {
        ok: true,
        payload: {
          tabs: pageTabs ?? [
            {
              targetId: "T1",
              suggestedTargetId: "apply",
              tabId: "t1",
              label: "apply",
              title: "Challenge",
              url: "https://example.com/challenge",
              type: "page",
            },
            { targetId: "W1", tabId: "t2", title: "worker", url: "https://example.com/w.js", type: "worker" },
          ],
        },
      };
    },
    async openTab(url, label) {
      calls.push({ method: "POST", path: "/tabs/open", body: { url, label } });
      return { ok: true, payload: { targetId: openedTargetId, url } };
    },
    async request(method, requestPath, { body } = {}) {
      calls.push({ method, path: requestPath, body });
      if (requestPath === "/screenshot") {
        return {
          ok: true,
          payload: {
            ok: true,
            path: resolved,
            targetId: body?.targetId ?? "T1",
            url: "https://example.com/challenge",
          },
        };
      }
      if (actError) return { ok: false, error: actError };
      return { ok: true, payload: { ok: true, url: "https://example.com/challenge" } };
    },
  };
}

test("a page that is still navigating is waited for, not read as an empty form", async () => {
  // Real desktop Chrome navigates slower than the headless container browser; a read taken
  // too early caught chrome://new-tab-page and looked like a form with no fields.
  let call = 0;
  const browser = {
    async evaluate() {
      call += 1;
      if (call === 1) return { ok: true, payload: { result: { href: "chrome://new-tab-page/", ready: "loading" } } };
      return { ok: true, payload: { result: { href: "https://jobs.example.com/apply", ready: "complete" } } };
    },
  };
  assert.equal(await waitForPageReady(browser, { targetId: "T1", timeoutMs: 3000, pollMs: 10 }), true);
  assert.equal(call, 2);

  const stuck = { async evaluate() { return { ok: true, payload: { result: { href: "chrome://new-tab-page/", ready: "loading" } } }; } };
  assert.equal(await waitForPageReady(stuck, { targetId: "T1", timeoutMs: 60, pollMs: 10 }), false);

  // Page evaluation being switched off is not a loading problem.
  const noEvaluate = { async evaluate() { return { ok: false, error: "browser evaluate is disabled by configuration" }; } };
  assert.equal(await waitForPageReady(noEvaluate, { targetId: "T1", timeoutMs: 60, pollMs: 10 }), true);
});

test("fast human clicks are spaced, not dropped", async () => {
  // An image-grid challenge is clicked fast. Rejecting a too-fast click lost it silently, which
  // looks exactly like a tile that would not select — the mirror gets blamed for a dropped input.
  const acts = [];
  const browser = fakeBrowser();
  const request = browser.request.bind(browser);
  browser.request = async (method, path, options) => {
    if (path === "/act") acts.push(options.body);
    return request(method, path, options);
  };
  const takeover = new BrowserTakeover({ browser });
  const clicks = await Promise.all(
    [0.2, 0.4, 0.6, 0.8].map((xRatio) =>
      takeover.input({ targetId: "T1", action: "click", xRatio, yRatio: 0.5 }),
    ),
  );
  assert.equal(clicks.length, 4);
  const relayed = acts.filter((body) => body.kind === "clickCoords");
  assert.equal(relayed.length, 4, "every click reached the page");
  // Each landed at its own x, so none was collapsed into another.
  assert.equal(new Set(relayed.map((body) => body.x)).size, 4);
});
