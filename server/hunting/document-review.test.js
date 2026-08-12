import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  buildReviewPrompt,
  DocumentReviewService,
  inventedFigures,
  parseReviewResult,
} from "./document-review.js";

const JOB = {
  id: "job-1234abcd",
  title: "Backend Engineer",
  company: "Acme",
  url: "https://jobs.example.com/acme/backend",
  descriptionExcerpt: "Go, Kubernetes, and event-driven systems.",
};
const CV = "Example User. React and Node services at Example Company. Reduced search latency by 30%.";
const LETTER = "Dear hiring team,\n\nI build Node services at Example Company and cut search latency by 30%.\n\nExample User";

test("the reviewer may rewrite the letter but never the CV", () => {
  const prompt = buildReviewPrompt({
    job: JOB,
    cv: CV,
    letter: LETTER,
    identityMemory: { body: "London" },
    applicationMemory: { body: "Pre-settled status" },
  });
  assert.match(prompt, /You did not write them/);
  assert.match(prompt, /You may not rewrite the CV/);
  assert.match(prompt, /He deliberately sends one CV to every employer/);
  assert.match(prompt, /Never add, remove, or alter a fact/);
  // Requirements must come from the listing, not the reviewer's imagination.
  assert.match(prompt, /Do not invent requirements the listing does not state/);
  assert.match(prompt, /Kubernetes/);
});

test("a rewrite that invents a figure is rejected, keeping the original letter", async () => {
  // "improved performance" becoming "improved performance by 40%" reads better and is a lie.
  const inflated = LETTER.replace("cut search latency by 30%", "cut search latency by 60% across 12 services");
  const service = new DocumentReviewService({ gateway: replyWith({ letterRewrite: inflated, summary: "Tightened it" }) });
  const result = await service.review({ job: JOB, cv: CV, letter: LETTER });
  assert.equal(result.letterRewritten, false);
  assert.equal(result.letter, LETTER);
  assert.match(result.rejectedRewrite, /introduced figures/);
});

test("a faithful rewrite is accepted", async () => {
  const faithful = "Dear hiring team,\n\nI build Node services at Example Company, where I cut search latency by 30%.\n\nExample User";
  const service = new DocumentReviewService({
    gateway: replyWith({ letterRewrite: faithful, summary: "Clearer opening", letterIssues: [{ issue: "generic opening", fix: "named the work" }] }),
  });
  const result = await service.review({ job: JOB, cv: CV, letter: LETTER });
  assert.equal(result.letterRewritten, true);
  assert.equal(result.letter, faithful);
  assert.deepEqual(result.letterIssues, [{ issue: "generic opening", fix: "named the work" }]);
});

test("CV gaps are reported as advice, never applied", async () => {
  const service = new DocumentReviewService({
    gateway: replyWith({
      summary: "One gap",
      cvGaps: [{ requirement: "Kubernetes", evidence: null, severity: "notable", suggestion: "Add the deployment work" }],
      letterRewrite: null,
    }),
  });
  const result = await service.review({ job: JOB, cv: CV, letter: LETTER });
  assert.deepEqual(result.cvGaps, [
    { requirement: "Kubernetes", evidence: null, severity: "notable", suggestion: "Add the deployment work" },
  ]);
  // The letter is untouched and the CV is never returned as a rewrite.
  assert.equal(result.letter, LETTER);
  assert.equal(result.letterRewritten, false);
});

test("a failed review never blocks the application", async () => {
  const gateway = new EventEmitter();
  gateway.request = async () => {
    throw new Error("model unavailable");
  };
  const service = new DocumentReviewService({ gateway });
  const result = await service.review({ job: JOB, cv: CV, letter: LETTER });
  assert.equal(result.reviewed, false);
  assert.equal(result.letter, LETTER, "the drafted letter survives a failed review");
});

test("figure detection ignores years and catches new numbers", () => {
  assert.deepEqual(inventedFigures({ rewrite: "grew it 40%", sources: ["grew it 30%"] }), ["40%"]);
  assert.deepEqual(inventedFigures({ rewrite: "since 2024 I built it", sources: ["I built it"] }), []);
  assert.deepEqual(inventedFigures({ rewrite: "cut latency by 30%", sources: ["cut latency by 30%"] }), []);
});

test("unknown severities and junk entries are normalized away", () => {
  const parsed = parseReviewResult(
    JSON.stringify({ summary: "x", cvGaps: [{ requirement: "Go", severity: "catastrophic" }, { evidence: "no requirement" }], letterIssues: [{}] }),
  );
  assert.equal(parsed.cvGaps.length, 1);
  assert.equal(parsed.cvGaps[0].severity, "notable");
  assert.deepEqual(parsed.letterIssues, []);
});

function replyWith(payload) {
  const gateway = new EventEmitter();
  gateway.request = async (method, params) => {
    if (method !== "chat.send") return {};
    queueMicrotask(() =>
      gateway.emit("event", "chat", { sessionKey: params.sessionKey, state: "final", message: JSON.stringify(payload) }),
    );
    return {};
  };
  return gateway;
}
