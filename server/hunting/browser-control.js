// Deterministic access to the OpenClaw-controlled browser from BFF code.
//
// The gateway exposes the browser control server through the `browser.request`
// method (operator.admin scope), which the BFF already holds. Everything here is a
// plain request/response pair so upload and verification decisions stay in JavaScript
// instead of being delegated to a model that can only describe what it clicked.
//
// Verified against openclaw 2026.6.11 (extensions/browser):
//   POST /tabs/open            { url, label }             -> tab descriptor
//   POST /tabs/focus           { targetId }
//   GET  /snapshot             ?targetId&format&maxChars   -> { snapshot | nodes }
//   POST /act                  { targetId, kind, ... }     -> { result }
//   POST /hooks/file-chooser   { targetId, inputRef|element|ref, paths } -> { ok: true }
// /hooks/file-chooser with inputRef or element binds the file directly
// (Playwright setInputFiles); with ref alone it arms the chooser and then clicks.
const BROWSER_GATEWAY_METHOD = "browser.request";
// The gateway's node invoke also defaults to 30s, so a call proxied to a real desktop Chrome
// (slower than headless, and file bytes may cross the proxy) hit "node invoke timed out" on
// uploads. The value below is passed through as the node invoke timeout too.
const DEFAULT_TIMEOUT_MS = Number(process.env.JARVIS_BROWSER_TIMEOUT_MS) || 120_000;

export class BrowserControl {
  constructor({ gateway, profile = null, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.gateway = gateway;
    this.profile = profile || null;
    this.timeoutMs = timeoutMs;
  }

  /** Closed result shape: callers classify `error` instead of catching exceptions. */
  async request(method, path, { query = undefined, body = undefined, timeoutMs } = {}) {
    const mergedQuery = this.profile ? { profile: this.profile, ...(query ?? {}) } : query;
    try {
      const payload = await this.gateway.request(BROWSER_GATEWAY_METHOD, {
        method,
        path,
        query: mergedQuery,
        body,
        timeoutMs: timeoutMs ?? this.timeoutMs,
      });
      return { ok: true, payload };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  status() {
    return this.request("GET", "/doctor");
  }

  tabs() {
    return this.request("GET", "/tabs");
  }

  openTab(url, label) {
    return this.request("POST", "/tabs/open", { body: { url, label } });
  }

  navigateTab(targetId, url) {
    return this.request("POST", "/navigate", { body: { targetId, url } });
  }

  /** DELETE /tabs/:targetId in the browser plugin's tab routes. */
  closeTab(targetId) {
    return this.request("DELETE", `/tabs/${encodeURIComponent(targetId)}`);
  }

  focusTab(targetId) {
    return this.request("POST", "/tabs/focus", { body: { targetId } });
  }

  snapshot({ targetId, maxChars = 6_000, interactive = false }) {
    return this.request("GET", "/snapshot", {
      query: { targetId, format: "ai", maxChars, ...(interactive ? { interactive: true } : {}) },
    });
  }

  /**
   * Page-side reads used for upload targeting and postcondition proof. Evaluate is
   * config-gated in the browser plugin, so every caller must handle it being refused.
   */
  evaluate({ targetId, fn, timeoutMs }) {
    return this.request("POST", "/act", { body: { targetId, kind: "evaluate", fn }, timeoutMs });
  }

  /** Bind files straight to a file input. `element` is a CSS selector, `inputRef` a snapshot ref. */
  setInputFiles({ targetId, inputRef = undefined, element = undefined, paths }) {
    return this.request("POST", "/hooks/file-chooser", {
      body: { targetId, inputRef, element, paths },
    });
  }

  /**
   * Arm the native file chooser, then click the control that opens it. Only for forms
   * that create their file input on demand; the caller still has to verify the result.
   */
  armFileChooserAndClick({ targetId, ref, paths, timeoutMs = 15_000 }) {
    return this.request("POST", "/hooks/file-chooser", {
      body: { targetId, ref, paths, timeoutMs },
    });
  }
}

/**
 * Wait until the tab has actually finished loading before reading it.
 *
 * A real desktop Chrome navigates far slower than the headless container browser: a read taken
 * straight after opening a tab caught `chrome://new-tab-page` and reported a form with no
 * fields. Returns false when the page never settles, so the caller can say so rather than
 * treat an empty read as an empty form.
 */
export async function waitForPageReady(browser, { targetId, timeoutMs = 15_000, pollMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await browser.evaluate({
      targetId,
      fn: "() => ({ href: location.href, ready: document.readyState })",
    });
    const result = probe.ok ? probe.payload?.result : null;
    // Page evaluation being unavailable is not a loading problem; let the caller proceed.
    if (!probe.ok) return true;
    if (result?.ready === "complete" && safeUrlParts(result.href)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/**
 * Open or recover the application tab through the same BFF browser route used by uploads.
 * The returned target is server-owned; model-reported targets never replace it.
 */
export async function openApplicationTab(browser, { url, label, existingTargetId = null }) {
  if (existingTargetId) {
    // Confirms one specific tab still exists; it never discovers a new one. Adoption is off by
    // default now, which is what stops a resumed Quantexa/Ashby run from being handed LinkedIn's
    // "Apply to Venn Apps" form because that tab happened to be open and ranked well.
    const existing = await resolveTabTarget(browser, { targetId: existingTargetId, url });
    if (existing.ok) {
      const focused = await browser.focusTab(existing.targetId);
      if (!focused.ok) return { ok: false, error: focused.error };
      return { ok: true, targetId: existing.targetId, currentUrl: url, reused: true };
    }
  }

  const opened = await browser.openTab(url, label);
  if (!opened.ok) return { ok: false, error: opened.error };
  let openedTargetId = String(opened.payload?.targetId ?? "").trim();
  if (!openedTargetId) return { ok: false, error: "browser did not return an application tab target" };

  let currentUrl = String(opened.payload?.url ?? "").trim();
  // A browser node can create the page before its first navigation resolves. `about:blank` is a
  // valid browser tab but never a valid application form, so finish navigation before handing it
  // to the model; otherwise every tool action stays trapped in the empty bootstrap page.
  if (!safeUrlParts(currentUrl)) {
    const navigated = await browser.navigateTab(openedTargetId, url);
    if (!navigated.ok) {
      return { ok: false, error: `browser opened a blank application tab and could not navigate it: ${navigated.error}` };
    }
    openedTargetId = String(navigated.payload?.targetId ?? openedTargetId).trim();
    currentUrl = String(navigated.payload?.url ?? url).trim();
  }
  await waitForPageReady(browser, { targetId: openedTargetId });
  // Confirms the tab we just opened, so it must never return a different one.
  const resolved = await resolveTabTarget(browser, { targetId: openedTargetId, url: currentUrl });
  return resolved.ok
    ? { ok: true, targetId: resolved.targetId, currentUrl, reused: false }
    : { ok: false, error: resolved.error };
}

/**
 * A redirected ATS URL can be resumed only while no other application owns it.
 * This rejects a polluted checkpoint without rejecting legitimate LinkedIn/Indeed handoffs.
 */
export function selectApplicationStartUrl({ jobUrl, currentUrl, resume, otherApplicationUrls = [] }) {
  if (!resume || !currentUrl) return jobUrl;
  const currentKey = canonicalTabUrl(currentUrl);
  const claimedElsewhere = new Set(otherApplicationUrls.map(canonicalTabUrl).filter(Boolean));
  return currentKey && !claimedElsewhere.has(currentKey) ? currentUrl : jobUrl;
}

/**
 * Confirm the tab the model reported still exists, else find the open tab whose URL host and
 * path match the listing. A wrong targetId would otherwise send upload calls to some other
 * page, so this stays a lookup against live tabs rather than trust in the reported value.
 */
/**
 * Find the tab this application should run in, adopting an employer tab the Apply click opened.
 *
 * Adoption — taking a tab this call did not start with — is OPT IN via `canAdopt`, and defaults to
 * off. It was opt-out, and that default caused the same bug three times in three call sites: a
 * caller that only wanted to confirm one tab silently received a different application's form
 * instead. Only a caller holding a pre-click tab baseline can tell a newly opened employer tab from
 * a leftover one, so only that caller may ask for it.
 *
 * `waitForNewTabMs` exists because the old single read lost the employer tab in 11 of 26 runs:
 * LinkedIn's Apply goes through a tracking redirect before the ATS page becomes a real tab, and
 * the model's turn ends before that finishes. One instantaneous read is the same mistake as
 * treating `document.readyState === "complete"` as "the form is mounted".
 */
export async function resolveTabTarget(
  browser,
  { targetId, url, knownTargetIds = [], waitForNewTabMs = 0, pollMs = 500, canAdopt = false, excludeUrls = [] },
) {
  const known = new Set(knownTargetIds.filter(Boolean));
  const deadline = Date.now() + Math.max(0, waitForNewTabMs);
  let tabs = await browser.tabs();
  if (!tabs.ok) return { ok: false, error: tabs.error };
  let pages = pageTabs(tabs);
  // Only wait when the caller expects a new tab and none has appeared yet.
  while (waitForNewTabMs > 0 && !pages.some((tab) => !known.has(tab.targetId)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    tabs = await browser.tabs();
    if (!tabs.ok) return { ok: false, error: tabs.error };
    pages = pageTabs(tabs);
  }
  const wanted = safeUrlParts(url);
  const redirected = pages.filter((tab) => !known.has(tab.targetId));
  // An aggregator's Apply button can open the employer form in a new tab, sometimes alongside an
  // interstitial. Rank the candidates instead of requiring exactly one: demanding a single new tab
  // meant any extra tab abandoned the adoption and the run reported "no form on the page".
  // canAdopt is false when the tab baseline could not be read: without it there is no way to tell
  // a tab this click opened from one left over by an earlier application, and guessing filled a
  // different company's form while the listing tab sat untouched.
  const adopted = canAdopt ? bestRedirectedTab({ redirected, wanted, excludeUrls }) : null;
  if (adopted) return { ok: true, targetId: adopted.targetId, redirected: true };
  if (targetId && pages.some((tab) => tab.targetId === targetId && safeUrlParts(tab.url))) {
    return { ok: true, targetId };
  }
  const match = wanted
    ? pages.find((tab) => {
        const parts = safeUrlParts(tab.url);
        return parts && parts.host === wanted.host && parts.path === wanted.path;
      }) ?? pages.find((tab) => safeUrlParts(tab.url)?.host === wanted.host)
    : undefined;
  return match
    ? { ok: true, targetId: match.targetId, recovered: true }
    : { ok: false, error: "no open browser tab matches this application" };
}

/** Host + path, so a tracking query string cannot hide a tab that belongs elsewhere. */
function canonicalTabUrl(value) {
  const parts = safeUrlParts(value);
  return parts ? `${parts.host}${parts.path}` : null;
}

function pageTabs(tabs) {
  return (tabs.payload?.tabs ?? []).filter((tab) => tab.type === "page");
}

// Hosts that hand off to an employer form rather than hosting it. A new tab on one of these is a
// staging step, so it loses to a genuine employer tab when both are open.
const HANDOFF_HOSTS = ["linkedin.com", "indeed.com", "indeed.co.uk", "glassdoor.com", "google.com"];

/**
 * Pick the employer tab out of everything the Apply click opened.
 *
 * Highest score wins, so an extra interstitial no longer defeats adoption. The listing's own host
 * scores lowest: a second LinkedIn tab is never the employer form.
 */
function bestRedirectedTab({ redirected, wanted, excludeUrls = [] }) {
  // Another application's form is never this application's form, however new the tab looks.
  const excluded = new Set(
    excludeUrls.map((value) => canonicalTabUrl(value)).filter(Boolean),
  );
  const scored = redirected
    .map((tab) => ({ tab, parts: safeUrlParts(tab.url) }))
    // about:blank and chrome:// tabs are the browser's own, never an application form.
    .filter((entry) => entry.parts)
    .filter((entry) => !excluded.has(canonicalTabUrl(entry.tab.url)))
    .map((entry) => {
      let score = 1;
      if (wanted && entry.parts.host === wanted.host) {
        // Same host: only the exact listing path is worth adopting, and even then it is a fallback.
        score = entry.parts.path === wanted.path ? 2 : 0;
      } else if (HANDOFF_HOSTS.some((host) => entry.parts.host === host || entry.parts.host.endsWith(`.${host}`))) {
        score = 1;
      } else {
        // A different, non-aggregator host is the employer's ATS.
        score = 3;
      }
      return { ...entry, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  return scored[0]?.tab ?? null;
}

function safeUrlParts(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { host: url.hostname.toLowerCase().replace(/^www\./, ""), path: url.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/** True when the browser plugin refused an evaluate call rather than failing to run it. */
export function isEvaluateDisabledError(error) {
  return /evaluate.*(disabled|not enabled)|browser_evaluate_disabled/i.test(String(error ?? ""));
}
