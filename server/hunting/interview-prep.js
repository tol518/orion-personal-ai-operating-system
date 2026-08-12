// Interview preparation for one application, saved as markdown he can read the night before.
//
// Borrowed from the /interview command in https://github.com/MadsLorentzen/ai-job-search. That repo
// collects STAR stories during a setup interview and draws on them; this app has no verified store
// of the user's stories, only his CV and his approved memories.
//
// So the honest shape is different: where a real story exists in those sources, the answer is
// written from it. Where one does not, the question is listed with the situation it needs and left
// for him to fill in. A fabricated STAR answer is the worst possible output here — he would walk
// into the room holding a story that never happened and be asked follow-up questions about it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runSessionTurn } from "./session-turn.js";
import { parseJsonObject } from "./cv-editor-service.js";

export const INTERVIEW_PREP_SESSION_KEY = "agent:main:dashboard:hunting-interview-prep";
const TIMEOUT_MS = 300_000;
const MAX_QUESTIONS = 12;

export class InterviewPrepService {
  constructor({ gateway, dir, timeoutMs = TIMEOUT_MS }) {
    this.gateway = gateway;
    this.dir = dir;
    this.timeoutMs = timeoutMs;
  }

  /** Write the prep sheet for one job and return the saved artifact. */
  async generate({ job, cv, identityMemory, applicationMemory, coverLetter = null }) {
    const text = await runSessionTurn({
      gateway: this.gateway,
      sessionKey: INTERVIEW_PREP_SESSION_KEY,
      message: buildInterviewPrompt({ job, cv, identityMemory, applicationMemory, coverLetter }),
      timeoutMs: this.timeoutMs,
      label: "Preparing interview questions",
    });
    const prep = parseInterviewPrep(text);
    if (!prep.questions.length) throw new Error("The interview preparation came back empty");
    return this.save({ job, prep });
  }

  save({ job, prep }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `${filePart(job.company)}-${filePart(job.title)}-${String(job.id).slice(0, 8)}-interview.md`;
    const hostPath = path.join(this.dir, name);
    const document = renderPrep({ job, prep });
    fs.writeFileSync(hostPath, document, { mode: 0o600 });
    return {
      name,
      hostPath,
      content: document,
      questions: prep.questions.length,
      grounded: prep.questions.filter((entry) => entry.answer).length,
      needsHisStory: prep.questions.filter((entry) => !entry.answer).length,
      sha256: createHash("sha256").update(document).digest("hex"),
      bytes: Buffer.byteLength(document),
      createdAt: new Date().toISOString(),
    };
  }

  read({ name }) {
    if (!name) return null;
    try {
      return {
        name: path.basename(name),
        content: fs.readFileSync(path.join(this.dir, path.basename(name)), "utf8"),
      };
    } catch {
      return null;
    }
  }
}

export function buildInterviewPrompt({ job, cv, identityMemory, applicationMemory, coverLetter }) {
  return [
    "You are preparing Example User for an interview for the role below. Write what he should walk in knowing.",
    "For each likely question, write a STAR answer (Situation, Task, Action, Result) ONLY from the verified CV and memories below.",
    "If no real experience in those sources supports a question, leave the answer null and instead name the kind of story it needs. Never invent a situation, a metric, a team, or a result. He will be asked follow-up questions about anything he says, so a made-up story is worse than an admitted gap.",
    "Cover the mix a real interview has: a couple about the role's core skills, one or two behavioural, one about a failure or setback, and one or two he should ask them.",
    "Keep each answer under 150 words and in his own plain voice, not corporate phrasing.",
    'Return only JSON: {"questions":[{"question":"...","kind":"technical|behavioural|failure|motivation|ask-them","answer":"the STAR answer, or null","source":"which verified fact it rests on, or null","needs":"the kind of story required, when answer is null"}],"notes":"anything else worth knowing before the interview"}',
    `ROLE: ${job.title}`,
    `COMPANY: ${job.company}`,
    `LISTING TEXT (all that is known about this employer):\n${job.descriptionExcerpt ?? "No description excerpt available."}`,
    `VERIFIED IDENTITY MEMORY:\n${identityMemory?.body ?? "none"}`,
    `VERIFIED APPLICATION MEMORY:\n${applicationMemory?.body ?? "none"}`,
    ...(coverLetter ? [`THE COVER LETTER HE SENT (they may ask about it):\n${coverLetter}`] : []),
    `VERIFIED CV — the only source of experience claims:\n${String(cv).slice(0, 60_000)}`,
  ].join("\n\n");
}

export function parseInterviewPrep(text) {
  const parsed = parseJsonObject(text);
  const questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
    .map((entry) => ({
      question: clean(entry?.question, 300),
      kind: KINDS.has(entry?.kind) ? entry.kind : "behavioural",
      answer: clean(entry?.answer, 1_400) || null,
      source: clean(entry?.source, 240) || null,
      needs: clean(entry?.needs, 240) || null,
    }))
    .filter((entry) => entry.question)
    .slice(0, MAX_QUESTIONS);
  return { questions, notes: clean(parsed?.notes, 800) || null };
}

const KINDS = new Set(["technical", "behavioural", "failure", "motivation", "ask-them"]);

/**
 * Rendered so the gaps are impossible to miss.
 *
 * An unanswered question is the most useful line on the page: it is the one he has to think about
 * before the interview, so it is marked rather than quietly omitted.
 */
export function renderPrep({ job, prep }) {
  const lines = [
    "---",
    `company: ${job.company}`,
    `role: ${job.title}`,
    `listing: ${job.url}`,
    `jobId: ${job.id}`,
    `savedAt: ${new Date().toISOString()}`,
    "---",
    "",
    `# Interview prep — ${job.company}, ${job.title}`,
    "",
  ];
  const answered = prep.questions.filter((entry) => entry.answer);
  const gaps = prep.questions.filter((entry) => !entry.answer);
  if (answered.length) {
    lines.push("## Answers grounded in your CV and memories", "");
    for (const entry of answered) {
      lines.push(`### ${entry.question}`, `_${entry.kind}_`, "", entry.answer);
      if (entry.source) lines.push("", `Rests on: ${entry.source}`);
      lines.push("");
    }
  }
  if (gaps.length) {
    lines.push(
      "## Needs your story",
      "",
      "Nothing in your CV or memories answers these. Write them yourself rather than improvising on the day.",
      "",
    );
    for (const entry of gaps) {
      lines.push(`- **${entry.question}** (${entry.kind})${entry.needs ? ` — needs: ${entry.needs}` : ""}`);
    }
    lines.push("");
  }
  if (prep.notes) lines.push("## Notes", "", prep.notes, "");
  return lines.join("\n");
}

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function filePart(value) {
  return (
    String(value ?? "role")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 45) || "role"
  );
}
