// Thin client for the BFF REST surface. All calls return the parsed JSON body;
// the BFF wraps gateway responses as { ok, ...payload } or { ok:false, error }.
import type {
  LearnedWorkflow,
  LearningSession,
  ScreenpipeStatus,
  StoredWorkflow,
  WorkflowRun,
} from "./workflow-types";

const BASE = "/api";

export type StoredAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  url: string;
};

export type ExecutionTarget = "mac" | "neutral" | "windows";
export type ExecutionDevice = { name: string; nodeId: string | null; available: boolean };
export type ExecutionTargetState = {
  target: ExecutionTarget;
  devices: { mac: ExecutionDevice; windows: ExecutionDevice };
};
export type AgentModelOption = { id: string; label: string };
export type AgentModels = { agentId: string; current: string | null; models: AgentModelOption[] };
export type AgentAnimationSpec = {
  columns: number;
  rows: number;
  animations: {
    idle: number[];
    walking: number[];
    sitting: number[];
    working: number[];
    dancing: number[];
  };
};
export type GeneratedAgentAppearance = {
  attachment: StoredAttachment;
  provider: string;
  model: string;
  prompt: string;
  animationSpec: AgentAnimationSpec;
};
export type CreateAgentInput = {
  name: string;
  role: string;
  instructions: string;
  model?: string;
  appearanceAttachmentId: string;
  appearancePrompt: string;
  referenceAttachmentIds: string[];
};
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  missingCostEntries: number;
};
export type UsageAttribution = {
  basis: "provider-processed";
  includesCache: true;
  agents: { main: UsageTotals; codex: UsageTotals };
  combined: UsageTotals;
  sessions: Array<{
    key: string;
    agentId: string;
    totals: UsageTotals;
    source: "gateway" | "history" | "codex-desktop";
  }>;
  sources?: { codexGateway: UsageTotals; codexDesktop: UsageTotals };
  codexWeeklyLimit?: {
    usedPercent: number;
    remainingPercent: number;
    windowMinutes: number;
    resetsAt: number | null;
    updatedAt: number;
    planType: string | null;
  } | null;
  pricing: {
    currency: "USD";
    estimated: true;
    verifiedAt: string;
    sources: Array<{ provider: string; url: string }>;
    assumptions: string[];
    pricedModels: string[];
    unpricedModels: string[];
  };
};
export type UsageReport = {
  totals?: Partial<UsageTotals>;
  attribution?: UsageAttribution;
};
export type ExtractionFile = {
  id: string;
  name: string;
  relPath: string;
  day: string | null;
  session: string | null;
  platform: string;
  combined: boolean;
  sizeBytes: number;
  modifiedAt: string;
};
export type ExtractionSource = { root: string; available: boolean };
export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export type CustomExtractor = {
  id: string;
  name: string;
  slug: string;
  description: string;
  sites: string[];
  status: "building" | "ready" | "failed";
  sourceKind: "bundled-folder" | "folder" | "brief" | "brief-and-folder";
  artifactDir: string;
  fileCount: number;
  builderAgentId: "codex";
  runnerAgentId: "black-noir";
  buildDetail: string | null;
  entrypoint: string | null;
  runInstructions: string;
  defaults: { destination?: string; travelStart?: string; travelEnd?: string; nights?: string };
  maxTravelDates: number;
  createdAt: string;
  updatedAt: string;
};
export type CustomExtractorUpload = { path: string; contentBase64: string };
export type ExtractionTask = {
  id: string;
  name: string;
  agentId: string;
  destination: string;
  sites: string[];
  travelStart: string;
  travelEnd: string;
  /** Weekdays that have departures worth searching; empty means every day. */
  departureDays: Weekday[];
  nights: { min: number; max: number };
  /** Weekdays the extraction itself runs on — unrelated to departureDays. */
  weekdays: Weekday[];
  scheduleStart: string;
  scheduleEnd: string;
  status: "active" | "completed" | "cancelled";
  lastRunDay: string | null;
  lastRunAt: string | null;
  lastRunDetail: string | null;
  /** Set while the agent is working on this task; null when idle. */
  runningSince: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  nextRunDay: string | null;
  customExtractorId: string | null;
};
export type ExtractionTaskInput = {
  name?: string;
  agentId: string;
  destination: string;
  sites: string[];
  travelStart: string;
  travelEnd: string;
  departureDays: Weekday[];
  nights: string;
  weekdays: Weekday[];
  scheduleStart: string;
  scheduleEnd: string;
  customExtractorId?: string;
};
export type ExtractionRunStatus = "running" | "paused" | "waiting" | "stalled" | "stopped" | "complete";
export type ExtractionRunCommand = "run" | "pause" | "stop";
/** `anytime` runs to completion; `window` confines work to start–end each day. */
export type ExtractionSchedule = {
  mode: "anytime" | "window";
  start: string | null;
  end: string | null;
};
export type ExtractionRun = {
  id: string;
  session: string;
  platform: string;
  destination: string | null;
  nights: number | null;
  status: ExtractionRunStatus;
  command: ExtractionRunCommand;
  schedule: ExtractionSchedule;
  /** When the script expects its window to reopen, while it is waiting. */
  windowOpensAt: string | null;
  /** False once the process is gone — pause/stop can no longer reach it. */
  controllable: boolean;
  totalDates: number;
  extractedDates: number;
  remainingDates: number;
  currentDate: string | null;
  firstDate: string;
  lastDate: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  etaMs: number | null;
};
export type ExtractionDetail = {
  extraction: ExtractionFile;
  columns: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
};
export type CanonicalCv = {
  content: string;
  sourceName: string | null;
  sourceFormat: string | null;
  hasOriginalPdf: boolean;
  pdfKind: "original" | "template" | null;
  canUndo: boolean;
  version: number;
  updatedAt: string;
};
export type CvUploadDocument = {
  content: string;
  sourceName: string;
  sourceFormat: string;
  sourcePdfToken: string | null;
};
export type CvPdfPreview = { blob: Blob; source: "original" | "template" };
export type CvRevision = {
  content: string;
  summary: string;
  warnings: string[];
  sourcePdfToken: string | null;
  preservedPdfStyling: boolean;
};
export type JobSearchProfile = {
  query: string;
  locations: string[];
  workModes: string[];
  minimumSalary: number | null;
  salaryCurrency: string;
  jobTypes: string[];
  excludedKeywords: string[];
  version: number;
  updatedAt: string;
};
/** new/current are presentable as live; stale and historical are explicitly not. */
export type HuntingJobFreshness = "new" | "current" | "stale" | "historical";
export type HuntingJobScope = "run" | "current" | "all";
export type HuntingJob = {
  id: string;
  url: string;
  canonicalUrl: string;
  sourceFamily: string;
  title: string;
  company: string;
  location: string;
  source: string;
  workMode: string | null;
  salary: string | null;
  listedAt: string | null;
  descriptionExcerpt: string;
  matchScore: number;
  matchReasons: string[];
  status: "new" | "shortlisted" | "dismissed";
  freshness: HuntingJobFreshness;
  discoveredAt: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastRunId: string | null;
  updatedAt: string;
};
export type HuntingSourceStatus = {
  source: string;
  status: "covered" | "unavailable";
  count: number;
  reason: string | null;
};
export type HuntingDiscoveryRun = {
  id: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string;
  sourceStatus: HuntingSourceStatus[];
  observedCount: number;
  newCount: number;
  error: string | null;
};
export type HuntingApplicationStatus =
  | "queued"
  | "preparing_cv"
  | "opening_form"
  | "uploading_cv"
  | "filling_verified_fields"
  | "needs_human_action"
  | "ready_for_review"
  | "submitted"
  | "failed";
export type HuntingUploadOutcome =
  | "pending"
  | "uploaded"
  | "not_required"
  | "input_not_found"
  | "artifact_unavailable"
  | "tool_unavailable"
  | "rejected"
  | "verification_failed";
export type HuntingFilledField = { field: string; source: string; sourceFact?: string; selectedOption?: string };
/** A field left blank, with whether the form required it — optional ones never block review. */
export type HuntingFieldNote = { field: string; reason: string; required: boolean };
/** `letter` is the sendable text; `content` also carries the which-application metadata. */
export type HuntingCoverLetter = {
  name: string;
  hostPath: string;
  content: string;
  letter: string;
  createdAt: string;
};
export type HuntingApplication = {
  jobId: string;
  status: HuntingApplicationStatus;
  sessionKey: string;
  summary: string;
  reasonCode: string | null;
  currentUrl: string | null;
  browserTargetId: string | null;
  filledFields: HuntingFilledField[];
  unresolvedFields: HuntingFieldNote[];
  skippedFields: HuntingFieldNote[];
  manualAction: string | null;
  manualActionKind: string | null;
  usedMemoryIds: string[];
  tailoredCvName: string | null;
  uploadOutcome: HuntingUploadOutcome;
  uploadAttempts: number;
  uploadVerifiedAt: string | null;
  uploadEvidence: Record<string, unknown>;
  artifact: Record<string, unknown>;
  coverLetter: { name?: string; words?: number; createdAt?: string };
  usage: HuntingApplicationUsage | Record<string, never>;
  startedAt: string;
  updatedAt: string;
};
/** A page in the OpenClaw-controlled browser the user can take over. */
export type HuntingBrowserTab = {
  targetId: string;
  tabId: string | null;
  label: string | null;
  title: string;
  url: string;
};
/** One mirrored frame plus the geometry click ratios are resolved against. */
export type HuntingBrowserFrame = {
  targetId: string;
  url: string;
  image: string;
  width: number;
  height: number;
  capturedAt: string;
};
export type HuntingBrowserInput = {
  action: "click" | "doubleClick" | "type" | "press" | "scroll";
  xRatio?: number;
  yRatio?: number;
  text?: string;
  key?: string;
  deltaY?: number;
};
/**
 * What one application cost. `quota` is present only for oauth providers, where a plan is
 * already paid for and the meaningful cost is quota; api keys bill per token instead.
 */
export type HuntingApplicationUsage = {
  model: string | null;
  provider: string | null;
  authType: "oauth" | "api_key" | "token" | null;
  plan: string | null;
  turns: { phase: string; inputTokens: number; outputTokens: number; sessionTokenDelta: number }[];
  tokens: { input: number; output: number; total: number; sessionTokenDelta: number };
  cost: {
    currency: string;
    amount: number;
    basis: "api_list_price_equivalent" | "estimated_charge";
    estimated: boolean;
    unpricedModels: string[];
  };
  quota: {
    reported: boolean;
    granularity: string;
    windows: {
      label: string;
      usedPercentBefore: number | null;
      usedPercentAfter: number;
      deltaPoints: number | null;
      resetAt: number | null;
    }[];
  } | null;
  measuredAt: string;
};
export type HuntingApplicationAttempt = {
  id: string;
  jobId: string;
  phase: string;
  outcome: string;
  reasonCode: string | null;
  detail: string | null;
  evidence: Record<string, unknown>;
  createdAt: string;
};
export type ScreenControlLease = { token: string; expiresAt: number };
export type ScreenInput = {
  action: "click" | "scroll";
  screenIndex: number;
  xRatio: number;
  yRatio: number;
  delta?: number;
};
export type HuntingAccessState = { ok: true; unlocked: boolean; accessToken?: string };
export type MemoryAccessState = { ok: true; unlocked: boolean; accessToken?: string };

let huntingAccessToken: string | null = null;
let memoryAccessToken: string | null = null;

async function getJson<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `GET ${path} failed`);
  return body as T;
}

async function postJson<T = any>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `POST ${path} failed`);
  return body as T;
}

async function putJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `PUT ${path} failed`);
  return body as T;
}

async function deleteJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `DELETE ${path} failed`);
  return body as T;
}

function huntingHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return huntingAccessToken
    ? { ...headers, "X-Jarvis-Hunting-Access": huntingAccessToken }
    : headers;
}

function memoryHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return memoryAccessToken ? { ...headers, "X-Jarvis-Memory-Access": memoryAccessToken } : headers;
}

async function getMemoryJson<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: memoryHeaders() });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `GET ${path} failed`);
  return body as T;
}

async function postMemoryJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: memoryHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `POST ${path} failed`);
  return body as T;
}

async function putMemoryJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: memoryHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `PUT ${path} failed`);
  return body as T;
}

async function deleteMemoryJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: memoryHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `DELETE ${path} failed`);
  return body as T;
}

async function getHuntingJson<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: huntingHeaders() });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `GET ${path} failed`);
  return body as T;
}

/** Error that keeps the response body, so callers can act on structured refusals. */
export class HuntingRequestError extends Error {
  readonly body: Record<string, unknown>;
  constructor(message: string, body: Record<string, unknown>) {
    super(message);
    this.name = "HuntingRequestError";
    this.body = body;
  }
}

/** The job holding the single-application slot, returned with a 409 from apply. */
export type ActiveApplicationConflict = {
  jobId: string;
  company: string;
  title: string;
  status: string | null;
  isSameJob: boolean;
};

export function activeApplicationConflict(error: unknown): ActiveApplicationConflict | null {
  if (!(error instanceof HuntingRequestError)) return null;
  const active = error.body.activeJob as ActiveApplicationConflict | null | undefined;
  return active && typeof active.jobId === "string" ? active : null;
}

async function postHuntingJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: huntingHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new HuntingRequestError(body.error ?? `POST ${path} failed`, body);
  return body as T;
}

async function putHuntingJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: huntingHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `PUT ${path} failed`);
  return body as T;
}

async function deleteHuntingJson<T = any>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: huntingHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? `DELETE ${path} failed`);
  return body as T;
}

async function postHuntingBlob(path: string, payload: unknown): Promise<CvPdfPreview> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: huntingHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
  });
  if (res.ok) {
    const source = res.headers.get("X-Jarvis-CV-Preview-Source");
    return { blob: await res.blob(), source: source === "original" ? "original" : "template" };
  }
  const body = await res.json().catch(() => null);
  throw new Error(body?.error ?? `POST ${path} failed`);
}

export const api = {
  authStatus: () => getJson<{ ok: true; authenticated: boolean }>("/auth/status"),
  login: (password: string) =>
    postJson<{ ok: true; authenticated: boolean }>("/auth/login", { password }),
  logout: () => postJson<{ ok: true; authenticated: boolean }>("/auth/logout", {}),
  status: () => getJson("/status"),
  nodes: () => getJson("/nodes"),
  deleteNode: (nodeId: string) => deleteJson(`/nodes/${encodeURIComponent(nodeId)}`, {}),
  usage: (range = "7d") => getJson<UsageReport>(`/usage?range=${encodeURIComponent(range)}`),
  sessions: (limit = 20) => getJson(`/sessions?limit=${limit}`),
  createSession: (agentId: string, label: string) =>
    postJson("/sessions", { agentId, label }),
  resetSession: (sessionKey: string, agentId?: string) =>
    postJson(`/sessions/${encodeURIComponent(sessionKey)}/reset`, { agentId }),
  deleteSession: (sessionKey: string, agentId?: string) =>
    deleteJson(`/sessions/${encodeURIComponent(sessionKey)}`, { agentId }),
  executionTarget: (sessionKey: string) =>
    getJson<ExecutionTargetState>(
      `/sessions/${encodeURIComponent(sessionKey)}/execution-target`,
    ),
  setExecutionTarget: (sessionKey: string, target: ExecutionTarget, agentId?: string) =>
    putJson<ExecutionTargetState>(
      `/sessions/${encodeURIComponent(sessionKey)}/execution-target`,
      { target, agentId },
    ),
  agents: () => getJson("/agents"),
  generateAgentAppearance: (payload: {
    name: string;
    role: string;
    description: string;
    referenceAttachmentIds: string[];
  }) => postJson<{ ok: true } & GeneratedAgentAppearance>("/agents/appearance/generate", payload),
  createAgent: (payload: CreateAgentInput) =>
    postJson<{ ok: true; agent: { agentId: string; name: string }; memory: { id: string; title: string } }>(
      "/agents",
      payload,
    ),
  agentModels: (agentId: string) => getJson<AgentModels>(`/agents/${encodeURIComponent(agentId)}/models`),
  saveAgentModel: (agentId: string, model: string) =>
    putJson<AgentModels>(`/agents/${encodeURIComponent(agentId)}/default-model`, { model }),
  setSessionModel: (sessionKey: string, agentId: string, model: string) =>
    putJson(`/sessions/${encodeURIComponent(sessionKey)}/model`, { agentId, model }),
  history: (sessionKey: string) => getJson(`/history?sessionKey=${encodeURIComponent(sessionKey)}`),
  uploadAttachments: async (files: File[]) =>
    postJson<{ ok: true; attachments: StoredAttachment[] }>("/attachments", {
      attachments: await Promise.all(files.map(filePayload)),
    }),
  chat: (sessionKey: string, message: string, agentId?: string, attachmentIds: string[] = []) =>
    postJson("/chat", { sessionKey, message, agentId, attachmentIds }),
  huntingAccess: () => getHuntingJson<HuntingAccessState>("/hunting/access"),
  unlockHunting: async (password: string) => {
    const access = await postJson<HuntingAccessState>("/hunting/access", { password });
    huntingAccessToken = access.accessToken ?? null;
    return access;
  },
  lockHunting: async () => {
    const access = await deleteHuntingJson<HuntingAccessState>("/hunting/access", {});
    huntingAccessToken = null;
    return access;
  },
  memoryAccess: () => getJson<MemoryAccessState>("/memory/access"),
  unlockMemory: async (password: string) => {
    const access = await postJson<MemoryAccessState>("/memory/access", { password });
    memoryAccessToken = access.accessToken ?? null;
    return access;
  },
  lockMemory: async () => {
    const access = await deleteJson<MemoryAccessState>("/memory/access", {});
    memoryAccessToken = null;
    return access;
  },
  cv: () => getHuntingJson<{ ok: true; cv: CanonicalCv | null }>("/hunting/cv"),
  uploadCv: (payload: { name: string; type: string; data: string }) =>
    postHuntingJson<{ ok: true; document: CvUploadDocument }>("/hunting/cv/upload", payload),
  previewCvPdf: (content: string, sourceName: string | null, sourcePdfToken: string | null) =>
    postHuntingBlob("/hunting/cv/pdf-preview", { content, sourceName, sourcePdfToken }),
  saveCv: (payload: {
    content: string;
    sourceName: string | null;
    sourceFormat: string | null;
    sourcePdfToken: string | null;
    expectedVersion: number;
  }) => putHuntingJson<{ ok: true; cv: CanonicalCv }>("/hunting/cv", payload),
  undoCv: (expectedVersion: number) =>
    postHuntingJson<{ ok: true; cv: CanonicalCv }>("/hunting/cv/undo", { expectedVersion }),
  reviseCv: (
    content: string,
    instruction: string,
    sourceName: string | null,
    sourcePdfToken: string | null,
  ) =>
    postHuntingJson<{ ok: true; revision: CvRevision }>("/hunting/cv/revise", {
      content,
      instruction,
      sourceName,
      sourcePdfToken,
    }),
  proposeCvMemory: () =>
    postHuntingJson<{ ok: true; created: boolean; proposal: { id: string; status: string } }>(
      "/hunting/cv/memory-proposal",
      {},
    ),
  huntingSearchProfile: () =>
    getHuntingJson<{ ok: true; profile: JobSearchProfile | null }>("/hunting/search-profile"),
  saveHuntingSearchProfile: (payload: {
    query: string;
    locations: string[];
    workModes: string[];
    minimumSalary: number | null;
    salaryCurrency: string;
    jobTypes: string[];
    excludedKeywords: string[];
    expectedVersion: number;
  }) => putHuntingJson<{ ok: true; profile: JobSearchProfile }>("/hunting/search-profile", payload),
  huntingJobs: (scope: HuntingJobScope = "current") =>
    getHuntingJson<{
      ok: true;
      jobs: HuntingJob[];
      scope: HuntingJobScope;
      run: HuntingDiscoveryRun | null;
    }>(`/hunting/jobs?scope=${scope}`),
  discoverHuntingJobs: () =>
    postHuntingJson<{
      ok: true;
      run: HuntingDiscoveryRun;
      jobs: HuntingJob[];
      summary: string;
      sourceStatus: HuntingSourceStatus[];
      droppedForDiversity: number;
    }>("/hunting/discover", {}),
  setHuntingJobStatus: (id: string, status: HuntingJob["status"]) =>
    putHuntingJson<{ ok: true; job: HuntingJob }>(
      `/hunting/jobs/${encodeURIComponent(id)}/status`,
      { status },
    ),
  huntingApplications: () =>
    getHuntingJson<{ ok: true; applications: HuntingApplication[] }>("/hunting/applications"),
  huntingBrowserTabs: () =>
    getHuntingJson<{ ok: true; tabs: HuntingBrowserTab[] }>("/hunting/browser/tabs"),
  startHuntingBrowserTakeover: (targetId: string, url: string | null) =>
    postHuntingJson<{ ok: true; frame: HuntingBrowserFrame }>("/hunting/browser/takeover", {
      targetId,
      url,
    }),
  huntingBrowserFrame: (targetId: string) =>
    postHuntingJson<{ ok: true; frame: HuntingBrowserFrame }>("/hunting/browser/frame", { targetId }),
  sendHuntingBrowserInput: (targetId: string, input: HuntingBrowserInput) =>
    postHuntingJson<{ ok: true; targetId: string; url: string }>("/hunting/browser/input", {
      targetId,
      ...input,
    }),
  navigateHuntingBrowser: (targetId: string, url: string) =>
    postHuntingJson<{ ok: true; targetId: string; url: string }>("/hunting/browser/navigate", {
      targetId,
      url,
    }),
  huntingCoverLetter: (jobId: string) =>
    getHuntingJson<{ ok: true; coverLetter: HuntingCoverLetter }>(
      `/hunting/applications/${encodeURIComponent(jobId)}/cover-letter`,
    ),
  huntingApplicationAttempts: (jobId: string) =>
    getHuntingJson<{ ok: true; attempts: HuntingApplicationAttempt[] }>(
      `/hunting/applications/${encodeURIComponent(jobId)}/attempts`,
    ),
  runHuntingApplication: (id: string, resume = false, guidance = "", attachmentIds: string[] = []) =>
    postHuntingJson<{ ok: true; application: HuntingApplication }>(
      `/hunting/jobs/${encodeURIComponent(id)}/apply`,
      { resume, guidance, attachmentIds },
    ),
  cancelHuntingApplication: (id: string) =>
    postHuntingJson<{ ok: true; application: HuntingApplication }>(
      `/hunting/jobs/${encodeURIComponent(id)}/cancel`,
      {},
    ),
  markHuntingApplicationSubmitted: (jobId: string, manualRecoveryConfirmed = false) =>
    postHuntingJson<{ ok: true; application: HuntingApplication }>(
      `/hunting/applications/${encodeURIComponent(jobId)}/submitted`,
      { manualRecoveryConfirmed },
    ),
  submitHuntingApplication: (jobId: string) =>
    postHuntingJson<{ ok: true; application: HuntingApplication }>(
      `/hunting/applications/${encodeURIComponent(jobId)}/submit`,
      {},
    ),
  extractions: () =>
    getJson<{ ok: true; extractions: ExtractionFile[]; source: ExtractionSource }>("/extractions"),
  extractionTasks: () =>
    getJson<{ ok: true; tasks: ExtractionTask[]; supportedSites: string[] }>("/extractions/tasks"),
  customExtractors: () =>
    getJson<{ ok: true; extractors: CustomExtractor[] }>("/extractions/custom-extractors"),
  createCustomExtractor: (input: {
    name: string;
    description: string;
    files: CustomExtractorUpload[];
  }) => postJson<{ ok: true; extractor: CustomExtractor }>("/extractions/custom-extractors", input),
  createExtractionTask: (input: ExtractionTaskInput) =>
    postJson<{ ok: true; task: ExtractionTask }>("/extractions/tasks", input),
  setExtractionTaskStatus: (id: string, status: ExtractionTask["status"]) =>
    postJson<{ ok: true; task: ExtractionTask }>(`/extractions/tasks/${encodeURIComponent(id)}/status`, { status }),
  runExtractionTaskNow: (id: string) =>
    postJson<{ ok: true; task: ExtractionTask }>(`/extractions/tasks/${encodeURIComponent(id)}/run-now`, {}),
  deleteExtractionTask: (id: string) => deleteJson(`/extractions/tasks/${encodeURIComponent(id)}`, {}),
  extractionRuns: () =>
    getJson<{ ok: true; runs: ExtractionRun[]; defaultSchedule: ExtractionSchedule }>("/extractions/runs"),
  controlExtractionRun: (id: string, body: { command?: ExtractionRunCommand; schedule?: ExtractionSchedule }) =>
    postJson<{ ok: true; run: ExtractionRun }>(`/extractions/runs/${encodeURIComponent(id)}/control`, body),
  setExtractionSchedule: (schedule: ExtractionSchedule) =>
    putJson<{ ok: true; defaultSchedule: ExtractionSchedule }>("/extractions/schedule", { schedule }),
  extraction: (id: string) =>
    getJson<{ ok: true } & ExtractionDetail>(`/extractions/${encodeURIComponent(id)}`),
  extractionDownloadUrl: (id: string) => `${BASE}/extractions/${encodeURIComponent(id)}/download`,
  screenpipeStatus: () => getJson<{ ok: true; screenpipe: ScreenpipeStatus }>("/workflows/screenpipe"),
  learningSessions: () =>
    getJson<{ ok: true; sessions: LearningSession[]; active: LearningSession | null }>("/workflows/sessions"),
  startLearningSession: (title: string, includeAudio: boolean) =>
    postJson<{ ok: true; session: LearningSession }>("/workflows/sessions", { title, includeAudio }),
  stopLearningSession: (id: string) =>
    postJson<{ ok: true; session: LearningSession }>(`/workflows/sessions/${encodeURIComponent(id)}/stop`, {}),
  extractWorkflow: (id: string) =>
    postJson<{ ok: true; session: LearningSession; draft: LearnedWorkflow }>(
      `/workflows/sessions/${encodeURIComponent(id)}/extract`,
      {},
    ),
  abandonLearningSession: (id: string) =>
    postJson<{ ok: true; session: LearningSession }>(`/workflows/sessions/${encodeURIComponent(id)}/abandon`, {}),
  workflows: () => getJson<{ ok: true; workflows: StoredWorkflow[] }>("/workflows"),
  workflowDetail: (id: string) =>
    getJson<{ ok: true; workflow: StoredWorkflow; runs: WorkflowRun[] }>(`/workflows/${encodeURIComponent(id)}`),
  saveWorkflow: (spec: LearnedWorkflow, sessionId?: string | null) =>
    postJson<{ ok: true; workflow: StoredWorkflow; memory: { saved: boolean; id?: string; error?: string } }>(
      "/workflows",
      { spec, sessionId },
    ),
  updateWorkflow: (id: string, spec: LearnedWorkflow) =>
    putJson<{ ok: true; workflow: StoredWorkflow; memory: { saved: boolean; id?: string; error?: string } }>(
      `/workflows/${encodeURIComponent(id)}`,
      { spec },
    ),
  deleteWorkflow: (id: string) => deleteJson(`/workflows/${encodeURIComponent(id)}`, {}),
  runWorkflow: (id: string, values: Record<string, string>) =>
    postJson<{ ok: true; run: WorkflowRun }>(`/workflows/${encodeURIComponent(id)}/run`, { values }),
  continueWorkflowRun: (runId: string, approved: boolean, guidance = "") =>
    postJson<{ ok: true; run: WorkflowRun }>(`/workflows/runs/${encodeURIComponent(runId)}/continue`, {
      approved,
      guidance,
    }),
  cancelWorkflowRun: (runId: string) =>
    postJson<{ ok: true; run: WorkflowRun }>(`/workflows/runs/${encodeURIComponent(runId)}/cancel`, {}),
  memoryStatus: () => getMemoryJson("/memory/status"),
  memories: (query = "") => getMemoryJson(`/memories?q=${encodeURIComponent(query)}`),
  memory: (id: string) => getMemoryJson(`/memories/${encodeURIComponent(id)}`),
  memoryGraph: () => getMemoryJson("/memory/graph"),
  neuralMemoryStatus: () => getMemoryJson("/memory/neural/status"),
  runNeuralMemory: () => postMemoryJson("/memory/neural/run", {}),
  createMemory: (payload: unknown) => postMemoryJson("/memories", payload),
  updateMemory: (id: string, payload: unknown) => putMemoryJson(`/memories/${encodeURIComponent(id)}`, payload),
  deleteMemory: (id: string, revision: string) =>
    deleteMemoryJson(`/memories/${encodeURIComponent(id)}`, { revision }),
  memoryProposals: (status = "pending") =>
    getMemoryJson(`/memory/proposals?status=${encodeURIComponent(status)}`),
  approveMemoryProposal: (id: string) =>
    postMemoryJson(`/memory/proposals/${encodeURIComponent(id)}/approve`, {}),
  rejectMemoryProposal: (id: string) =>
    postMemoryJson(`/memory/proposals/${encodeURIComponent(id)}/reject`, {}),
  nodeInvoke: (nodeId: string, command: string, params?: unknown) =>
    postJson(`/node/${encodeURIComponent(nodeId)}/invoke`, { command, params }),
  screenSnapshot: (nodeId: string, screenIndex: number, signal?: AbortSignal) =>
    postJson(
      `/node/${encodeURIComponent(nodeId)}/invoke`,
      {
        command: "screen.snapshot",
        params: { screenIndex, maxWidth: 2560, quality: 0.9, format: "jpeg" },
      },
      signal,
    ),
  startScreenControl: (nodeId: string) =>
    postJson<{ ok: true; control: ScreenControlLease }>(
      `/node/${encodeURIComponent(nodeId)}/screen-control`,
      {},
    ),
  stopScreenControl: (nodeId: string, token: string) =>
    deleteJson<{ ok: true }>(`/node/${encodeURIComponent(nodeId)}/screen-control`, { token }),
  sendScreenInput: (nodeId: string, token: string, input: ScreenInput) =>
    postJson<{ ok: true; payload: { ok: true; action: ScreenInput["action"] } }>(
      `/node/${encodeURIComponent(nodeId)}/screen-input`,
      { token, input },
    ),
};

async function filePayload(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    content: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}
