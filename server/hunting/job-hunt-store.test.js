import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalizeJobUrl,
  classifyJobFreshness,
  compareJobsForQueue,
  isFinishedApplication,
  JobHuntStore,
  MANUAL_ACTION_KINDS,
  normalizeProfile,
  sourceFamilyForUrl,
} from "./job-hunt-store.js";

test("stores one versioned search brief", () => {
  withStore((store) => {
    const first = store.saveProfile({
      query: "Full-stack TypeScript roles in travel technology",
      locations: ["London", "Remote UK"],
      workModes: ["hybrid", "remote"],
      minimumSalary: 55_000,
      salaryCurrency: "GBP",
      jobTypes: ["permanent"],
      excludedKeywords: ["unpaid"],
    });
    assert.equal(first.version, 1);
    assert.deepEqual(store.getProfile()?.locations, ["London", "Remote UK"]);
    assert.throws(() => store.saveProfile(first, 0), /another session/);
  });
});

test("validates short search briefs and invalid salaries", () => {
  assert.throws(() => normalizeProfile({ query: "dev" }), /at least 10/);
  assert.throws(
    () => normalizeProfile({ query: "Software engineering", minimumSalary: -1 }),
    /minimum salary/,
  );
});

test("canonical URLs drop tracking noise and collapse LinkedIn and Indeed variants", () => {
  assert.equal(
    canonicalizeJobUrl("https://www.Example.com/jobs/dev/?utm_source=x&trk=y&ref=z#apply"),
    "example.com/jobs/dev",
  );
  assert.equal(
    canonicalizeJobUrl("https://uk.linkedin.com/jobs/view/graduate-software-engineer-at-acme-4443869815?refId=abc"),
    canonicalizeJobUrl("https://www.linkedin.com/jobs/view/4443869815/"),
  );
  assert.equal(
    canonicalizeJobUrl("https://uk.indeed.com/viewjob?jk=abc123&from=serp&vjs=3"),
    "indeed.com/viewjob?jk=abc123",
  );
  // A significant query parameter survives; only blocklisted tracking keys are removed.
  assert.equal(
    canonicalizeJobUrl("https://boards.greenhouse.io/acme/jobs/42?gh_jid=42&utm_medium=email"),
    "boards.greenhouse.io/acme/jobs/42?gh_jid=42",
  );
});

test("source families collapse board spelling variants and mark first-party hosts", () => {
  assert.equal(sourceFamilyForUrl("https://www.reed.co.uk/jobs/dev/123"), "reed");
  assert.equal(sourceFamilyForUrl("https://uk.indeed.com/viewjob?jk=1"), "indeed");
  assert.equal(sourceFamilyForUrl("https://careers.acme.com/jobs/9"), "first-party:careers.acme.com");
});

test("a repeat run returns its own results, not the whole historical table", () => {
  withStore((store) => {
    const first = store.startDiscoveryRun();
    store.upsertJobs([jobFixture({ url: "https://careers.acme.com/jobs/1", listedAt: today() })], {
      runId: first.id,
    });
    store.finishDiscoveryRun(first.id, { status: "complete", summary: "first" });

    const second = store.startDiscoveryRun();
    store.upsertJobs([jobFixture({ url: "https://careers.beta.com/jobs/2", listedAt: today() })], {
      runId: second.id,
    });
    store.finishDiscoveryRun(second.id, { status: "complete", summary: "second" });

    assert.deepEqual(
      store.listJobs({ scope: "run" }).map((job) => job.url),
      ["https://careers.beta.com/jobs/2"],
    );
    assert.equal(store.listJobs({ scope: "all" }).length, 2);
    // The listing the latest run did not see is history, not a current recommendation.
    const historical = store.listJobs({ scope: "all" }).find((job) => job.url.includes("acme"));
    assert.equal(historical.freshness, "historical");
  });
});

test("a re-observed listing updates in place instead of returning as new", () => {
  withStore((store) => {
    const first = store.startDiscoveryRun();
    const [created] = store.upsertJobs([jobFixture({ matchScore: 70 })], { runId: first.id });
    store.setJobStatus(created.id, "shortlisted");
    store.finishDiscoveryRun(first.id, { status: "complete" });

    const second = store.startDiscoveryRun();
    store.upsertJobs([jobFixture({ url: `${jobFixture().url}?utm_source=newsletter`, matchScore: 91 })], {
      runId: second.id,
    });
    store.finishDiscoveryRun(second.id, { status: "complete" });

    const jobs = store.listJobs({ scope: "run" });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].matchScore, 91);
    assert.equal(jobs[0].status, "shortlisted");
    assert.notEqual(jobs[0].freshness, "new");
  });
});

test("freshness degrades without revalidation and ranking favours verified recent listings", () => {
  const base = { lastRunId: "run-1", firstSeenAt: "2026-07-01T00:00:00.000Z" };
  const now = Date.parse("2026-07-25T00:00:00.000Z");
  assert.equal(
    classifyJobFreshness({ ...base, lastSeenAt: base.firstSeenAt, listedAt: null }, { latestRunId: "run-1", now }),
    "new",
  );
  assert.equal(
    classifyJobFreshness(
      { ...base, lastSeenAt: "2026-07-24T00:00:00.000Z", listedAt: "2026-07-20" },
      { latestRunId: "run-1", now },
    ),
    "current",
  );
  assert.equal(
    classifyJobFreshness(
      { ...base, lastSeenAt: "2026-07-24T00:00:00.000Z", listedAt: "2026-05-01" },
      { latestRunId: "run-1", now },
    ),
    "stale",
  );
  assert.equal(
    classifyJobFreshness({ ...base, lastSeenAt: base.firstSeenAt, listedAt: null }, { latestRunId: "run-2", now }),
    "historical",
  );

  const undatedStrong = { listedAt: null, matchScore: 99, lastSeenAt: "2026-07-25T00:00:00.000Z" };
  const datedWeak = { listedAt: today(), matchScore: 40, lastSeenAt: "2026-07-25T00:00:00.000Z" };
  assert.deepEqual([undatedStrong, datedWeak].sort(compareJobsForQueue), [datedWeak, undatedStrong]);
});

test("exclusions describe what the queue already holds", () => {
  withStore((store) => {
    const run = store.startDiscoveryRun();
    const [job] = store.upsertJobs([jobFixture()], { runId: run.id });
    store.finishDiscoveryRun(run.id, { status: "complete" });
    store.setJobStatus(job.id, "dismissed");
    const exclusions = store.buildDiscoveryExclusions();
    assert.deepEqual(exclusions.knownUrls, ["example.com/jobs/software-engineer"]);
    assert.deepEqual(exclusions.dismissedRoleKeys, ["example travel::software engineer"]);
    assert.equal(exclusions.sourceFamilyCounts["first-party:example.com"], 1);
  });
});

test("ready_for_review is unreachable without verified upload evidence", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture()]);
    const sessionKey = `agent:main:dashboard:hunting-application-${job.id}`;
    assert.throws(
      () => store.saveApplication(job.id, { status: "ready_for_review", sessionKey, summary: "done" }),
      /verified CV upload/,
    );
    const uploaded = store.saveApplication(job.id, {
      status: "ready_for_review",
      sessionKey,
      summary: "Fields complete",
      uploadOutcome: "uploaded",
      uploadVerifiedAt: new Date().toISOString(),
      uploadEvidence: { method: "file-input-read", filename: "cv.pdf" },
      filledFields: [{ field: "First name", source: "identity-memory" }],
    });
    assert.equal(uploaded.status, "ready_for_review");
    assert.deepEqual(uploaded.filledFields, [{ field: "First name", source: "identity-memory" }]);
    // Optional blanks and the saved letter travel with the checkpoint.
    const withNotes = store.saveApplication(job.id, {
      status: "ready_for_review",
      sessionKey,
      summary: "Complete",
      uploadOutcome: "uploaded",
      unresolvedFields: [],
      skippedFields: [{ field: "Cover note", reason: "optional and unanswerable" }],
      coverLetter: { name: "Acme-Engineer-1234abcd.md", words: 320 },
      filledFields: [
        { field: "Right to work", source: "application-memory", selectedOption: "Yes - Settled/pre-settled status" },
      ],
    });
    assert.deepEqual(withNotes.skippedFields, [
      { field: "Cover note", reason: "optional and unanswerable", required: false },
    ]);
    assert.equal(withNotes.coverLetter.name, "Acme-Engineer-1234abcd.md");
    assert.equal(withNotes.filledFields[0].selectedOption, "Yes - Settled/pre-settled status");
    // A form that provably asks for no CV is the only other way through the gate.
    const noCv = store.saveApplication(job.id, {
      status: "ready_for_review",
      sessionKey,
      summary: "No CV requested",
      uploadOutcome: "not_required",
    });
    assert.equal(noCv.status, "ready_for_review");
  });
});

test("checkpoints keep their attempt history and validate the state machine", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture()]);
    const sessionKey = `agent:main:dashboard:hunting-application-${job.id}`;
    const checkpoint = store.saveApplication(job.id, {
      status: "needs_human_action",
      sessionKey,
      summary: "Sign-in required",
      currentUrl: "https://example.com/login",
      manualAction: "Sign in, then resume",
      manualActionKind: "sign_in",
      uploadOutcome: "pending",
    });
    assert.equal(checkpoint.manualActionKind, "sign_in");
    assert.throws(
      () => store.saveApplication(job.id, { status: "running", sessionKey, summary: "x" }),
      /invalid application status/,
    );
    assert.throws(
      () =>
        store.saveApplication(job.id, {
          status: "needs_human_action",
          sessionKey,
          summary: "x",
          manualActionKind: "shrug",
        }),
      /invalid manual action kind/,
    );
    store.recordAttempt(job.id, {
      phase: "uploading_cv",
      outcome: "artifact_unavailable",
      reasonCode: "artifact_not_visible_to_browser",
      detail: "must stay within inbound media directory",
      evidence: { browserRef: "media://inbound/cv.pdf" },
    });
    const attempts = store.listAttempts(job.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].reasonCode, "artifact_not_visible_to_browser");
    assert.equal(attempts[0].evidence.browserRef, "media://inbound/cv.pdf");
    const submitted = store.saveApplication(job.id, { ...checkpoint, status: "submitted" });
    assert.equal(submitted.startedAt, checkpoint.startedAt);
    const cancelled = store.saveApplication(job.id, {
      ...checkpoint,
      status: "failed",
      reasonCode: "user_cancelled",
    });
    store.recordAttempt(job.id, { phase: "cancelled", outcome: "user_cancelled" });
    assert.equal(cancelled.status, "failed");
    assert.equal(store.listAttempts(job.id)[0].phase, "cancelled");
  });
});

test("a prior final-submit click remains discoverable beyond the bounded audit list", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture()]);
    store.recordAttempt(job.id, { phase: "submitted", outcome: "not_attempted" });
    store.recordAttempt(job.id, { phase: "submitted", outcome: "control_not_found" });
    assert.equal(store.hasFinalSubmitAttempt(job.id), false);

    store.recordAttempt(job.id, { phase: "submitted", outcome: "verification_failed" });
    for (let index = 0; index < 60; index += 1) {
      store.recordAttempt(job.id, { phase: "guidance", outcome: "not_saved" });
    }

    assert.equal(store.listAttempts(job.id).length, 50);
    assert.equal(store.hasFinalSubmitAttempt(job.id), true);
  });
});

test("recovery only runs when the caller claims ownership, not on every open", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-job-hunt-"));
  const databasePath = path.join(directory, "jarvis.sqlite");
  try {
    const store = new JobHuntStore(databasePath);
    const [job] = store.upsertJobs([jobFixture()]);
    store.saveApplication(job.id, {
      status: "uploading_cv",
      sessionKey: `agent:main:dashboard:hunting-application-${job.id}`,
      summary: "Attaching",
    });
    const run = store.startDiscoveryRun();

    // A second process opening the same database (e.g. a launch that then loses the port
    // bind) must leave the live instance's in-flight work alone.
    const bystander = new JobHuntStore(databasePath);
    bystander.database.close();
    assert.equal(store.getApplication(job.id).status, "uploading_cv");
    assert.equal(store.getDiscoveryRun(run.id).status, "running");

    store.recoverInterruptedWork();
    const recovered = store.getApplication(job.id);
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.reasonCode, "service_restarted");
    assert.equal(store.getDiscoveryRun(run.id).status, "failed");
    store.database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a site consent is scoped to one host, re-granted idempotently, and revocable", () => {
  withStore((store) => {
    store.grantSiteConsent({ host: "BendingSpoons.com", gate: "privacy_policy", phrase: "just accept it" });
    store.grantSiteConsent({ host: "bendingspoons.com", gate: "privacy_policy", phrase: "accept the privacy policy" });
    store.grantSiteConsent({ host: "bendingspoons.com", gate: "terms" });

    // Host is the identity, case-insensitively; re-granting refreshes rather than duplicates.
    const consents = store.listSiteConsents("bendingspoons.com");
    assert.deepEqual(consents.map((entry) => entry.gate), ["privacy_policy", "terms"]);
    assert.equal(consents[0].phrase, "accept the privacy policy");
    // One host's permission says nothing about another's.
    assert.deepEqual(store.listSiteConsents("greenhouse.io"), []);

    assert.equal(store.revokeSiteConsent({ host: "bendingspoons.com", gate: "terms" }), true);
    assert.equal(store.revokeSiteConsent({ host: "bendingspoons.com", gate: "terms" }), false);
    assert.deepEqual(store.listSiteConsents("bendingspoons.com").map((entry) => entry.gate), ["privacy_policy"]);
  });
});

test("every checkpoint kind the runner can emit is storable", async () => {
  // A kind the runner produces but the store rejects turns a normal checkpoint into
  // "failed | unexpected_error" and loses the run's work; legal_acceptance did exactly that.
  const { HUMAN_ACTION_KINDS } = await import("./job-application-runner.js");
  for (const kind of HUMAN_ACTION_KINDS) {
    assert.ok(MANUAL_ACTION_KINDS.has(kind), `store rejects runner kind "${kind}"`);
  }
});

test("a host counts as proven only after one application there finished cleanly", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture({ url: "https://job-boards.greenhouse.io/acme/jobs/1" })]);
    const sessionKey = `agent:main:dashboard:hunting-application-${job.id}`;
    const base = { sessionKey, currentUrl: "https://job-boards.greenhouse.io/acme/jobs/1" };

    // An application that stopped for a human is not proof of anything.
    store.saveApplication(job.id, { ...base, status: "needs_human_action", summary: "needs you" });
    assert.deepEqual(store.hostsWithVerifiedRun(), []);

    store.saveApplication(job.id, {
      ...base,
      status: "ready_for_review",
      summary: "complete",
      uploadOutcome: "uploaded",
      uploadVerifiedAt: new Date().toISOString(),
      unresolvedFields: [],
    });
    assert.deepEqual(store.hostsWithVerifiedRun(), ["job-boards.greenhouse.io"]);
    // A resumed run must never count itself as its own proof.
    assert.deepEqual(store.hostsWithVerifiedRun({ excludeJobId: job.id }), []);
  });
});

test("an application still carrying a required blank is not proof", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture({ url: "https://jobs.lever.co/acme/1" })]);
    store.saveApplication(job.id, {
      sessionKey: `agent:main:dashboard:hunting-application-${job.id}`,
      currentUrl: "https://jobs.lever.co/acme/1",
      status: "ready_for_review",
      summary: "complete",
      uploadOutcome: "uploaded",
      unresolvedFields: [{ field: "Salary expectation", reason: "no verified figure", required: true }],
    });
    assert.deepEqual(store.hostsWithVerifiedRun(), []);
  });
});

test("the outcome pipeline is an event log, and the current stage is derived from it", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture()]);
    store.recordOutcome(job.id, { stage: "applied", occurredAt: "2026-07-01T09:00:00.000Z" });
    assert.equal(store.currentStage(job.id), "applied");

    // Progress moves the stage forward; the earlier event is history, not a contradiction.
    store.recordOutcome(job.id, { stage: "interview", occurredAt: "2026-07-08T09:00:00.000Z", note: "First call" });
    assert.equal(store.currentStage(job.id), "interview");
    assert.deepEqual(store.listOutcomes(job.id).map((event) => event.stage), ["applied", "interview"]);

    // A terminal stage wins outright, even though "offer" sits further along the happy path.
    store.recordOutcome(job.id, { stage: "rejected", occurredAt: "2026-07-15T09:00:00.000Z" });
    assert.equal(store.currentStage(job.id), "rejected");

    assert.throws(() => store.recordOutcome(job.id, { stage: "ghosted" }), /invalid application outcome stage/);
  });
});

test("an email-derived outcome waits for approval before it counts", () => {
  // The Gmail reader may only propose. An inbox message that looks like a rejection must never
  // rewrite the pipeline on its own.
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture()]);
    store.recordOutcome(job.id, { stage: "applied" });
    const proposal = store.recordOutcome(job.id, {
      stage: "rejected",
      source: "email",
      confirmed: false,
      note: "Thanks for applying, we have decided to move forward with other candidates",
    });
    assert.equal(proposal.confirmed, false);
    // Unconfirmed, so it does not move the stage.
    assert.equal(store.currentStage(job.id), "applied");
    assert.deepEqual(store.outcomeSummary().pending.map((entry) => entry.id), [proposal.id]);

    assert.equal(store.resolveProposedOutcome(proposal.id, { accept: true }), true);
    assert.equal(store.currentStage(job.id), "rejected");
    // Deciding twice changes nothing.
    assert.equal(store.resolveProposedOutcome(proposal.id, { accept: true }), false);
  });
});

test("a discarded proposal leaves no trace in the pipeline", () => {
  withStore((store) => {
    const [job] = store.upsertJobs([jobFixture()]);
    const proposal = store.recordOutcome(job.id, { stage: "offer", source: "email", confirmed: false });
    assert.equal(store.resolveProposedOutcome(proposal.id, { accept: false }), true);
    assert.deepEqual(store.listOutcomes(job.id), []);
    assert.equal(store.currentStage(job.id), null);
  });
});

test("the pipeline summary counts each application once, at its current stage", () => {
  withStore((store) => {
    const [a] = store.upsertJobs([jobFixture({ url: "https://careers.acme.com/1" })]);
    const [b] = store.upsertJobs([jobFixture({ url: "https://careers.beta.com/2" })]);
    store.recordOutcome(a.id, { stage: "applied" });
    store.recordOutcome(a.id, { stage: "interview" });
    store.recordOutcome(b.id, { stage: "applied" });
    const { counts } = store.outcomeSummary();
    assert.equal(counts.interview, 1);
    assert.equal(counts.applied, 1);
    assert.equal(counts.offer, 0);
  });
});

test("only a finished application's tab may be closed", () => {
  // Closing a tab the user still needs is the damaging mistake here: a checkpoint waiting on him is
  // the tab he takes over, and a ready_for_review one is the tab he submits from.
  assert.equal(isFinishedApplication({ status: "submitted" }), true);
  assert.equal(isFinishedApplication({ status: "failed" }), true);
  for (const status of ["needs_human_action", "ready_for_review", "filling_verified_fields", "queued"]) {
    assert.equal(isFinishedApplication({ status }), false, status);
  }
  assert.equal(isFinishedApplication(null), false);
});

function withStore(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-job-hunt-"));
  try {
    const store = new JobHuntStore(path.join(directory, "jarvis.sqlite"));
    run(store);
    store.database.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function jobFixture(overrides = {}) {
  return {
    title: "Software Engineer",
    company: "Example Travel",
    location: "London",
    url: "https://example.com/jobs/software-engineer",
    source: "Company site",
    workMode: "hybrid",
    salary: "£60,000–£70,000",
    listedAt: "2026-07-09",
    descriptionExcerpt: "Build TypeScript services for travel products.",
    matchScore: 80,
    matchReasons: ["TypeScript", "London"],
    ...overrides,
  };
}
