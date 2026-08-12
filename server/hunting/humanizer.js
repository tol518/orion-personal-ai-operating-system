// Checking a cover letter for the tells that make it read as machine-written.
//
// The humanizing rules go into the generating prompt, but a prompt is a request and this codebase
// does not treat requests as evidence — the same reason form completion is judged against the live
// page rather than the model's account of it. So the letter is inspected after it comes back, and
// what is still there decides whether one revision pass is worth spending.
//
// The split is deliberate. Curly quotes are a character substitution with exactly one correct
// answer, so they are fixed here. An em dash is not: replacing it needs a full stop, a comma, or a
// restructured sentence depending on the clause, and a blind swap produces comma splices. Anything
// needing judgement is reported and handed back to the model, never guessed at.
//
// Rules and their wording are derived from skills/humanizer/RULES.md; see that directory's
// SOURCE.md for provenance.

/** Straight-quote substitutions. Character-level, no judgement, so applied directly. */
const TYPOGRAPHIC_FIXES = [
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/…/g, "..."],
  // Non-breaking and other exotic spaces survive copy-paste into form fields as mojibake.
  [/[   ]/g, " "],
];

/**
 * Tells worth a revision pass. Each needs sentence-level rework, so each is described in the terms
 * the rewrite should use rather than as a find-and-replace pair.
 */
const TELLS = [
  { rule: "em-or-en-dash", pattern: /[—–]/, note: "contains an em or en dash" },
  {
    rule: "significance-inflation",
    pattern: /\b(stands as|serves as|a testament to|a reminder that|underscores?|pivotal|at the forefront of|symbolis(?:e|ing)|plays a (?:vital|crucial|key) role)\b/i,
    note: "inflates significance instead of stating the fact",
  },
  {
    rule: "participial-padding",
    pattern: /,\s+(?:highlighting|emphasi[sz]ing|showcasing|demonstrating|reflecting|underscoring)\b/i,
    note: "ends a sentence with an -ing clause that adds no fact",
  },
  {
    rule: "promotional-language",
    pattern: /\b(passionate|thrilled|excited to|delve|leverag(?:e|ing)|spearhead(?:ed|ing)|renowned|vibrant|cutting[- ]edge|world[- ]class|boasts)\b/i,
    note: "uses sales language in place of specifics",
  },
  {
    rule: "ai-vocabulary",
    pattern: /\b(additionally|crucial|seamless(?:ly)?|robust|holistic|myriad|plethora|utilis?e|utili[sz]ing|commence|facilitate|tapestry|interplay|landscape of)\b/i,
    note: "uses AI-frequent vocabulary where a plain word exists",
  },
  {
    rule: "negative-parallelism",
    pattern: /\b(not only\b[^.]{0,80}\bbut also|it'?s not just\b|more than just\b)/i,
    note: "states the point through a negative parallelism",
  },
  {
    rule: "filler-phrase",
    pattern: /\b(in order to|due to the fact that|at this point in time|in the event that|has the ability to|it is important to note that)\b/i,
    note: "carries a filler phrase with a shorter equivalent",
  },
  {
    rule: "excessive-hedging",
    pattern: /\b(could potentially|may possibly|might potentially|possibly might)\b/i,
    note: "stacks hedges",
  },
  {
    rule: "authority-trope",
    pattern: /\b(the real question is|at its core|what really matters|fundamentally,|the heart of)\b/i,
    note: "uses rhetorical padding in place of the claim",
  },
  {
    rule: "generic-uplift-ending",
    pattern: /\b(the future looks bright|exciting times ahead|achieve great things together|together we can achieve)\b/i,
    note: "ends on generic uplift rather than a concrete point",
  },
  {
    rule: "chatbot-residue",
    pattern: /\b(i hope this helps|let me know if|would you like me to|as an AI|based on the information provided|as of my last (?:update|training)|here is a cover letter)\b/i,
    note: "contains assistant-to-user residue that must never reach an employer",
  },
  {
    rule: "rhetorical-opener",
    pattern: /(^|\n)\s*(honestly\?|look,|here'?s the thing|let'?s be honest)/i,
    note: "opens with a theatrical hook",
  },
];

/** Apply the substitutions that have one correct answer. Returns the text and what changed. */
export function fixTypography(text) {
  let letter = String(text ?? "");
  const applied = [];
  for (const [pattern, replacement] of TYPOGRAPHIC_FIXES) {
    if (pattern.test(letter)) {
      letter = letter.replace(pattern, replacement);
      applied.push(replacement === "'" ? "curly apostrophes" : replacement === '"' ? "curly quotes" : "other");
    }
  }
  return { letter, applied: [...new Set(applied)] };
}

/** Every tell present in the letter, as the revision instruction that would clear it. */
export function findAiTells(text) {
  const letter = String(text ?? "");
  return TELLS.filter((tell) => tell.pattern.test(letter)).map((tell) => ({
    rule: tell.rule,
    note: tell.note,
    excerpt: excerptFor(letter, tell.pattern),
  }));
}

/** The revision turn's message: the letter, the specific tells found, and nothing else to do. */
export function buildHumanizePrompt({ letter, tells, rules }) {
  return [
    "Rewrite the cover letter below so it reads as the user wrote it himself, then return only the rewritten letter.",
    "These specific problems were found in it. Fix every one:",
    ...tells.map((tell, index) => `${index + 1}. It ${tell.note}. Found: "${tell.excerpt}"`),
    "Change wording only. Do not add, drop, or alter any factual claim: no new metric, employer, tool, date, qualification, or level of seniority, and do not remove one that is there.",
    "Keep the same paragraph count, the same structure, British English, and the existing sign-off.",
    "Return only the letter. No preamble, no commentary, no code fence, no notes about what you changed.",
    `RULES:\n${rules}`,
    `LETTER:\n${letter}`,
  ].join("\n\n");
}

function excerptFor(letter, pattern) {
  const match = pattern.exec(letter);
  if (!match) return "";
  const start = Math.max(0, match.index - 24);
  return letter.slice(start, match.index + match[0].length + 24).replace(/\s+/g, " ").trim().slice(0, 90);
}
