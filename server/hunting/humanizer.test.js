import assert from "node:assert/strict";
import test from "node:test";
import { buildHumanizePrompt, findAiTells, fixTypography } from "./humanizer.js";

test("substitutions with one correct answer are applied, and prose is left alone", () => {
  const { letter, applied } = fixTypography("I’d call it “done”… mostly");
  assert.equal(letter, `I'd call it "done"... mostly`);
  assert.ok(applied.length > 0);
  // An em dash needs a full stop, a comma, or a restructure depending on the clause, so it is
  // never swapped blindly here — a blind swap produces comma splices.
  const dashed = fixTypography("I rebuilt the flow — it shipped in three weeks.");
  assert.match(dashed.letter, /—/);
});

test("tells that need sentence rework are reported with the offending text", () => {
  const rules = findAiTells(
    "I am passionate about this pivotal role. Additionally, I rebuilt the API, demonstrating my ability to deliver.",
  ).map((tell) => tell.rule);
  assert.ok(rules.includes("promotional-language"));
  assert.ok(rules.includes("significance-inflation"));
  assert.ok(rules.includes("ai-vocabulary"));
  assert.ok(rules.includes("participial-padding"));

  const [dash] = findAiTells("I built the service — it handles 400 requests a second.");
  assert.equal(dash.rule, "em-or-en-dash");
  assert.match(dash.excerpt, /built the service/);
});

test("assistant residue is caught, because it must never reach an employer", () => {
  for (const text of [
    "Here is a cover letter for the role.",
    "I hope this helps! Let me know if you would like changes.",
    "As an AI, I can say the user is a strong fit.",
  ]) {
    assert.ok(
      findAiTells(text).some((tell) => tell.rule === "chatbot-residue"),
      text,
    );
  }
});

test("a plain, factual letter has nothing to revise", () => {
  // The pass must not fire on good prose: a clean draft should cost no extra model turn.
  const letter = [
    "Dear hiring team,",
    "I am applying for the graduate software engineer role. I work at Example Company, where I build",
    "React and Node services for holiday bookings, and I wrote the pricing tracker that watches our",
    "own site for changes.",
    "I studied Computer Science at Example University. I would like to work on backend systems with real",
    "traffic behind them.",
    "Yours sincerely,",
    "Example User",
  ].join("\n");
  assert.deepEqual(findAiTells(letter), []);
  assert.deepEqual(fixTypography(letter).applied, []);
});

test("the revision prompt names each problem and forbids changing the facts", () => {
  const prompt = buildHumanizePrompt({
    letter: "I am passionate about this role.",
    tells: findAiTells("I am passionate about this role."),
    rules: "RULES BODY",
  });
  assert.match(prompt, /1\. It uses sales language in place of specifics/);
  assert.match(prompt, /Do not add, drop, or alter any factual claim/);
  assert.match(prompt, /Keep the same paragraph count/);
  assert.match(prompt, /RULES BODY/);
  assert.match(prompt, /Return only the letter/);
});
