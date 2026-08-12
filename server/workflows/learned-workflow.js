// The workflow recipe: one schema, validated in one place.
//
// A learned workflow is written by a model from a screen recording, so nothing it says about
// itself is trusted on its own. This module is where a model draft becomes a workflow: enums are
// closed, text is bounded, and the two safety decisions that matter are taken away from the
// model entirely —
//   - a step that sends, submits, pays, deletes, or posts is marked requiresUserConfirmation
//     here even if the draft said otherwise (markStepConfirmations),
//   - the blocked-action list always contains the acceptances nobody may delegate, reusing the
//     same NEVER_DELEGABLE list the job-application runner enforces.
// A model can add caution. It cannot remove it.
import { randomUUID } from "node:crypto";
import { NEVER_DELEGABLE } from "../hunting/consent-policy.js";

export const ACTION_TYPES = new Set([
  "navigate",
  "click",
  "type",
  "select",
  "copy",
  "paste",
  "wait",
  "verify",
  "confirm",
  "custom",
]);
export const RISK_LEVELS = new Set(["low", "medium", "high"]);

const MAX_STEPS = 40;
const MAX_VARIABLES = 20;
const MAX_TEXT = 600;
const MAX_INSTRUCTION = 1_000;
const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,39}$/i;
// {{clientName}} — the only interpolation form, so a step body cannot smuggle in a template.
const VARIABLE_REFERENCE = /\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}/gi;

/**
 * Actions whose effect leaves the machine or cannot be undone. Any step matching these needs a
 * human yes at run time, whatever the draft claimed, and their presence raises the risk level.
 */
const IRREVERSIBLE_ACTION = /\b(send|submit|publish|post|pay|purchase|order|transfer|delete|remove|archive|cancel|approve|sign|share|invite|email|dispatch|issue|refund)\b/i;

function text(value, max = MAX_TEXT) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function stringList(value, max = 20, maxLength = 200) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => text(entry, maxLength)).filter(Boolean))].slice(0, max);
}

function safeUrl(value) {
  const raw = text(value, 500);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // A recorded workflow navigates the web. A file:// or javascript: step is not a navigation.
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Every {{variable}} referenced anywhere in the workflow body. */
export function referencedVariables(workflow) {
  const haystack = JSON.stringify({ steps: workflow.steps ?? [], name: workflow.name, description: workflow.description });
  const found = new Set();
  for (const match of haystack.matchAll(VARIABLE_REFERENCE)) found.add(match[1]);
  return [...found];
}

function normalizeVariable(raw) {
  const name = text(raw?.name, 40);
  if (!VARIABLE_NAME.test(name)) return null;
  return {
    name,
    description: text(raw?.description, 300) || `Value for ${name}`,
    required: raw?.required !== false,
    ...(text(raw?.example, 200) ? { example: text(raw?.example, 200) } : {}),
  };
}

function normalizeStep(raw, index) {
  const instruction = text(raw?.instruction, MAX_INSTRUCTION);
  if (!instruction) return null;
  const actionType = ACTION_TYPES.has(raw?.actionType) ? raw.actionType : "custom";
  const target = {
    ...(text(raw?.target?.text) ? { text: text(raw.target.text) } : {}),
    ...(text(raw?.target?.selector, 300) ? { selector: text(raw.target.selector, 300) } : {}),
    ...(text(raw?.target?.visualDescription) ? { visualDescription: text(raw.target.visualDescription) } : {}),
  };
  return {
    id: text(raw?.id, 60) || `step-${index + 1}`,
    instruction,
    ...(text(raw?.app, 120) ? { app: text(raw.app, 120) } : {}),
    ...(safeUrl(raw?.url) ? { url: safeUrl(raw.url) } : {}),
    actionType,
    ...(Object.keys(target).length ? { target } : {}),
    ...(text(raw?.input) ? { input: text(raw.input) } : {}),
    ...(text(raw?.successCheck) ? { successCheck: text(raw.successCheck) } : {}),
    ...(text(raw?.fallback) ? { fallback: text(raw.fallback) } : {}),
    requiresUserConfirmation: raw?.requiresUserConfirmation === true,
  };
}

/**
 * Force a confirmation checkpoint onto every step whose effect leaves the machine.
 *
 * The model is asked to mark risky steps and usually does, but "usually" is not a safety
 * property. This runs over the normalized steps and is the reason the runner can trust the
 * flag it reads.
 */
export function markStepConfirmations(steps) {
  return steps.map((step) => {
    const surface = `${step.instruction} ${step.target?.text ?? ""} ${step.input ?? ""}`;
    const irreversible = step.actionType === "confirm" || IRREVERSIBLE_ACTION.test(surface);
    return { ...step, requiresUserConfirmation: step.requiresUserConfirmation || irreversible };
  });
}

/** Risk follows the steps, not the draft's self-assessment; a draft may only raise it. */
export function deriveRiskLevel(steps, claimed) {
  const confirmations = steps.filter((step) => step.requiresUserConfirmation).length;
  const derived = confirmations >= 2 ? "high" : confirmations === 1 ? "medium" : "low";
  const order = ["low", "medium", "high"];
  const claimedLevel = RISK_LEVELS.has(claimed) ? claimed : "low";
  return order[Math.max(order.indexOf(derived), order.indexOf(claimedLevel))];
}

/**
 * Model draft (or stored row) to a validated LearnedWorkflow.
 *
 * `source` is supplied by the caller from the learning session, never by the model: the window
 * a workflow was learned from is a fact the app owns.
 */
export function normalizeLearnedWorkflow(raw, { id, source } = {}) {
  const name = text(raw?.name, 120);
  if (!name) throw Object.assign(new Error("a workflow needs a name"), { statusCode: 400 });

  const steps = markStepConfirmations(
    (Array.isArray(raw?.steps) ? raw.steps : [])
      .slice(0, MAX_STEPS)
      .map((step, index) => normalizeStep(step, index))
      .filter(Boolean),
  );
  if (!steps.length) throw Object.assign(new Error("a workflow needs at least one step"), { statusCode: 400 });

  const declared = new Map();
  for (const raw_ of Array.isArray(raw?.variables) ? raw.variables.slice(0, MAX_VARIABLES) : []) {
    const variable = normalizeVariable(raw_);
    if (variable) declared.set(variable.name, variable);
  }
  // A step that interpolates {{invoiceMonth}} without declaring it would fail at run time with
  // no way for the user to supply it, so the reference itself declares the variable.
  const workflowShape = { name, description: text(raw?.description, 800), steps };
  for (const referenced of referencedVariables(workflowShape)) {
    if (!declared.has(referenced)) {
      declared.set(referenced, {
        name: referenced,
        description: `Value for ${referenced} (used by a step but not declared in the draft)`,
        required: true,
      });
    }
  }

  const resolvedSource = source ?? raw?.source ?? {};
  const riskLevel = deriveRiskLevel(steps, raw?.safety?.riskLevel);
  return {
    id: text(id ?? raw?.id, 60) || randomUUID(),
    name,
    description: text(raw?.description, 800) || `Workflow learned from a recorded session on ${text(resolvedSource.screenpipeSessionStart, 40) || "an unknown date"}.`,
    source: {
      screenpipeSessionStart: text(resolvedSource.screenpipeSessionStart, 40),
      screenpipeSessionEnd: text(resolvedSource.screenpipeSessionEnd, 40),
      apps: stringList(resolvedSource.apps, 20, 120),
      ...(stringList(resolvedSource.urls, 20, 500).length ? { urls: stringList(resolvedSource.urls, 20, 500) } : {}),
    },
    variables: [...declared.values()],
    steps,
    safety: {
      riskLevel,
      // A workflow that contains any confirmation checkpoint also confirms before it starts:
      // the user should know what they are launching, not discover it three steps in.
      requiresConfirmationBeforeRun:
        raw?.safety?.requiresConfirmationBeforeRun !== false || riskLevel !== "low",
      blockedActions: [...new Set([...NEVER_DELEGABLE, ...stringList(raw?.safety?.blockedActions, 20, 300)])],
    },
  };
}

/**
 * Resolve {{variables}} into runnable steps.
 *
 * Closed result: either every required variable is present and `steps` is runnable, or `missing`
 * names what the user still has to supply. The runner never sees a half-filled step.
 */
export function fillVariables(workflow, values = {}) {
  const supplied = new Map(
    Object.entries(values ?? {})
      .map(([key, value]) => [text(key, 40), text(value, 500)])
      .filter(([key, value]) => key && value),
  );
  const missing = (workflow.variables ?? [])
    .filter((variable) => variable.required && !supplied.has(variable.name))
    .map((variable) => variable.name);
  if (missing.length) return { ok: false, missing };

  const substitute = (value) =>
    typeof value === "string"
      ? value.replace(VARIABLE_REFERENCE, (match, name) => supplied.get(name) ?? match)
      : value;
  const steps = workflow.steps.map((step) => ({
    ...step,
    instruction: substitute(step.instruction),
    ...(step.input ? { input: substitute(step.input) } : {}),
    ...(step.url ? { url: substitute(step.url) } : {}),
    ...(step.target
      ? {
          target: {
            ...(step.target.text ? { text: substitute(step.target.text) } : {}),
            ...(step.target.selector ? { selector: step.target.selector } : {}),
            ...(step.target.visualDescription ? { visualDescription: substitute(step.target.visualDescription) } : {}),
          },
        }
      : {}),
  }));
  return { ok: true, steps, values: Object.fromEntries(supplied) };
}

/** Stable class-level key, so re-learning the same task updates one note instead of adding one. */
export function workflowManagedKey(name) {
  return `workflow-${name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function workflowMemoryTags(workflow) {
  return [
    "workflow",
    "learned-workflow",
    ...workflow.source.apps.map((app) => app.toLowerCase().replace(/\s+/g, "-")).slice(0, 6),
  ].slice(0, 12);
}

/**
 * The human-readable recipe stored in Jarvis's Obsidian memory.
 *
 * Obsidian is the source of truth for what Jarvis knows; SQLite is the source of truth for what
 * Jarvis can execute. This note is the former: a person can read it, correct it in Obsidian, and
 * see at a glance what the assistant will do and where it will stop and ask. The canonical
 * executable JSON stays in the workflow store, and the note carries its id so the two are
 * traceable to each other.
 */
export function renderWorkflowNote(workflow, { runHistory = [] } = {}) {
  const lines = [
    `Reusable workflow learned from a screen recording. Executable spec id: \`${workflow.id}\`.`,
    "",
    `Intent: ${workflow.description}`,
    "",
    `Apps and sites: ${workflow.source.apps.join(", ") || "not identified"}${workflow.source.urls?.length ? ` · ${workflow.source.urls.slice(0, 5).join(", ")}` : ""}`,
    `Learned from the Screenpipe window ${workflow.source.screenpipeSessionStart || "unknown"} → ${workflow.source.screenpipeSessionEnd || "unknown"}.`,
    "",
    "Inputs needed at run time:",
    ...(workflow.variables.length
      ? workflow.variables.map(
          (variable) =>
            `- \`${variable.name}\`${variable.required ? "" : " (optional)"} — ${variable.description}${variable.example ? ` e.g. ${variable.example}` : ""}`,
        )
      : ["- none; the workflow runs the same way every time."]),
    "",
    "Steps:",
    ...workflow.steps.map((step, index) => {
      const where = step.url ? ` [${step.url}]` : step.app ? ` [${step.app}]` : "";
      const anchor = step.target?.text
        ? ` — anchor: "${step.target.text}"`
        : step.target?.visualDescription
          ? ` — look for: ${step.target.visualDescription}`
          : "";
      const gate = step.requiresUserConfirmation ? " **(asks the user first)**" : "";
      return `${index + 1}. ${step.instruction}${where}${anchor}${gate}`;
    }),
    "",
    `Safety: risk ${workflow.safety.riskLevel}. ${workflow.safety.requiresConfirmationBeforeRun ? "Confirms with the user before the first step." : "Starts without a pre-run prompt."} Never, in this or any workflow: ${workflow.safety.blockedActions.slice(0, 6).join("; ")}.`,
  ];
  if (runHistory.length) {
    lines.push(
      "",
      "Execution history:",
      ...runHistory
        .slice(0, 10)
        .map((run) => `- ${run.startedAt}: ${run.status}${run.detail ? ` — ${text(run.detail, 200)}` : ""}`),
    );
  }
  return lines.join("\n").slice(0, 9_000);
}
