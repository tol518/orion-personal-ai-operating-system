// A second agent reads the documents before they go out.
//
// Borrowed from https://github.com/MadsLorentzen/ai-job-search, whose /apply spawns a reviewer to
// critique the drafter's work. The drafter knows what it meant; a fresh reader sees what it actually
// says. The two roles are separate turns so the reviewer is not defending its own draft.
//
// The asymmetry is deliberate and comes from the user's own decision: the CV is never rewritten per
// job, so the reviewer may only *report* on it. A gap between the listing and the CV is information
// for him to act on, not licence to edit his CV. The cover letter is written for this one role, so
// that one the reviewer may rewrite.
import { runSessionTurn } from "./session-turn.js";
import { parseJsonObject } from "./cv-editor-service.js";

const MODEL = "openai/gpt-5.6-terra";
export const DOCUMENT_REVIEW_SESSION_KEY = "agent:main:dashboard:hunting-document-review";
const TIMEOUT_MS = 300_000;
const MAX_ITEMS = 8;
const SEVERITIES = new Set(["blocking", "notable", "minor"]);

export class DocumentReviewService {
  constructor({ gateway, timeoutMs = TIMEOUT_MS }) {
    this.gateway = gateway;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Review the pair. Returns the advisory CV notes plus the letter, rewritten only if the rewrite
   * survived the fact check below. Never throws: a failed review must not stop an application.
   */
  async review({ job, cv, letter, identityMemory, applicationMemory }) {
    let parsed;
    try {
      const text = await runSessionTurn({
        gateway: this.gateway,
        sessionKey: DOCUMENT_REVIEW_SESSION_KEY,
        message: buildReviewPrompt({ job, cv, letter, identityMemory, applicationMemory }),
        timeoutMs: this.timeoutMs,
        label: "Reviewing the CV and cover letter",
      });
      parsed = parseReviewResult(text);
    } catch (error) {
      return {
        reviewed: false,
        detail: String(error?.message ?? error).slice(0, 300),
        cvGaps: [],
        letterIssues: [],
        letter,
        letterRewritten: false,
      };
    }
    // A rewrite that invented a number is rejected outright rather than trusted and sent.
    const invented = letter ? inventedFigures({ rewrite: parsed.letterRewrite, sources: [letter, cv] }) : [];
    const usableRewrite =
      parsed.letterRewrite && !invented.length && parsed.letterRewrite.length >= Math.floor((letter?.length ?? 0) * 0.6)
        ? parsed.letterRewrite
        : null;
    return {
      reviewed: true,
      detail: parsed.summary,
      cvGaps: parsed.cvGaps,
      letterIssues: parsed.letterIssues,
      letter: usableRewrite ?? letter,
      letterRewritten: Boolean(usableRewrite),
      ...(invented.length ? { rejectedRewrite: `introduced figures absent from the sources: ${invented.join(", ")}` } : {}),
    };
  }
}

export function buildReviewPrompt({ job, cv, letter, identityMemory, applicationMemory }) {
  return [
    "You are a second reader checking documents another agent drafted for Example User's application. You did not write them.",
    "Your job is to find what a hiring reader would notice: a requirement in the listing that his CV does not evidence, and anything in the cover letter that is vague, generic, repetitive, or reads as machine-written.",
    "You may rewrite the COVER LETTER. You may not rewrite the CV: report gaps in it for the user to decide on. He deliberately sends one CV to every employer.",
    "Never add, remove, or alter a fact. No new metric, employer, tool, date, qualification, or level of seniority in the rewrite, and never claim experience the CV does not show. A plain true sentence beats a polished false one.",
    "Judge the CV only against the listing text given here. Do not invent requirements the listing does not state.",
    'Return only JSON: {"summary":"one sentence","cvGaps":[{"requirement":"what the listing asks for","evidence":"what the CV shows, or null","severity":"blocking|notable|minor","suggestion":"what the user could add, or null"}],"letterIssues":[{"issue":"what is wrong","fix":"how it was fixed"}],"letterRewrite":"the improved letter, or null if it is already good"}',
    `ROLE: ${job.title}`,
    `COMPANY: ${job.company}`,
    `LISTING TEXT:\n${job.descriptionExcerpt ?? "No description excerpt available."}`,
    `VERIFIED IDENTITY MEMORY:\n${identityMemory?.body ?? "none"}`,
    `VERIFIED APPLICATION MEMORY:\n${applicationMemory?.body ?? "none"}`,
    `CV (advisory only, never rewrite):\n${String(cv).slice(0, 60_000)}`,
    `COVER LETTER (may be rewritten):\n${letter ?? "No cover letter was written for this role."}`,
  ].join("\n\n");
}

export function parseReviewResult(text) {
  const parsed = parseJsonObject(text);
  return {
    summary: cleanText(parsed?.summary, 300) || "No review summary was given.",
    cvGaps: asArray(parsed?.cvGaps)
      .map((gap) => ({
        requirement: cleanText(gap?.requirement, 200),
        evidence: cleanText(gap?.evidence, 200) || null,
        severity: SEVERITIES.has(gap?.severity) ? gap.severity : "notable",
        suggestion: cleanText(gap?.suggestion, 240) || null,
      }))
      .filter((gap) => gap.requirement)
      .slice(0, MAX_ITEMS),
    letterIssues: asArray(parsed?.letterIssues)
      .map((entry) => ({
        issue: cleanText(entry?.issue, 200),
        fix: cleanText(entry?.fix, 200) || null,
      }))
      .filter((entry) => entry.issue)
      .slice(0, MAX_ITEMS),
    letterRewrite: cleanLetter(parsed?.letterRewrite),
  };
}

/**
 * Numbers are how a rewrite inflates a claim without looking like it.
 *
 * "Improved performance" becoming "improved performance by 40%" reads better and is a fabrication.
 * Any figure in the rewrite that is not already in the letter or the CV rejects the whole rewrite:
 * the original wording is worth more than the polish.
 */
export function inventedFigures({ rewrite, sources }) {
  if (!rewrite) return [];
  const known = new Set(sources.flatMap((source) => figuresIn(source)));
  return [...new Set(figuresIn(rewrite))].filter((figure) => !known.has(figure)).slice(0, 6);
}

function figuresIn(text) {
  // Years are excluded: a date already in the sources reappears in many formats, and a wrong one
  // is caught by the fact rules rather than by counting digits.
  return (String(text ?? "").match(/\d[\d,.]*\s*%?/g) ?? [])
    .map((value) => value.replace(/[\s,]/g, ""))
    .filter((value) => !/^(19|20)\d{2}\.?$/.test(value));
}

function cleanLetter(value) {
  const text = String(value ?? "")
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return text.length > 40 ? text : null;
}

function cleanText(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export { MODEL as DOCUMENT_REVIEW_MODEL };
