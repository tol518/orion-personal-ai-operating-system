// Company-specific cover letters, grounded in the CV and approved memories.
//
// Saved as markdown so the letter that was actually sent can be re-read before an interview —
// a letter that only ever existed inside a form field is unreviewable afterwards.
//
// Style comes from the vendored cover-letter-generator skill; the grounding rules below
// override it wherever the two disagree (see skills/cover-letter-generator/SOURCE.md). The
// generator may not invent a metric, a tool, a company fact, or a level of seniority.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { runSessionTurn } from "./session-turn.js";
import { buildHumanizePrompt, findAiTells, fixTypography } from "./humanizer.js";

const MODEL = "openai/gpt-5.6-terra";
export const COVER_LETTER_SESSION_KEY = "agent:main:dashboard:hunting-cover-letter";
const SESSION_KEY = COVER_LETTER_SESSION_KEY;
const TIMEOUT_MS = 300_000;
const SKILLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "skills");
const SKILL_PATH = path.join(SKILLS_DIR, "cover-letter-generator", "SKILL.md");
// Style guidance is layered: the generator skill decides what a letter contains, the humanizer
// rules decide how it sounds, and the grounding rules below outrank both.
const HUMANIZER_RULES_PATH = path.join(SKILLS_DIR, "humanizer", "RULES.md");

const GROUNDING_RULES = [
  "Write as the user, in the first person, as the letter he sends over his own name.",
  "Never state, imply, or hint that the letter was drafted by an assistant, an AI, a tool, or anything other than the user. No meta commentary about writing or generating it, and no reference to prompts, models, or automation anywhere in the text.",
  "Every factual claim must be traceable to the verified CV or the approved memories below. If a claim is not supported there, leave it out.",
  "Never invent or inflate a metric, employer, job title, date, qualification, tool, technology, or level of seniority. Do not describe experience the user does not have.",
  "You have not researched this company. Use only the company name, the role, and the listing text provided; do not assert products, funding, strategy, culture, or news you have not read.",
  "Do not claim a skill is in progress unless the CV or memory records it.",
  "Write for this exact company and role. A letter that would fit any employer has failed.",
  "British English, no em dashes, no emoji, no placeholder brackets, and no invented contact details.",
];

export class CoverLetterService {
  constructor({ gateway, dir, timeoutMs = TIMEOUT_MS }) {
    this.gateway = gateway;
    this.dir = dir;
    this.timeoutMs = timeoutMs;
  }

  /** Write the letter for one job and return the saved artifact plus its text. */
  async generate({ job, cv, identityMemory, applicationMemory }) {
    const humanizerRules = readRules(HUMANIZER_RULES_PATH, HUMANIZER_FALLBACK);
    const text = await runSessionTurn({
      gateway: this.gateway,
      sessionKey: SESSION_KEY,
      message: buildCoverLetterPrompt({
        job,
        cv,
        identityMemory,
        applicationMemory,
        skill: readRules(SKILL_PATH, SKILL_FALLBACK),
        humanizerRules,
      }),
      timeoutMs: this.timeoutMs,
      label: "Writing the cover letter",
    });
    const draft = normalizeLetter(text);
    if (!draft) throw new Error("The cover letter came back empty");
    const humanized = await this.#humanize({ letter: draft, rules: humanizerRules });
    return this.save({
      job,
      letter: humanized.letter,
      memoryIds: [identityMemory.id, applicationMemory.id],
      humanizer: humanized.report,
    });
  }

  /**
   * One revision pass, and only when the draft earned it.
   *
   * Asking for the rules up front does not mean they were followed, so the draft is inspected.
   * A clean draft costs nothing extra; a draft with tells is worth one more turn, because these
   * letters are read by people who screen for exactly this. The pass is capped at one: a second
   * rewrite of an already-rewritten letter drifts away from the grounded facts for diminishing
   * returns, so remaining tells are recorded instead of chased.
   */
  async #humanize({ letter, rules }) {
    const typography = fixTypography(letter);
    const tells = findAiTells(typography.letter);
    if (!tells.length) {
      return {
        letter: typography.letter,
        report: { revised: false, typographyFixed: typography.applied, tellsFound: [], tellsRemaining: [] },
      };
    }
    let revised = null;
    try {
      revised = normalizeLetter(
        await runSessionTurn({
          gateway: this.gateway,
          sessionKey: SESSION_KEY,
          message: buildHumanizePrompt({ letter: typography.letter, tells, rules }),
          timeoutMs: this.timeoutMs,
          label: "Making the cover letter sound human",
        }),
      );
    } catch {
      // A failed rewrite must not lose a usable letter; the draft still goes out.
    }
    // A rewrite that came back empty or truncated is rejected in favour of the draft it replaced.
    const usable = revised && revised.length >= Math.floor(typography.letter.length * 0.6) ? revised : null;
    const finalLetter = usable ? fixTypography(usable).letter : typography.letter;
    return {
      letter: finalLetter,
      report: {
        revised: Boolean(usable),
        typographyFixed: typography.applied,
        tellsFound: tells.map((tell) => tell.rule),
        tellsRemaining: findAiTells(finalLetter).map((tell) => tell.rule),
      },
    };
  }

  save({ job, letter, memoryIds = [], humanizer = null }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `${filePart(job.company)}-${filePart(job.title)}-${String(job.id).slice(0, 8)}.md`;
    const hostPath = path.join(this.dir, name);
    const document = withFrontMatter({ job, letter });
    fs.writeFileSync(hostPath, document, { mode: 0o600 });
    return {
      name,
      hostPath,
      content: document,
      letter,
      words: letter.split(/\s+/).filter(Boolean).length,
      sha256: createHash("sha256").update(document).digest("hex"),
      bytes: Buffer.byteLength(document),
      // Kept on the checkpoint, not in the letter: the audit belongs to the application.
      groundedIn: ["canonical CV", ...memoryIds],
      // Which tells were found and whether the revision pass ran, so a stiff letter is explainable.
      ...(humanizer ? { humanizer } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Re-read a saved letter for review; returns null once the file is gone. `letter` is the
   * sendable text with the application metadata removed — callers pasting into a form or
   * showing the letter to the user want that, never the raw file.
   */
  read({ name }) {
    if (!name) return null;
    const hostPath = path.join(this.dir, path.basename(name));
    try {
      const content = fs.readFileSync(hostPath, "utf8");
      return {
        name: path.basename(name),
        hostPath,
        content,
        letter: stripFrontMatter(content),
        createdAt: fs.statSync(hostPath).mtime.toISOString(),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Some forms only accept the cover letter as a file. Plain text is tried first because it is
 * the smallest, most widely accepted thing to hand over; PDF is the fallback for the forms
 * that reject .txt. Both carry the letter alone — no metadata, same as the pasted text.
 */
export function renderCoverLetterText(letter) {
  return Buffer.from(`${String(letter ?? "").trim()}\n`, "utf8");
}

/** A plain business-letter PDF. Rendered with pdfkit, so no browser is involved. */
export async function renderCoverLetterPdf(letter) {
  const { default: PDFDocument } = await import("pdfkit");
  return await new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: 64, bottom: 64, left: 64, right: 64 },
      info: { Title: "Cover letter" },
    });
    const chunks = [];
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
    document.font("Helvetica").fontSize(11);
    // Blank lines separate paragraphs; single newlines (the sign-off) stay as line breaks.
    for (const paragraph of String(letter ?? "").trim().split(/\n{2,}/)) {
      document.text(paragraph.replace(/[ \t]+$/gm, ""), { align: "left", lineGap: 2.5 });
      document.moveDown(0.7);
    }
    document.end();
  });
}

/** Drop the leading application metadata block, leaving the letter as it would be sent. */
export function stripFrontMatter(content) {
  const match = /^---\n[\s\S]*?\n---\n+/.exec(String(content ?? ""));
  return match ? String(content).slice(match[0].length).trim() : String(content ?? "").trim();
}

export function buildCoverLetterPrompt({
  job,
  cv,
  identityMemory,
  applicationMemory,
  skill,
  humanizerRules = "",
}) {
  return [
    "You are writing one cover letter for the user, Example User, for the specific role below.",
    "Follow the structure guidance in the SKILL below and the wording rules in HUMANIZER RULES, except where either conflicts with the grounding rules — the grounding rules always win.",
    "It must read as a person wrote it. Never satisfy a humanizing rule by changing what the letter claims: a plain true sentence beats a natural-sounding false one.",
    ...GROUNDING_RULES.map((rule) => `- ${rule}`),
    "Aim for 250 to 400 words in three or four paragraphs. Address it to the hiring team when no name is given.",
    "Return only the letter as markdown. No preamble, no commentary, no code fence, no front matter.",
    `SKILL:\n${skill}`,
    `HUMANIZER RULES:\n${humanizerRules}`,
    `ROLE: ${job.title}`,
    `COMPANY: ${job.company}`,
    `LISTING URL: ${job.url}`,
    `LISTING TEXT (all you know about this employer):\n${job.descriptionExcerpt ?? "No description excerpt available."}`,
    `VERIFIED MATCH REASONS:\n${(job.matchReasons ?? []).join("\n") || "None recorded."}`,
    `VERIFIED IDENTITY MEMORY (${identityMemory.id}):\n${identityMemory.body}`,
    `VERIFIED APPLICATION MEMORY (${applicationMemory.id}):\n${applicationMemory.body}`,
    `VERIFIED CV — the only source of experience claims:\n${String(cv).slice(0, 80_000)}`,
  ].join("\n\n");
}

const SKILL_FALLBACK =
  "No skill file is available; rely on the grounding rules and a standard four-paragraph business letter.";
const HUMANIZER_FALLBACK =
  "No humanizer rules file is available; write plainly, use ordinary words, avoid em dashes, and never use assistant phrasing.";

/** A missing guidance file degrades the letter's style; it must not stop the letter. */
function readRules(rulesPath, fallback) {
  try {
    return fs.readFileSync(rulesPath, "utf8");
  } catch {
    return fallback;
  }
}

/**
 * Front matter records which application the letter belongs to, and nothing else.
 *
 * It deliberately carries no authorship or tooling attribution: this file is the user's letter,
 * and it may end up forwarded or attached somewhere. The provenance an audit needs (sources,
 * checksum, word count, time) lives on the application checkpoint instead.
 */
function withFrontMatter({ job, letter }) {
  const frontMatter = [
    "---",
    `company: ${yamlString(job.company)}`,
    `role: ${yamlString(job.title)}`,
    `listing: ${yamlString(job.url)}`,
    `jobId: ${yamlString(job.id)}`,
    `savedAt: ${new Date().toISOString()}`,
    "---",
  ].join("\n");
  return `${frontMatter}\n\n${letter}\n`;
}

function normalizeLetter(text) {
  return String(text ?? "")
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function filePart(value) {
  return (
    String(value ?? "role")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45) || "role"
  );
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}
