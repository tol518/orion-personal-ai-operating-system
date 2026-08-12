// Jarvis Dashboard BFF: bridges the browser UI to the OpenClaw gateway.
// Holds the operator token, keeps one gateway WS connection, and exposes a
// small REST + SSE surface the frontend can consume. Reachable from the phone
// over private network; the gateway token never leaves this process.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import dotenv from "dotenv";
import { GatewayClient } from "./gateway.js";
import {
  addUsageTotals,
  buildUsageAttribution,
  reportDateBounds,
  summarizeHistoryModelUsage,
  summarizeHistoryUsage,
} from "./usage-summary.js";
import { applyPricingToUsageReport, estimateModelUsage } from "./model-pricing.js";
import { loadCodexDesktopUsage } from "./codex-desktop-usage.js";
import { ObsidianMcpClient } from "./obsidian-mcp.js";
import { ExtractionCatalog } from "./extractions.js";
import { ExtractionScheduler } from "./extraction-scheduler.js";
import { ProviderBExtractor } from "./provider-b.js";
import { ExtractionTaskStore, nextRunDay, SUPPORTED_SITES } from "./extraction-tasks.js";
import { MemoryStore } from "./memory-store.js";
import { ProposalStore } from "./proposal-store.js";
import { AttachmentStore } from "./attachment-store.js";
import { buildMemoryAwareMessage, decorateChatEvent } from "./chat-memory.js";
import { contextForAgent, ManagedMemoryService } from "./managed-memory.js";
import { WindowsScreenBridge } from "./windows-screen-bridge.js";
import { extractCvDocument, MAX_CV_TEXT_LENGTH, normalizeCvText } from "./hunting/cv-document.js";
import { CV_EDITOR_SESSION_KEY, CvEditorService } from "./hunting/cv-editor-service.js";
import { createCvPdf } from "./hunting/cv-pdf.js";
import { listMergedPdfLinks, revisePdfHyperlink } from "./hunting/cv-pdf-links.js";
import { CvStore } from "./hunting/cv-store.js";
import { JobDiscoveryService } from "./hunting/job-discovery-service.js";
import {
  buildApplicationGuidanceLesson,
  collectMemoryRetryFields,
  describeUploadForPrompt,
  JobApplicationRunner,
  normalizeApplicationGuidance,
  selectRelatedApplicantMemories,
} from "./hunting/job-application-runner.js";
import { isFinishedApplication, JobHuntStore } from "./hunting/job-hunt-store.js";
import { HuntingAccess } from "./hunting/hunting-access.js";
import {
  BrowserControl,
  openApplicationTab,
  resolveTabTarget,
  selectApplicationStartUrl,
  waitForPageReady,
} from "./hunting/browser-control.js";
import { BrowserTakeover } from "./hunting/browser-takeover.js";
import { CoverLetterService, COVER_LETTER_SESSION_KEY } from "./hunting/cover-letter-service.js";
import { ApplicationUsageMeter } from "./hunting/application-usage.js";
import { assessFormCompletion, readFormState } from "./hunting/form-state.js";
import { checkCvReadability } from "./hunting/cv-ats-check.js";
import { DocumentReviewService, DOCUMENT_REVIEW_SESSION_KEY } from "./hunting/document-review.js";
import { InterviewPrepService, INTERVIEW_PREP_SESSION_KEY } from "./hunting/interview-prep.js";
import { repairAttachments } from "./hunting/attachment-repair.js";
import {
  autoSubmitHosts,
  isAutoSubmitHost,
  parseSubmitInstruction,
  SubmitService,
  submitBlockers,
} from "./hunting/submit-service.js";
import { describeStrategyForPrompt, resolveSiteStrategy } from "./hunting/site-strategy.js";
import {
  describeConsentForPlaybook,
  describeConsentForPrompt,
  parseConsentGrant,
} from "./hunting/consent-policy.js";
import {
  deriveLessons,
  mergePlaybook,
  playbookKey,
  playbookTags,
  playbookTitle,
  siteHost,
} from "./hunting/site-playbook.js";
import {
  ApplicationUploadService,
  canContinueAfterEmbeddedUpload,
} from "./hunting/application-upload-service.js";
import {
  detectHumanCheckpoint,
  detectSubmissionRejection,
  resolveAutomationPolicy,
  resolveSiteAdapter,
} from "./hunting/site-adapters.js";
import {
  APPLICATION_CV_FILENAME,
  DEFAULT_ARTIFACT_DIR,
  describeStagedArtifact,
  stageApplicationArtifact,
} from "./hunting/application-artifact.js";
import { HumanScreenControl } from "./human-screen-control.js";
import { ScreenpipeClient } from "./workflows/screenpipe-client.js";
import { buildObservationDigest } from "./workflows/observation-window.js";
import {
  fillVariables,
  normalizeLearnedWorkflow,
  renderWorkflowNote,
  workflowManagedKey,
  workflowMemoryTags,
} from "./workflows/learned-workflow.js";
import { WorkflowStore } from "./workflows/workflow-store.js";
import { WorkflowLearner } from "./workflows/workflow-learner.js";
import { WorkflowRunner } from "./workflows/workflow-runner.js";
import { ConsolidationService } from "./neural/consolidation-service.js";
import { NeuralConnectionEngine } from "./neural/neural-connection-engine.js";
import { NeuralStore } from "./neural/neural-store.js";
import { OAuthLunaRunner, RelationClassifier } from "./neural/relation-classifier.js";
import {
  buildExecutionPolicy,
  buildSessionExecutionPatch,
  ExecutionTargetStore,
  resolveExecutionDevices,
} from "./execution-target.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4820);
const HOST = process.env.HOST ?? "127.0.0.1";
const APP_SESSION_COOKIE = "jarvis_session";
const ALLOWED_ORIGINS = new Set(
  String(process.env.JARVIS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
for (const hostname of ["127.0.0.1", "localhost"]) {
  ALLOWED_ORIGINS.add(`http://${hostname}:${PORT}`);
  ALLOWED_ORIGINS.add(`http://${hostname}:5173`);
}
// Memory-enriched user turns can exceed OpenClaw's 8k display default before the original
// message appears. Keep this below the gateway's 128 KiB single-message cap so history can
// restore the full envelope and the client can render only the user-authored section.
const CHAT_HISTORY_MAX_CHARS = 120_000;
const GATEWAY_URL = process.env.GATEWAY_URL ?? "ws://127.0.0.1:18789/";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN ?? "";
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT ?? "";
const OBSIDIAN_MCP_COMMAND = process.env.OBSIDIAN_MCP_COMMAND ?? "";
const OBSIDIAN_MCP_ARGS = parseJsonArray(process.env.OBSIDIAN_MCP_ARGS_JSON);
const OBSIDIAN_MEMORY_FOLDER = process.env.OBSIDIAN_MEMORY_FOLDER ?? "Memory";
const OBSIDIAN_SYNC_INTERVAL_MS = Number(process.env.OBSIDIAN_SYNC_INTERVAL_MS ?? 2000);
// Staging dir for prepared CVs. The default is the browser plugin's managed inbound media
// directory, which is the only location a containerised browser can also read (see
// hunting/application-artifact.js). Overriding it only works when the browser shares this
// filesystem and the path stays inside a managed upload root.
const APPLICATION_UPLOAD_DIR = process.env.JARVIS_APPLICATION_UPLOAD_DIR ?? DEFAULT_ARTIFACT_DIR;
const BROWSER_PROFILE = process.env.JARVIS_BROWSER_PROFILE ?? null;
// Cover letters are kept as markdown so the letter behind an interview can be re-read.
const COVER_LETTER_DIR =
  process.env.JARVIS_COVER_LETTER_DIR ?? path.join(__dirname, "data", "cover-letters");
const INTERVIEW_PREP_DIR =
  process.env.JARVIS_INTERVIEW_PREP_DIR ?? path.join(__dirname, "data", "interview-prep");

if (!GATEWAY_TOKEN) {
  console.warn("[jarvis-bff] GATEWAY_TOKEN is empty — set it in server/.env");
}
if (!process.env.JARVIS_ACCESS_PASSWORD) {
  console.warn("[jarvis-bff] JARVIS_ACCESS_PASSWORD is empty — dashboard access will remain locked");
}
if (!process.env.HUNTING_ACCESS_PASSWORD) {
  console.warn("[jarvis-bff] HUNTING_ACCESS_PASSWORD is empty — Hunting will remain locked");
}
if (!process.env.MEMORY_ACCESS_PASSWORD) {
  console.warn("[jarvis-bff] MEMORY_ACCESS_PASSWORD is empty — Second Brain will remain locked");
}

const gateway = new GatewayClient({ url: GATEWAY_URL, token: GATEWAY_TOKEN });
gateway.start();
const windowsScreen = new WindowsScreenBridge({
  url: process.env.WINDOWS_SCREEN_BRIDGE_URL,
  token: process.env.WINDOWS_SCREEN_BRIDGE_TOKEN,
  nodeId: process.env.WINDOWS_SCREEN_BRIDGE_NODE_ID,
  invoke: (request) =>
    gateway.request("node.invoke", {
      ...request,
      idempotencyKey: randomUUID(),
    }),
  powershellScript: fs.readFileSync(path.join(__dirname, "windows-screen-snapshot.ps1"), "utf8"),
});
const humanScreenControl = new HumanScreenControl({ gateway, windowsScreen });

const obsidian = new ObsidianMcpClient({
  command: OBSIDIAN_MCP_COMMAND,
  args: OBSIDIAN_MCP_ARGS,
  vault: OBSIDIAN_VAULT,
});
const databasePath = path.join(__dirname, "data", "jarvis.sqlite");
const attachmentStore = new AttachmentStore(databasePath, path.join(__dirname, "data", "attachments"));
const proposals = new ProposalStore(databasePath);
const neuralStore = new NeuralStore(databasePath);
const extractions = new ExtractionCatalog();
const extractionTasks = new ExtractionTaskStore(databasePath);
// ProviderB requires an authorized headed-browser session, so the BFF runs its
// configured adapter instead of handing that provider to an agent.
const providerB = new ProviderBExtractor({ gateway, workspaceRoot: extractions.root });
const extractionScheduler = new ExtractionScheduler({
  store: extractionTasks,
  gateway,
  providerB,
  workspaceRoot: extractions.root,
});
const executionTargets = new ExecutionTargetStore(databasePath);
const cvs = new CvStore(databasePath);
const cvEditor = new CvEditorService({ gateway });
const jobHunts = new JobHuntStore(databasePath);
// Hunting turns browse real sites through a Codex-routed model, so their ceilings are
// generous and operator-tunable; a turn that hits one is aborted, never abandoned.
const jobDiscovery = new JobDiscoveryService({
  gateway,
  timeoutMs: optionalEnvInt("JARVIS_DISCOVERY_TIMEOUT_MS"),
});
const jobApplications = new JobApplicationRunner({
  gateway,
  openFormTimeoutMs: optionalEnvInt("JARVIS_APPLICATION_OPEN_TIMEOUT_MS"),
  fillTimeoutMs: optionalEnvInt("JARVIS_APPLICATION_FILL_TIMEOUT_MS"),
});
const browserControl = new BrowserControl({ gateway, profile: BROWSER_PROFILE });
const applicationUploads = new ApplicationUploadService({ browser: browserControl });
const browserTakeover = new BrowserTakeover({ browser: browserControl });
// Auto-submit is opt-in per host and off by default; see JARVIS_AUTO_SUBMIT_HOSTS.
const applicationSubmits = new SubmitService({ browser: browserControl });
// A final submit is irreversible. This short-lived lock makes a double-click (or a second
// dashboard client) wait rather than sending the same application twice.
const submittingApplicationIds = new Set();
const coverLetters = new CoverLetterService({ gateway, dir: COVER_LETTER_DIR });
const documentReview = new DocumentReviewService({ gateway });
const interviewPrep = new InterviewPrepService({ gateway, dir: INTERVIEW_PREP_DIR });
const huntingAccess = new HuntingAccess({ password: process.env.HUNTING_ACCESS_PASSWORD });
const memoryAccess = new HuntingAccess({ password: process.env.MEMORY_ACCESS_PASSWORD });
const appAccess = new HuntingAccess({ password: process.env.JARVIS_ACCESS_PASSWORD });
// Workflow learning: Screenpipe is the observation layer, this store is the executable spec and
// run log, and the Obsidian memory below holds the readable recipe.
const screenpipe = new ScreenpipeClient();
const workflowStore = new WorkflowStore(databasePath);
const workflowLearner = new WorkflowLearner({ gateway });
const workflowRunner = new WorkflowRunner({ browser: browserControl, gateway, store: workflowStore });
// Apps whose windows are never observed, on top of the password-manager list the digest always
// excludes. Comma-separated, e.g. JARVIS_WORKFLOW_EXCLUDE_APPS="Messages,Signal".
const WORKFLOW_EXCLUDE_APPS = String(process.env.JARVIS_WORKFLOW_EXCLUDE_APPS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const lunaRunner = new OAuthLunaRunner({ gateway });
let neuralEngine;
const memories = new MemoryStore({
  mcp: obsidian,
  folder: OBSIDIAN_MEMORY_FOLDER,
  intervalMs: OBSIDIAN_SYNC_INTERVAL_MS,
  onChange: (event) => {
    broadcast("memory.changed", event);
    neuralEngine?.runNow().catch(() => undefined);
  },
});
const managedMemories = new ManagedMemoryService(memories);
neuralEngine = new NeuralConnectionEngine({
  memories,
  neuralStore,
  proposalStore: proposals,
  classifier: new RelationClassifier({ runner: lunaRunner }),
  consolidation: new ConsolidationService({ runner: lunaRunner }),
  onChange: ({ status, proposalsChanged }) => {
    broadcast("memory.neural.status", status);
    if (proposalsChanged) {
      broadcast("memory.proposals.changed", { pending: proposals.list("pending").length });
      broadcast("memory.changed", { version: memories.version, count: memories.list().length });
    }
  },
});
memories.start().then(async () => {
  await Promise.all([
    managedMemories.ensure({
      memoryType: "agent_instruction",
      managedKey: "main",
      title: "J.A.R.V.I.S. Agent Instructions",
      tags: ["agent", "orchestrator", "leadership"],
      body: "Role: Main orchestrator and leader.\n\nResponsibilities: Coordinate all agents, decompose work, assign tasks, preserve project context, and ensure delegated work is integrated and verified.\n\nBehaviour: Lead clearly, choose the best specialist for each task, and include relevant Project and Agent Instruction context whenever spawning an agent.",
    }),
    managedMemories.ensure({
      memoryType: "agent_instruction",
      managedKey: "codex",
      title: "Codex Agent Instructions",
      tags: ["agent", "code", "engineering"],
      body: "Role: Code specialist.\n\nResponsibilities: Implement, debug, review, and validate software changes delegated by J.A.R.V.I.S.\n\nBehaviour: Follow project conventions, preserve user work, test proportionately, and report concrete evidence.",
    }),
    managedMemories.ensure({
      memoryType: "agent_instruction",
      managedKey: "black-noir",
      title: "Black Noir Agent Instructions",
      tags: ["agent", "field-specialist", "job-discovery", "focused-execution"],
      body: "Role: Quiet field specialist and Hunting job-discovery specialist inspired by Black Noir.\n\nResponsibilities: Own delegated job searches, discover current source-diverse opportunities, perform focused reconnaissance, and report concise evidence-backed results to J.A.R.V.I.S. Do not take over CV editing, application-form completion, authentication, or submission unless J.A.R.V.I.S. explicitly delegates them.\n\nBehaviour: Remain disciplined, discreet, and task-focused while following J.A.R.V.I.S. as the main orchestrator.",
    }),
    managedMemories.ensure({
      memoryType: "project",
      managedKey: "jarvis-control-app",
      title: "J.A.R.V.I.S. Control App",
      tags: ["project", "jarvis", "openclaw"],
      body: "Goal: Build the J.A.R.V.I.S. control app and its second-brain memory system.\n\nParticipating agents: J.A.R.V.I.S. leads orchestration; Codex handles software engineering; Black Noir handles focused delegated work and reconnaissance.\n\nCurrent context: Agent-created memories and relationships are saved automatically when they are durable and relevant. Do not save every conversation.",
    }),
  ]);
  await managedMemories.syncProjectLinks();
  await neuralEngine.start();
}).catch((error) => {
  console.warn(`[jarvis-bff] Obsidian/neural memory unavailable: ${error.message}`);
});

// ---- Server-Sent Events fan-out -------------------------------------------
const sseClients = new Set();
const sessionAttachmentGrants = new Map();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Forward selected gateway events straight to the browser.
// Turns that write or check the user's documents. They are part of an application, not chat, so they
// must not surface in the console as if the agent were talking to him.
const INTERNAL_DOCUMENT_SESSIONS = new Set([
  COVER_LETTER_SESSION_KEY,
  DOCUMENT_REVIEW_SESSION_KEY,
  INTERVIEW_PREP_SESSION_KEY,
]);
const FORWARDED_EVENTS = new Set([
  "chat",
  "agent",
  "session.tool",
  "session.message",
  "sessions.changed",
  "node.presence.alive",
  "node.pair.requested",
  "node.pair.resolved",
  "gateway.disconnected",
]);
gateway.on("event", async (event, payload) => {
  if (
    event === "chat" &&
    (lunaRunner.ownsSession(payload?.sessionKey) ||
      cvEditor.ownsSession(payload?.sessionKey) ||
      jobDiscovery.ownsSession(payload?.sessionKey) ||
      jobApplications.ownsSession(payload?.sessionKey) ||
      workflowLearner.ownsSession(payload?.sessionKey) ||
      workflowRunner.ownsSession(payload?.sessionKey) ||
      INTERNAL_DOCUMENT_SESSIONS.has(payload?.sessionKey))
  ) return;
  if (!FORWARDED_EVENTS.has(event)) return;
  if (event === "chat" && payload?.state === "final") {
    try {
      const decorated = decorateChatEvent(payload, memories);
      const usedIds = (decorated.memoryCitations ?? []).map(({ id }) => id);
      if (usedIds.length > 1) neuralEngine.recordActivation(usedIds).catch(() => undefined);
      const actorAgentId = /^agent:([^:]+):/.exec(payload?.sessionKey ?? "")?.[1] ?? "main";
      let learnedLessons = [];
      let savedMemories = [];
      if (decorated.managedMemoryUpserts?.length) {
        try {
          const managedUpdates = await managedMemories.apply(decorated.managedMemoryUpserts, actorAgentId);
          learnedLessons = managedUpdates
            .filter((memory) => memory.memoryType === "shared_lesson")
            .map(({ id, title }) => ({ id, title }));
          broadcast("memory.changed", { version: memories.version, count: memories.list().length });
          neuralEngine.runNow().catch(() => undefined);
        } catch (error) {
          console.warn(`[jarvis-bff] managed memory update skipped: ${error.message}`);
        }
      }
      if (decorated.memoryActions?.length) {
        let memoryChanged = false;
        for (const action of decorated.memoryActions) {
          try {
            if (action.kind === "memory") {
              const allowedAttachments = sessionAttachmentGrants.get(payload?.sessionKey) ?? new Set();
              action.payload.attachmentIds = (action.payload.attachmentIds ?? []).filter((id) => allowedAttachments.has(id));
              const memory = await memories.create(action.payload, "agent");
              attachmentStore.setForMemory(memory.id, action.payload.attachmentIds);
              savedMemories.push({ id: memory.id, title: memory.title });
            } else {
              await memories.addRelationship(action.payload.fromId, action.payload.toId, {
                ...action.payload,
                creationSource: "agent",
              });
            }
            memoryChanged = true;
          } catch (error) {
            console.warn(`[jarvis-bff] automatic memory action skipped: ${error.message}`);
          }
        }
        if (memoryChanged) {
          broadcast("memory.changed", { version: memories.version, count: memories.list().length });
          neuralEngine.runNow().catch(() => undefined);
        }
      }
      const { managedMemoryUpserts: _managedMemoryUpserts, memoryActions: _memoryActions, ...publicPayload } = decorated;
      sessionAttachmentGrants.delete(payload?.sessionKey);
      broadcast(event, { ...publicPayload, learnedLessons, savedMemories });
      return;
    } catch (error) {
      console.warn(`[jarvis-bff] memory response metadata skipped: ${error.message}`);
    }
  }
  broadcast(event, payload);
});
gateway.on("status", (status) => broadcast("gateway.status", status));

// ---- REST -----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "30mb" }));

const ok = (res, payload) => res.json({ ok: true, ...payload });
const fail = (res, err, code = 502) =>
  res.status(err?.statusCode ?? code).json({ ok: false, error: String(err?.message ?? err) });

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/auth/status", (req, res) => {
  ok(res, { authenticated: appAccess.verify(appAccessToken(req)) });
});

app.post("/api/auth/login", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Sign-in requires the JARVIS page", 403);
  try {
    const session = appAccess.unlock(req.body?.password, req.ip);
    res.cookie(APP_SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: Math.max(0, session.expiresAt - Date.now()),
      path: "/",
    });
    ok(res, { authenticated: true });
  } catch (err) {
    if (err?.retryAfter) res.set("Retry-After", String(err.retryAfter));
    fail(res, err, 401);
  }
});

app.post("/api/auth/logout", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Sign-out requires the JARVIS page", 403);
  appAccess.revoke(appAccessToken(req));
  res.clearCookie(APP_SESSION_COOKIE, { path: "/" });
  ok(res, { authenticated: false });
});

app.use("/api", (req, res, next) => {
  if (!appAccess.verify(appAccessToken(req))) return fail(res, "Authentication required", 401);
  next();
});

app.get("/api/status", (_req, res) => ok(res, { status: gateway.status() }));

app.post("/api/attachments", (req, res) => {
  try {
    ok(res, { attachments: attachmentStore.saveMany(req.body?.attachments) });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/attachments/:id", (req, res) => {
  try {
    const file = attachmentStore.file(req.params.id);
    if (!file) return fail(res, Object.assign(new Error("attachment not found"), { statusCode: 404 }));
    res.type("application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename=${JSON.stringify(file.attachment.fileName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(file.path);
  } catch (err) {
    fail(res, err, 404);
  }
});

app.get("/api/nodes", async (_req, res) => {
  try {
    const nodes = await gateway.request("node.list", {});
    const decorated = await windowsScreen.decorateNodeList(nodes);
    ok(res, humanScreenControl.decorateNodeList(decorated));
  } catch (err) {
    fail(res, err);
  }
});

app.delete("/api/nodes/:nodeId", async (req, res) => {
  try {
    ok(res, await gateway.request("node.pair.remove", { nodeId: req.params.nodeId }));
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/usage", async (req, res) => {
  const range = typeof req.query.range === "string" ? req.query.range : "7d";
  try {
    const rawReport = await gateway.request("sessions.usage", { range });
    const { report, pricing } = applyPricingToUsageReport(rawReport);
    const bounds = reportDateBounds(report);
    const supplementalSessions = [];
    let codexDesktop = {
      totals: {},
      sessions: [],
      weeklyLimit: null,
      pricedModels: [],
      unpricedModels: [],
    };
    if (bounds) {
      try {
        codexDesktop = await loadCodexDesktopUsage(bounds);
      } catch (error) {
        console.warn(`[jarvis-bff] Codex desktop usage unavailable: ${error.message}`);
      }
      const listed = await gateway.request("sessions.list", {
        agentId: "codex",
        limit: 1000,
      });
      const gatewayKeys = new Set((report.sessions ?? []).map((session) => session.key));
      const candidates = (listed.sessions ?? []).filter(
        (session) =>
          typeof session.key === "string" &&
          !gatewayKeys.has(session.key) &&
          Number(session.updatedAt ?? 0) >= bounds.startMs,
      );
      const histories = await Promise.allSettled(
        candidates.map(async (session) => ({
          session,
          history: await gateway.request("chat.history", {
            sessionKey: session.key,
            agentId: "codex",
            limit: 1000,
          }),
        })),
      );
      for (const result of histories) {
        if (result.status !== "fulfilled") continue;
        const { session, history } = result.value;
        const modelUsage = summarizeHistoryModelUsage(
          history.messages,
          bounds.startMs,
          bounds.endMs,
          { provider: "openai", model: session.model },
        );
        const estimate = estimateModelUsage(modelUsage);
        for (const model of estimate.pricedModels) {
          if (!pricing.pricedModels.includes(model)) pricing.pricedModels.push(model);
        }
        for (const model of estimate.unpricedModels) {
          if (!pricing.unpricedModels.includes(model)) pricing.unpricedModels.push(model);
        }
        supplementalSessions.push({
          key: session.key,
          agentId: "codex",
          totals: {
            ...summarizeHistoryUsage(history.messages, bounds.startMs, bounds.endMs),
            ...estimate.totals,
          },
        });
      }
    }
    for (const model of codexDesktop.pricedModels) {
      if (!pricing.pricedModels.includes(model)) pricing.pricedModels.push(model);
    }
    for (const model of codexDesktop.unpricedModels) {
      if (!pricing.unpricedModels.includes(model)) pricing.unpricedModels.push(model);
    }
    pricing.pricedModels.sort();
    pricing.unpricedModels.sort();
    const gatewayAttribution = buildUsageAttribution(report, supplementalSessions);
    const codexGateway = gatewayAttribution.agents.codex;
    const codex = addUsageTotals(codexGateway, codexDesktop.totals);
    ok(res, {
      ...report,
      attribution: {
        ...gatewayAttribution,
        agents: { ...gatewayAttribution.agents, codex },
        combined: addUsageTotals(gatewayAttribution.agents.main, codex),
        sources: { codexGateway, codexDesktop: codexDesktop.totals },
        codexWeeklyLimit: codexDesktop.weeklyLimit,
        sessions: [
          ...gatewayAttribution.sessions,
          ...codexDesktop.sessions.map((session) => ({
            key: session.key,
            agentId: "codex",
            totals: session.totals,
            source: "codex-desktop",
          })),
        ],
        pricing,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/sessions", async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  try {
    ok(
      res,
      await gateway.request("sessions.list", {
        limit,
        includeDerivedTitles: true,
        includeLastMessage: true,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/sessions", async (req, res) => {
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "main";
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  if (!agentId) return fail(res, "agentId required", 400);
  try {
    ok(
      res,
      await gateway.request("sessions.create", {
        agentId,
        ...(label ? { label } : {}),
      }),
    );
  } catch (err) {
    fail(res, err, 400);
  }
});

app.post("/api/sessions/:key/reset", async (req, res) => {
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
  try {
    ok(
      res,
      await gateway.request("sessions.reset", {
        key: req.params.key,
        ...(agentId ? { agentId } : {}),
        reason: "new",
      }),
    );
  } catch (err) {
    fail(res, err, 400);
  }
});

app.delete("/api/sessions/:key", async (req, res) => {
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
  try {
    const result = await gateway.request("sessions.delete", {
      key: req.params.key,
      ...(agentId ? { agentId } : {}),
      deleteTranscript: true,
    });
    executionTargets.delete(req.params.key);
    ok(res, result);
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/sessions/:key/execution-target", async (req, res) => {
  try {
    const devices = await getExecutionDevices();
    ok(res, { target: executionTargets.get(req.params.key), devices });
  } catch (err) {
    fail(res, err);
  }
});

app.put("/api/sessions/:key/execution-target", async (req, res) => {
  const target = typeof req.body?.target === "string" ? req.body.target.trim() : "";
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
  try {
    const devices = await getExecutionDevices();
    await patchSessionExecutionTarget(req.params.key, agentId, target, devices);
    executionTargets.set(req.params.key, target);
    ok(res, { target, devices });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/agents", async (_req, res) => {
  try {
    ok(res, await gateway.request("agents.list", {}));
  } catch (err) {
    fail(res, err);
  }
});

function modelOptionsFromConfig(configPayload, agentId) {
  const config = configPayload?.config;
  const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const agent = agentList.find((entry) => entry?.id === agentId);
  const model = typeof agent?.model === "string" ? agent.model : agent?.model?.primary;
  const defaults = config?.agents?.defaults?.models;
  const defaultModels = defaults && typeof defaults === "object" ? defaults : {};
  const agentModels = agent?.models && typeof agent.models === "object" ? agent.models : {};
  const configured = { ...defaultModels, ...agentModels };
  const haiku = "anthropic/claude-haiku-4-5";
  const ids = [...new Set([model, ...Object.keys(configured), haiku].filter(Boolean))];
  return {
    agentId,
    current: model ?? null,
    models: ids.map((id) => ({
      id,
      label: id === haiku ? "Claude Haiku 4.5" : configured[id]?.alias || id,
    })),
  };
}

function isModelAllowed(configPayload, agentId, model) {
  return modelOptionsFromConfig(configPayload, agentId).models.some((entry) => entry.id === model);
}

app.get("/api/agents/:agentId/models", async (req, res) => {
  try {
    ok(res, modelOptionsFromConfig(await gateway.request("config.get", {}), req.params.agentId));
  } catch (err) {
    fail(res, err);
  }
});

app.put("/api/agents/:agentId/default-model", async (req, res) => {
  const agentId = req.params.agentId.trim();
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  if (!agentId || !model) return fail(res, "agentId and model required", 400);

  try {
    const config = await gateway.request("config.get", {});
    if (!isModelAllowed(config, agentId, model)) {
      return fail(res, "model is not enabled for this agent", 400);
    }
    const agents = Array.isArray(config?.config?.agents?.list) ? config.config.agents.list : [];
    if (!agents.some((agent) => agent?.id === agentId)) {
      return fail(res, "agent not found", 404);
    }
    if (!config?.hash) return fail(res, "config hash missing; reload and retry", 409);

    await gateway.request("config.patch", {
      baseHash: config.hash,
      raw: JSON.stringify({ agents: { list: [{ id: agentId, model }] } }),
      note: `Default model for ${agentId} updated from the J.A.R.V.I.S. dashboard.`,
    });
    ok(res, { ...modelOptionsFromConfig(config, agentId), current: model });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.put("/api/sessions/:key/model", async (req, res) => {
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  if (!agentId || !model) return fail(res, "agentId and model required", 400);
  try {
    const config = await gateway.request("config.get", {});
    if (!isModelAllowed(config, agentId, model)) {
      return fail(res, "model is not enabled for this agent", 400);
    }
    ok(
      res,
      await gateway.request("sessions.patch", {
        key: req.params.key,
        agentId,
        model,
      }),
    );
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/history", async (req, res) => {
  const sessionKey = req.query.sessionKey;
  if (typeof sessionKey !== "string") return fail(res, "sessionKey required", 400);
  try {
    ok(
      res,
      await gateway.request("chat.history", {
        sessionKey,
        limit: 50,
        maxChars: CHAT_HISTORY_MAX_CHARS,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/memory/access", (req, res) => {
  ok(res, { unlocked: memoryAccess.verify(memoryAccessToken(req)) });
});

app.post("/api/memory/access", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Memory unlock requires the JARVIS page", 403);
  try {
    const session = memoryAccess.unlock(req.body?.password, req.ip);
    ok(res, { unlocked: true, accessToken: session.token });
  } catch (err) {
    if (err?.retryAfter) res.set("Retry-After", String(err.retryAfter));
    fail(res, err, 401);
  }
});

app.delete("/api/memory/access", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Memory lock requires the JARVIS page", 403);
  memoryAccess.revoke(memoryAccessToken(req));
  ok(res, { unlocked: false });
});

function requireMemoryAccess(req, res, next) {
  if (!memoryAccess.verify(memoryAccessToken(req))) return fail(res, "Second Brain is locked", 401);
  next();
}

app.use("/api/memory", (req, res, next) => {
  if (req.path === "/access") return next();
  return requireMemoryAccess(req, res, next);
});
app.use("/api/memories", requireMemoryAccess);
app.get("/api/memory/status", (_req, res) => ok(res, { status: memories.status() }));

app.get("/api/hunting/access", (req, res) => {
  ok(res, { unlocked: huntingAccess.verify(huntingAccessToken(req)) });
});

app.post("/api/hunting/access", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Hunting unlock requires the JARVIS page", 403);
  try {
    const session = huntingAccess.unlock(req.body?.password, req.ip);
    ok(res, { unlocked: true, accessToken: session.token });
  } catch (err) {
    if (err?.retryAfter) res.set("Retry-After", String(err.retryAfter));
    fail(res, err, 401);
  }
});

app.delete("/api/hunting/access", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Hunting lock requires the JARVIS page", 403);
  huntingAccess.revoke(huntingAccessToken(req));
  ok(res, { unlocked: false });
});

app.use("/api/hunting", (req, res, next) => {
  const token = huntingAccessToken(req);
  if (!huntingAccess.verify(token)) {
    return fail(res, "Hunting is locked", 401);
  }
  next();
});

app.get("/api/hunting/cv", (_req, res) => ok(res, { cv: cvs.get() }));

app.post("/api/hunting/cv/upload", async (req, res) => {
  try {
    const extracted = await extractCvDocument(req.body ?? {});
    const { originalPdf, ...document } = extracted;
    const sourcePdfToken = originalPdf
      ? cvs.stageOriginalPdf({
          pdf: originalPdf,
          content: document.content,
          sourceName: document.sourceName,
        })
      : null;
    ok(res, { document: { ...document, sourcePdfToken } });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.post("/api/hunting/cv/pdf-preview", async (req, res) => {
  const content = normalizeCvText(req.body?.content);
  if (content.length < 40) return fail(res, "CV must contain at least 40 characters", 400);
  if (content.length > MAX_CV_TEXT_LENGTH) return fail(res, "CV is too long", 413);
  try {
    const sourceName = cleanOptionalText(req.body?.sourceName, 180);
    const original = cvs.sourcePdfFor({
      content,
      draftToken: cleanOptionalText(req.body?.sourcePdfToken, 100),
    });
    const basePdf = original ?? cvs.sourcePdf();
    const links = await listMergedPdfLinks([
      basePdf?.data,
      ...cvs.linkSourcePdfs(),
    ]);
    const pdf = original?.data ?? await createCvPdf({ content, sourceName, links });
    const previewSource = original?.kind ?? "template";
    res
      .status(200)
      .set({
        "Cache-Control": "no-store, private",
        "Content-Disposition": 'inline; filename="canonical-cv-preview.pdf"',
        "Content-Length": String(pdf.byteLength),
        "Content-Type": "application/pdf",
        "X-Jarvis-CV-Preview-Source": previewSource,
      })
      .send(pdf);
  } catch (err) {
    fail(res, err, 500);
  }
});

app.put("/api/hunting/cv", (req, res) => {
  const content = normalizeCvText(req.body?.content);
  const expectedVersion = Number(req.body?.expectedVersion ?? 0);
  if (content.length < 40) return fail(res, "CV must contain at least 40 characters", 400);
  if (content.length > MAX_CV_TEXT_LENGTH) return fail(res, "CV is too long", 413);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return fail(res, "expectedVersion must be a non-negative integer", 400);
  }
  try {
    ok(res, {
      cv: cvs.save({
        content,
        expectedVersion,
        sourceName: cleanOptionalText(req.body?.sourceName, 180),
        sourceFormat: cleanOptionalText(req.body?.sourceFormat, 20),
        sourcePdfToken: cleanOptionalText(req.body?.sourcePdfToken, 100),
      }),
    });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.post("/api/hunting/cv/undo", (req, res) => {
  const expectedVersion = Number(req.body?.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return fail(res, "expectedVersion must be a positive integer", 400);
  }
  try {
    ok(res, { cv: cvs.undo({ expectedVersion }) });
  } catch (err) {
    fail(res, err, err?.statusCode ?? 400);
  }
});

app.post("/api/hunting/cv/revise", async (req, res) => {
  const content = normalizeCvText(req.body?.content);
  const instruction = String(req.body?.instruction ?? "").trim();
  if (content.length < 40 || !instruction) {
    return fail(res, "CV content and an edit instruction are required", 400);
  }
  if (content.length > MAX_CV_TEXT_LENGTH || instruction.length > 4_000) {
    return fail(res, "CV or edit instruction is too long", 413);
  }
  try {
    const sourceName = cleanOptionalText(req.body?.sourceName, 180);
    const sourcePdfToken = cleanOptionalText(req.body?.sourcePdfToken, 100);
    const original = cvs.sourcePdfFor({ content, draftToken: sourcePdfToken });
    if (original) {
      // Hyperlinks are PDF annotations. Update them before the text-only LLM path,
      // otherwise a metadata-only edit would unnecessarily discard the source layout.
      const linkRevision = await revisePdfHyperlink({ pdf: original.data, instruction });
      if (linkRevision) {
        const nextSourcePdfToken = cvs.stageOriginalPdf({
          pdf: linkRevision.pdf,
          content,
          sourceName: original.sourceName ?? sourceName ?? "CV.pdf",
          kind: original.kind,
        });
        return ok(res, {
          revision: {
            content,
            summary: `Updated the ${linkRevision.label} hyperlink while preserving the original PDF styling.`,
            warnings: [],
            sourcePdfToken: nextSourcePdfToken,
            preservedPdfStyling: true,
          },
        });
      }
    }
    const revision = await cvEditor.revise(content, instruction);
    const basePdf = original ?? cvs.sourcePdf();
    const links = await listMergedPdfLinks([
      basePdf?.data,
      ...cvs.linkSourcePdfs(),
    ]);
    const pdf = await createCvPdf({ content: revision.content, sourceName, links });
    const nextSourcePdfToken = cvs.stageOriginalPdf({
      pdf,
      content: revision.content,
      sourceName: sourceName ?? basePdf?.sourceName ?? "CV.pdf",
      kind: "template",
    });
    ok(res, {
      revision: {
        ...revision,
        sourcePdfToken: nextSourcePdfToken,
        preservedPdfStyling: true,
      },
    });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.post("/api/hunting/cv/memory-proposal", async (_req, res) => {
  const cv = cvs.get();
  if (!cv) return fail(res, "Save the canonical CV first", 400);
  try {
    const draft = await cvEditor.createMemoryDraft(cv.content);
    const fingerprint = `cv-profile:${createHash("sha256").update(cv.content).digest("hex")}`;
    const result = proposals.createUnique("memory", {
      ...draft,
      memoryType: "general",
      fingerprint,
    }, cvEditor.sessionKey);
    broadcast("memory.proposals.changed", { pending: proposals.list("pending").length });
    ok(res, { proposal: result.proposal, created: result.created });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.get("/api/hunting/search-profile", (_req, res) => {
  ok(res, { profile: jobHunts.getProfile() });
});

app.put("/api/hunting/search-profile", (req, res) => {
  const expectedVersion = Number(req.body?.expectedVersion ?? 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return fail(res, "expectedVersion must be a non-negative integer", 400);
  }
  try {
    ok(res, { profile: jobHunts.saveProfile(req.body, expectedVersion) });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/hunting/jobs", (req, res) => {
  const includeDismissed = req.query.includeDismissed !== "false";
  const requested = String(req.query.scope ?? "");
  const scope = ["run", "current", "all"].includes(requested) ? requested : "current";
  ok(res, {
    jobs: jobHunts.listJobs({ scope, includeDismissed }),
    scope,
    run: jobHunts.latestDiscoveryRun(),
  });
});

app.post("/api/hunting/discover", async (_req, res) => {
  const profile = jobHunts.getProfile();
  if (!profile) return fail(res, "Save a job-search brief first", 400);
  const run = jobHunts.startDiscoveryRun();
  try {
    const result = await jobDiscovery.discover({
      profile,
      cv: cvs.get(),
      exclusions: jobHunts.buildDiscoveryExclusions(),
    });
    const observed = jobHunts.upsertJobs(result.jobs, { runId: run.id });
    // First sighting and latest sighting coincide only for rows this run created.
    const newCount = observed.filter((job) => job.firstSeenAt === job.lastSeenAt).length;
    const finished = jobHunts.finishDiscoveryRun(run.id, {
      status: "complete",
      summary: result.summary,
      sourceStatus: result.sourceStatus,
      observedCount: observed.length,
      newCount,
    });
    ok(res, {
      run: finished,
      jobs: jobHunts.listJobs({ scope: "run", runId: run.id }),
      summary: finished.summary,
      sourceStatus: finished.sourceStatus,
      droppedForDiversity: result.droppedForDiversity,
    });
  } catch (err) {
    jobHunts.finishDiscoveryRun(run.id, { status: "failed", error: String(err?.message ?? err) });
    fail(res, err, 500);
  }
});

app.put("/api/hunting/jobs/:id/status", (req, res) => {
  try {
    ok(res, { job: jobHunts.setJobStatus(req.params.id, String(req.body?.status ?? "")) });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/hunting/applications", (_req, res) => {
  ok(res, { applications: jobHunts.listApplications() });
});

app.post("/api/hunting/jobs/:id/apply", async (req, res) => {
  const job = jobHunts.getJob(req.params.id);
  if (!job) return fail(res, "job not found", 404);
  const cv = cvs.get();
  if (!cv) return fail(res, "Save a canonical CV before starting an application", 400);
  const identityMemory = memories.get("memory-example-user");
  const applicationMemory = memories.get("memory-example-job-application-profile");
  if (!identityMemory || !applicationMemory) {
    return fail(res, "The verified the user identity and job-application memories are required", 400);
  }
  const relatedPersonalMemories = selectRelatedApplicantMemories(memories.list(), {
    identityMemory,
    applicationMemory,
  });
  const resume = req.body?.resume === true;
  const guidance = normalizeApplicationGuidance(req.body?.guidance);
  const submitApproval = parseSubmitInstruction(guidance);
  const guidanceAttachmentIds = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds : [];
  const guidanceAttachments = attachmentStore.gatewayPayloads(guidanceAttachmentIds);
  const current = jobHunts.getApplication(job.id);
  if (resume && !current) return fail(res, "Start this application before resuming it", 400);
  if (guidance && !resume) return fail(res, "Guidance can only be sent when resuming an application", 400);
  if (current?.status === "submitted") return fail(res, "This application is already marked as submitted", 409);
  if (submitApproval && jobHunts.hasFinalSubmitAttempt(job.id)) {
    return fail(
      res,
      "J.A.R.V.I.S. already attempted this application's final submit and will not click it again.",
      409,
    );
  }

  let release;
  try {
    release = jobApplications.claim(job.id);
  } catch (err) {
    // Only one application runs at a time. Name the job holding the slot so the UI can offer
    // to cancel it instead of showing a refusal the user cannot act on.
    const activeJob = err?.activeJobId ? jobHunts.getJob(err.activeJobId) : null;
    return res.status(409).json({
      ok: false,
      error: String(err?.message ?? err),
      code: err?.code ?? "application_already_running",
      activeJob: activeJob
        ? {
            jobId: activeJob.id,
            company: activeJob.company,
            title: activeJob.title,
            status: jobHunts.getApplication(activeJob.id)?.status ?? null,
            isSameJob: activeJob.id === job.id,
          }
        : null,
    });
  }
  // An acceptance instruction typed on resume is a permission, not a hint: record it against
  // this host before the run starts so the run is already cleared and does not stop to re-ask.
  const consentGrant = parseConsentGrant({
    guidance,
    guidanceAttachments,
    checkpoint: current ? { manualAction: current.manualAction, summary: current.summary } : null,
  });
  if (consentGrant) {
    // Resume checkpoints belong to the live application, which may be on a different host
    // after LinkedIn, Indeed, or another board redirects to the employer's ATS.
    const consentHost = siteHost(current?.currentUrl ?? job.url);
    jobHunts.grantSiteConsent({ host: consentHost, gate: consentGrant.gate, phrase: consentGrant.phrase });
  }

  const context = {
    job,
    cv,
    current,
    resume,
    guidance,
    submitApproval,
    consentGrant,
    guidanceCheckpoint: guidance && current
      ? {
          reasonCode: current.reasonCode,
          summary: current.summary,
          manualAction: current.manualAction,
        }
      : null,
    adapter: resolveSiteAdapter(job.url),
    identityMemory,
    applicationMemory,
    relatedPersonalMemories,
    sessionKey: jobApplications.sessionKey(job.id),
    assertActive: () => jobApplications.assertActive(job.id),
  };
  try {
    const application = await runControlledApplication(context);
    const meteredApplication = await recordApplicationUsage(context, application);
    await rememberSuccessfulApplicationGuidance(context, meteredApplication);
    ok(res, { application: meteredApplication });
  } catch (err) {
    if (err?.code === "application_cancelled" || jobApplications.isCancelled(job.id)) {
      return ok(res, { application: jobHunts.getApplication(job.id), cancelled: true });
    }
    const failed = saveApplicationPhase(context, {
      status: "failed",
      reasonCode: "unexpected_error",
      summary: String(err?.message ?? err).slice(0, 500),
      currentUrl: current?.currentUrl ?? job.url,
      manualAction: "Review the error, then retry the application.",
      manualActionKind: "review",
    });
    // A run that fell over still spent tokens; record them rather than lose the bill.
    await recordApplicationUsage(context, failed);
    fail(res, err, 500);
  } finally {
    release();
  }
});

app.post("/api/hunting/jobs/:id/cancel", async (req, res) => {
  const job = jobHunts.getJob(req.params.id);
  if (!job) return fail(res, "job not found", 404);
  const current = jobHunts.getApplication(job.id);
  if (!current) {
    return fail(res, "This application has not been started", 409);
  }
  const wasRunning = jobApplications.isRunning(job.id);
  // Always ask the gateway to abort, even if the database already says cancelled. A previous
  // cancel click may have updated the checkpoint while the model turn kept running elsewhere.
  const aborting = jobApplications.cancel(job.id, {
    // Only one controlled application may run at once, so these shared preparation turns
    // belong to this job while it owns the runner.
    sessionKeys: [CV_EDITOR_SESSION_KEY, COVER_LETTER_SESSION_KEY],
  });
  const alreadyCancelled = current.reasonCode === "user_cancelled";
  const application = alreadyCancelled
    ? current
    : jobHunts.saveApplication(job.id, {
        ...current,
        status: "failed",
        sessionKey: current?.sessionKey ?? jobApplications.sessionKey(job.id),
        reasonCode: "user_cancelled",
        summary: "Application automation was cancelled by the user. Any active work is stopping.",
        currentUrl: current?.currentUrl ?? job.url,
        manualAction: null,
        manualActionKind: null,
      });
  jobHunts.recordAttempt(job.id, {
    phase: "cancelled",
    outcome: alreadyCancelled ? "abort_retried" : "user_cancelled",
    reasonCode: "user_cancelled",
    detail: alreadyCancelled
      ? "The user pressed cancel again; gateway sessions were asked to abort again."
      : "The user cancelled the application. Active model turns are being aborted.",
    evidence: { abortRequested: true, wasRunning },
  });
  broadcast("hunting.applications.changed", { jobId: job.id, status: application.status });

  void aborting
    .then((result) => {
      jobHunts.recordAttempt(job.id, {
        phase: "cancelled",
        outcome: "abort_complete",
        reasonCode: "user_cancelled",
        detail: "Cancellation cleanup completed.",
        evidence: {
          abortedSessions: result.aborts.filter((entry) => entry.aborted).map((entry) => entry.sessionKey),
        },
      });
    })
    .catch(() => {
      jobHunts.recordAttempt(job.id, {
        phase: "cancelled",
        outcome: "abort_failed",
        reasonCode: "user_cancelled",
        detail: "Cancellation was recorded, but model cleanup could not be confirmed.",
        evidence: {},
      });
    });
  ok(res, { application, alreadyCancelled });
});

app.get("/api/hunting/applications/:jobId/attempts", (req, res) => {
  ok(res, { attempts: jobHunts.listAttempts(req.params.jobId) });
});

// The saved cover letter, so the letter behind an interview can be re-read later.
app.get("/api/hunting/applications/:jobId/cover-letter", (req, res) => {
  const application = jobHunts.getApplication(req.params.jobId);
  if (!application) return fail(res, "application not found", 404);
  const letter = coverLetters.read({ name: application.coverLetter?.name });
  if (!letter) return fail(res, "no cover letter has been saved for this application", 404);
  ok(res, { coverLetter: letter });
});

// Human takeover of the controlled browser. The browser is headless inside the gateway
// container, so a CAPTCHA, sign-in wall, or 2FA prompt can only be answered by mirroring it
// to the user. J.A.R.V.I.S. never touches a challenge; these routes carry the user's own
// input, and they stay behind the Hunting gate because that browser holds signed-in sessions.
app.get("/api/hunting/browser/tabs", async (_req, res) => {
  try {
    ok(res, { tabs: await browserTakeover.listTabs() });
  } catch (err) {
    fail(res, err, err?.statusCode ?? 502);
  }
});

app.post("/api/hunting/browser/takeover", async (req, res) => {
  const targetId = String(req.body?.targetId ?? "").trim();
  const url = String(req.body?.url ?? "").trim() || null;
  if (!targetId) return fail(res, "targetId is required", 400);
  try {
    ok(res, { frame: await browserTakeover.start({ targetId, url }) });
  } catch (err) {
    fail(res, err, err?.statusCode ?? 502);
  }
});

app.post("/api/hunting/browser/frame", async (req, res) => {
  const targetId = String(req.body?.targetId ?? "").trim();
  if (!targetId) return fail(res, "targetId is required", 400);
  try {
    ok(res, { frame: await browserTakeover.frame({ targetId }) });
  } catch (err) {
    fail(res, err, err?.statusCode ?? 502);
  }
});

app.post("/api/hunting/browser/input", async (req, res) => {
  const targetId = String(req.body?.targetId ?? "").trim();
  if (!targetId) return fail(res, "targetId is required", 400);
  try {
    ok(res, await browserTakeover.input({ ...req.body, targetId }));
  } catch (err) {
    fail(res, err, err?.statusCode ?? 502);
  }
});

app.post("/api/hunting/browser/navigate", async (req, res) => {
  const targetId = String(req.body?.targetId ?? "").trim();
  const url = String(req.body?.url ?? "").trim();
  if (!targetId || !url) return fail(res, "targetId and url are required", 400);
  try {
    ok(res, await browserTakeover.navigate({ targetId, url }));
  } catch (err) {
    fail(res, err, err?.statusCode ?? 502);
  }
});

app.post("/api/hunting/applications/:jobId/interview-prep", async (req, res) => {
  try {
    const job = jobHunts.getJob(req.params.jobId);
    if (!job) return fail(res, "job not found", 404);
    const cv = cvs.get();
    if (!cv) return fail(res, "Save a canonical CV before preparing for an interview", 400);
    const application = jobHunts.getApplication(job.id);
    const saved = await interviewPrep.generate({
      job,
      cv: cv.content,
      identityMemory: memories.get("memory-example-user"),
      applicationMemory: memories.get("memory-example-job-application-profile"),
      coverLetter: coverLetters.read({ name: application?.coverLetter?.name })?.letter ?? null,
    });
    ok(res, { prep: saved });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/hunting/applications/:jobId/interview-prep", async (req, res) => {
  try {
    const job = jobHunts.getJob(req.params.jobId);
    if (!job) return fail(res, "job not found", 404);
    const name = `${String(req.query.name ?? "")}`;
    const found = interviewPrep.read({ name });
    if (!found) return fail(res, "no interview preparation saved for this application", 404);
    ok(res, { prep: found });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/hunting/applications/:jobId/submitted", async (req, res) => {
  const current = jobHunts.getApplication(req.params.jobId);
  if (!current) return fail(res, "application not found", 404);
  try {
    const manualRecoveryConfirmed =
      req.body?.manualRecoveryConfirmed === true &&
      current.status === "needs_human_action" &&
      ["submission_spam_flagged", "submission_unverified"].includes(current.reasonCode);
    if (manualRecoveryConfirmed) {
      const application = jobHunts.saveApplication(req.params.jobId, {
        ...current,
        status: "submitted",
        reasonCode: "manual_recovery_confirmed",
        summary: "The user confirmed submission from the manual verification session.",
        manualAction: null,
        manualActionKind: null,
      });
      jobHunts.recordAttempt(req.params.jobId, {
        phase: "submitted",
        outcome: "manual_recovery_confirmed",
        detail: `Confirmed by the user after ${current.reasonCode}.`,
        evidence: { previousStatus: current.status, previousReasonCode: current.reasonCode },
      });
      broadcast("hunting.applications.changed", { jobId: req.params.jobId, status: application.status });
      return ok(res, { application, submissionAccepted: true });
    }
    // The user's confirmation is necessary but the employer page is the final source of truth.
    // If it visibly rejected the submission, preserve the page and stop instead of recording a
    // false success or encouraging the agent to hammer Submit again.
    if (!current.browserTargetId) {
      const application = jobHunts.saveApplication(req.params.jobId, {
        ...current,
        status: "needs_human_action",
        reasonCode: "submission_unverified",
        summary: "Submission could not be verified because there is no controlled browser tab.",
        manualAction: "Confirm the employer page shows a successful submission, then press Confirm submitted again.",
        manualActionKind: "verification",
      });
      return ok(res, { application, submissionAccepted: false });
    }
    {
      const page = await browserControl.snapshot({ targetId: current.browserTargetId, maxChars: 30_000 });
      if (!page.ok) {
        const application = jobHunts.saveApplication(req.params.jobId, {
          ...current,
          status: "needs_human_action",
          reasonCode: "submission_unverified",
          summary: `Submission could not be verified: ${page.error ?? "browser snapshot unavailable"}`,
          manualAction: "Confirm the employer page shows a successful submission, then press Confirm submitted again.",
          manualActionKind: "verification",
        });
        return ok(res, { application, submissionAccepted: false });
      }
      const rejection = detectSubmissionRejection({ text: String(page.payload?.snapshot ?? "") });
      if (rejection) {
        const application = jobHunts.saveApplication(req.params.jobId, {
          ...current,
          status: "needs_human_action",
          reasonCode: rejection.reasonCode,
          summary: rejection.detail,
          manualAction:
            "Do not repeatedly resubmit from the controlled browser. Wait before retrying, then open the official application in an up-to-date normal browser with JavaScript enabled; if you use a VPN or proxy, disconnect it for that manual attempt. Review or re-enter the details yourself and submit once. If it is rejected again, contact the employer's recruiting support. J.A.R.V.I.S. will not retry or bypass the protection.",
          manualActionKind: "verification",
        });
        jobHunts.recordAttempt(req.params.jobId, {
          phase: "submitted",
          outcome: "rejected",
          reasonCode: rejection.reasonCode,
          detail: rejection.detail,
          evidence: {
            marker: rejection.evidence,
            targetId: current.browserTargetId,
            currentUrl: page.payload?.url ?? current.currentUrl,
          },
        });
        broadcast("hunting.applications.changed", {
          jobId: req.params.jobId,
          status: application.status,
        });
        return ok(res, { application, submissionAccepted: false });
      }
    }
    const application = jobHunts.saveApplication(req.params.jobId, {
      ...current,
      status: "submitted",
      reasonCode: "user_confirmed",
      summary: "Application submission was confirmed by the user.",
      manualAction: null,
      manualActionKind: null,
    });
    // The prior status is the audit trail for what the user finished by hand.
    jobHunts.recordAttempt(req.params.jobId, {
      phase: "submitted",
      outcome: "user_confirmed",
      detail: `Confirmed by the user from ${current.status}.`,
      evidence: { previousStatus: current.status, uploadOutcome: current.uploadOutcome },
    });
    broadcast("hunting.applications.changed", { jobId: req.params.jobId, status: application.status });
    ok(res, { application, submissionAccepted: true });
  } catch (err) {
    fail(res, err, 400);
  }
});

// The application agent deliberately never decides to submit. This route is reached only after
// the operator presses the per-application "Submit with J.A.R.V.I.S." control, and it still
// refuses an incomplete, prepare-only, or previously rejected form.
app.post("/api/hunting/applications/:jobId/submit", async (req, res) => {
  const jobId = req.params.jobId;
  const current = jobHunts.getApplication(jobId);
  const job = jobHunts.getJob(jobId);
  if (!current || !job) return fail(res, "application not found", 404);
  if (submittingApplicationIds.has(jobId)) return fail(res, "This application is already being submitted", 409);
  if (current.status !== "ready_for_review") {
    return fail(res, "Only a fully verified application can be submitted with J.A.R.V.I.S.", 409);
  }
  if (!current.browserTargetId) return fail(res, "The controlled application tab is no longer available", 409);

  submittingApplicationIds.add(jobId);
  try {
    const url = current.currentUrl || job.url;
    const host = siteHost(url);
    const playbook = host ? memories.findManaged("shared_lesson", playbookKey(host)) : null;
    const strategy = resolveSiteStrategy({
      host,
      playbookBody: playbook?.body ?? "",
      configured: { automationPolicy: resolveAutomationPolicy(url), autoSubmit: false },
    });
    const blockers = [
      ...(host ? [] : ["the current application host could not be verified"]),
      ...submitBlockers({
        application: current,
        assessment: {
          blockingFields: current.unresolvedFields.filter((field) => field.required !== false),
        },
        automationPolicy: strategy.automationPolicy,
        host,
        // This is a direct, per-application approval, not blanket host auto-submit. The
        // wildcard skips only the host-proven ramp; all completion and safety checks remain.
        hosts: ["*"],
      }),
    ];
    if (blockers.length) return fail(res, `J.A.R.V.I.S. cannot submit this application: ${blockers.join("; ")}`, 409);

    const result = await applicationSubmits.submit({ targetId: current.browserTargetId, adapter: resolveSiteAdapter(url) });
    jobHunts.recordAttempt(jobId, {
      phase: "submitted",
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      detail: result.detail,
      evidence: { ...result.evidence, initiatedBy: "user_approved_ai_submit" },
    });

    const submitted = result.outcome === "submitted";
    const application = jobHunts.saveApplication(jobId, {
      ...current,
      status: submitted ? "submitted" : "needs_human_action",
      reasonCode: submitted ? "user_approved_ai_submit" : `ai_submit_${result.reasonCode ?? result.outcome}`,
      summary: submitted ? result.detail : `J.A.R.V.I.S. stopped after one submit attempt: ${result.detail}`,
      currentUrl: result.evidence?.url ?? url,
      manualAction: submitted
        ? null
        : result.outcome === "rejected"
          ? "The employer rejected the submission. Do not retry automatically; review the employer page and use its official support route if needed."
          : "Check the employer page yourself before deciding whether to submit manually. J.A.R.V.I.S. will not click Submit again.",
      manualActionKind: submitted ? null : "review",
    });
    broadcast("hunting.applications.changed", { jobId, status: application.status });
    ok(res, { application, submissionAccepted: submitted });
  } catch (err) {
    fail(res, err, 400);
  } finally {
    submittingApplicationIds.delete(jobId);
  }
});

app.get("/api/memories", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q : "";
  try {
    await memories.refresh();
    ok(res, { memories: memories.list(query).map(withMemoryAttachments) });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/memories/:id", (req, res) => {
  const memory = memories.get(req.params.id);
  if (!memory) return fail(res, Object.assign(new Error("memory not found"), { statusCode: 404 }));
  ok(res, { memory: withMemoryAttachments(memory) });
});

app.get("/api/memory/graph", (_req, res) => {
  const graph = memories.graph();
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const approvedPairs = new Set(graph.edges.map((edge) => [edge.source, edge.target].sort().join("::")));
  const candidates = proposals.list("pending").flatMap((proposal) => {
    if (proposal.kind !== "relationship") return [];
    const source = proposal.payload.fromId;
    const target = proposal.payload.toId;
    if (!nodeIds.has(source) || !nodeIds.has(target)) return [];
    if (approvedPairs.has([source, target].sort().join("::"))) return [];
    return [{
      id: `candidate:${proposal.id}`,
      source,
      target,
      label: proposal.payload.relationType ?? proposal.payload.label ?? "related",
      relationType: proposal.payload.relationType ?? proposal.payload.label ?? "related",
      weight: Number(proposal.payload.weight ?? 0.58),
      confidence: Number(proposal.payload.confidence ?? 0.58),
      creationSource: proposal.payload.creationSource ?? "agent-proposal",
      activationCount: Number(proposal.payload.activationCount ?? 0),
      lastActivatedAt: proposal.payload.lastActivatedAt ?? null,
      archived: false,
      state: "candidate",
      tier: proposal.payload.tier ?? "medium",
    }];
  });
  ok(res, { nodes: graph.nodes, edges: [...graph.edges, ...candidates] });
});

app.get("/api/memory/neural/status", (_req, res) => ok(res, { status: neuralEngine.status() }));

app.post("/api/memory/neural/run", async (_req, res) => {
  try {
    ok(res, { status: await neuralEngine.runNow() });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.post("/api/memories", async (req, res) => {
  try {
    const memory = await memories.create(req.body ?? {}, "user");
    attachmentStore.setForMemory(memory.id, req.body?.attachmentIds);
    broadcast("memory.changed", { version: memories.version, count: memories.list().length });
    ok(res, { memory: withMemoryAttachments(memory) });
    neuralEngine.runNow().catch(() => undefined);
  } catch (err) {
    fail(res, err, 400);
  }
});

app.put("/api/memories/:id", async (req, res) => {
  try {
    const memory = await memories.update(req.params.id, req.body ?? {});
    if (Array.isArray(req.body?.attachmentIds)) {
      attachmentStore.setForMemory(memory.id, req.body.attachmentIds);
    }
    broadcast("memory.changed", { version: memories.version, count: memories.list().length });
    ok(res, { memory: withMemoryAttachments(memory) });
    neuralEngine.runNow().catch(() => undefined);
  } catch (err) {
    fail(res, err, 400);
  }
});

app.delete("/api/memories/:id", async (req, res) => {
  try {
    const deleted = await memories.delete(req.params.id, req.body ?? {});
    attachmentStore.removeMemory(req.params.id);
    broadcast("memory.changed", { version: memories.version, count: memories.list().length });
    ok(res, { deleted });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.get("/api/memory/proposals", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  if (!new Set(["pending", "approved", "rejected"]).has(status)) {
    return fail(res, Object.assign(new Error("invalid proposal status"), { statusCode: 400 }));
  }
  ok(res, { proposals: proposals.list(status) });
});

app.post("/api/memory/proposals/:id/approve", async (req, res) => {
  const proposal = proposals.get(req.params.id);
  if (!proposal) return fail(res, Object.assign(new Error("proposal not found"), { statusCode: 404 }));
  if (proposal.status !== "pending") {
    return fail(res, Object.assign(new Error("proposal has already been resolved"), { statusCode: 409 }));
  }
  try {
    let memory = null;
    if (proposal.kind === "memory") {
      memory = await memories.create(proposal.payload, "agent-approved");
    } else {
      memory = await memories.addRelationship(
        proposal.payload.fromId,
        proposal.payload.toId,
        proposal.payload,
      );
      if (proposal.payload.supersedesId) {
        await memories.markSuperseded(proposal.payload.supersedesId, proposal.payload.fromId);
      }
    }
    const resolved = proposals.resolve(proposal.id, "approved");
    broadcast("memory.changed", { version: memories.version, count: memories.list().length });
    broadcast("memory.proposals.changed", { pending: proposals.list("pending").length });
    ok(res, { proposal: resolved, memory });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.post("/api/memory/proposals/:id/reject", (req, res) => {
  try {
    const proposal = proposals.resolve(req.params.id, "rejected");
    broadcast("memory.proposals.changed", { pending: proposals.list("pending").length });
    ok(res, { proposal });
  } catch (err) {
    fail(res, err, 400);
  }
});

// Send a message to an agent. The streamed reply arrives via SSE ("chat").
// ---- Extraction catalogue -------------------------------------------------
// Read-only view of the price-comparison CSVs the agent produces in the
// OpenClaw workspace. Nothing here writes: extraction runs stay with the agent.

app.get("/api/extractions", (_req, res) => {
  try {
    ok(res, { extractions: extractions.list(), source: extractions.status() });
  } catch (err) {
    fail(res, err, 500);
  }
});

// Declared before /:id so "runs" and "schedule" are not read as extraction ids.
app.get("/api/extractions/runs", (_req, res) => {
  try {
    ok(res, { runs: extractions.runs(), defaultSchedule: extractions.defaultSchedule() });
  } catch (err) {
    fail(res, err, 500);
  }
});

// ---- ProviderB ---------------------------------------------------------
// Runs through the OpenClaw-controlled browser rather than a headless driver;
// See provider-b.js for the environment-configured public adapter.

app.post("/api/extractions/provider-b/probe", async (_req, res) => {
  try {
    ok(res, { profile: providerB.profile, probe: await providerB.probe() });
  } catch (err) {
    fail(res, Object.assign(err, { message: `[profile=${providerB.profile}] ${err.message}` }), 502);
  }
});

app.post("/api/extractions/provider-b/extract", async (req, res) => {
  try {
    const { destination, dates, nights, adults, airports, session } = normalizeProviderBInput(req.body);
    const day = new Date().toISOString().slice(0, 10);
    const dayRoot = path.resolve(extractions.root, "Extraction_Live_Workspace", day);
    const sessionName = session ?? `provider-b-${slug(destination)}-${dates[0]}`;
    const sessionDir = path.resolve(dayRoot, sessionName);
    if (!sessionDir.startsWith(`${dayRoot}${path.sep}`)) {
      return fail(res, new Error("invalid extraction session"), 400);
    }
    const results = await providerB.extract({
      destination,
      dates,
      nights: nights ?? 7,
      adults: adults ?? 2,
      airports: airports ?? ["LON"],
      sessionDir,
    });
    ok(res, { sessionDir: path.relative(extractions.root, sessionDir), results });
  } catch (err) {
    fail(res, err, 502);
  }
});

// ---- Extraction tasks -----------------------------------------------------
// A task is a standing instruction: which agent, which sites, which travel
// dates, and which weekdays. The scheduler hands each firing to the agent.

const withNextRun = (task) => ({ ...task, nextRunDay: nextRunDay(task) });

app.get("/api/extractions/tasks", (_req, res) => {
  try {
    extractionTasks.expire();
    ok(res, { tasks: extractionTasks.list().map(withNextRun), supportedSites: SUPPORTED_SITES });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.post("/api/extractions/tasks", (req, res) => {
  try {
    ok(res, { task: withNextRun(extractionTasks.create(req.body ?? {})) });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.post("/api/extractions/tasks/:id/status", async (req, res) => {
  try {
    const task = extractionTasks.setStatus(req.params.id, req.body?.status);
    if (!task) return fail(res, new Error("Task not found"), 404);
    // Stopping a task must also stop the work it already handed to the agent.
    if (task.status !== "active") await extractionScheduler.abort(task);
    ok(res, { task: withNextRun(task) });
  } catch (err) {
    fail(res, err, 400);
  }
});

// Run outside the schedule without consuming the day's slot, so a user can
// prove a task works instead of waiting for its weekday.
app.post("/api/extractions/tasks/:id/run-now", async (req, res) => {
  try {
    const task = await extractionScheduler.runNow(req.params.id);
    if (!task) return fail(res, new Error("Task not found"), 404);
    ok(res, { task: withNextRun(task) });
  } catch (err) {
    fail(res, err, err?.statusCode ?? 500);
  }
});

app.delete("/api/extractions/tasks/:id", async (req, res) => {
  try {
    // Read before deleting: aborting needs the session key, which needs the task.
    const task = extractionTasks.get(req.params.id);
    if (task) await extractionScheduler.abort(task);
    extractionTasks.delete(req.params.id);
    ok(res, {});
  } catch (err) {
    fail(res, err, 500);
  }
});

// Pause / resume / stop a run, and set the hours it is allowed to work. The
// script polls for this; Jarvis never runs an extraction itself.
app.post("/api/extractions/runs/:id/control", (req, res) => {
  try {
    const run = extractions.control(req.params.id, {
      command: req.body?.command,
      schedule: req.body?.schedule,
    });
    if (!run) return fail(res, new Error("Extraction run not found"), 404);
    ok(res, { run });
  } catch (err) {
    fail(res, err, 500);
  }
});

// The window runs started later will adopt, so the hours can be chosen before
// the run exists.
app.put("/api/extractions/schedule", (req, res) => {
  try {
    ok(res, { defaultSchedule: extractions.setDefaultSchedule(req.body?.schedule) });
  } catch (err) {
    fail(res, err, 500);
  }
});

app.get("/api/extractions/:id", (req, res) => {
  try {
    const detail = extractions.read(req.params.id);
    if (!detail) return fail(res, new Error("Extraction not found"), 404);
    ok(res, detail);
  } catch (err) {
    fail(res, err, 500);
  }
});

app.get("/api/extractions/:id/download", (req, res) => {
  const target = extractions.resolve(req.params.id);
  if (!target || !fs.existsSync(target.absPath)) {
    return fail(res, new Error("Extraction not found"), 404);
  }
  res.type("text/csv").sendFile(target.absPath);
});

// ---- Workflow learning ----------------------------------------------------
// Screen recording -> Screenpipe local memory -> AI extracts workflow -> Jarvis memory ->
// the agent replays it later. Screenpipe is only ever read from; every reusable artefact (the
// spec, its variables, its safety rules, its run history) lives in Jarvis.

app.get("/api/workflows/screenpipe", async (_req, res) => {
  ok(res, { screenpipe: await screenpipe.health() });
});

app.get("/api/workflows/sessions", (_req, res) =>
  ok(res, { sessions: workflowStore.listSessions(), active: workflowStore.activeSession() }));

app.post("/api/workflows/sessions", async (req, res) => {
  try {
    const active = workflowStore.activeSession();
    if (active) {
      throw Object.assign(new Error("A workflow recording is already open; stop it first"), {
        statusCode: 409,
      });
    }
    // Screenpipe records continuously, so a session is a bookmark into its stream rather than a
    // recorder we start. Checking health up front is what stops the user narrating a five-minute
    // task into a recorder that was not running.
    const health = await screenpipe.health();
    if (!health.running) {
      throw Object.assign(
        new Error(`Screenpipe is not answering at ${health.baseUrl} (${health.detail}). Start it before recording.`),
        { statusCode: 503 },
      );
    }
    // Running but unreadable is the worse failure: the user would do the whole task before the
    // capture failed. Refuse up front with the reason, which for a 401 names the fix.
    if (!health.readable) {
      throw Object.assign(new Error(`Screenpipe is running but cannot be read. ${health.detail}`), {
        statusCode: 503,
      });
    }
    const session = workflowStore.startSession({
      title: req.body?.title,
      includeAudio: req.body?.includeAudio === true,
    });
    broadcast("workflow.session.changed", session);
    ok(res, { session });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/workflows/sessions/:id/stop", async (req, res) => {
  try {
    const session = workflowStore.getSession(req.params.id);
    if (!session) throw Object.assign(new Error("learning session not found"), { statusCode: 404 });
    if (session.status !== "recording") {
      throw Object.assign(new Error(`this session is ${session.status}, not recording`), { statusCode: 409 });
    }
    const endedAt = new Date().toISOString();
    const capture = await screenpipe.captureWindow({
      startTime: session.startedAt,
      endTime: endedAt,
      includeAudio: session.includeAudio,
    });
    // Only the redacted digest is persisted. The raw capture is dropped here, so Jarvis never
    // holds a second copy of the recording outside Screenpipe's own database.
    const digest = buildObservationDigest(capture, { excludeApps: WORKFLOW_EXCLUDE_APPS });
    const updated = workflowStore.updateSession(session.id, {
      status: "captured",
      endedAt,
      digest,
      error: digest.segments.length ? null : "Screenpipe returned nothing for this window.",
    });
    broadcast("workflow.session.changed", updated);
    ok(res, { session: updated });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/workflows/sessions/:id/extract", async (req, res) => {
  try {
    const session = workflowStore.getSession(req.params.id);
    if (!session) throw Object.assign(new Error("learning session not found"), { statusCode: 404 });
    if (!session.digest?.segments?.length) {
      throw Object.assign(new Error("this session has no captured screen activity to convert"), {
        statusCode: 400,
      });
    }
    const draft = await workflowLearner.extract({ digest: session.digest, title: session.title });
    const updated = workflowStore.updateSession(session.id, { status: "extracted", draft, error: null });
    broadcast("workflow.session.changed", updated);
    ok(res, { session: updated, draft });
  } catch (err) {
    workflowStore.updateSession(req.params.id, { error: String(err?.message ?? err) });
    fail(res, err);
  }
});

app.post("/api/workflows/sessions/:id/abandon", (req, res) => {
  try {
    const updated = workflowStore.updateSession(req.params.id, {
      status: "abandoned",
      endedAt: workflowStore.getSession(req.params.id)?.endedAt ?? new Date().toISOString(),
    });
    broadcast("workflow.session.changed", updated);
    ok(res, { session: updated });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/workflows", (_req, res) =>
  ok(res, {
    workflows: workflowStore.listWorkflows().map((workflow) => ({
      ...workflow,
      lastRun: workflowStore.listRuns(workflow.id, 1)[0] ?? null,
    })),
  }));

app.get("/api/workflows/:id", (req, res) => {
  const workflow = workflowStore.getWorkflow(req.params.id);
  if (!workflow) return fail(res, "workflow not found", 404);
  ok(res, { workflow, runs: workflowStore.listRuns(workflow.id) });
});

/** Save an approved draft: the executable spec to SQLite, the readable recipe to Jarvis memory. */
app.post("/api/workflows", async (req, res) => {
  try {
    const spec = normalizeLearnedWorkflow(req.body?.spec ?? req.body);
    const sessionId = String(req.body?.sessionId ?? "").trim() || null;
    const saved = workflowStore.saveWorkflow(spec, { sessionId });
    const memory = await syncWorkflowMemory(saved);
    if (sessionId && workflowStore.getSession(sessionId)) {
      workflowStore.updateSession(sessionId, { status: "saved", workflowId: saved.id });
      broadcast("workflow.session.changed", workflowStore.getSession(sessionId));
    }
    broadcast("workflow.changed", { id: saved.id, name: saved.name });
    ok(res, { workflow: workflowStore.getWorkflow(saved.id), memory });
  } catch (err) {
    fail(res, err);
  }
});

app.put("/api/workflows/:id", async (req, res) => {
  try {
    const existing = workflowStore.getWorkflow(req.params.id);
    if (!existing) throw Object.assign(new Error("workflow not found"), { statusCode: 404 });
    const spec = normalizeLearnedWorkflow(req.body?.spec ?? req.body, { id: existing.id });
    const saved = workflowStore.saveWorkflow(spec, { sessionId: existing.sessionId, memoryId: existing.memoryId });
    const memory = await syncWorkflowMemory(saved);
    broadcast("workflow.changed", { id: saved.id, name: saved.name });
    ok(res, { workflow: workflowStore.getWorkflow(saved.id), memory });
  } catch (err) {
    fail(res, err);
  }
});

app.delete("/api/workflows/:id", (req, res) => {
  try {
    const removed = workflowStore.deleteWorkflow(req.params.id);
    broadcast("workflow.changed", { id: removed.id, name: removed.name, deleted: true });
    // The Obsidian note is left in place: it is the user's document in their own vault, and
    // deleting a workflow from the app is not consent to delete a page from their second brain.
    ok(res, { workflow: removed, memoryId: removed.memoryId });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/workflows/:id/run", async (req, res) => {
  try {
    const workflow = workflowStore.getWorkflow(req.params.id);
    if (!workflow) throw Object.assign(new Error("workflow not found"), { statusCode: 404 });
    const filled = fillVariables(workflow.spec, req.body?.values);
    if (!filled.ok) {
      return res.status(400).json({
        ok: false,
        error: `Missing required values: ${filled.missing.join(", ")}`,
        missing: filled.missing,
      });
    }
    const run = await workflowRunner.start({ workflow: workflow.spec, steps: filled.steps, values: filled.values });
    await recordRunInMemory(workflow.id, run);
    broadcast("workflow.run.changed", run);
    ok(res, { run, steps: filled.steps });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/workflows/runs/:runId/continue", async (req, res) => {
  try {
    const run = workflowStore.getRun(req.params.runId);
    if (!run) throw Object.assign(new Error("workflow run not found"), { statusCode: 404 });
    const workflow = workflowStore.getWorkflow(run.workflowId);
    if (!workflow) throw Object.assign(new Error("workflow not found"), { statusCode: 404 });
    const filled = fillVariables(workflow.spec, run.variables);
    if (!filled.ok) throw Object.assign(new Error(`Missing required values: ${filled.missing.join(", ")}`), { statusCode: 400 });
    const next = await workflowRunner.resume({
      runId: run.id,
      workflow: workflow.spec,
      steps: filled.steps,
      approved: req.body?.approved === true,
      guidance: String(req.body?.guidance ?? ""),
    });
    await recordRunInMemory(workflow.id, next);
    broadcast("workflow.run.changed", next);
    ok(res, { run: next, steps: filled.steps });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/workflows/runs/:runId/cancel", (req, res) => {
  try {
    const run = workflowRunner.cancel(req.params.runId);
    broadcast("workflow.run.changed", run);
    ok(res, { run });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Mirror a saved workflow into the Obsidian memory as one note per workflow.
 *
 * Obsidian is the source of truth for what Jarvis knows, so the recipe belongs there: it is
 * human-readable, editable in the vault, and retrievable by the ordinary chat memory path, which
 * is what makes "run the invoice workflow for Client X" work without a new lookup system. A
 * missing or offline vault is reported, not fatal — the executable spec is already saved.
 */
async function syncWorkflowMemory(workflow) {
  const spec = workflow.spec;
  const body = renderWorkflowNote(spec, { runHistory: workflowStore.listRuns(workflow.id, 10) });
  const managedKey = workflowManagedKey(spec.name);
  try {
    const existing = workflowStore.getWorkflow(workflow.id)?.memoryId
      ? memories.get(workflowStore.getWorkflow(workflow.id).memoryId)
      : memories.findManaged("general", managedKey);
    const saved = existing
      ? await memories.update(existing.id, {
          title: `Workflow · ${spec.name}`,
          body,
          tags: workflowMemoryTags(spec),
          links: existing.manualLinks ?? [],
        })
      : await memories.create(
          { title: `Workflow · ${spec.name}`, body, tags: workflowMemoryTags(spec), memoryType: "general", managedKey },
          "user",
        );
    workflowStore.setWorkflowMemory(workflow.id, saved.id);
    broadcast("memory.changed", { version: memories.version, count: memories.list().length });
    return { saved: true, id: saved.id, title: saved.title };
  } catch (err) {
    return { saved: false, error: String(err?.message ?? err) };
  }
}

/**
 * Refresh the note's execution history once a run has actually finished.
 *
 * Only terminal states are written: a note that recorded every pause at a checkpoint would fill up
 * with half-runs and the history would stop being a record of what the workflow did.
 */
async function recordRunInMemory(workflowId, run) {
  if (run?.status === "running" || run?.status === "awaiting_confirmation") return;
  const workflow = workflowStore.getWorkflow(workflowId);
  if (!workflow?.memoryId) return;
  await syncWorkflowMemory(workflow).catch(() => undefined);
}

app.post("/api/chat", async (req, res) => {
  const { sessionKey, message, agentId, attachmentIds = [] } = req.body ?? {};
  const userMessage = String(message ?? "");
  if (!sessionKey || (!userMessage.trim() && !attachmentIds.length)) {
    return fail(res, "sessionKey and a message or attachment are required", 400);
  }
  try {
    const target = executionTargets.get(sessionKey);
    const devices = await getExecutionDevices();
    await patchSessionExecutionTarget(sessionKey, agentId, target, devices);
    const relevantLessons = memories.retrieve(userMessage, 2, "shared_lesson");
    const relevantMemories = [
      ...relevantLessons,
      ...memories.retrieve(userMessage, 4, "general"),
    ];
    const activeAgentId = agentId || /^agent:([^:]+):/.exec(sessionKey)?.[1] || "main";
    const memoryContext = contextForAgent(memories.list(), activeAgentId, relevantMemories);
    const userAttachments = attachmentStore.list(attachmentIds);
    const memoryAttachments = memoryContext.flatMap((memory) =>
      attachmentStore.forMemory(memory.id).map((attachment) => ({ ...attachment, memoryId: memory.id })),
    );
    const gatewayAttachments = attachmentStore.gatewayPayloads([
      ...userAttachments.map(({ id }) => id),
      ...memoryAttachments.map(({ id }) => id),
    ]);
    sessionAttachmentGrants.set(sessionKey, new Set([
      ...userAttachments.map(({ id }) => id),
      ...memoryAttachments.map(({ id }) => id),
    ]));
    neuralEngine.recordRetrieval(relevantMemories.map(({ id }) => id));
    const ack = await gateway.request("chat.send", {
      sessionKey,
      ...(agentId ? { agentId } : {}),
      message: buildMemoryAwareMessage(
        userMessage,
        memoryContext,
        buildExecutionPolicy(target, devices),
        { user: userAttachments, memory: memoryAttachments },
      ),
      ...(gatewayAttachments.length ? { attachments: gatewayAttachments } : {}),
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    ok(res, {
      ack,
      memoryCandidates: relevantMemories.map(({ id, title }) => ({ id, title })),
    });
  } catch (err) {
    fail(res, err);
  }
});

function withMemoryAttachments(memory) {
  return { ...memory, attachments: attachmentStore.forMemory(memory.id) };
}

async function getExecutionDevices() {
  return resolveExecutionDevices(await gateway.request("node.list", {}));
}

async function patchSessionExecutionTarget(sessionKey, agentId, target, devices) {
  await gateway.request("sessions.patch", {
    key: sessionKey,
    ...(agentId ? { agentId } : {}),
    ...buildSessionExecutionPatch(target, devices),
  });
}

app.post("/api/node/:nodeId/screen-control", async (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Manual screen control requires the JARVIS page", 403);
  try {
    const raw = await gateway.request("node.list", {});
    const decorated = humanScreenControl.decorateNodeList(
      await windowsScreen.decorateNodeList(raw),
    );
    ok(res, { control: humanScreenControl.start(req.params.nodeId, decorated.nodes ?? []) });
  } catch (err) {
    fail(res, err, 400);
  }
});

app.delete("/api/node/:nodeId/screen-control", (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Manual screen control requires the JARVIS page", 403);
  humanScreenControl.stop(req.params.nodeId, String(req.body?.token ?? ""));
  ok(res, {});
});

app.post("/api/node/:nodeId/screen-input", async (req, res) => {
  if (!requestIsSameOrigin(req)) return fail(res, "Manual screen control requires the JARVIS page", 403);
  try {
    const payload = await humanScreenControl.input(
      req.params.nodeId,
      String(req.body?.token ?? ""),
      req.body?.input,
    );
    ok(res, { payload });
  } catch (err) {
    fail(res, err, 400);
  }
});

// The browser-facing API exposes only the typed snapshot operation. Arbitrary
// node.invoke commands would inherit the BFF's operator privileges.
app.post("/api/node/:nodeId/invoke", async (req, res) => {
  const { command, params } = req.body ?? {};
  if (command !== "screen.snapshot") return fail(res, "unsupported node command", 400);
  try {
    if (windowsScreen.handles(req.params.nodeId, command)) {
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const payload = await windowsScreen.snapshot(params ?? {}, controller.signal);
      return ok(res, { nodeId: req.params.nodeId, command, payload });
    }
    ok(res, await gateway.request("node.invoke", {
      nodeId: req.params.nodeId,
      command: "screen.snapshot",
      params: normalizeSnapshotParams(params),
      idempotencyKey: randomUUID(),
    }));
  } catch (err) {
    fail(res, err);
  }
});

// SSE stream of live gateway events.
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: gateway.status\ndata: ${JSON.stringify(gateway.status())}\n\n`);
  res.write(`event: memory.status\ndata: ${JSON.stringify(memories.status())}\n\n`);
  res.write(`event: memory.neural.status\ndata: ${JSON.stringify(neuralEngine.status())}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// Serve the built client if present (production single-process mode).
const clientDist = path.resolve(__dirname, "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.listen(PORT, HOST, () => {
  console.log(`[jarvis-bff] listening on http://${HOST}:${PORT}  (gateway: ${GATEWAY_URL})`);
  // Owning the port proves this is the only live instance, so anything still marked in
  // flight belongs to a process that is gone. A launch that loses the port bind never
  // reaches this point and therefore cannot disturb the instance that won it.
  jobHunts.recoverInterruptedWork();
  // Same reasoning: only the instance holding the port may fire scheduled
  // extractions, so two processes cannot dispatch the same day's task, and a
  // task still marked running belongs to a process that is gone.
  extractionTasks.recoverInterruptedRuns();
  extractionScheduler.start();
});

/** Undefined when unset or unusable, so the owning service's default stays authoritative. */
function optionalEnvInt(name) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * One controlled application, as an explicit sequence of persisted phases:
 * preparing_cv -> opening_form -> uploading_cv -> filling_verified_fields, ending in
 * ready_for_review, needs_human_action, or failed. Each phase writes an attempt row, so a
 * resumed run reads what happened instead of asking the model to remember it. Sign-in,
 * CAPTCHA, and the final submit are never automated.
 */
/**
 * Close tabs left behind by applications that are over.
 *
 * None of the wrong-tab failures could have happened with one application tab open at a time: the
 * leftovers are what made a wrong pick possible. Only terminal applications are pruned — a
 * checkpoint waiting on the user still needs its tab, because that is the tab he takes over.
 */
async function pruneFinishedApplicationTabs({ browserControl, keepJobId }) {
  const closed = [];
  for (const application of jobHunts.listApplications()) {
    if (application.jobId === keepJobId) continue;
    if (!isFinishedApplication(application) || !application.browserTargetId) continue;
    const result = await browserControl.closeTab(application.browserTargetId);
    // A tab that is already gone is the desired state, so a failure here is not worth reporting.
    if (result.ok) closed.push(application.browserTargetId);
  }
  return closed;
}

async function runControlledApplication(context) {
  const { job, adapter, current, resume } = context;
  // Read back what this site already taught us, and let it tighten how this run behaves.
  // A resumed application already knows its employer-form URL. Use that host before the first
  // model turn so a permission granted at the checkpoint is present when the form is inspected.
  const host = siteHost(resume && current?.currentUrl ? current.currentUrl : job.url);
  const playbook = memories.findManaged("shared_lesson", playbookKey(host));
  const strategy = resolveSiteStrategy({
    host,
    playbookBody: playbook?.body ?? "",
    configured: {
      automationPolicy: resolveAutomationPolicy(job.url),
      autoSubmit: isAutoSubmitHost(host, autoSubmitHosts()),
    },
  });
  context.strategy = strategy;
  // Standing acceptances come from the BFF's own table, never from the playbook memory: a
  // permission the model can write is not a permission the user gave.
  context.consentGates = jobHunts.listSiteConsents(host).map((entry) => entry.gate);
  context.consentPrompt = describeConsentForPrompt({ host, gates: context.consentGates });
  if (strategy.reasons.length) {
    jobHunts.recordAttempt(job.id, {
      phase: "preparing_cv",
      outcome: "strategy_from_memory",
      reasonCode: strategy.automationPolicy,
      detail: strategy.reasons.join("; "),
      evidence: { host, learnedFrom: strategy.learnedFrom },
    });
  }
  const meter = new ApplicationUsageMeter({ gateway });
  await meter.begin({
    sessionKeys: [
      context.sessionKey,
      COVER_LETTER_SESSION_KEY,
      CV_EDITOR_SESSION_KEY,
      DOCUMENT_REVIEW_SESSION_KEY,
    ],
  });
  context.meter = meter;

  saveApplicationPhase(context, {
    status: "preparing_cv",
    summary: resume
      ? `Resuming the ${adapter.label} application for ${job.company}.`
      : `Preparing your CV and cover letter for ${job.company}.`,
    currentUrl: current?.currentUrl ?? job.url,
  });
  // No model turn here any more: the CV is attached as uploaded, so there is nothing to meter.
  const artifact = await resolveApplicationArtifact(context);
  context.assertActive();
  jobHunts.recordAttempt(job.id, {
    phase: "preparing_cv",
    outcome: artifact.reused ? "reused" : "prepared",
    detail: `${artifact.name} (${artifact.source ?? "reused"})${
      artifact.readability ? ` · ${artifact.readability.detail}` : ""
    }`,
    evidence: {
      ...artifactEvidence(artifact),
      source: artifact.source ?? null,
      ...(artifact.readability ? { atsReadability: artifact.readability } : {}),
    },
  });

  // A cover letter is a nice-to-have: if writing it fails, the application still proceeds.
  const coverLetter = await resolveCoverLetter(context);
  context.assertActive();
  if (coverLetter.outcome === "written") {
    await meter.recordTurn({ phase: "cover_letter", sessionKey: COVER_LETTER_SESSION_KEY });
    if (coverLetter.review?.reviewed) {
      await meter.recordTurn({ phase: "document_review", sessionKey: DOCUMENT_REVIEW_SESSION_KEY });
    }
  }
  jobHunts.recordAttempt(job.id, {
    phase: "preparing_cv",
    outcome: coverLetter.outcome,
    detail: coverLetter.detail,
    evidence: coverLetter.evidence,
  });

  saveApplicationPhase(context, {
    status: "opening_form",
    summary: `Opening the ${adapter.label} application form.`,
    currentUrl: current?.currentUrl ?? job.url,
    tailoredCvName: artifact.name,
    tailoredCvContent: artifact.content,
    artifact: artifactEvidence(artifact),
    coverLetter: coverLetter.evidence,
  });
  // A URL already claimed by another application's checkpoint is stale ownership, not a
  // legitimate ATS redirect. Resume from the listing instead of reopening the wrong form.
  const otherApplicationUrls = jobHunts
    .listApplications()
    .filter((entry) => entry.jobId !== job.id && entry.currentUrl)
    .map((entry) => entry.currentUrl);
  const applicationStartUrl = selectApplicationStartUrl({
    jobUrl: job.url,
    currentUrl: current?.currentUrl,
    resume,
    otherApplicationUrls,
  });
  const ownedTab = await openApplicationTab(browserControl, {
    url: applicationStartUrl,
    label: `hunting-${job.id}`,
    existingTargetId: resume ? current?.browserTargetId : null,
  });
  context.assertActive();
  if (!ownedTab.ok) {
    jobHunts.recordAttempt(job.id, {
      phase: "opening_form",
      outcome: "failed",
      reasonCode: "application_tab_open_failed",
      detail: ownedTab.error,
      evidence: { requestedUrl: applicationStartUrl },
    });
    return saveApplicationPhase(context, {
      status: "needs_human_action",
      reasonCode: "application_tab_open_failed",
      summary: `The controlled browser could not open the application tab: ${ownedTab.error}`,
      currentUrl: current?.currentUrl ?? job.url,
      manualAction: `Open ${job.url} in Screens -> Control, then resume with J.A.R.V.I.S.`,
      manualActionKind: "review",
      tailoredCvName: artifact.name,
    });
  }
  // The original listing is our baseline. An Apply click may open a single employer tab; the
  // BFF adopts that new page deterministically instead of asking the user for its target id.
  // Fewer stale tabs, fewer ways for the wrong one to be picked.
  const prunedTabs = await pruneFinishedApplicationTabs({ browserControl, keepJobId: job.id });
  if (prunedTabs.length) {
    jobHunts.recordAttempt(job.id, {
      phase: "opening_form",
      outcome: "pruned_finished_tabs",
      detail: `Closed ${prunedTabs.length} tab(s) left by finished applications.`,
      evidence: { closedTargetIds: prunedTabs },
    });
  }
  const tabBaseline = await browserControl.tabs();
  const knownTargetIds = tabBaseline.ok
    ? (tabBaseline.payload?.tabs ?? []).filter((tab) => tab.type === "page").map((tab) => tab.targetId)
    : [ownedTab.targetId];
  // Every other application's form, so a tab left open by an earlier run can never be adopted as
  // this one. Without this, a stale Greenhouse tab was filled with this job's answers while the
  // listing tab sat untouched — the run reported progress on the wrong company's application.
  let opened = await jobApplications.openForm({
    job,
    adapter,
    ownedTab,
    resume,
    guidance: context.guidance,
    siteHistory: describeStrategyForPrompt({ host, strategy }),
    consent: context.consentPrompt,
    attachments: context.guidanceAttachments,
  });
  context.assertActive();
  await meter.recordTurn({ phase: "opening_form", sessionKey: context.sessionKey });
  jobHunts.recordAttempt(job.id, {
    phase: "opening_form",
    outcome: opened.status,
    reasonCode: opened.humanActionKind,
    detail: opened.notes,
    evidence: {
      targetId: ownedTab.targetId,
      currentUrl: opened.currentUrl,
      cvRequired: opened.cvRequired,
      cvAttached: opened.cvAttached,
      uploadInputRef: opened.uploadInputRef,
      uploadControlRef: opened.uploadControlRef,
    },
  });
  // Resolve the BFF-owned tab before accepting an opening-model failure. LinkedIn and Indeed
  // frequently open the employer form in a popup the model cannot inspect from its old tab.
  // Wait for the employer tab when the model reported no form: that is the exact shape of an
  // external apply mid-handoff, and the tracking redirect can outlast the model's turn.
  const tab = await resolveTabTarget(browserControl, {
    targetId: ownedTab.targetId,
    url: opened.currentUrl ?? job.url,
    knownTargetIds,
    waitForNewTabMs: opened.status === "form_open" ? 0 : 8_000,
    // Fail closed: an unreadable baseline cannot distinguish a tab this click opened from a
    // leftover one, so nothing is adopted rather than the wrong form being adopted confidently.
    canAdopt: tabBaseline.ok,
    excludeUrls: otherApplicationUrls,
  });
  context.assertActive();
  if (!tab.ok) {
    return saveApplicationPhase(context, {
      status: "needs_human_action",
      reasonCode: "application_tab_missing",
      summary: `The application tab could not be located: ${tab.error}`,
      currentUrl: opened.currentUrl ?? job.url,
      manualAction: `Open ${job.url} in Screens → Control, then resume with J.A.R.V.I.S.`,
      manualActionKind: "review",
      tailoredCvName: artifact.name,
    });
  }

  const page = await browserControl.snapshot({ targetId: tab.targetId, maxChars: 8_000 });
  context.assertActive();
  if (!page.ok || typeof page.payload?.snapshot !== "string") {
    return saveApplicationPhase(context, {
      status: "needs_human_action",
      reasonCode: "application_page_unverified",
      summary: `The application page could not be inspected: ${page.error ?? "browser snapshot unavailable"}`,
      currentUrl: opened.currentUrl ?? job.url,
      browserTargetId: tab.targetId,
      manualAction: "Open the application in Screens → Control and confirm the form is visible, then resume with J.A.R.V.I.S.",
      manualActionKind: "verification",
      tailoredCvName: artifact.name,
    });
  }
  const pageUrl = page.ok ? (page.payload?.url ?? opened.currentUrl) : opened.currentUrl;
  const formAdapter = resolveSiteAdapter(pageUrl ?? job.url);
  const sourceHost = siteHost(job.url);
  const formHost = siteHost(pageUrl);
  context.activeHost = formHost || host;
  // The source-site permission was prepared before the form opened. Once a redirect is known,
  // rebuild it for the host that actually owns the declarations and controls.
  context.consentGates = jobHunts.listSiteConsents(formHost).map((entry) => entry.gate);
  context.consentPrompt = describeConsentForPrompt({ host: formHost, gates: context.consentGates });
  const formPlaybook = formHost === host ? playbook : memories.findManaged("shared_lesson", playbookKey(formHost));
  const formStrategy =
    formHost === host
      ? strategy
      : resolveSiteStrategy({
          host: formHost,
          playbookBody: formPlaybook?.body ?? "",
          configured: {
            automationPolicy: resolveAutomationPolicy(pageUrl),
            autoSubmit: isAutoSubmitHost(formHost, autoSubmitHosts()),
          },
        });
  context.activeStrategy = formStrategy;
  if (formHost && formHost !== sourceHost) {
    jobHunts.recordAttempt(job.id, {
      phase: "opening_form",
      outcome: "redirect_followed",
      reasonCode: "external_application_form",
      detail: `Followed the server-owned application tab from ${sourceHost} to ${formHost}.`,
      evidence: { sourceHost, destinationHost: formHost, targetId: tab.targetId, createdNewTab: tab.redirected === true },
    });
  }
  if (opened.status !== "form_open" && tab.redirected) {
    // A new server-owned page is concrete evidence that Apply navigated away from the
    // aggregator. Continue from a fresh form snapshot rather than turning a popup into a
    // user-facing target-id request; the normal checkpoint and field verification still run.
    opened = {
      ...opened,
      status: "form_open",
      currentUrl: pageUrl ?? opened.currentUrl,
      cvRequired: true,
      cvAttached: false,
      humanActionKind: null,
      humanAction: null,
      notes: `Following the employer-hosted application form on ${formHost || "the redirected site"}.`,
    };
    jobHunts.recordAttempt(job.id, {
      phase: "opening_form",
      outcome: "redirect_recovered",
      reasonCode: "model_could_not_see_new_tab",
      detail: "The server adopted the newly opened employer tab after the opening model remained on the listing.",
      evidence: { targetId: tab.targetId, currentUrl: pageUrl },
    });
  }
  const checkpoint = detectHumanCheckpoint({
    url: pageUrl,
    text: page.ok ? String(page.payload?.snapshot ?? "") : "",
    adapter: formAdapter,
  });
  if (checkpoint) {
    jobHunts.recordAttempt(job.id, {
      phase: "opening_form",
      outcome: "human_checkpoint",
      reasonCode: checkpoint.kind,
      detail: checkpoint.detail,
      evidence: { targetId: tab.targetId, currentUrl: pageUrl },
    });
    return saveApplicationPhase(context, {
      status: "needs_human_action",
      reasonCode: `checkpoint_${checkpoint.kind}`,
      summary: checkpoint.detail,
      currentUrl: pageUrl,
      browserTargetId: tab.targetId,
      manualAction: manualActionForCheckpoint(checkpoint, formAdapter),
      manualActionKind: checkpoint.kind,
      tailoredCvName: artifact.name,
    });
  }
  if (opened.status !== "form_open") {
    return saveApplicationPhase(context, {
      status: opened.status === "failed" ? "failed" : "needs_human_action",
      reasonCode: `open_form_${opened.humanActionKind ?? opened.status}`,
      summary: opened.notes,
      currentUrl: opened.currentUrl ?? pageUrl ?? job.url,
      browserTargetId: tab.targetId,
      manualAction:
        opened.humanAction ?? "Open the application form in Screens → Control, then resume with J.A.R.V.I.S.",
      manualActionKind: opened.humanActionKind ?? "review",
      tailoredCvName: artifact.name,
    });
  }

  let upload = { outcome: "not_required", evidence: {}, attempts: 0, detail: "This form asks for no CV." };
  if (opened.cvRequired) {
    saveApplicationPhase(context, {
      status: "uploading_cv",
      summary: `Attaching ${artifact.name}.`,
      currentUrl: pageUrl,
      browserTargetId: tab.targetId,
      tailoredCvName: artifact.name,
    });
    upload = await applicationUploads.attach({
      targetId: tab.targetId,
      artifact,
      adapter: formAdapter,
      inputRef: opened.uploadInputRef,
      chooserRef: opened.uploadControlRef,
    });
    context.assertActive();
    jobHunts.recordAttempt(job.id, {
      phase: "uploading_cv",
      outcome: upload.outcome,
      reasonCode: upload.reasonCode,
      detail: upload.detail,
      evidence: { ...upload.evidence, attempts: upload.attempts },
    });
    const continueWithEmbeddedAttachment = canContinueAfterEmbeddedUpload({
      resume,
      observedAttached: opened.cvAttached,
      upload,
    });
    // A three-step form does not show its CV field on step 1. The page was readable and simply
    // had no file input yet, so this is "not reached", not "not available": the fill phase walks
    // the steps and the post-fill repair attaches the CV once the field exists. Nothing is lost
    // by continuing, because the final assessment refuses to call a form ready without the CV.
    const cvFieldNotReachedYet =
      upload.outcome === "input_not_found" && upload.reasonCode === "no_file_input_on_page";
    if (cvFieldNotReachedYet) {
      jobHunts.recordAttempt(job.id, {
        phase: "uploading_cv",
        outcome: "deferred_to_later_step",
        reasonCode: upload.reasonCode,
        detail: "No file input on this step; the CV is attached after the form's later steps are reached.",
        evidence: { ...upload.evidence, currentUrl: pageUrl },
      });
    }
    if (upload.outcome !== "uploaded" && !continueWithEmbeddedAttachment && !cvFieldNotReachedYet) {
      return saveApplicationPhase(context, {
        status: "needs_human_action",
        reasonCode: `upload_${upload.reasonCode ?? upload.outcome}`,
        summary: `The prepared CV was not attached (${upload.outcome}).`,
        currentUrl: pageUrl,
        browserTargetId: tab.targetId,
        tailoredCvName: artifact.name,
        uploadOutcome: upload.outcome,
        uploadAttempts: upload.attempts,
        uploadEvidence: upload.evidence,
        manualAction: manualActionForUpload(upload, artifact),
        manualActionKind: upload.outcome === "tool_unavailable" ? "review" : "upload",
      });
    }
    if (continueWithEmbeddedAttachment) {
      jobHunts.recordAttempt(job.id, {
        phase: "uploading_cv",
        outcome: "embedded_attachment_unverified",
        reasonCode: upload.reasonCode,
        detail: "Continuing because the fresh form inspection reports the system-attached CV, although its embedded control cannot be re-read.",
        evidence: { ...upload.evidence, observedAttached: opened.cvAttached },
      });
    }
  }

  // Some employers reject automated submissions outright (an Ashby form answered "flagged as
  // possible spam"). The answer is to stop automating the typing for that host, not to disguise
  // it: everything is prepared and attached, and the user completes the form in the mirror.
  if (formStrategy.automationPolicy === "prepare_only") {
    jobHunts.recordAttempt(job.id, {
      phase: "filling_verified_fields",
      outcome: "prepare_only",
      reasonCode: "host_rejects_automated_entry",
      detail: "Form prepared; field entry left to the user for this employer.",
      evidence: { targetId: tab.targetId, currentUrl: pageUrl, uploadOutcome: upload.outcome },
    });
    return saveApplicationPhase(context, {
      status: "needs_human_action",
      reasonCode: "prepare_only_host",
      summary: `${artifact.name} is attached and the form is open. This employer rejects automated form entry, so the answers are yours to enter.`,
      currentUrl: pageUrl,
      browserTargetId: tab.targetId,
      tailoredCvName: artifact.name,
      coverLetter: coverLetter.evidence,
      uploadOutcome: upload.outcome,
      uploadAttempts: upload.attempts,
      uploadVerifiedAt: upload.outcome === "uploaded" ? (upload.evidence.verifiedAt ?? new Date().toISOString()) : null,
      uploadEvidence: upload.evidence,
      manualAction:
        "Open the browser takeover, fill the remaining answers yourself, and submit. Your verified answers and the cover letter are on the checkpoint to copy from.",
      manualActionKind: "review",
    });
  }

  saveApplicationPhase(context, {
    status: "filling_verified_fields",
    summary: opened.cvRequired ? `${artifact.name} is attached; filling supported fields.` : "Filling supported fields.",
    currentUrl: pageUrl,
    browserTargetId: tab.targetId,
    tailoredCvName: artifact.name,
    uploadOutcome: upload.outcome,
    uploadAttempts: upload.attempts,
    uploadVerifiedAt: upload.outcome === "uploaded" ? (upload.evidence.verifiedAt ?? new Date().toISOString()) : null,
    uploadEvidence: upload.evidence,
  });
  const fillRequest = {
    job,
    cv: artifact.content,
    identityMemory: context.identityMemory,
    applicationMemory: context.applicationMemory,
    relatedMemories: context.relatedPersonalMemories,
    adapter: formAdapter,
    targetId: tab.targetId,
    uploadSummary: describeUploadForPrompt({
      outcome: upload.outcome,
      evidence: upload.evidence,
      cvRequired: opened.cvRequired,
    }),
    coverLetter: coverLetter.letter,
    guidance: context.guidance,
    consent: context.consentPrompt,
    attachments: context.guidanceAttachments,
  };
  let filled = await jobApplications.fillFields(fillRequest);
  context.assertActive();

  await meter.recordTurn({ phase: "filling_verified_fields", sessionKey: context.sessionKey });

  // A transient widget failure is not a missing fact. When the first pass itself says verified
  // memory contains the answer, give that answer one bounded automatic retry before involving
  // the user. Unknown or materially different questions are deliberately excluded.
  const memoryRetryFields = collectMemoryRetryFields(filled);
  if (memoryRetryFields.length) {
    jobHunts.recordAttempt(job.id, {
      phase: "filling_verified_fields",
      outcome: "memory_retry",
      reasonCode: "verified_answer_not_committed",
      detail: `Retrying ${memoryRetryFields.length} field(s) already answered by approved memory.`,
      evidence: { fields: memoryRetryFields, targetId: tab.targetId },
    });
    filled = await jobApplications.fillFields({ ...fillRequest, memoryRetryFields });
    context.assertActive();
    await meter.recordTurn({ phase: "filling_verified_fields_memory_retry", sessionKey: context.sessionKey });
  }

  // Judge completion against the live form, not the model's account of it. A searchable
  // dropdown that was typed into but never committed reads as answered to the model and as
  // empty to the employer; only the page can settle that.
  const outcome = await judgeFilledForm({
    targetId: tab.targetId,
    filled,
    adapter: formAdapter,
    cvArtifact: artifact,
    coverLetter: coverLetter.letter ? { name: coverLetter.evidence.name, letter: coverLetter.letter } : null,
    cvOutstanding: opened.cvRequired === true && upload.outcome !== "uploaded",
  });
  context.assertActive();
  const guardedOutcome =
    outcome.status === "ready_for_review" && upload.outcome === "input_not_found"
      ? {
          ...outcome,
          status: "needs_human_action",
          reasonCode: "cv_upload_unverified",
          summary: `${outcome.summary} The embedded CV control cannot be verified automatically.`,
          manualAction: "Confirm the CV remains attached, review the filled answers, and submit the application yourself.",
          manualActionKind: "review",
        }
      : outcome;
  jobHunts.recordAttempt(job.id, {
    phase: "filling_verified_fields",
    outcome: guardedOutcome.status,
    reasonCode: guardedOutcome.reasonCode,
    detail: guardedOutcome.summary,
    evidence: {
      targetId: tab.targetId,
      currentUrl: filled.currentUrl,
      reportedStatus: filled.status,
      filledFields: guardedOutcome.filledFields,
      droppedClaims: guardedOutcome.droppedClaims,
      unresolvedFields: guardedOutcome.unresolvedFields,
      skippedFields: guardedOutcome.skippedFields,
      attachments: guardedOutcome.attachments ?? null,
      formCounts: guardedOutcome.formCounts,
    },
  });
  const submitted = await maybeAutoSubmit({
    context,
    outcome: guardedOutcome,
    uploadOutcome: upload.outcome,
    targetId: tab.targetId,
    adapter: formAdapter,
    currentUrl: pageUrl,
  });
  if (submitted) return submitted;

  return saveApplicationPhase(context, {
    status: guardedOutcome.status,
    reasonCode: guardedOutcome.reasonCode,
    summary: guardedOutcome.summary,
    currentUrl: filled.currentUrl ?? pageUrl,
    browserTargetId: tab.targetId,
    filledFields: guardedOutcome.filledFields,
    unresolvedFields: guardedOutcome.unresolvedFields,
    skippedFields: guardedOutcome.skippedFields,
    manualAction: guardedOutcome.manualAction,
    manualActionKind: guardedOutcome.manualActionKind,
    tailoredCvName: artifact.name,
    coverLetter: coverLetter.evidence,
    uploadOutcome: upload.outcome,
    uploadAttempts: upload.attempts,
    uploadVerifiedAt: upload.outcome === "uploaded" ? (upload.evidence.verifiedAt ?? new Date().toISOString()) : null,
    uploadEvidence: upload.evidence,
    usedMemoryIds: filled.usedMemoryIds.length
      ? filled.usedMemoryIds
      : [context.identityMemory.id, context.applicationMemory.id],
  });
}

/** A user correction becomes shared procedural memory only after live-page verification succeeds. */
async function rememberSuccessfulApplicationGuidance(context, application) {
  if (!context.guidance || application?.status !== "ready_for_review") return;
  const lesson = buildApplicationGuidanceLesson({
    guidance: context.guidance,
    checkpoint: context.guidanceCheckpoint,
    adapter: context.adapter,
  });
  if (!lesson) {
    jobHunts.recordAttempt(context.job.id, {
      phase: "guidance",
      outcome: "not_saved",
      reasonCode: "sensitive_or_empty",
      detail: "The retry guidance was used transiently but was not safe to store as memory.",
    });
    return;
  }
  try {
    const memory = await managedMemories.upsert(lesson, "main");
    jobHunts.recordAttempt(context.job.id, {
      phase: "guidance",
      outcome: "learned",
      reasonCode: context.guidanceCheckpoint?.reasonCode,
      detail: `Saved proven recovery as Shared Lesson: ${memory.title}`,
      evidence: { memoryId: memory.id, managedKey: memory.managedKey },
    });
  } catch (error) {
    console.warn(`[jarvis-bff] could not save application guidance: ${error.message}`);
    jobHunts.recordAttempt(context.job.id, {
      phase: "guidance",
      outcome: "memory_failed",
      reasonCode: "memory_unavailable",
      detail: "The guided retry succeeded, but its Shared Lesson could not be saved.",
    });
  }
}

/**
 * Decide the checkpoint from what the form holds.
 *
 * Required and empty blocks review. Optional and empty is skipped, because stopping a whole
 * application over an optional cover note wastes the user's time. A claimed answer the page
 * cannot show is dropped rather than believed.
 */
async function judgeFilledForm({ targetId, filled, adapter, cvArtifact, coverLetter, cvOutstanding = false }) {
  const modelAction = filled.humanActionKind;
  if (filled.status === "failed") {
    return {
      status: "failed",
      reasonCode: "fields_failed",
      summary: filled.summary,
      filledFields: filled.filledFields,
      unresolvedFields: filled.unresolvedFields,
      skippedFields: filled.skippedFields,
      droppedClaims: [],
      formCounts: null,
      manualAction: filled.humanAction ?? "Review the form, then retry the application.",
      manualActionKind: modelAction ?? "review",
    };
  }

  // Real Chrome can still be navigating; an unsettled page reads as a form with no fields.
  await waitForPageReady(browserControl, { targetId });
  const formState = await readFormState({ browser: browserControl, targetId });
  if (!formState.available) {
    // A model claim is not proof. If live state cannot be read, readiness must fail closed.
    return {
      status: "needs_human_action",
      reasonCode: "fields_unverified",
      summary: `${filled.summary} (the form could not be re-read: ${formState.error})`,
      filledFields: [],
      unresolvedFields: filled.unresolvedFields,
      skippedFields: filled.skippedFields,
      droppedClaims: filled.filledFields.map((entry) => ({
        field: entry.field,
        reason: "live form state was unavailable",
      })),
      formCounts: null,
      manualAction: "Check every answer on the form yourself before submitting, then resume so J.A.R.V.I.S. can verify the retained state.",
      manualActionKind: "verification",
    };
  }

  // File fields get one deterministic repair pass before anything is called incomplete: a CV
  // field emptied by the form re-rendering, and a cover letter field that only takes a file.
  const repair = await repairAttachments({
    uploads: applicationUploads,
    targetId,
    adapter,
    formState,
    cvArtifact,
    coverLetter,
    stagingDir: APPLICATION_UPLOAD_DIR,
  });
  const finalState = repair.changed ? await readFormState({ browser: browserControl, targetId }) : formState;
  if (!finalState.available) {
    return {
      status: "needs_human_action",
      reasonCode: "fields_unverified_after_attachment_repair",
      summary: `Attachments changed, but the form could not be re-read: ${finalState.error}`,
      filledFields: [],
      unresolvedFields: filled.unresolvedFields,
      skippedFields: filled.skippedFields,
      droppedClaims: filled.filledFields.map((entry) => ({
        field: entry.field,
        reason: "live form state was unavailable after attachment repair",
      })),
      attachments: repair,
      formCounts: null,
      manualAction: "Review every answer and attachment yourself, then resume for verification.",
      manualActionKind: "verification",
    };
  }

  const assessment = assessFormCompletion({
    fields: finalState.fields,
    claimedFields: filled.filledFields,
  });
  // A CV deferred to a later step must still arrive. If the repair pass could not attach it —
  // including when the field never appeared at all — say so here rather than let an unattached
  // CV pass as ready because the form no longer shows the field.
  const cvStillMissing =
    cvOutstanding && repair.cv?.outcome !== "uploaded"
      ? [{ field: "CV", reason: "the prepared CV is still not attached to this form", required: true }]
      : [];
  const unresolvedFields = mergeFieldNotes(
    filled.unresolvedFields.filter((entry) => entry.required !== false),
    cvStillMissing,
    assessment.blockingFields,
    assessment.unverifiedClaims.map((claim) => ({ ...claim, required: true })),
  );
  const skippedFields = mergeFieldNotes(filled.skippedFields, assessment.skippedOptional).slice(0, 20);

  // A human step the model reported (sign-in, challenge, a question only the user can answer)
  // outranks field arithmetic.
  if (modelAction && modelAction !== "review") {
    return {
      status: "needs_human_action",
      reasonCode: `fields_${modelAction}`,
      summary: filled.summary,
      filledFields: assessment.verifiedFields,
      unresolvedFields,
      skippedFields,
      droppedClaims: assessment.unverifiedClaims,
      attachments: repair,
      formCounts: assessment.counts,
      manualAction: filled.humanAction ?? "Finish the step the form is asking for, then resume.",
      manualActionKind: modelAction,
    };
  }
  if (unresolvedFields.length) {
    const names = unresolvedFields.slice(0, 3).map((entry) => entry.field).join(", ");
    return {
      status: "needs_human_action",
      reasonCode: "fields_incomplete",
      summary: `${assessment.verifiedFields.length} of ${assessment.counts.required} required fields are answered; ${unresolvedFields.length} still need you.`,
      filledFields: assessment.verifiedFields,
      unresolvedFields,
      skippedFields,
      droppedClaims: assessment.unverifiedClaims,
      attachments: repair,
      formCounts: assessment.counts,
      manualAction: `Answer these on the form, then resume: ${names}${unresolvedFields.length > 3 ? "…" : ""}`,
      manualActionKind: "answer_question",
    };
  }
  return {
    status: "ready_for_review",
    reasonCode: "fields_verified",
    summary: `Every required field is answered${skippedFields.length ? `; ${skippedFields.length} optional field(s) left blank` : ""}.`,
    filledFields: assessment.verifiedFields,
    unresolvedFields,
    skippedFields,
    droppedClaims: assessment.unverifiedClaims,
    attachments: repair,
    formCounts: assessment.counts,
    manualAction: "Review every answer, then submit the application yourself.",
    manualActionKind: "review",
  };
}

function mergeFieldNotes(...lists) {
  const merged = new Map();
  for (const entry of lists.flat()) {
    const key = String(entry.field ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || merged.has(key)) continue;
    merged.set(key, entry);
  }
  return [...merged.values()].slice(0, 40);
}

/**
 * Attach what the application cost once every turn has run. Measured centrally rather than at
 * each exit so a run that stops early is still accounted for, and never fatal: losing the
 * meter reading must not lose the checkpoint.
 */
async function recordApplicationUsage(context, application) {
  if (!context.meter || !application) return application;
  try {
    context.assertActive?.();
    const usage = await context.meter.finish();
    context.assertActive?.();
    jobHunts.recordAttempt(context.job.id, {
      phase: "usage",
      outcome: "measured",
      reasonCode: usage.authType,
      detail: `${usage.tokens.total} tokens over ${usage.turns.length} turn(s)`,
      evidence: usage,
    });
    const updated = jobHunts.saveApplication(context.job.id, { ...application, usage });
    broadcast("hunting.applications.changed", { jobId: context.job.id, status: updated.status });
    await recordSitePlaybook(context, updated);
    return updated;
  } catch (err) {
    if (err?.code === "application_cancelled") throw err;
    return application;
  }
}

/**
 * Teach the site's playbook what this run learned.
 *
 * One memory node per website, so a lesson lands where it applies again: a sign-in wall belongs
 * to that host, not to the job. Lessons come from the attempt records, never from free
 * invention, and never include what was typed into a field. Failing to write it must not fail
 * the application.
 */
async function recordSitePlaybook(context, application) {
  const host = context.activeHost ?? siteHost(context.job.url);
  if (!host) return;
  try {
    const lessons = deriveLessons({
      adapter: context.adapter,
      host,
      attempts: jobHunts.listAttempts(context.job.id),
      application,
    });
    // A standing acceptance belongs in the site's note too — it is the reason a later run walks
    // past a step that used to stop. The note is a record of the permission, never its source.
    for (const gate of context.consentGates ?? []) {
      lessons.push({ section: "works", key: `consent_${gate}`, text: describeConsentForPlaybook({ host, gate }) });
    }
    if (!lessons.length) return;
    const managedKey = playbookKey(host);
    // Shared lesson, not project: this is procedural memory, and the shared-lesson surface is
    // what future runs and other agents actually retrieve.
    const existing = memories.findManaged("shared_lesson", managedKey);
    await managedMemories.upsert({
      memoryType: "shared_lesson",
      managedKey,
      title: playbookTitle(host),
      body: mergePlaybook({ host, existingBody: existing?.body ?? "", lessons }),
      tags: playbookTags(host),
    });
    broadcast("memory.changed", { version: memories.version, count: memories.list().length });
  } catch {
    // A playbook that could not be written is not a reason to fail a finished application.
  }
}

/**
 * Submit the application when the user has opted this host in and every check already passed.
 *
 * Returns the saved checkpoint when it acted, or null to leave the normal review path alone.
 * A submission is irreversible, so the blocker list is evaluated against the assessment that
 * was actually made, and a click is never retried.
 */
async function maybeAutoSubmit({ context, outcome, uploadOutcome, targetId, adapter, currentUrl }) {
  const host = siteHost(currentUrl ?? outcome.currentUrl ?? context.job.url);
  const strategy = context.activeStrategy ?? context.strategy;
  const explicitlyApproved = context.submitApproval?.source === "guidance";
  const candidate = {
    status: outcome.status,
    uploadOutcome: uploadOutcome ?? context.current?.uploadOutcome,
    unresolvedFields: outcome.unresolvedFields,
  };
  const blockers = submitBlockers({
    application: candidate,
    assessment: { blockingFields: outcome.unresolvedFields.filter((field) => field.required !== false) },
    automationPolicy: strategy?.automationPolicy ?? resolveAutomationPolicy(currentUrl ?? context.job.url),
    host,
    // Memory can withdraw auto-submit for a site, never grant it.
    // A direct instruction skips only the host ramp for this run. It does not become site
    // consent, and prepare-only, upload, required-field, and live-form blockers still apply.
    hosts: explicitlyApproved ? ["*"] : strategy?.autoSubmit === false ? [] : autoSubmitHosts(),
    // Every host is eligible, but only after one application there finished cleanly. The current
    // job is excluded so a resumed run cannot count itself as its own proof.
    provenHosts:
      explicitlyApproved || strategy?.autoSubmit === false
        ? []
        : jobHunts.hostsWithVerifiedRun({ excludeJobId: context.job.id }),
  });
  if (blockers.length) {
    // Silent unless the host was opted in: otherwise every application would log a refusal.
    if (
      (explicitlyApproved || autoSubmitHosts().length) &&
      blockers[0] &&
      !blockers[0].startsWith("auto-submit is not enabled")
    ) {
      jobHunts.recordAttempt(context.job.id, {
        phase: "submitted",
        outcome: "not_attempted",
        reasonCode: "blocked",
        detail: blockers.join("; "),
      });
    }
    return null;
  }

  const result = await applicationSubmits.submit({ targetId, adapter });
  jobHunts.recordAttempt(context.job.id, {
    phase: "submitted",
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    detail: result.detail,
    evidence: {
      ...result.evidence,
      initiatedBy: explicitlyApproved ? "explicit_submit_instruction" : "host_auto_submit",
    },
  });
  if (result.outcome !== "submitted") {
    return saveApplicationPhase(context, {
      status: "needs_human_action",
      reasonCode: `${explicitlyApproved ? "user_submit" : "auto_submit"}_${result.reasonCode ?? result.outcome}`,
      summary: `J.A.R.V.I.S. stopped after one submit attempt: ${result.detail}`,
      currentUrl: result.evidence?.url ?? outcome.currentUrl,
      browserTargetId: targetId,
      filledFields: outcome.filledFields,
      unresolvedFields: outcome.unresolvedFields,
      skippedFields: outcome.skippedFields,
      uploadOutcome: outcome.uploadOutcome,
      manualAction:
        result.outcome === "rejected"
          ? "The employer rejected the submission. Review it yourself before trying again; J.A.R.V.I.S. will not resubmit."
          : "Check the form and submit it yourself; J.A.R.V.I.S. clicked submit once and could not confirm the result.",
      manualActionKind: "review",
    });
  }
  return saveApplicationPhase(context, {
    status: "submitted",
    reasonCode: explicitlyApproved ? "user_requested_ai_submit" : "auto_submitted",
    summary: result.detail,
    currentUrl: result.evidence?.url ?? outcome.currentUrl,
    browserTargetId: targetId,
    filledFields: outcome.filledFields,
    unresolvedFields: outcome.unresolvedFields,
    skippedFields: outcome.skippedFields,
    uploadOutcome: outcome.uploadOutcome,
    manualAction: null,
    manualActionKind: null,
  });
}

function saveApplicationPhase(context, input) {
  context.assertActive?.();
  const application = jobHunts.saveApplication(context.job.id, {
    sessionKey: context.sessionKey,
    usedMemoryIds: [context.identityMemory.id, context.applicationMemory.id],
    ...input,
  });
  broadcast("hunting.applications.changed", { jobId: context.job.id, status: application.status });
  return application;
}

/** Reuse the staged PDF on resume; regenerating it would diverge from the attached file. */
async function resolveApplicationArtifact({ cv, current, resume }) {
  if (resume && current?.tailoredCvContent) {
    const staged = describeStagedArtifact({ dir: APPLICATION_UPLOAD_DIR, name: current.tailoredCvName });
    if (staged) return { ...staged, content: current.tailoredCvContent, reused: true };
  }
  return { ...(await prepareApplicationCv(cv)), reused: false };
}

/** Reuse the saved letter on resume; write a fresh one otherwise. Never blocks the run. */
async function resolveCoverLetter({ job, cv, current, resume, identityMemory, applicationMemory }) {
  if (resume) {
    const saved = coverLetters.read({ name: current?.coverLetter?.name });
    if (saved) {
      return { outcome: "reused", detail: saved.name, letter: saved.letter, evidence: current.coverLetter };
    }
  }
  try {
    const written = await coverLetters.generate({ job, cv: cv.content, identityMemory, applicationMemory });
    // A second reader before it goes out: it may improve the letter, and it may only *report* on
    // the CV, which the user sends unchanged to every employer.
    const review = await documentReview.review({
      job,
      cv: cv.content,
      letter: written.letter,
      identityMemory,
      applicationMemory,
    });
    if (review.letterRewritten) coverLetters.save({ job, letter: review.letter, memoryIds: [identityMemory.id, applicationMemory.id] });
    return {
      outcome: "written",
      detail: `${written.name} (${written.words} words)`,
      letter: review.letter,
      review,
      evidence: {
        name: written.name,
        hostPath: written.hostPath,
        words: written.words,
        sha256: written.sha256,
        bytes: written.bytes,
        // Provenance lives here rather than inside the letter, which is the user's own document.
        groundedIn: written.groundedIn,
        // What the second reader found: CV gaps are advice for the user, letter issues are fixed.
        ...(review.reviewed
          ? { review: { cvGaps: review.cvGaps, letterIssues: review.letterIssues, letterRewritten: review.letterRewritten } }
          : {}),
        createdAt: written.createdAt,
      },
    };
  } catch (err) {
    return {
      outcome: "failed",
      detail: String(err?.message ?? err).slice(0, 300),
      letter: null,
      evidence: {},
    };
  }
}

function artifactEvidence(artifact) {
  return {
    name: artifact.name,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    browserRef: artifact.browserRef,
    hostPath: artifact.hostPath,
    createdAt: artifact.createdAt,
  };
}

function manualActionForCheckpoint(checkpoint, adapter) {
  if (checkpoint.kind === "sign_in") {
    return `Take over in Screens → Control and sign in to ${adapter.label} yourself, then resume with J.A.R.V.I.S. J.A.R.V.I.S. never enters credentials.`;
  }
  if (checkpoint.kind === "captcha") {
    return `Take over in Screens → Control and clear the ${adapter.label} verification yourself, then resume with J.A.R.V.I.S.`;
  }
  return `${checkpoint.detail} Take over in Screens → Control, then resume with J.A.R.V.I.S.`;
}

function manualActionForUpload(upload, artifact) {
  if (upload.outcome === "artifact_unavailable") {
    // The browser names the root it will accept; quoting it turns a config mismatch into a
    // one-line fix, which matters when the browser moves between hosts.
    const expected = expectedUploadRoot(upload.detail);
    const remedy = expected
      ? `That browser accepts uploads from ${expected}; set JARVIS_APPLICATION_UPLOAD_DIR to it and retry`
      : "stage it inside the browser's inbound media directory, or attach it manually";
    return `The browser host cannot read the prepared CV. It is staged at ${artifact.hostPath} and was offered as ${artifact.browserRef}. ${remedy}, then resume.`;
  }
  if (upload.outcome === "tool_unavailable") {
    return `The OpenClaw browser did not answer the upload call (${upload.detail ?? "no detail"}). Check the browser plugin, then retry this application.`;
  }
  if (upload.outcome === "input_not_found") {
    return `Open the CV upload control on the form and attach ${artifact.hostPath} yourself (an embedded frame cannot be reached automatically), then resume with J.A.R.V.I.S.`;
  }
  return `Attach ${artifact.hostPath} through the form's upload control and confirm the filename appears on the page, then resume with J.A.R.V.I.S.`;
}

/** Pull the directory out of "must stay within inbound media directory (/path)". */
function expectedUploadRoot(detail) {
  return /inbound media directory \(([^)]+)\)/.exec(String(detail ?? ""))?.[1] ?? null;
}

async function prepareApplicationCv(cv) {
  // Prefer the exact file the user uploaded. It stops matching only if he edited the CV text
  // afterwards, in which case the canonical text is the truth and gets rendered instead.
  const uploaded = cvs.sourcePdfFor({ content: cv.content });
  const bytes =
    uploaded?.data ??
    (await createCvPdf({ content: cv.content, sourceName: cv.sourceName ?? "Example User CV" }));
  const staged = stageApplicationArtifact({
    dir: APPLICATION_UPLOAD_DIR,
    name: APPLICATION_CV_FILENAME,
    bytes,
  });
  // A PDF with no readable text layer uploads cleanly and scores zero in every ATS. Checked here,
  // once, rather than discovered from silence weeks later.
  const readability = await checkCvReadability({ bytes, expectedText: cv.content });
  return {
    ...staged,
    content: cv.content,
    source: uploaded ? "uploaded-pdf" : "rendered-from-canonical-text",
    readability,
  };
}

function cleanOptionalText(value, limit) {
  const text = typeof value === "string" ? value.trim().slice(0, limit) : "";
  return text || null;
}

function requestIsSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && ALLOWED_ORIGINS.has(parsed.origin);
  } catch {
    return false;
  }
}

function normalizeProviderBInput(body = {}) {
  const destination = String(body.destination ?? "").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .,'&()/-]{0,79}$/u.test(destination)) {
    throw Object.assign(new Error("destination must be a single line of 1-80 characters"), { statusCode: 400 });
  }
  if (!Array.isArray(body.dates) || body.dates.length === 0 || body.dates.length > 120) {
    throw Object.assign(new Error("dates must contain 1-120 ISO dates"), { statusCode: 400 });
  }
  const dates = [...new Set(body.dates.map((value) => String(value)))];
  if (dates.some((value) => !isIsoDate(value))) {
    throw Object.assign(new Error("every date must use YYYY-MM-DD"), { statusCode: 400 });
  }
  const nights = boundedInteger(body.nights ?? 7, "nights", 1, 28);
  const adults = boundedInteger(body.adults ?? 2, "adults", 1, 8);
  const airports = body.airports ?? ["LON"];
  if (!Array.isArray(airports) || airports.length === 0 || airports.length > 10) {
    throw Object.assign(new Error("airports must contain 1-10 codes"), { statusCode: 400 });
  }
  const normalizedAirports = airports.map((value) => String(value).trim().toUpperCase());
  if (normalizedAirports.some((value) => !/^[A-Z0-9]{2,5}$/.test(value))) {
    throw Object.assign(new Error("invalid airport code"), { statusCode: 400 });
  }
  const session = body.session == null || body.session === "" ? null : String(body.session);
  if (session !== null && !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(session)) {
    throw Object.assign(new Error("session must be a safe identifier"), { statusCode: 400 });
  }
  return { destination, dates, nights, adults, airports: normalizedAirports, session };
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function boundedInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${name} must be between ${min} and ${max}`), { statusCode: 400 });
  }
  return parsed;
}

function slug(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "destination";
}

function normalizeSnapshotParams(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    screenIndex: boundedInteger(input.screenIndex ?? 0, "screenIndex", 0, 15),
    maxWidth: boundedInteger(input.maxWidth ?? 2560, "maxWidth", 320, 4096),
    quality: Math.min(1, Math.max(0.1, Number(input.quality) || 0.9)),
    format: input.format === "png" ? "png" : "jpeg",
  };
}

function huntingAccessToken(req) {
  return String(req.get("x-jarvis-hunting-access") ?? "").trim();
}

function memoryAccessToken(req) {
  return String(req.get("x-jarvis-memory-access") ?? "").trim();
}

function appAccessToken(req) {
  const cookies = String(req.get("cookie") ?? "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    const name = cookie.slice(0, separator).trim();
    if (name !== APP_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function shutdown() {
  neuralEngine.stop();
  memories.stop();
  gateway.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
