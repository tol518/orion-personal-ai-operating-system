import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildDiscoveryPrompt,
  JobDiscoveryService,
  mergeSourceStatus,
  parseDiscoveryResponse,
} from "./job-discovery-service.js";

test("a hunt gets a generous, operator-tunable ceiling and refuses to overlap itself", async () => {
  assert.equal(new JobDiscoveryService({ gateway: {} }).timeoutMs, 900_000);
  assert.equal(new JobDiscoveryService({ gateway: {}, timeoutMs: 120_000 }).timeoutMs, 120_000);

  const service = new JobDiscoveryService({ gateway: {} });
  service.active = true;
  await assert.rejects(() => service.discover({ profile: {}, cv: null }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /already running/);
    return true;
  });
});

test("the prompt demands LinkedIn, Indeed, and first-party passes with a stated status", async () => {
  const gateway = new EventEmitter();
  let prompt = "";
  const requests = [];
  gateway.request = async (method, payload) => {
    requests.push({ method, payload });
    if (method !== "chat.send") return;
    prompt = payload.message;
    queueMicrotask(() =>
      gateway.emit("event", "chat", {
        sessionKey: payload.sessionKey,
        state: "final",
        message: '{"jobs":[],"sourceStatus":[],"summary":"No current matches"}',
      }),
    );
  };

  const service = new JobDiscoveryService({ gateway });
  const result = await service.discover({ profile: { query: "Software engineer" }, cv: null });

  assert.match(prompt, /separate public-web discovery passes for LinkedIn Jobs, for Indeed, and for first-party/);
  assert.match(prompt, /J\.A\.R\.V\.I\.S\., the main orchestrator responsible for job discovery/);
  assert.match(prompt, /Report a status for every required source/);
  assert.match(prompt, /do not automate a signed-in LinkedIn or Indeed session/);
  assert.deepEqual(
    requests
      .filter(({ method }) => method === "sessions.create" || method === "sessions.reset" || method === "sessions.patch")
      .map(({ method, payload }) => ({ method, key: payload.key, agentId: payload.agentId, model: payload.model })),
    [
      {
        method: "sessions.create",
        key: "agent:main:dashboard:hunting-job-discovery",
        agentId: "main",
        model: "openai/gpt-5.6-luna",
      },
      {
        method: "sessions.reset",
        key: "agent:main:dashboard:hunting-job-discovery",
        agentId: "main",
        model: undefined,
      },
      {
        method: "sessions.patch",
        key: "agent:main:dashboard:hunting-job-discovery",
        agentId: "main",
        model: "openai/gpt-5.6-luna",
      },
    ],
  );
  assert.deepEqual(
    requests
      .filter(({ method }) => method === "chat.abort" || method === "chat.send")
      .map(({ method, payload }) => ({
        method,
        sessionKey: payload.sessionKey,
        agentId: payload.agentId,
      })),
    [
      {
        method: "chat.abort",
        sessionKey: "agent:main:dashboard:hunting-job-discovery",
        agentId: "main",
      },
      {
        method: "chat.send",
        sessionKey: "agent:main:dashboard:hunting-job-discovery",
        agentId: "main",
      },
    ],
  );
  // An empty run still states what each required source did.
  assert.deepEqual(
    result.sourceStatus.map((entry) => `${entry.source}:${entry.status}`),
    ["linkedin:unavailable", "indeed:unavailable", "first-party:unavailable"],
  );
});

test("the prompt carries the queue's existing listings so a repeat run does not replay them", () => {
  const prompt = buildDiscoveryPrompt({
    profile: { query: "Software engineer" },
    cv: null,
    exclusions: {
      knownUrls: ["reed.co.uk/jobs/dev/1"],
      dismissedRoleKeys: ["acme::junior developer"],
    },
  });
  assert.match(prompt, /ALREADY IN QUEUE/);
  assert.match(prompt, /reed\.co\.uk\/jobs\/dev\/1/);
  assert.match(prompt, /acme::junior developer/);
  assert.match(buildDiscoveryPrompt({ profile: {}, cv: null }), /this is the first run/);
});

test("one board cannot exceed two new results, including through spelling variants", () => {
  const result = parseDiscoveryResponse(
    JSON.stringify({
      jobs: [
        reedJob({ id: 1, source: "Reed", matchScore: 95 }),
        reedJob({ id: 2, source: "reed.co.uk", matchScore: 90 }),
        reedJob({ id: 3, source: "REED UK", matchScore: 85 }),
        reedJob({ id: 4, source: "Reed Jobs", matchScore: 80 }),
      ],
      summary: "Reed heavy",
    }),
  );
  assert.equal(result.jobs.length, 2);
  assert.equal(result.droppedForDiversity, 2);
});

test("a listing already in the queue is re-observed without consuming a new-result slot", () => {
  const result = parseDiscoveryResponse(
    JSON.stringify({
      jobs: [
        reedJob({ id: 1, matchScore: 99 }),
        reedJob({ id: 2, matchScore: 90 }),
        reedJob({ id: 3, matchScore: 85 }),
      ],
      summary: "mixed",
    }),
    { knownUrls: ["reed.co.uk/jobs/dev/1"] },
  );
  assert.deepEqual(
    result.jobs.map((job) => `${job.canonicalUrl}:${job.alreadyKnown}`),
    ["reed.co.uk/jobs/dev/1:true", "reed.co.uk/jobs/dev/2:false", "reed.co.uk/jobs/dev/3:false"],
  );
  assert.equal(result.droppedForDiversity, 0);
});

test("normalizes and deduplicates results, keeping the strongest copy", () => {
  const result = parseDiscoveryResponse(
    JSON.stringify({
      jobs: [
        reedJob({ id: 1, matchScore: 60 }),
        { ...reedJob({ id: 1, matchScore: 88 }), url: "https://www.reed.co.uk/jobs/dev/1?utm_source=email" },
      ],
      summary: "duplicates",
    }),
  );
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].matchScore, 88);
});

test("malformed results are dropped without discarding the valid ones", () => {
  const result = parseDiscoveryResponse(
    JSON.stringify({
      jobs: [
        { title: "No URL", company: "Acme" },
        { title: "Bad protocol", company: "Acme", url: "ftp://acme.com/job" },
        reedJob({ id: 9, matchScore: 70 }),
      ],
      summary: "partial",
    }),
  );
  assert.equal(result.jobs.length, 1);
  assert.equal(result.summary, "partial");
});

test("coverage comes from the hostnames returned, and the model only supplies the reason", () => {
  const statuses = mergeSourceStatus(
    [
      { source: "linkedin", status: "covered", reason: "found plenty" },
      { source: "indeed", status: "unavailable", reason: "sign-in wall on every result" },
    ],
    [{ sourceFamily: "first-party:careers.acme.com" }, { sourceFamily: "reed" }],
  );
  const bySource = new Map(statuses.map((entry) => [entry.source, entry]));
  // LinkedIn claimed coverage but returned nothing, so the claim does not stand.
  assert.equal(bySource.get("linkedin").status, "unavailable");
  assert.equal(bySource.get("indeed").reason, "sign-in wall on every result");
  assert.equal(bySource.get("first-party").status, "covered");
  assert.equal(bySource.get("reed").count, 1);
});

function reedJob({ id, source = "Reed", matchScore = 80 }) {
  return {
    title: `Developer ${id}`,
    company: `Company ${id}`,
    location: "London",
    url: `https://www.reed.co.uk/jobs/dev/${id}`,
    source,
    listedAt: null,
    descriptionExcerpt: "Build things.",
    matchScore,
    matchReasons: ["TypeScript"],
  };
}
