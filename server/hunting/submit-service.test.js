import assert from "node:assert/strict";
import test from "node:test";
import {
  autoSubmitHosts,
  findSubmitRef,
  isAutoSubmitHost,
  parseSubmitInstruction,
  SubmitService,
  submitBlockers,
} from "./submit-service.js";
import { resolveSiteAdapter } from "./site-adapters.js";

const REED = resolveSiteAdapter("https://www.reed.co.uk/jobs/x/1");
const READY = {
  status: "ready_for_review",
  uploadOutcome: "uploaded",
  unresolvedFields: [],
};
const HOSTS = ["reed.co.uk"];

test("only a direct, affirmative application-submit instruction grants one-run approval", () => {
  for (const guidance of [
    "Click Submit application.",
    "Please submit this application.",
    "Go ahead and submit the job application.",
    "Submit it now.",
  ]) {
    assert.equal(parseSubmitInstruction(guidance)?.source, "guidance", guidance);
  }
  for (const guidance of [
    "Do not submit the application.",
    "Review it before submitting.",
    "The Submit application button is visible.",
    "Wait, submit it not yet.",
    "",
  ]) {
    assert.equal(parseSubmitInstruction(guidance), null, guidance);
  }
});

test("auto-submit is opt-in per host and off when nothing is listed", () => {
  assert.deepEqual(autoSubmitHosts("reed.co.uk, www.Indeed.com "), ["reed.co.uk", "indeed.com"]);
  assert.deepEqual(autoSubmitHosts(""), []);
  assert.equal(isAutoSubmitHost("www.reed.co.uk", HOSTS), true);
  assert.equal(isAutoSubmitHost("jobs.reed.co.uk", HOSTS), true);
  // An employer that was never opted in is never submitted for.
  assert.equal(isAutoSubmitHost("jobs.ashbyhq.com", HOSTS), false);
  assert.equal(isAutoSubmitHost("reed.co.uk", []), false);
  assert.equal(isAutoSubmitHost("job-boards.greenhouse.io", ["greenhouse.io"]), true);
});

test("a component-bound submit control can be clicked by its fresh snapshot ref", async () => {
  const browser = fakeBrowser({
    controls: [],
    beforeClickText: '- button "Submit application" [ref=e42]',
    afterClickText: "Thank you for applying. We have received your application.",
  });
  const result = await new SubmitService({ browser }).submit({ targetId: "T1", adapter: REED });
  assert.equal(result.outcome, "submitted");
  assert.equal(browser.clicks[0].ref, "e42");
  assert.equal(browser.clicks[0].selector, undefined);
  assert.deepEqual(findSubmitRef('- button "Submit application" [ref=e42]', ["submit application"]), {
    label: "Submit application",
    ref: "e42",
  });
});

test("every precondition must hold before a submission is even attempted", () => {
  assert.deepEqual(submitBlockers({ application: READY, host: "reed.co.uk", hosts: HOSTS }), []);

  const cases = [
    [{ application: READY, host: "jobs.ashbyhq.com" }, /has not completed an application cleanly yet/],
    [{ application: READY, host: "reed.co.uk", automationPolicy: "prepare_only" }, /prepare-only/],
    [{ application: { ...READY, status: "needs_human_action" }, host: "reed.co.uk" }, /status is/],
    [{ application: { ...READY, uploadOutcome: "verification_failed" }, host: "reed.co.uk" }, /CV upload is/],
    [
      { application: { ...READY, unresolvedFields: [{ field: "Salary", required: true }] }, host: "reed.co.uk" },
      /required field/,
    ],
    [
      { application: READY, host: "reed.co.uk", assessment: { blockingFields: [{ field: "Phone" }] } },
      /page still reports empty/,
    ],
  ];
  for (const [input, pattern] of cases) {
    const blockers = submitBlockers({ hosts: HOSTS, ...input });
    assert.ok(blockers.length, `expected a blocker for ${JSON.stringify(input.application?.status)}`);
    assert.match(blockers.join("; "), pattern);
  }
});

test("an optional field left blank does not block a submission", () => {
  const blockers = submitBlockers({
    application: { ...READY, unresolvedFields: [{ field: "Cover note", required: false }] },
    host: "reed.co.uk",
    hosts: HOSTS,
  });
  assert.deepEqual(blockers, []);
});

test("a confirmed submission is reported as submitted", async () => {
  const browser = fakeBrowser({ afterClickText: "Thank you for applying. We have received your application." });
  const result = await new SubmitService({ browser }).submit({ targetId: "T1", adapter: REED });
  assert.equal(result.outcome, "submitted");
  assert.equal(result.reasonCode, "confirmed_on_page");
  assert.match(result.evidence.confirmation, /Thank you for applying/);
  assert.equal(browser.clicks.length, 1, "submit is clicked exactly once");
  assert.equal(browser.snapshots.at(-1).maxChars, 30_000);
});

test("a rejection banner is never read as success, and is not retried", async () => {
  const browser = fakeBrowser({
    afterClickText: "We couldn't submit your application. Your application submission was flagged as possible spam.",
  });
  const result = await new SubmitService({ browser }).submit({ targetId: "T1", adapter: REED });
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "submission_spam_flagged");
  assert.equal(browser.clicks.length, 1);
});

test("a silent page is verification_failed rather than an assumed success", async () => {
  const browser = fakeBrowser({ afterClickText: "Graduate Software Engineer — apply" });
  const result = await new SubmitService({ browser }).submit({ targetId: "T1", adapter: REED });
  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.reasonCode, "no_confirmation_on_page");
});

test("a disabled or missing submit control is reported, not forced", async () => {
  const disabled = fakeBrowser({ controls: [{ text: "Submit application", disabled: true, visible: true }] });
  const result = await new SubmitService({ browser: disabled }).submit({ targetId: "T1", adapter: REED });
  assert.equal(result.outcome, "control_not_found");
  assert.equal(disabled.clicks.length, 0);

  const none = fakeBrowser({ controls: [{ text: "Save for later", disabled: false, visible: true }] });
  const missing = await new SubmitService({ browser: none }).submit({ targetId: "T1", adapter: REED });
  assert.equal(missing.outcome, "control_not_found");
  assert.deepEqual(missing.evidence.candidates, ["Save for later"]);
});

function fakeBrowser({
  controls = [{ text: "Submit application", disabled: false, visible: true }],
  beforeClickText = "",
  afterClickText = "",
} = {}) {
  const clicks = [];
  const snapshots = [];
  return {
    clicks,
    snapshots,
    async evaluate({ fn }) {
      // Page-readiness probe.
      if (fn.includes("document.readyState")) {
        return { ok: true, payload: { result: { href: "https://www.reed.co.uk/apply", ready: "complete" } } };
      }
      const wanted = REED.forbiddenControlLabels.map((label) => label.toLowerCase());
      const usable = controls
        .map((entry, index) => ({ ...entry, index }))
        .filter((entry) => entry.visible && !entry.disabled);
      const match =
        usable.find((entry) => wanted.some((label) => entry.text.toLowerCase() === label)) ??
        usable.find((entry) => wanted.some((label) => entry.text.toLowerCase().includes(label)));
      return {
        ok: true,
        payload: { result: { match: match ?? null, candidates: controls.map((entry) => entry.text) } },
      };
    },
    async request(method, path, { body } = {}) {
      if (path === "/act" && body?.kind === "click") clicks.push(body);
      return { ok: true, payload: { ok: true } };
    },
    async snapshot(args) {
      snapshots.push(args);
      return {
        ok: true,
        payload: { snapshot: clicks.length ? afterClickText : beforeClickText, url: "https://www.reed.co.uk/apply" },
      };
    },
  };
}

test("a host earns auto-submit by completing one application cleanly", () => {
  // Auto-submit is open to every host now, but the first application on a host still stops for
  // review: the checkpoints show blanket submission would have sent unattached CVs and unanswered
  // required fields, and a submission cannot be recalled.
  const first = submitBlockers({ application: READY, host: "job-boards.greenhouse.io", hosts: [] });
  assert.match(first.join("; "), /has not completed an application cleanly yet/);

  const later = submitBlockers({
    application: READY,
    host: "job-boards.greenhouse.io",
    hosts: [],
    provenHosts: ["greenhouse.io"],
  });
  assert.deepEqual(later, [], "a proven host submits without further review");

  // Proof on one host says nothing about another.
  assert.match(
    submitBlockers({ application: READY, host: "jobs.lever.co", hosts: [], provenHosts: ["greenhouse.io"] }).join("; "),
    /has not completed an application cleanly yet/,
  );

  // Every other precondition still applies to a proven host.
  assert.match(
    submitBlockers({
      application: { ...READY, uploadOutcome: "input_not_found" },
      host: "job-boards.greenhouse.io",
      hosts: [],
      provenHosts: ["greenhouse.io"],
    }).join("; "),
    /CV upload is/,
  );
});

test("a wildcard host list opts everything in from the first attempt", () => {
  assert.equal(isAutoSubmitHost("anything.example.com", ["*"]), true);
  assert.deepEqual(submitBlockers({ application: READY, host: "brand-new.example.com", hosts: ["*"] }), []);
});

test("a direct per-application approval skips only the host ramp", () => {
  const approved = { application: READY, host: "jobs.spotify.com", hosts: ["*"] };
  assert.deepEqual(submitBlockers(approved), []);
  assert.match(
    submitBlockers({ ...approved, automationPolicy: "prepare_only" }).join("; "),
    /prepare-only/,
  );
  assert.match(
    submitBlockers({ ...approved, application: { ...READY, uploadOutcome: "verification_failed" } }).join("; "),
    /CV upload is/,
  );
});
