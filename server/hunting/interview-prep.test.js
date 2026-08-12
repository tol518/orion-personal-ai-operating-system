import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  buildInterviewPrompt,
  InterviewPrepService,
  parseInterviewPrep,
  renderPrep,
} from "./interview-prep.js";

const JOB = {
  id: "job-1234abcd",
  title: "Backend Engineer",
  company: "Acme",
  url: "https://jobs.example.com/acme/backend",
  descriptionExcerpt: "Go and event-driven systems.",
};
const CV = "Example User. Node services at Example Company; built the pricing tracker.";

test("the prompt refuses invented stories and asks for a real mix of questions", () => {
  const prompt = buildInterviewPrompt({
    job: JOB,
    cv: CV,
    identityMemory: { body: "London" },
    applicationMemory: { body: "Pre-settled status" },
    coverLetter: "Dear hiring team,",
  });
  assert.match(prompt, /ONLY from the verified CV and memories/);
  assert.match(prompt, /leave the answer null/);
  assert.match(prompt, /a made-up story is worse than an admitted gap/);
  assert.match(prompt, /one about a failure or setback/);
  // They may ask about the letter he actually sent.
  assert.match(prompt, /THE COVER LETTER HE SENT/);
});

test("an unanswerable question is kept and marked, never dropped or invented", () => {
  const prep = parseInterviewPrep(
    JSON.stringify({
      questions: [
        { question: "Tell me about a Node service you built", kind: "technical", answer: "S: Example Company needed...", source: "CV: pricing tracker" },
        { question: "Describe a time you led a team", kind: "behavioural", answer: null, needs: "a story where you led people" },
      ],
      notes: "Ask about their on-call rota.",
    }),
  );
  assert.equal(prep.questions.length, 2);
  const rendered = renderPrep({ job: JOB, prep });
  assert.match(rendered, /## Answers grounded in your CV and memories/);
  assert.match(rendered, /Rests on: CV: pricing tracker/);
  // The gap is the most useful line on the page, so it is surfaced under its own heading.
  assert.match(rendered, /## Needs your story/);
  assert.match(rendered, /Describe a time you led a team.*needs: a story where you led people/);
  assert.match(rendered, /## Notes/);
});

test("a saved sheet reports how much of it he still has to write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-interview-"));
  try {
    const service = new InterviewPrepService({
      dir,
      gateway: replyWith({
        questions: [
          { question: "Why us?", kind: "motivation", answer: "Because you build travel systems.", source: "CV" },
          { question: "A time you failed?", kind: "failure", answer: null, needs: "a setback you owned" },
        ],
      }),
    });
    const saved = await service.generate({ job: JOB, cv: CV, identityMemory: { body: "x" }, applicationMemory: { body: "y" } });
    assert.equal(saved.questions, 2);
    assert.equal(saved.grounded, 1);
    assert.equal(saved.needsHisStory, 1);
    assert.match(saved.name, /Acme-Backend-Engineer-job-1234-interview\.md/);
    // Re-readable later, which is the point of saving it as markdown.
    assert.match(service.read({ name: saved.name }).content, /Why us\?/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty sheet is refused rather than saved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-interview-"));
  try {
    const service = new InterviewPrepService({ dir, gateway: replyWith({ questions: [] }) });
    await assert.rejects(
      () => service.generate({ job: JOB, cv: CV, identityMemory: { body: "x" }, applicationMemory: { body: "y" } }),
      /came back empty/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
