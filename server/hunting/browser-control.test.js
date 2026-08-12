import assert from "node:assert/strict";
import test from "node:test";
import { openApplicationTab, resolveTabTarget, selectApplicationStartUrl } from "./browser-control.js";

test("the server opens and owns a new application tab", async () => {
  const browser = fakeBrowser();
  const result = await openApplicationTab(browser, {
    url: "https://job-boards.greenhouse.io/example/jobs/123",
    label: "hunting-job-1",
  });

  assert.deepEqual(result, {
    ok: true,
    targetId: "SERVER-TARGET",
    currentUrl: "https://job-boards.greenhouse.io/example/jobs/123",
    reused: false,
  });
  assert.deepEqual(browser.opened, [{ url: result.currentUrl, label: "hunting-job-1" }]);
});

test("a blank browser bootstrap tab is navigated before an application run owns it", async () => {
  const browser = fakeBrowser({ openedUrl: "about:blank" });
  const result = await openApplicationTab(browser, {
    url: "https://jobs.example.com/apply",
    label: "hunting-job-blank-tab",
  });

  assert.deepEqual(browser.navigated, [{ targetId: "SERVER-TARGET", url: "https://jobs.example.com/apply" }]);
  assert.equal(result.targetId, "SERVER-TARGET");
  assert.equal(result.currentUrl, "https://jobs.example.com/apply");
});

test("a resume reuses and focuses the server-owned target", async () => {
  const browser = fakeBrowser();
  const result = await openApplicationTab(browser, {
    url: "https://jobs.example.com/apply",
    label: "hunting-job-1",
    existingTargetId: "SERVER-TARGET",
  });

  assert.equal(result.reused, true);
  assert.deepEqual(browser.focused, ["SERVER-TARGET"]);
  assert.deepEqual(browser.opened, []);
});

test("an unavailable saved target is recovered from a matching live application tab", async () => {
  const browser = fakeBrowser({ initialTargetId: "OTHER-TARGET" });
  const result = await openApplicationTab(browser, {
    url: "https://jobs.example.com/apply",
    label: "hunting-job-1",
    existingTargetId: "CLOSED-TARGET",
  });

  assert.equal(result.targetId, "OTHER-TARGET");
  assert.equal(result.reused, true);
  assert.deepEqual(browser.focused, ["OTHER-TARGET"]);
  assert.equal(browser.opened.length, 0);
});

test("a resume never reopens a form URL already owned by another application", () => {
  const jobUrl = "https://jobs.ashbyhq.com/trainline/role-1";
  const staleUrl = "https://job-boards.greenhouse.io/mthree/jobs/9";
  assert.equal(
    selectApplicationStartUrl({
      jobUrl,
      currentUrl: staleUrl,
      resume: true,
      otherApplicationUrls: [`${staleUrl}?gh_src=old`],
    }),
    jobUrl,
  );
  assert.equal(
    selectApplicationStartUrl({
      jobUrl,
      currentUrl: "https://jobs.ashbyhq.com/trainline/role-1/application",
      resume: true,
      otherApplicationUrls: [staleUrl],
    }),
    "https://jobs.ashbyhq.com/trainline/role-1/application",
  );
});

test("a newly opened employer tab is adopted after an aggregator Apply click", async () => {
  const browser = fakeBrowser({
    tabs: [
      { type: "page", targetId: "LINKEDIN", url: "https://www.linkedin.com/jobs/view/1" },
      { type: "page", targetId: "ASHBY", url: "https://jobs.ashbyhq.com/example/apply" },
    ],
  });
  const result = await resolveTabTarget(browser, {
    targetId: "LINKEDIN",
    url: "https://jobs.ashbyhq.com/example/apply",
    knownTargetIds: ["LINKEDIN"],
    // The handoff after an Apply click is the one caller allowed to adopt, and it must ask.
    canAdopt: true,
  });
  assert.deepEqual(result, { ok: true, targetId: "ASHBY", redirected: true });
});

function fakeBrowser({ initialTargetId = "SERVER-TARGET", tabs = null, openedUrl = null } = {}) {
  const browser = {
    currentTargetId: initialTargetId,
    currentUrl: "https://jobs.example.com/apply",
    opened: [],
    navigated: [],
    focused: [],
    async tabs() {
      return {
        ok: true,
        payload: {
          tabs: tabs ?? [
            {
              type: "page",
              targetId: this.currentTargetId,
              url: this.currentUrl,
            },
          ],
        },
      };
    },
    async openTab(url, label) {
      this.opened.push({ url, label });
      this.currentTargetId = "SERVER-TARGET";
      this.currentUrl = openedUrl ?? url;
      return { ok: true, payload: { targetId: this.currentTargetId, url: this.currentUrl } };
    },
    async navigateTab(targetId, url) {
      this.navigated.push({ targetId, url });
      this.currentTargetId = targetId;
      this.currentUrl = url;
      return { ok: true, payload: { targetId, url } };
    },
    async focusTab(targetId) {
      this.focused.push(targetId);
      return { ok: true, payload: { targetId } };
    },
    async evaluate() {
      return {
        ok: true,
        payload: { result: { href: this.currentUrl, ready: "complete" } },
      };
    },
  };
  return browser;
}

test("the employer tab is adopted even when the Apply click also opened an interstitial", () => {
  // Live failure, 11 of 26 runs: requiring exactly one new tab meant any extra tab abandoned the
  // adoption and the run reported "no application fields are visible" while the form sat in a tab.
  return withTabs(
    [
      { type: "page", targetId: "LISTING", url: "https://www.linkedin.com/jobs/view/1" },
      { type: "page", targetId: "TRACKER", url: "https://www.linkedin.com/jobs/apply-redirect/1" },
      { type: "page", targetId: "EMPLOYER", url: "https://job-boards.greenhouse.io/acme/jobs/9" },
    ],
    async (browser) => {
      const resolved = await resolveTabTarget(browser, {
        targetId: "LISTING",
        url: "https://www.linkedin.com/jobs/view/1",
        knownTargetIds: ["LISTING"],
        canAdopt: true,
      });
      // The ATS host wins over a second aggregator tab.
      assert.deepEqual(resolved, { ok: true, targetId: "EMPLOYER", redirected: true });
    },
  );
});

test("a second tab on the listing's own host is never mistaken for the employer form", async () => {
  await withTabs(
    [
      { type: "page", targetId: "LISTING", url: "https://www.linkedin.com/jobs/view/1" },
      { type: "page", targetId: "FEED", url: "https://www.linkedin.com/feed/" },
    ],
    async (browser) => {
      const resolved = await resolveTabTarget(browser, {
        targetId: "LISTING",
        url: "https://www.linkedin.com/jobs/view/1",
        knownTargetIds: ["LISTING"],
      });
      assert.equal(resolved.targetId, "LISTING");
      assert.notEqual(resolved.redirected, true);
    },
  );
});

test("a slow handoff is waited for instead of read once and lost", async () => {
  // The tracking redirect can finish after the model's turn ends, so the first read sees nothing.
  let reads = 0;
  const browser = {
    async tabs() {
      reads += 1;
      const tabs = [{ type: "page", targetId: "LISTING", url: "https://www.linkedin.com/jobs/view/1" }];
      if (reads >= 3) tabs.push({ type: "page", targetId: "EMPLOYER", url: "https://boards.ashbyhq.com/acme/9" });
      return { ok: true, payload: { tabs } };
    },
  };
  const resolved = await resolveTabTarget(browser, {
    targetId: "LISTING",
    url: "https://www.linkedin.com/jobs/view/1",
    knownTargetIds: ["LISTING"],
    waitForNewTabMs: 3_000,
    pollMs: 10,
    canAdopt: true,
  });
  assert.deepEqual(resolved, { ok: true, targetId: "EMPLOYER", redirected: true });
  assert.ok(reads >= 3, "polled until the employer tab appeared");
});

async function withTabs(tabs, run) {
  await run({ async tabs() { return { ok: true, payload: { tabs } }; } });
}

test("a leftover tab from another application is never adopted as this one", async () => {
  // Live failure: a Greenhouse tab left open by the Tripadvisor run 11 minutes earlier was adopted
  // for a VOIS listing, and this job's answers went into Tripadvisor's form.
  await withTabs(
    [
      { type: "page", targetId: "LISTING", url: "https://uk.linkedin.com/jobs/view/4443296168" },
      { type: "page", targetId: "STALE", url: "https://job-boards.greenhouse.io/tripadvisor/jobs/6977663" },
    ],
    async (browser) => {
      const resolved = await resolveTabTarget(browser, {
        targetId: "LISTING",
        url: "https://uk.linkedin.com/jobs/view/4443296168",
        knownTargetIds: ["LISTING"],
        excludeUrls: ["https://job-boards.greenhouse.io/tripadvisor/jobs/6977663?utm_source=x"],
      });
      assert.equal(resolved.targetId, "LISTING");
      assert.notEqual(resolved.redirected, true);
    },
  );
});

test("an unreadable tab baseline adopts nothing rather than guessing", async () => {
  // knownTargetIds degrades to just the owned tab when the baseline read fails, which made every
  // other open tab look freshly created. Adoption has to be off in that case.
  await withTabs(
    [
      { type: "page", targetId: "LISTING", url: "https://uk.linkedin.com/jobs/view/1" },
      { type: "page", targetId: "SOMEONE-ELSES", url: "https://job-boards.greenhouse.io/acme/jobs/9" },
    ],
    async (browser) => {
      const guessed = await resolveTabTarget(browser, {
        targetId: "LISTING",
        url: "https://uk.linkedin.com/jobs/view/1",
        knownTargetIds: ["LISTING"],
        canAdopt: false,
      });
      assert.equal(guessed.targetId, "LISTING");
      assert.notEqual(guessed.redirected, true);
    },
  );
});

test("resuming an application never hands back another application's tab", async () => {
  // The live failure: a resumed Quantexa/Ashby application was driven against LinkedIn's
  // "Apply to Venn Apps" form. openApplicationTab confirms one specific tab; with no baseline
  // every other open tab looks newly created, so adoption must be off on that path.
  const focused = [];
  const browser = {
    async tabs() {
      return {
        ok: true,
        payload: {
          tabs: [
            { type: "page", targetId: "OTHER-APPLICATION", url: "https://www.linkedin.com/jobs/apply/venn-apps" },
            { type: "page", targetId: "OURS", url: "https://jobs.ashbyhq.com/quantexa/software-engineer" },
            { type: "page", targetId: "UNRELATED", url: "https://mail.google.com/" },
          ],
        },
      };
    },
    async focusTab(targetId) {
      focused.push(targetId);
      return { ok: true };
    },
    async openTab() {
      throw new Error("a live tab must be reused, never reopened from scratch");
    },
  };
  const result = await openApplicationTab(browser, {
    url: "https://jobs.ashbyhq.com/quantexa/software-engineer",
    label: "Quantexa",
    existingTargetId: "OURS",
  });
  assert.deepEqual(result, {
    ok: true,
    targetId: "OURS",
    currentUrl: "https://jobs.ashbyhq.com/quantexa/software-engineer",
    reused: true,
  });
  assert.deepEqual(focused, ["OURS"]);
});

test("a genuinely closed tab is reopened rather than swapped for a stranger", async () => {
  // The saved target is gone. The answer is a fresh tab on the right URL, not the best-looking
  // tab that happens to be open.
  let opened = null;
  const browser = {
    async tabs() {
      return {
        ok: true,
        payload: {
          tabs: [
            { type: "page", targetId: "SOMEONE-ELSE", url: "https://boards.greenhouse.io/acme/jobs/1" },
            ...(opened ? [{ type: "page", targetId: opened, url: "https://jobs.ashbyhq.com/quantexa/se" }] : []),
          ],
        },
      };
    },
    async openTab(url) {
      opened = "FRESH";
      return { ok: true, payload: { targetId: opened, url } };
    },
    async focusTab() {
      return { ok: true };
    },
    async evaluate() {
      return { ok: true, payload: { result: { href: "https://jobs.ashbyhq.com/quantexa/se", ready: "complete" } } };
    },
  };
  const result = await openApplicationTab(browser, {
    url: "https://jobs.ashbyhq.com/quantexa/se",
    label: "Quantexa",
    existingTargetId: "CLOSED-LONG-AGO",
  });
  assert.equal(result.ok, true);
  assert.equal(result.targetId, "FRESH");
  assert.equal(result.reused, false);
});

test("a caller that does not ask for adoption never receives another tab", () => {
  // The point of the default flip: adoption used to be opt-out, and every caller that forgot to
  // opt out silently inherited the bug. A new caller now has to mean it.
  return withTabs(
    [
      { type: "page", targetId: "OURS", url: "https://jobs.ashbyhq.com/quantexa/se" },
      { type: "page", targetId: "TEMPTING", url: "https://job-boards.greenhouse.io/other/jobs/9" },
    ],
    async (browser) => {
      const resolved = await resolveTabTarget(browser, {
        targetId: "OURS",
        url: "https://jobs.ashbyhq.com/quantexa/se",
        knownTargetIds: ["OURS"],
      });
      assert.equal(resolved.targetId, "OURS");
      assert.notEqual(resolved.redirected, true);
    },
  );
});
