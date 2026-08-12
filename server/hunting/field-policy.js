// How the fill phase is allowed to answer a field, and how to drive the widget in front of it.
//
// Written after a real failure: the right-to-work answer was in verified memory, the form asked
// it as a searchable dropdown, and the run left the field empty because it typed into the
// combobox without ever selecting an option. Two rules come out of that — drive the widget to a
// committed selection, and match the verified fact to the option list tolerantly (case,
// punctuation and extra words differ everywhere) without ever claiming more than the fact says.

const WIDGET_PROCEDURES = [
  "Native <select>: read its options from a fresh snapshot, then select by the option's visible text. Do not type into it.",
  "Searchable dropdown or combobox (a text box that opens a list): click it, type a short distinctive fragment of the answer, wait for the filtered list in a new snapshot, then click the option you want — or press ArrowDown until it is highlighted and press Enter.",
  "Never leave a combobox holding typed text with no option selected. Typed text that was never committed is discarded silently and the answer is lost. After selecting, take a snapshot and confirm the control now shows the chosen option; if it does not, clear it and try once more.",
  "Radio groups and checkboxes: click the specific option, then confirm it reads as checked.",
  "A checkbox list is one question that accepts several answers: tick every option the verified sources support and leave the rest, rather than treating each box as its own question. Report the question once, with the ticked options.",
  "Custom Yes/No button groups: treat ARIA radio, pressed, checked, or selected state as the committed value. After clicking the exact answer, take a fresh snapshot and confirm the option is still selected; a click alone is not proof.",
  "Date fields: type in the format the field itself shows; if the format is ambiguous, leave it and report it.",
];

const MATCHING_RULES = [
  "Match a verified answer to the offered options loosely on wording but strictly on meaning. Ignore case, hyphens, punctuation, ordering and extra words: \"pre-settled status\" in memory matches an option written \"Yes - Settled/pre-settled status\".",
  "Choose the option that the verified fact already entails. Never choose an option that claims more or different than the fact: pre-settled status is not a British or Irish passport, and \"no sponsorship needed\" is not \"I need Visa Sponsorship\".",
  "For every fixed-choice answer, report sourceFact as the short supporting fact from the named source. The system checks that fact's polarity against the retained option; do not paraphrase it into the opposite question wording.",
  "If several options fit equally well, or the closest option would overstate the fact, leave the field and report it as unresolved.",
  "If the option list has a \"Prefer not to say\" style choice and memory says exactly that, use it.",
];

const FILE_FIELD_RULES = [
  "Never upload, replace, clear, or re-select a file. The CV is attached by the system, and the system also attaches the cover letter when a field only accepts a file.",
  "If a cover letter, supporting document, or similar field accepts a file rather than text, leave it alone and list it in skippedFields noting that it needs a file. Do not paste the letter into an unrelated field to compensate.",
  "If the CV field looks empty, say so in unresolvedFields rather than attempting the upload yourself; the system re-attaches and re-checks it after this turn.",
];

const OPTIONAL_FIELD_RULES = [
  "Treat a field as required only when the form marks it required (asterisk, \"required\", or the browser rejects an empty value).",
  "If an optional field has no verified answer, skip it and list it in skippedFields with a short reason. Do not stop the application for an optional field, and never invent content to fill one.",
  "If a required field has no verified answer, leave it untouched and list it in unresolvedFields so the user can decide.",
];

/**
 * Prompt block for the fill phase. Kept out of the runner so widget/matching policy has one
 * home, and so a cover letter is only offered when one was actually generated.
 */
export function describeFieldPolicy({ coverLetter = null } = {}) {
  const lines = [
    "FIELD POLICY",
    "Widgets:",
    ...WIDGET_PROCEDURES.map((rule) => `- ${rule}`),
    "Matching a verified answer to a fixed option list:",
    ...MATCHING_RULES.map((rule) => `- ${rule}`),
    "File fields:",
    ...FILE_FIELD_RULES.map((rule) => `- ${rule}`),
    "Required versus optional:",
    ...OPTIONAL_FIELD_RULES.map((rule) => `- ${rule}`),
  ];
  if (coverLetter) {
    lines.push(
      "Cover letter or cover note fields:",
      "- A cover letter written for this exact company and role is supplied below. Paste it into a cover letter, cover note, or \"why do you want to work here\" field when that field takes text.",
      "- Do not rewrite it, do not add claims to it, and do not paste it into a field that asks for something else.",
      "- If the only cover letter field takes a file, leave it: the system attaches the same letter as a file after this turn.",
    );
  }
  return lines.join("\n");
}

/**
 * Deterministic option matcher used to check a reported selection against the options that were
 * on screen. Returns the entailed option, or null when nothing matches closely enough — the
 * same conservative answer the prompt asks for.
 */
export function matchOption(options, answer) {
  const target = normalizeAnswer(answer);
  if (!target) return null;
  const scored = options
    .map((option) => ({ option, score: optionScore(normalizeAnswer(option), target) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  if (!scored.length) return null;
  // A near-tie means the wording cannot decide it; the caller must not guess.
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.15) return null;
  return scored[0].score >= 0.5 ? scored[0].option : null;
}

function optionScore(option, target) {
  if (!option) return 0;
  const targetNegative = hasNegativePolarity(target);
  const optionNegative = hasNegativePolarity(option);
  if (targetNegative && option === "no") return 0.98;
  if (!targetNegative && option === "no") return 0;
  if (targetNegative !== optionNegative && sharesDecisionSubject(option, target)) return 0;
  if (option === target) return 1;
  if (option.includes(target) || target.includes(option)) return 0.85;
  const optionTokens = new Set(option.split(" ").filter((token) => token.length > 2));
  const targetTokens = target.split(" ").filter((token) => token.length > 2);
  if (!targetTokens.length || !optionTokens.size) return 0;
  const shared = targetTokens.filter((token) => optionTokens.has(token)).length;
  return shared / targetTokens.length;
}

function hasNegativePolarity(value) {
  return /\b(no|not|never|without|doesnt|does not|dont|do not)\b/.test(value);
}

function sharesDecisionSubject(option, target) {
  const decisionTokens = new Set(["visa", "sponsor", "sponsorship", "authorised", "authorized", "eligible"]);
  const optionTokens = new Set(option.split(" "));
  return target.split(" ").some((token) => decisionTokens.has(token) && optionTokens.has(token));
}

function normalizeAnswer(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[-_/\\]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
