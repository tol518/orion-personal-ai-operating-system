// Model-driven phases of a controlled application.
//
// The runner owns exactly two model turns: open the form and report what it is, then fill
// the fields that verified data supports. The CV upload between them is done by BFF code
// (see application-upload-service.js), because a model cannot prove that a file was bound to
// a file input — it can only report that it tried.
import { createHash } from "node:crypto";
import { parseJsonObject } from "./cv-editor-service.js";
import { describeFieldPolicy } from "./field-policy.js";
import { abortSessionRun, runSessionTurn, withSessionConflictRetry } from "./session-turn.js";
import { describeAdapterForPrompt } from "./site-adapters.js";

const APPLICATION_MODEL = "openai/gpt-5.6-terra";
const APPLICATION_SESSION_PREFIX = "agent:main:dashboard:hunting-application-";
// Both phases browse a real application form through a Codex-routed model; the previous
// ceilings were tight enough to abandon turns that were still making progress.
const OPEN_FORM_TIMEOUT_MS = 600_000;
const FILL_FIELDS_TIMEOUT_MS = 900_000;
const OPEN_FORM_STATUSES = new Set(["form_open", "needs_human_action", "failed"]);
const FILL_STATUSES = new Set(["ready_for_review", "needs_human_action", "failed"]);
export const HUMAN_ACTION_KINDS = new Set([
  "sign_in",
  "captcha",
  "verification",
  "upload",
  "answer_question",
  // A policy or declaration this host is not cleared for; the UI turns it into a one-click grant.
  "legal_acceptance",
  "review",
  "other",
]);
const FIELD_SOURCES = new Set([
  "cv",
  "identity-memory",
  "application-memory",
  "job-listing",
  // An acceptance the user cleared in chat; the grant itself is the source.
  "user-authorisation",
]);
const MAX_GUIDANCE_LENGTH = 2_000;

/** Labels are globally unique in OpenClaw's session store, unlike application job IDs. */
export function applicationSessionLabel(job) {
  const id = String(job.id ?? "").trim();
  const suffix = ` · ${id}`;
  const summary = `Hunting · ${job.company} · ${job.title}`;
  return `${summary.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
}

// Non-negotiable boundaries. These are repeated in both phases because each phase is a
// separate model turn and neither may inherit permission from the other.
const SAFETY_RULES = [
  "Never enter a password, passcode, one-time code, or 2FA response, never create an account, and never complete an email or identity verification. Credentials are never supplied to you; if any appear in your context, do not use them.",
  "Never solve, click, delegate, or attempt to bypass a CAPTCHA or anti-bot challenge, and never use any tool or skill that claims to do so.",
  "Never click the final apply, submit, confirm, or send control; submission is the system's decision, not yours.",
  "Never invent or infer experience, dates, metrics, qualifications, work authorisation, salary expectations, contact details, consent, or demographic answers.",
  // Acceptance is not forbidden any more, it is delegated: what this host is cleared for arrives
  // in its own prompt block, written from permissions the user gave in chat.
  "Accept a policy, terms, or declaration only where the authorisation block below says the user cleared it for this host. Where it does, do it without asking again; where it does not, leave the control alone and report it.",
  "Leave voluntary demographic, disability, veteran, and diversity questions blank and report them as unresolved for the user to decide.",
  "Stay in the tab you were given, read a fresh snapshot before each interaction, and report the current URL before you stop.",
];

export class JobApplicationRunner {
  constructor({ gateway, openFormTimeoutMs = OPEN_FORM_TIMEOUT_MS, fillTimeoutMs = FILL_FIELDS_TIMEOUT_MS }) {
    this.gateway = gateway;
    this.openFormTimeoutMs = openFormTimeoutMs;
    this.fillTimeoutMs = fillTimeoutMs;
    this.running = new Set();
    this.cancelled = new Set();
    this.stopWaiters = new Map();
  }

  sessionKey(jobId) {
    return `${APPLICATION_SESSION_PREFIX}${jobId}`;
  }

  ownsSession(sessionKey) {
    return String(sessionKey ?? "").startsWith(APPLICATION_SESSION_PREFIX);
  }

  /** The job currently holding the single-application slot, if any. */
  activeJobId() {
    return [...this.running][0] ?? null;
  }

  claim(jobId) {
    if (this.running.size > 0) {
      const activeJobId = this.activeJobId();
      // Carry the busy job's id so the caller can name it and offer to cancel it, rather than
      // leaving the user with a refusal they cannot act on.
      throw Object.assign(new Error("J.A.R.V.I.S. is already working on an application"), {
        statusCode: 409,
        code: activeJobId === jobId ? "application_already_running" : "another_application_running",
        activeJobId,
      });
    }
    this.cancelled.delete(jobId);
    this.running.add(jobId);
    let resolveStopped;
    const stopped = new Promise((resolve) => {
      resolveStopped = resolve;
    });
    this.stopWaiters.set(jobId, { stopped, resolveStopped });
    return () => {
      this.running.delete(jobId);
      this.cancelled.delete(jobId);
      this.stopWaiters.get(jobId)?.resolveStopped();
      this.stopWaiters.delete(jobId);
    };
  }

  isRunning(jobId) {
    return this.running.has(jobId);
  }

  isCancelled(jobId) {
    return this.cancelled.has(jobId);
  }

  /** Wait for the active run's finally block to release the single-application slot. */
  async waitForStop(jobId, { timeoutMs = 8_000 } = {}) {
    if (!this.running.has(jobId)) return true;
    const waiter = this.stopWaiters.get(jobId);
    if (!waiter) return false;
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), timeoutMs);
      waiter.stopped.then(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
  }

  assertActive(jobId) {
    if (this.cancelled.has(jobId)) throw new ApplicationCancelledError(jobId);
  }

  /** Mark the orchestration cancelled first, then abort every model session it may own. */
  async cancel(jobId, { sessionKeys = [] } = {}) {
    const wasRunning = this.running.has(jobId);
    if (wasRunning) this.cancelled.add(jobId);
    const keys = [...new Set([this.sessionKey(jobId), ...sessionKeys].filter(Boolean))];
    const aborts = await Promise.all(
      keys.map(async (sessionKey) => ({
        sessionKey,
        ...(await abortSessionRun({ gateway: this.gateway, sessionKey })),
      })),
    );
    return { cancelled: wasRunning, aborts };
  }

  /** Phase 1: get the application form on screen and describe it. No data entry, no upload. */
  async openForm({ job, adapter, ownedTab, resume = false, guidance = null, siteHistory = null, consent = null, attachments = [] }) {
    const sessionKey = this.sessionKey(job.id);
    await this.#prepareSession({ sessionKey, job, reset: !resume });
    const text = await runSessionTurn({
      gateway: this.gateway,
      sessionKey,
      message: buildOpenFormPrompt({ job, adapter, ownedTab, resume, guidance, siteHistory, consent }),
      attachments,
      timeoutMs: this.openFormTimeoutMs,
      label: "Opening the application form",
    });
    return parseOpenFormResult(text);
  }

  /** Phase 2: fill only what verified sources support, then stop for user review. */
  async fillFields({
    job,
    cv,
    identityMemory,
    applicationMemory,
    relatedMemories = [],
    adapter,
    targetId,
    uploadSummary,
    coverLetter = null,
    guidance = null,
    consent = null,
    memoryRetryFields = [],
    attachments = [],
  }) {
    const sessionKey = this.sessionKey(job.id);
    await this.#prepareSession({ sessionKey, job, reset: false });
    const text = await runSessionTurn({
      gateway: this.gateway,
      sessionKey,
      message: buildFillFieldsPrompt({
        job,
        cv,
        identityMemory,
        applicationMemory,
        relatedMemories,
        adapter,
        targetId,
        uploadSummary,
        coverLetter,
        guidance,
        consent,
        memoryRetryFields,
      }),
      attachments,
      timeoutMs: this.fillTimeoutMs,
      label: "Filling the application fields",
    });
    return parseFillFieldsResult(text);
  }

  async #prepareSession({ sessionKey, job, reset }) {
    // Clear a run orphaned by a restart; otherwise this phase's message queues behind it.
    await abortSessionRun({ gateway: this.gateway, sessionKey });
    // Session initialization is a state mutation, while each chat turn also initializes and
    // commits that state. Repeating create/patch between opening and filling, or on every resume,
    // races the gateway's commit and produces "reply session initialization conflicted". A new
    // application is the only time this runner needs to reset its session; later turns reuse it.
    if (!reset) return;
    await withSessionConflictRetry(() => this.#writeSessionState({ sessionKey, job, reset: true }));
  }

  async #writeSessionState({ sessionKey, job, reset }) {
    await this.gateway.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: applicationSessionLabel(job),
      model: APPLICATION_MODEL,
    });
    if (reset) {
      await this.gateway.request("sessions.reset", { key: sessionKey, agentId: "main", reason: "reset" });
    }
    await this.gateway.request("sessions.patch", {
      key: sessionKey,
      agentId: "main",
      model: APPLICATION_MODEL,
      thinkingLevel: "medium",
    });
  }
}

export class ApplicationCancelledError extends Error {
  constructor(jobId) {
    super("The application was cancelled by the user");
    this.name = "ApplicationCancelledError";
    this.code = "application_cancelled";
    this.jobId = jobId;
    this.statusCode = 409;
  }
}

export function buildOpenFormPrompt({
  job,
  adapter,
  ownedTab,
  resume,
  guidance = null,
  siteHistory = null,
  consent = null,
}) {
  return [
    "You are J.A.R.V.I.S. opening a job application form for the user. This turn only opens and describes the form.",
    resume ? "The user has just completed a manual step." : "This is a new application run.",
    `The server already opened the exact listing in browser tab targetId ${ownedTab.targetId}: ${ownedTab.currentUrl}`,
    'Use only that tab. Do not call browser tabs, open, or navigate. Every browser call must use target="node" and targetId from above; target="host" and target="sandbox" are forbidden for Hunting.',
    "Never use exec, node_exec, shell, computer control, AppleScript, or Safari. Those paths require a Mac approval and are not part of this application workflow; the server already owns the controlled browser tab.",
    "You may click the site's apply entry control and progress controls listed below to reach the form.",
    "LinkedIn and Indeed can send Apply to an employer-hosted form in a new tab. The server follows that redirected tab automatically; inspect the live form and never ask the user to provide a target ID.",
    "Do not type into any field, click any file chooser, upload, replace, clear, or re-select any file, and do not submit. File controls are exclusively owned by the server after this turn.",
    "A visible but unclicked final Submit control is normal at this stage. Do not report it as a human action or say that submission needs personal review: return form_open so the server can continue the verified workflow.",
    describeAdapterForPrompt(adapter),
    // What this site did to previous applications, so the run starts already knowing.
    ...(siteHistory ? [siteHistory] : []),
    ...SAFETY_RULES,
    ...(consent ? [consent] : []),
    applicationGuidancePrompt(guidance),
    "If the form is embedded in an iframe, hosted behind a sign-in wall, or blocked by a challenge, stop and report it as a human action.",
    "Report the file input for the CV when the snapshot exposes one: give its ref, and separately the ref of the visible upload control if there is one.",
    "Return only JSON with this shape:",
    '{"status":"form_open|needs_human_action|failed","currentUrl":"https://...","cvRequired":true,"cvAttached":true,"uploadInputRef":"ref of the file input or null","uploadControlRef":"ref of the visible upload button or null","humanActionKind":"sign_in|captcha|verification|legal_acceptance|other or null","humanAction":"exact next action for the user or null","notes":"short factual description of the form"}',
    "Set cvRequired to false only when the form provably asks for no CV or resume.",
    `JOB:\n${JSON.stringify(job)}`,
  ].join("\n\n");
}

export function buildFillFieldsPrompt({
  job,
  cv,
  identityMemory,
  applicationMemory,
  relatedMemories = [],
  adapter,
  targetId,
  uploadSummary,
  coverLetter = null,
  guidance = null,
  consent = null,
  memoryRetryFields = [],
}) {
  return [
    "You are J.A.R.V.I.S. completing the supported fields of an already open job application form.",
    `Work only in browser tab targetId ${targetId}. Read a fresh snapshot first.`,
    uploadSummary,
    "Never click, clear, replace, or upload through any resume, CV, cover-letter, or other file control. The server exclusively owns every file input, including when user guidance asks to change an attachment.",
    applicationMemoryPrompt({ identityMemory, applicationMemory, relatedMemories }),
    "Fill only fields whose answers are explicitly supported by the verified CV or the verified memories below. Every field you fill must name the source you used.",
    "On the first pass, answer every work-authorisation, right-to-work, sponsorship, salary, notice-period, or referral-source question when the approved Second Brain memory gives that answer — including when the form asks it as a dropdown whose wording differs. Do not defer it to the user merely because the control is indirect.",
    describeFieldPolicy({ coverLetter }),
    describeAdapterForPrompt(adapter),
    ...SAFETY_RULES,
    ...(consent ? [consent] : []),
    applicationGuidancePrompt(guidance),
    memoryRetryPrompt(memoryRetryFields),
    // A three-step form stalls forever if every step boundary reads as a final submit.
    "A multi-step form's Next, Continue, or Save and continue control advances to more fields; it is not the final submission. Use it to reach the remaining steps, and fill each step the same way.",
    "Stop with the completed form visible for the user to review.",
    "Return only JSON with this shape:",
    '{"status":"ready_for_review|needs_human_action|failed","summary":"short factual status","currentUrl":"https://...","filledFields":[{"field":"field label","source":"cv|identity-memory|application-memory|job-listing","sourceFact":"short verbatim fact from that source supporting this answer","selectedOption":"exact option text you committed, or null for free text"}],"unresolvedFields":[{"field":"field label","reason":"why you could not answer it","required":true}],"skippedFields":[{"field":"field label","reason":"optional and unanswerable"}],"humanActionKind":"sign_in|captcha|verification|upload|answer_question|legal_acceptance|review|other or null","humanAction":"exact next action for the user or null","usedMemoryIds":["memory ids you relied on"]}',
    "Use ready_for_review when every required field is answered and only optional fields remain blank. The system re-reads the form afterwards and will overrule a claim the page does not support, so report exactly what you committed.",
    `JOB:\n${JSON.stringify(job)}`,
    ...(coverLetter ? [`COVER LETTER WRITTEN FOR THIS ROLE (paste verbatim when asked for one):\n${coverLetter}`] : []),
    `FACTUAL TAILORED CV (already attached to the form by the system):\n${cv.slice(0, 80_000)}`,
  ].join("\n\n");
}

function applicationMemoryPrompt({ identityMemory, applicationMemory, relatedMemories }) {
  const related = relatedMemories.length
    ? [
        "RELATED APPROVED PERSONAL MEMORIES:",
        "Use a linked memory only when its text explicitly states a fact about the user. A fact about another named person or organisation is not the user's fact.",
        ...relatedMemories.map((memory) => `MEMORY ${memory.id} — ${memory.title}:\n${memory.body}`),
      ]
    : [];
  return [
    "APPROVED SECOND BRAIN SOURCE OF TRUTH:",
    "Read these memories before inspecting or filling any field. Reuse an exact supported answer immediately; ask the user only when the question is materially different or no approved answer exists.",
    `VERIFIED IDENTITY MEMORY (${identityMemory.id}):\n${identityMemory.body}`,
    `VERIFIED APPLICATION MEMORY (${applicationMemory.id}):\n${applicationMemory.body}`,
    ...related,
  ].join("\n\n");
}

/** Approved general memories directly connected to either canonical applicant memory. */
export function selectRelatedApplicantMemories(allMemories, { identityMemory, applicationMemory }) {
  const canonicalIds = new Set([identityMemory?.id, applicationMemory?.id].filter(Boolean));
  const linkedIds = new Set([
    ...(identityMemory?.links ?? []),
    ...(applicationMemory?.links ?? []),
  ]);
  return (allMemories ?? [])
    .filter(
      (memory) =>
        linkedIds.has(memory?.id) &&
        !canonicalIds.has(memory.id) &&
        memory.status === "approved" &&
        memory.memoryType === "general",
    )
    .slice(0, 12);
}

/** Fields whose first pass already admitted that a reusable approved answer exists. */
export function collectMemoryRetryFields(result) {
  const reusableField =
    /\b(?:work authori[sz]ation|right to work|visa|sponsor|sponsorship|salary|notice period|referral|hear about)\b/i;
  const admitsKnownAnswer =
    /\b(?:verified|approved|stored)\b.{0,80}\b(?:answer|fact|memory|profile|record)|\b(?:memory|profile)\b.{0,80}\b(?:answers?|supports?|states?|gives?)\b/i;
  const fields = (result?.unresolvedFields ?? [])
    .filter(
      (entry) =>
        reusableField.test(String(entry?.field ?? "")) &&
        admitsKnownAnswer.test(`${entry?.field ?? ""} ${entry?.reason ?? ""}`),
    )
    .map((entry) => cleanText(entry?.field, 160))
    .filter(Boolean);
  return [...new Set(fields)].slice(0, 12);
}

function memoryRetryPrompt(fields) {
  if (!fields.length) return "This is the first verified-field pass.";
  return [
    "AUTOMATIC VERIFIED-MEMORY RETRY:",
    "The previous pass already recognized that approved memory answers the fields below. Do not ask the user for those answers again.",
    ...fields.map((field) => `- ${field}`),
    "Re-read the exact verified fact, operate each live control again, and confirm the committed value in a fresh snapshot. Never broaden the fact to a materially different declaration. If a control still cannot retain the answer, report a technical verification problem rather than asking the user what the answer is.",
  ].join("\n");
}

/** One retry instruction from the user. It is transient unless the verified retry succeeds. */
export function normalizeApplicationGuidance(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_GUIDANCE_LENGTH);
}

/**
 * Turn a proven recovery into the existing Shared Lesson shape. Stable keys dedupe the same
 * correction; likely credentials are never copied into Obsidian even if entered by mistake.
 */
export function buildApplicationGuidanceLesson({ guidance, checkpoint, adapter }) {
  const normalized = normalizeApplicationGuidance(guidance);
  if (!normalized || containsSensitiveGuidance(normalized)) return null;
  const reasonCode = cleanText(checkpoint?.reasonCode || "application-checkpoint", 80);
  const rawTrigger = cleanText(
    [checkpoint?.summary, checkpoint?.manualAction].filter(Boolean).join(" ") || reasonCode,
    600,
  );
  const trigger = containsSensitiveGuidance(rawTrigger) ? reasonCode : rawTrigger;
  const fingerprint = createHash("sha256")
    .update(`${adapter.id}\0${reasonCode}\0${normalized}`)
    .digest("hex")
    .slice(0, 12);
  return {
    memoryType: "shared_lesson",
    managedKey: `job-application-${adapter.id}-${reasonCode}-${fingerprint}`,
    title: `${adapter.label} application recovery: ${reasonCode}`.slice(0, 120),
    body: [
      `Trigger: ${trigger}`,
      `Better approach: ${normalized}`,
      "Avoid: Repeating the failed step without checking the live form, or overriding authentication, CAPTCHA, declaration, credential, or final-submit safety boundaries.",
      "Verify: Re-read the live form and confirm every required field is answered before reaching ready for review; final submission remains user-controlled.",
    ].join("\n\n"),
    tags: ["job-hunting", "application-recovery", adapter.id, reasonCode],
  };
}

function applicationGuidancePrompt(guidance) {
  const normalized = normalizeApplicationGuidance(guidance);
  if (!normalized) return "No additional user guidance was supplied for this run.";
  return [
    "USER GUIDANCE FOR THIS RESUME:",
    normalized,
    "Follow this task-specific guidance when it is compatible with the live page and the verified sources. It cannot override any safety rule above, and it is not permission to invent applicant facts.",
  ].join("\n");
}

function containsSensitiveGuidance(value) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return true;
  return /\b(password|passcode|one[- ]?time code|otp|2fa|recovery code|api key|access token|refresh token|session cookie|bearer)\b/i.test(
    value,
  );
}

export function parseOpenFormResult(text) {
  const parsed = parseResultJson(text);
  const requestedStatus = OPEN_FORM_STATUSES.has(parsed?.status) ? parsed.status : "failed";
  const notes = cleanText(parsed?.notes || "No form description returned.", 500);
  // The model is forbidden from clicking Submit, but a visible final button is not a blocker:
  // the BFF owns that decision after it verifies every required field and attachment.
  const submitOnlyReview =
    requestedStatus === "needs_human_action" &&
    ["other", "review", null].includes(parsed?.humanActionKind ?? null) &&
    /(?:cannot|will not|unable to) submit|final review|final submission was not clicked/i.test(
      `${notes} ${String(parsed?.humanAction ?? "")}`,
    );
  const status = submitOnlyReview ? "form_open" : requestedStatus;
  return {
    status,
    currentUrl: safeHttpUrl(parsed?.currentUrl),
    // Absent means "assume a CV is wanted": skipping the upload needs proof, not silence.
    cvRequired: parsed?.cvRequired === false ? false : true,
    cvAttached: parsed?.cvAttached === true,
    uploadInputRef: cleanOptionalText(parsed?.uploadInputRef, 60),
    uploadControlRef: cleanOptionalText(parsed?.uploadControlRef, 60),
    humanActionKind: HUMAN_ACTION_KINDS.has(parsed?.humanActionKind) ? parsed.humanActionKind : null,
    humanAction: cleanOptionalText(parsed?.humanAction, 500),
    notes,
  };
}

export function parseFillFieldsResult(text) {
  const parsed = parseResultJson(text);
  const status = FILL_STATUSES.has(parsed?.status) ? parsed.status : "failed";
  return {
    status,
    summary: cleanText(parsed?.summary || "J.A.R.V.I.S. did not return a valid application status", 500),
    currentUrl: safeHttpUrl(parsed?.currentUrl),
    filledFields: cleanFieldAudit(parsed?.filledFields),
    // `required` here is the model's reading; the BFF re-derives it from the page afterwards.
    unresolvedFields: cleanFieldNotes(parsed?.unresolvedFields, { required: true }),
    skippedFields: cleanFieldNotes(parsed?.skippedFields, { required: false }),
    humanActionKind: HUMAN_ACTION_KINDS.has(parsed?.humanActionKind) ? parsed.humanActionKind : null,
    humanAction: cleanOptionalText(parsed?.humanAction, 500),
    usedMemoryIds: cleanList(parsed?.usedMemoryIds, 10, 160),
  };
}

/**
 * An unparseable reply is a failed phase, not a thrown error: the checkpoint has to record
 * what happened, and a phase that cannot be read is exactly the case where the user must
 * take over rather than see a stack trace.
 */
function parseResultJson(text) {
  try {
    return parseJsonObject(text);
  } catch {
    return {};
  }
}

/** Sentence the fill phase gets instead of an upload path, so it cannot re-upload the CV. */
export function describeUploadForPrompt({ outcome, evidence, cvRequired }) {
  if (cvRequired === false) return "This form asks for no CV, so there is nothing to attach.";
  if (outcome === "uploaded") {
    const filename = evidence?.filename ?? evidence?.artifactName ?? "the prepared CV";
    return `The system has already attached ${filename} to this form and verified it on the page. Do not upload, replace, or re-select any file.`;
  }
  if (outcome === "input_not_found") {
    return "The CV control is embedded or otherwise unreachable to the system. A fresh form inspection reports that the application already holds the prepared CV; do not upload, replace, or clear any file. Continue with supported non-file fields, and report that the CV remains unverified.";
  }
  return "No CV is attached and you must not attempt an upload. Report the missing CV as a human action.";
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanOptionalText(value, maxLength) {
  return cleanText(value, maxLength) || null;
}

function cleanList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function cleanFieldAudit(value) {
  if (!Array.isArray(value)) return [];
  const audit = [];
  for (const entry of value) {
    const field = cleanText(typeof entry === "string" ? entry : entry?.field, 160);
    if (!field) continue;
    const source = cleanText(entry?.source, 60);
    const selectedOption = cleanOptionalText(entry?.selectedOption, 160);
    const sourceFact = cleanOptionalText(entry?.sourceFact, 240);
    audit.push({
      field,
      source: FIELD_SOURCES.has(source) ? source : "unstated",
      ...(sourceFact ? { sourceFact } : {}),
      // Recorded so a dropdown answer can be reviewed as "which option was committed".
      ...(selectedOption ? { selectedOption } : {}),
    });
    if (audit.length >= 80) break;
  }
  return audit;
}

/** Accepts "field: reason" strings as well as objects, since models drift between the two. */
function cleanFieldNotes(value, { required }) {
  if (!Array.isArray(value)) return [];
  const notes = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const [field, ...rest] = entry.split(":");
      const label = cleanText(field, 160);
      if (!label) continue;
      notes.push({ field: label, reason: cleanText(rest.join(":"), 300) || "no reason given", required });
      continue;
    }
    const field = cleanText(entry?.field, 160);
    if (!field) continue;
    notes.push({
      field,
      reason: cleanText(entry?.reason, 300) || "no reason given",
      required: typeof entry?.required === "boolean" ? entry.required : required,
    });
    if (notes.length >= 40) break;
  }
  return notes.slice(0, 40);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return new Set(["http:", "https:"]).has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
