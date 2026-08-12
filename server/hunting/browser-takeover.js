// Human takeover of the OpenClaw-controlled browser.
//
// The browser runs headless inside the gateway container, so it appears on no screen the
// user can reach: Screens → Control mirrors the Mac and Windows desktops, not this browser.
// A CAPTCHA, sign-in wall, or 2FA step therefore has nowhere to be answered unless the
// browser itself is mirrored. This service does that: frames out, the user's own clicks and
// keystrokes in.
//
// It is not a CAPTCHA-solving feature and must never become one. J.A.R.V.I.S. is forbidden
// from touching a challenge (see SAFETY_RULES in job-application-runner.js); every input
// that reaches the page through here came from the person sitting in front of the UI.
//
// Frames: POST /screenshot answers with a path on the browser's filesystem, not bytes. On a
// containerised gateway that path is inside the container, but the same ~/.openclaw bind
// mount that makes uploads work makes the frame readable here (see application-artifact.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pinned so screenshot pixels, page CSS pixels, and click ratios stay in one relation.
const VIEWPORT = { width: 1024, height: 700 };
const MIN_INPUT_INTERVAL_MS = 40;
// Typing is relayed key by key, so a bounded batch keeps one request from becoming a flood.
const MAX_TYPED_CHARACTERS = 120;
const INPUT_ACTIONS = new Set(["click", "doubleClick", "type", "press", "scroll"]);
// Human inputs are spaced rather than dropped; this only bounds a misbehaving client.
const MAX_QUEUED_INPUTS = 8;

export class BrowserTakeover {
  constructor({ browser, viewport = VIEWPORT }) {
    this.browser = browser;
    this.viewport = viewport;
    this.lastInputAt = 0;
    this.pendingInputs = 0;
  }

  /** Page tabs the user can take over, newest-looking labels first. */
  async listTabs() {
    const tabs = await this.browser.tabs();
    if (!tabs.ok) throw gatewayError(tabs.error);
    return (tabs.payload?.tabs ?? [])
      .filter((tab) => tab.type === "page")
      .map((tab) => ({
        targetId: tab.targetId,
        tabId: tab.tabId ?? null,
        label: tab.label ?? null,
        title: tab.title ?? "",
        url: tab.url ?? "",
      }));
  }

  /**
   * Start a takeover: pin the viewport so later clicks land where the user aims, and return
   * the first frame together with the geometry the client maps against.
   */
  async start({ targetId, url = null }) {
    const canonicalTargetId = await this.#resolveTargetId(targetId, { url, openIfMissing: true });
    const resized = await this.browser.request("POST", "/act", {
      body: {
        targetId: canonicalTargetId,
        kind: "resize",
        width: this.viewport.width,
        height: this.viewport.height,
      },
    });
    if (!resized.ok) throw gatewayError(resized.error);
    return this.frame({ targetId: String(resized.payload?.targetId ?? canonicalTargetId) });
  }

  /** One JPEG frame as a data URL, with the viewport geometry clicks are relative to. */
  async frame({ targetId }) {
    const shot = await this.browser.request("POST", "/screenshot", {
      body: { targetId, type: "jpeg" },
    });
    if (!shot.ok) throw gatewayError(shot.error);
    const framePath = String(shot.payload?.path ?? "");
    const bytes = readBrowserMedia(framePath);
    if (!bytes) {
      throw Object.assign(
        new Error(
          `The browser saved a frame at ${framePath} that this host cannot read. Map the browser's media directory onto this host, or run the browser on this host.`,
        ),
        { statusCode: 502 },
      );
    }
    return {
      // OpenClaw accepts labels/tabIds as request references, but actions must use the
      // resolved raw target. Hand that canonical value back to the UI with every frame.
      targetId: String(shot.payload?.targetId ?? targetId),
      url: String(shot.payload?.url ?? ""),
      image: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      width: this.viewport.width,
      height: this.viewport.height,
      capturedAt: new Date().toISOString(),
    };
  }

  /**
   * Relay one human input. Coordinates arrive as ratios so the client can scale the frame
   * to any screen (phone included) without the server caring how it was displayed.
   */
  async input({ targetId, action, xRatio, yRatio, text, key, deltaY }) {
    if (!INPUT_ACTIONS.has(action)) {
      throw Object.assign(new Error("unsupported takeover input"), { statusCode: 400 });
    }
    // Validate before throttling: a malformed request should not consume the caller's slot
    // and delay the input they actually meant to send.
    const canonicalTargetId = await this.#resolveTargetId(targetId);
    const requests = this.#buildActRequests({
      targetId: canonicalTargetId,
      action,
      xRatio,
      yRatio,
      text,
      key,
      deltaY,
    });
    // Space inputs instead of rejecting them. Refusing a too-fast click silently lost it, and an
    // image-grid challenge is exactly where people click fast: a dropped tile click looks like a
    // selection that did not register, which is indistinguishable from a broken mirror. The queue
    // is still bounded, so a runaway client cannot flood the browser.
    if (this.pendingInputs >= MAX_QUEUED_INPUTS) {
      throw Object.assign(new Error("Manual input is arriving too quickly"), { statusCode: 429 });
    }
    this.pendingInputs += 1;
    try {
      const gap = MIN_INPUT_INTERVAL_MS - (Date.now() - this.lastInputAt);
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
      this.lastInputAt = Date.now();
    } finally {
      this.pendingInputs -= 1;
    }

    let url = "";
    let currentTargetId = canonicalTargetId;
    for (const request of requests) {
      const result = await this.browser.request("POST", "/act", {
        body: { ...request, targetId: currentTargetId },
      });
      if (!result.ok) throw gatewayError(result.error);
      url = String(result.payload?.url ?? url);
      currentTargetId = String(result.payload?.targetId ?? currentTargetId);
    }
    return { targetId: currentTargetId, url, action, steps: requests.length };
  }

  /** Reload or move the mirrored tab; a solved challenge often needs the page re-requested. */
  async navigate({ targetId, url }) {
    const result = await this.browser.request("POST", "/navigate", { body: { targetId, url } });
    if (!result.ok) throw gatewayError(result.error);
    return {
      targetId: String(result.payload?.targetId ?? targetId),
      url: String(result.payload?.url ?? url),
    };
  }

  /** Resolve an agent-friendly tab label/id to the raw target required inside /act. */
  async #resolveTargetId(targetId, { url = null, openIfMissing = false } = {}) {
    const tabs = await this.browser.tabs();
    if (!tabs.ok) throw gatewayError(tabs.error);
    const pages = (tabs.payload?.tabs ?? []).filter((tab) => tab.type === "page");
    const exact = pages.find(
      (tab) =>
        tab.targetId === targetId ||
        tab.suggestedTargetId === targetId ||
        tab.tabId === targetId ||
        tab.label === targetId,
    );
    if (exact) return exact.targetId;
    const normalizedTargetId = targetId.toLowerCase();
    const prefixMatches = pages.filter((tab) =>
      tab.targetId.toLowerCase().startsWith(normalizedTargetId),
    );
    if (prefixMatches.length === 1) return prefixMatches[0].targetId;
    const wantedUrl = safeHttpUrl(url);
    if (wantedUrl) {
      const matchingPage =
        pages.find((tab) => samePage(tab.url, wantedUrl)) ??
        pages.find((tab) => safeHttpUrl(tab.url)?.hostname === wantedUrl.hostname);
      if (matchingPage) return matchingPage.targetId;
      if (openIfMissing) {
        const opened = await this.browser.openTab(wantedUrl.href, "jarvis-human-takeover");
        if (!opened.ok) throw gatewayError(opened.error);
        const openedTargetId = String(opened.payload?.targetId ?? "").trim();
        if (openedTargetId) return openedTargetId;
        throw Object.assign(new Error("browser opened the application without a target id"), {
          statusCode: 502,
        });
      }
    }
    throw Object.assign(new Error(`browser tab not found: ${targetId}`), { statusCode: 404 });
  }

  /**
   * One human input becomes one or more act requests.
   *
   * Typing is a sequence of key presses rather than the act `type` kind, because `type`
   * requires a ref or selector and so cannot reach whatever the user just clicked into —
   * including a field inside a challenge iframe. `press` goes through the keyboard, which is
   * both ref-free and what a human actually does.
   */
  #buildActRequests({ targetId, action, xRatio, yRatio, text, key, deltaY }) {
    if (action === "type") {
      const value = String(text ?? "");
      if (!value) throw Object.assign(new Error("text is required"), { statusCode: 400 });
      if (value.length > MAX_TYPED_CHARACTERS) {
        throw Object.assign(new Error(`type at most ${MAX_TYPED_CHARACTERS} characters at a time`), {
          statusCode: 400,
        });
      }
      return [...value].map((character) => ({ targetId, kind: "press", key: keyForCharacter(character) }));
    }
    if (action === "press") {
      const value = String(key ?? "");
      if (!value) throw Object.assign(new Error("key is required"), { statusCode: 400 });
      return [{ targetId, kind: "press", key: value }];
    }
    if (action === "scroll") {
      // The act contract has no scroll kind, so a scroll is expressed as the key that does it.
      const amount = Number(deltaY) || 0;
      return [{ targetId, kind: "press", key: amount < 0 ? "PageUp" : "PageDown" }];
    }
    return [
      {
        targetId,
        kind: "clickCoords",
        x: ratioToPixels(xRatio, this.viewport.width),
        y: ratioToPixels(yRatio, this.viewport.height),
        ...(action === "doubleClick" ? { doubleClick: true } : {}),
      },
    ];
  }
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function samePage(value, wanted) {
  const candidate = safeHttpUrl(value);
  return (
    candidate?.hostname.toLowerCase().replace(/^www\./, "") ===
      wanted.hostname.toLowerCase().replace(/^www\./, "") &&
    candidate.pathname.replace(/\/+$/, "") === wanted.pathname.replace(/\/+$/, "")
  );
}

/** Playwright takes single characters as key names; whitespace needs its key name. */
function keyForCharacter(character) {
  if (character === " ") return "Space";
  if (character === "\t") return "Tab";
  if (character === "\n") return "Enter";
  return character;
}

/**
 * Read a frame the browser wrote, and drop it afterwards so mirroring does not fill the
 * media directory. Same-host installs hit the direct path; a containerised browser is
 * reached by rewriting whatever precedes `/.openclaw/` to this host's config directory.
 */
export function readBrowserMedia(framePath, { homeDir = os.homedir() } = {}) {
  for (const candidate of browserMediaCandidates(framePath, homeDir)) {
    try {
      const bytes = fs.readFileSync(candidate);
      // Only ever remove the frame we just captured, inside the browser media directory.
      if (candidate.includes(`${path.sep}media${path.sep}browser${path.sep}`)) {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // A frame we cannot delete is harmless; the bytes are already in hand.
        }
      }
      return bytes;
    } catch {
      // Try the next candidate location.
    }
  }
  return null;
}

export function browserMediaCandidates(framePath, homeDir = os.homedir()) {
  const raw = String(framePath ?? "");
  if (!raw) return [];
  const marker = "/.openclaw/";
  const index = raw.indexOf(marker);
  if (index < 0) return [raw];
  const relative = raw.slice(index + marker.length);
  return [raw, path.join(homeDir, ".openclaw", relative)];
}

function ratioToPixels(ratio, extent) {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw Object.assign(new Error("click coordinates must be ratios between 0 and 1"), {
      statusCode: 400,
    });
  }
  return Math.max(0, Math.min(extent - 1, Math.round(value * extent)));
}

function gatewayError(message) {
  const text = String(message ?? "browser control failed");
  // A tab that has gone away is worth distinguishing: the UI re-lists tabs on 404.
  const statusCode = /tab|target/i.test(text) && /not found|unknown|closed/i.test(text) ? 404 : 502;
  return Object.assign(new Error(text), { statusCode });
}
