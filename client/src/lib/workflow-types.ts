// The workflow-learning contract, mirroring server/workflows/learned-workflow.js. The server is
// the authority: it re-validates and re-derives safety on every save, so these types describe what
// the UI can show and edit, not what it is allowed to assert.

export type WorkflowActionType =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "copy"
  | "paste"
  | "wait"
  | "verify"
  | "confirm"
  | "custom";

export const WORKFLOW_ACTION_TYPES: WorkflowActionType[] = [
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
];

export type LearnedWorkflow = {
  id: string;
  name: string;
  description: string;
  source: {
    screenpipeSessionStart: string;
    screenpipeSessionEnd: string;
    apps: string[];
    urls?: string[];
  };
  variables: Array<{
    name: string;
    description: string;
    required: boolean;
    example?: string;
  }>;
  steps: Array<{
    id: string;
    instruction: string;
    app?: string;
    url?: string;
    actionType: WorkflowActionType;
    target?: {
      text?: string;
      selector?: string;
      visualDescription?: string;
    };
    input?: string;
    successCheck?: string;
    fallback?: string;
    requiresUserConfirmation?: boolean;
  }>;
  safety: {
    riskLevel: "low" | "medium" | "high";
    requiresConfirmationBeforeRun: boolean;
    blockedActions: string[];
  };
};

export type LearningSessionStatus = "recording" | "captured" | "extracted" | "saved" | "abandoned";

/** What the UI needs from a stored digest: enough to show what was captured, never the raw text. */
export type ObservationDigestSummary = {
  apps: string[];
  urls: string[];
  segments: Array<{
    index: number;
    app: string;
    window: string;
    url: string | null;
    startedAt: string;
    endedAt: string;
    lines: string[];
    actions: Array<{ eventType: string; element: string | null; text: string | null; coordinatesOnly?: boolean }>;
    narration: string[];
  }>;
  counts: Record<string, number>;
  unavailable: Array<{ contentType: string; reason: string }>;
  stats: { items: number; redactions: number; excludedItems: number; duplicateLines: number };
};

export type LearningSession = {
  id: string;
  title: string;
  status: LearningSessionStatus;
  startedAt: string;
  endedAt: string | null;
  includeAudio: boolean;
  digest: ObservationDigestSummary | null;
  draft: LearnedWorkflow | null;
  workflowId: string | null;
  error: string | null;
};

export type WorkflowRunStatus = "running" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";

export type WorkflowRun = {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  variables: Record<string, string>;
  results: Array<{
    index: number;
    id: string;
    status: "ok" | "failed" | "awaiting_confirmation";
    detail: string;
    approved?: boolean;
    usedFallback?: boolean;
  }>;
  detail: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type StoredWorkflow = {
  id: string;
  name: string;
  spec: LearnedWorkflow;
  memoryId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: WorkflowRun | null;
};

// `running` and `readable` are separate because /health needs no token and /search does: a healthy
// recorder can still refuse every read until SCREENPIPE_API_KEY is set.
export type ScreenpipeStatus = {
  running: boolean;
  readable: boolean;
  baseUrl: string;
  detail: string | null;
};
