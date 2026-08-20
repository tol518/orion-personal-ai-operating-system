export type MemorySource = "user" | "agent" | "agent-approved" | "agent-managed";
export type MemoryType = "general" | "agent_instruction" | "project" | "shared_lesson";
export type MemoryRelationType =
  | "related"
  | "similar_to"
  | "supports"
  | "contradicts"
  | "caused_by"
  | "derived_from"
  | "part_of"
  | "same_project"
  | "same_entity"
  | "temporal"
  | "nearest_neighbor";

export type MemoryConnection = {
  source: string;
  target: string;
  relationType: MemoryRelationType;
  weight: number;
  confidence: number;
  creationSource: string;
  activationCount: number;
  lastActivatedAt: string | null;
  createdAt: string;
  archived: boolean;
};

export type Memory = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  links: string[];
  manualLinks: string[];
  connections: MemoryConnection[];
  status: "approved";
  memoryType: MemoryType;
  managedKey: string | null;
  memoryState: "active" | "superseded";
  supersededBy: string | null;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  path: string;
  revision: string;
  excerpt: string;
  attachments: import("./api").StoredAttachment[];
};

export type MemoryGraphNode = Pick<Memory, "id" | "title" | "tags" | "source" | "updatedAt" | "memoryState" | "memoryType">;

export type MemoryGraphEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  relationType: MemoryRelationType;
  weight: number;
  confidence: number;
  creationSource: string;
  activationCount: number;
  lastActivatedAt: string | null;
  archived: boolean;
  state: "approved" | "candidate";
  tier?: "medium" | "high";
};

export type MemoryProposal = {
  id: string;
  kind: "memory" | "relationship";
  payload: {
    title?: string;
    body?: string;
    tags?: string[];
    fromId?: string;
    toId?: string;
    label?: string;
    relationType?: MemoryRelationType;
    weight?: number;
    confidence?: number;
    creationSource?: string;
    tier?: "medium" | "high";
    reason?: string;
    scoreFactors?: Record<string, number>;
    supersedesId?: string;
    consolidationMembers?: string[];
  };
  status: "pending" | "approved" | "rejected";
  sessionKey: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type NeuralMemoryStatus = {
  enabled: boolean;
  running: boolean;
  model: string;
  authentication: "codex-oauth";
  contextWindow: number;
  advertisedContextWindow: number;
  embeddingModel: string;
  candidateLimit: number;
  lastRunAt: string | null;
  lastError: string | null;
  lastCreatedCandidates: number;
};

export type MemoryStatus = {
  configured: boolean;
  connected: boolean;
  folder: string;
  count: number;
  lastSyncedAt: string | null;
  error: string | null;
};
