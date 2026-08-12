import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { buildCoverLetterPrompt, CoverLetterService } from "./cover-letter-service.js";
import { describeFieldPolicy } from "./field-policy.js";

const JOB = {
  id: "job-1234abcd",
  title: "Automation Engineer",
  company: "Goodlord",
  url: "https://jobs.example.com/goodlord/automation-engineer",
  descriptionExcerpt: "Automate lettings workflows in TypeScript.",
  matchReasons: ["TypeScript", "automation"],
};
const IDENTITY = { id: "memory-example-user", body: "Example User, London." };
const APPLICATION = { id: "memory-example-job-application-profile", body: "Pre-settled status." };

test("the prompt forbids invented experience and unresearched company claims", () => {
  const prompt = buildCoverLetterPrompt({
    job: JOB,
    cv: "Verified CV text",
    identityMemory: IDENTITY,
    applicationMemory: APPLICATION,
    skill: "# Cover Letter Generator\nOpen with a hook.",
    humanizerRules: "## Do not inflate significance\nCut \"stands as\".",
  });
  // The letter goes out over the user's name, so it must never disclose how it was drafted.
  assert.match(prompt, /Write as the user, in the first person/);
  assert.match(prompt, /Never state, imply, or hint that the letter was drafted by an assistant/);
  assert.match(prompt, /Every factual claim must be traceable/);
  assert.match(prompt, /Never invent or inflate a metric/);
  assert.match(prompt, /You have not researched this company/);
  assert.match(prompt, /the grounding rules always win/);
  // The role and company must be in the prompt, or the letter cannot be specific to them.
  assert.match(prompt, /ROLE: Automation Engineer/);
  assert.match(prompt, /COMPANY: Goodlord/);
  assert.match(prompt, /Open with a hook/);
  // Style now layers: structure from the skill, wording from the humanizer, facts from grounding.
  assert.match(prompt, /HUMANIZER RULES:/);
  assert.match(prompt, /Do not inflate significance/);
  assert.match(prompt, /a plain true sentence beats a natural-sounding false one/);
});

test("a written letter is saved as reviewable markdown with its provenance", async () => {
  await withService(async (service, dir) => {
    const saved = await service.generate({
      job: JOB,
      cv: "Verified CV text",
      identityMemory: IDENTITY,
      applicationMemory: APPLICATION,
    });
    assert.equal(saved.name, "Goodlord-Automation-Engineer-job-1234.md");
    const onDisk = fs.readFileSync(path.join(dir, saved.name), "utf8");
    assert.match(onDisk, /^---\n/);
    assert.match(onDisk, /company: "Goodlord"/);
    assert.match(onDisk, /role: "Automation Engineer"/);
    assert.match(onDisk, /savedAt: /);
    assert.match(onDisk, /Dear Goodlord hiring team/);
    // The file may be forwarded or attached, so it carries no authorship or tooling trail.
    assert.doesNotMatch(onDisk, /J\.A\.R\.V\.I\.S|assistant|generatedBy|groundedIn|cover-letter-generator/i);
    // The audit still exists — on the checkpoint, not inside the user's letter.
    assert.deepEqual(saved.groundedIn, [
      "canonical CV",
      "memory-example-user",
      "memory-example-job-application-profile",
    ]);
    assert.equal(saved.words > 0, true);
    assert.match(saved.sha256, /^[a-f0-9]{64}$/);
    // Restrictive permissions: the letter carries personal detail.
    assert.equal(fs.statSync(saved.hostPath).mode & 0o777, 0o600);
  });
});

test("a saved letter can be read back later and is null once gone", async () => {
  await withService(async (service, dir) => {
    const saved = await service.generate({
      job: JOB,
      cv: "cv",
      identityMemory: IDENTITY,
      applicationMemory: APPLICATION,
    });
    const reread = service.read({ name: saved.name });
    assert.match(reread.content, /Dear Goodlord hiring team/);
    // What a form field or the reader gets is the letter alone, never the metadata block.
    assert.equal(reread.letter.startsWith("---"), false);
    assert.equal(reread.letter.startsWith("Dear Goodlord hiring team"), true);
    assert.equal(saved.letter.startsWith("---"), false);
    assert.equal(service.read({ name: "nope.md" }), null);
    assert.equal(service.read({ name: null }), null);
    fs.rmSync(path.join(dir, saved.name));
    assert.equal(service.read({ name: saved.name }), null);
  });
});

test("a code-fenced reply is unwrapped and an empty one is refused", async () => {
  await withService(async (service) => {
    const saved = await service.generate({
      job: JOB,
      cv: "cv",
      identityMemory: IDENTITY,
      applicationMemory: APPLICATION,
    });
    assert.equal(saved.letter.startsWith("```"), false);
  }, "```markdown\nDear Goodlord hiring team,\n\nBody.\n```");

  await withService(async (service) => {
    await assert.rejects(
      () => service.generate({ job: JOB, cv: "cv", identityMemory: IDENTITY, applicationMemory: APPLICATION }),
      /came back empty/,
    );
  }, "   ");
});

test("the field policy offers the letter only when one exists", () => {
  const withLetter = describeFieldPolicy({ coverLetter: "Dear team," });
  assert.match(withLetter, /Cover letter or cover note fields/);
  assert.match(withLetter, /Do not rewrite it/);
  assert.doesNotMatch(describeFieldPolicy({}), /Cover letter or cover note fields/);
});

test("the field policy states the dropdown and optional-field rules the run needs", () => {
  const policy = describeFieldPolicy({});
  assert.match(policy, /Never leave a combobox holding typed text with no option selected/);
  assert.match(policy, /Ignore case, hyphens, punctuation/);
  assert.match(policy, /Never choose an option that claims more/);
  assert.match(policy, /Do not stop the application for an optional field/);
});

/** Replies handed out in order, with every prompt recorded, so a second pass is observable. */
function scriptedGateway(replies) {
  const gateway = new EventEmitter();
  gateway.prompts = [];
  let turn = 0;
  gateway.request = async (method, params) => {
    if (method !== "chat.send") return {};
    gateway.prompts.push(String(params.message ?? ""));
    const reply = replies[Math.min(turn, replies.length - 1)];
    turn += 1;
    queueMicrotask(() =>
      gateway.emit("event", "chat", { sessionKey: params.sessionKey, state: "final", message: reply }),
    );
    return {};
  };
  return gateway;
}

async function withScriptedService(replies, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-letters-"));
  const gateway = scriptedGateway(replies);
  try {
    await run(new CoverLetterService({ gateway, dir }), gateway);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CLEAN_LETTER = [
  "Dear hiring team,",
  "",
  "I am applying for the automation engineer role. I build TypeScript services at Example Company and",
  "wrote the pricing tracker that watches our own site.",
  "",
  "Yours sincerely,",
  "Example User",
].join("\n");

test("a draft that reads as machine-written earns one revision pass", async () => {
  const draft = "Dear hiring team,\n\nI am passionate about this pivotal role — additionally, I deliver.\n\nExample User";
  await withScriptedService([draft, CLEAN_LETTER], async (service, gateway) => {
    const saved = await service.generate({
      job: JOB,
      cv: "Verified CV text",
      identityMemory: IDENTITY,
      applicationMemory: APPLICATION,
    });
    assert.equal(gateway.prompts.length, 2, "one writing turn and one revision turn");
    assert.match(gateway.prompts[1], /Rewrite the cover letter below/);
    assert.equal(saved.letter, CLEAN_LETTER);
    assert.equal(saved.humanizer.revised, true);
    for (const rule of ["promotional-language", "significance-inflation", "em-or-en-dash"]) {
      assert.ok(saved.humanizer.tellsFound.includes(rule), rule);
    }
    assert.deepEqual(saved.humanizer.tellsRemaining, []);
  });
});

test("a clean draft costs no extra turn", async () => {
  await withScriptedService([CLEAN_LETTER], async (service, gateway) => {
    const saved = await service.generate({
      job: JOB,
      cv: "Verified CV text",
      identityMemory: IDENTITY,
      applicationMemory: APPLICATION,
    });
    assert.equal(gateway.prompts.length, 1);
    assert.equal(saved.humanizer.revised, false);
    assert.equal(saved.letter, CLEAN_LETTER);
  });
});

test("a truncated rewrite is rejected and the draft survives", async () => {
  // Losing a usable letter to a bad rewrite would be worse than the tells it was meant to fix.
  const draft = `Dear hiring team,\n\nI am passionate about this role and I built the tracker at Example Company in TypeScript.\n\nExample User`;
  await withScriptedService([draft, "Sure!"], async (service, gateway) => {
    const saved = await service.generate({
      job: JOB,
      cv: "Verified CV text",
      identityMemory: IDENTITY,
      applicationMemory: APPLICATION,
    });
    assert.equal(gateway.prompts.length, 2);
    assert.equal(saved.humanizer.revised, false);
    assert.match(saved.letter, /I built the tracker at Example Company/);
    // The tells stay recorded even though they could not be cleared, so a stiff letter is explainable.
    assert.ok(saved.humanizer.tellsRemaining.includes("promotional-language"));
  });
});

async function withService(run, reply = "Dear Goodlord hiring team,\n\nI would like to apply.\n\nSincerely, the user") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-letters-"));
  try {
    await run(new CoverLetterService({ gateway: fakeGateway(reply), dir }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeGateway(reply) {
  const gateway = new EventEmitter();
  gateway.request = async (method, params) => {
    if (method !== "chat.send") return {};
    queueMicrotask(() =>
      gateway.emit("event", "chat", { sessionKey: params.sessionKey, state: "final", message: reply }),
    );
    return {};
  };
  return gateway;
}
