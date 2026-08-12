import { createHash, randomUUID } from "node:crypto";
import { Document, parseDocument } from "yaml";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const WORD = /[a-z0-9]+/g;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "been",
  "could",
  "from",
  "have",
  "into",
  "just",
  "like",
  "that",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

export class MemoryConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "MemoryConflictError";
    this.statusCode = 409;
  }
}

function revisionOf(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item?.id ?? item).trim()).filter(Boolean))];
}

const RELATION_TYPES = new Set([
  "related",
  "similar_to",
  "supports",
  "contradicts",
  "caused_by",
  "derived_from",
  "part_of",
  "same_project",
  "same_entity",
  "temporal",
]);
const MEMORY_TYPES = new Set(["general", "agent_instruction", "project", "shared_lesson"]);
const AGENT_MANAGED_MEMORY_TYPES = new Set(["agent_instruction", "project", "shared_lesson"]);

function numericUnit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeConnection(value, sourceId, defaults = {}) {
  if (!value || typeof value !== "object") return null;
  const source = cleanText(value.source ?? sourceId);
  const target = cleanText(value.target ?? value.target_id ?? value.id);
  if (!source || !target || source === target) return null;
  const requestedRelation = cleanText(value.relationType ?? value.relation_type ?? value.label);
  const relationType = RELATION_TYPES.has(requestedRelation) ? requestedRelation : "related";
  const creationSource = cleanText(value.creationSource ?? value.creation_source ?? defaults.creationSource) || "manual";
  return {
    source,
    target,
    relationType,
    weight: numericUnit(value.weight, creationSource === "manual" ? 1 : 0.6),
    confidence: numericUnit(value.confidence, creationSource === "manual" ? 1 : 0.6),
    creationSource,
    activationCount: Math.max(0, Math.floor(Number(value.activationCount ?? value.activation_count ?? 0) || 0)),
    lastActivatedAt: cleanText(value.lastActivatedAt ?? value.last_activated_at) || null,
    createdAt: cleanText(value.createdAt ?? value.created_at ?? defaults.createdAt) || new Date().toISOString(),
    archived: value.archived === true,
  };
}

function connectionDocumentValue(connection) {
  return {
    source: connection.source,
    target: connection.target,
    relation_type: connection.relationType,
    weight: Number(connection.weight.toFixed(4)),
    confidence: Number(connection.confidence.toFixed(4)),
    creation_source: connection.creationSource,
    activation_count: connection.activationCount,
    last_activated_at: connection.lastActivatedAt,
    created_at: connection.createdAt,
    archived: connection.archived,
  };
}

function mergeConnections(connections) {
  const merged = new Map();
  for (const connection of connections.filter(Boolean)) {
    const key = `${connection.source}::${connection.target}::${connection.relationType}`;
    const current = merged.get(key);
    if (!current || (connection.creationSource === "manual" && current.creationSource !== "manual")) {
      merged.set(key, connection);
      continue;
    }
    if (current.creationSource === "manual") continue;
    merged.set(key, {
      ...current,
      weight: Math.max(current.weight, connection.weight),
      confidence: Math.max(current.confidence, connection.confidence),
      activationCount: Math.max(current.activationCount, connection.activationCount),
      lastActivatedAt: [current.lastActivatedAt, connection.lastActivatedAt].filter(Boolean).sort().at(-1) ?? null,
    });
  }
  return [...merged.values()];
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeMemoryType(value) {
  const type = cleanText(value);
  return MEMORY_TYPES.has(type) ? type : "general";
}

function excerptOf(body) {
  const text = cleanText(body.replace(/[#*_>`~\[\]]/g, ""));
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

function safeTitle(value) {
  const title = cleanText(value);
  if (!title) throw new Error("title is required");
  if (title.length > 120) throw new Error("title must be 120 characters or fewer");
  return title;
}

function pathTitle(title) {
  return title
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function parseMemory(notePath, raw) {
  const match = raw.match(FRONTMATTER);
  if (!match) throw new Error("missing YAML frontmatter");
  const document = parseDocument(match[1]);
  if (document.errors.length) throw document.errors[0];
  const data = document.toJS() ?? {};
  const id = cleanText(data.id);
  const title = cleanText(data.title);
  if (!id || !title) throw new Error("frontmatter requires id and title");
  const legacyLinks = stringList(data.links).filter((target) => target !== id);
  const parsedConnections = Array.isArray(data.connections)
    ? data.connections.map((value) => normalizeConnection(value, id, { createdAt: data.created_at })).filter(Boolean)
    : [];
  const connectedTargets = new Set(parsedConnections.map((connection) => connection.target));
  const connections = mergeConnections([
    ...parsedConnections,
    ...legacyLinks
      .filter((target) => !connectedTargets.has(target))
      .map((target) => normalizeConnection({ target, relationType: "related" }, id, {
        creationSource: "manual",
        createdAt: data.created_at,
      })),
  ]);
  const links = [...new Set(connections.filter((connection) => !connection.archived).map((connection) => connection.target))];
  return {
    id,
    title,
    body: match[2].replace(/^\r?\n/, "").replace(/\s+$/, ""),
    tags: stringList(data.tags),
    links,
    manualLinks: connections
      .filter((connection) => connection.creationSource === "manual" && !connection.archived)
      .map((connection) => connection.target),
    connections,
    status: cleanText(data.status) || "approved",
    memoryType: normalizeMemoryType(data.memory_type),
    managedKey: cleanText(data.managed_key) || null,
    memoryState: cleanText(data.memory_state) || "active",
    supersededBy: cleanText(data.superseded_by) || null,
    source: cleanText(data.source) || "user",
    createdAt: cleanText(data.created_at),
    updatedAt: cleanText(data.updated_at),
    path: notePath,
    revision: revisionOf(raw),
    excerpt: excerptOf(match[2]),
    raw,
    document,
  };
}

function serializeMemory(existing, fields) {
  const document = existing?.document ?? new Document();
  const now = new Date().toISOString();
  const createdAt = existing?.createdAt || fields.createdAt || now;
  document.set("id", fields.id);
  document.set("title", fields.title);
  document.set("created_at", createdAt);
  document.set("updated_at", now);
  document.set("tags", fields.tags);
  const connections = mergeConnections(fields.connections ?? []);
  document.set("links", [...new Set(connections.filter((connection) => !connection.archived).map((connection) => connection.target))]);
  document.set("connections", connections.map(connectionDocumentValue));
  document.set("status", "approved");
  document.set("source", fields.source);
  document.set("memory_type", normalizeMemoryType(fields.memoryType));
  document.set("managed_key", cleanText(fields.managedKey) || null);
  document.set("memory_state", fields.memoryState ?? "active");
  document.set("superseded_by", fields.supersededBy ?? null);
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n\n${fields.body.trim()}\n`;
}

function publicMemory(memory) {
  const { raw: _raw, document: _document, ...result } = memory;
  return result;
}

function queryWords(query) {
  return [...new Set((query.toLowerCase().match(WORD) ?? []).filter((word) => word.length > 2 && !STOP_WORDS.has(word)))];
}

export class MemoryStore {
  constructor({ mcp, folder = "Memory", intervalMs = 2000, onChange = () => {} }) {
    this.mcp = mcp;
    this.folder = folder.replace(/^\/+|\/+$/g, "") || "Memory";
    this.intervalMs = Math.max(1000, intervalMs);
    this.onChange = onChange;
    this.memories = new Map();
    this.version = "";
    this.lastSyncedAt = null;
    this.lastError = null;
    this.timer = null;
    this.refreshing = null;
  }

  async start() {
    await this.refresh().catch(() => undefined);
    this.timer = setInterval(() => this.refresh().catch(() => undefined), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.mcp.stop();
  }

  status() {
    return {
      configured: this.mcp.configured,
      connected: this.mcp.connected && !this.lastError,
      folder: this.folder,
      count: this.memories.size,
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
    };
  }

  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.#refresh();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async #refresh() {
    try {
      const prefix = `${this.folder}/`;
      const systemFiles = new Set(["index.md", "log.md", "schema.md", "agents.md"]);
      const paths = (await this.mcp.listNotes(prefix)).filter((item) => {
        if (!item.endsWith(".md")) return false;
        const relative = item.slice(prefix.length).toLowerCase();
        if (relative.startsWith("raw/") || relative.startsWith("_system/")) return false;
        return !systemFiles.has(relative);
      });
      const settled = await Promise.allSettled(
        paths.map(async (notePath) => parseMemory(notePath, await this.mcp.readNote(notePath))),
      );
      const next = new Map();
      const invalid = [];
      for (let index = 0; index < settled.length; index += 1) {
        const result = settled[index];
        if (result.status === "fulfilled") {
          if (result.value.status === "approved") next.set(result.value.id, result.value);
        } else {
          invalid.push(`${paths[index]}: ${result.reason?.message ?? result.reason}`);
        }
      }
      const version = revisionOf(
        [...next.values()]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((memory) => `${memory.path}:${memory.revision}`)
          .join("\n"),
      );
      const changed = this.version !== "" && version !== this.version;
      this.memories = next;
      this.version = version;
      this.lastSyncedAt = new Date().toISOString();
      this.lastError = invalid.length ? invalid.join("; ") : null;
      if (changed) this.onChange({ version, count: next.size, syncedAt: this.lastSyncedAt });
      return this.list();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  list(query = "") {
    const normalized = query.trim().toLowerCase();
    return [...this.memories.values()]
      .filter((memory) => {
        if (!normalized) return true;
        return `${memory.title}\n${memory.body}\n${memory.tags.join(" ")}`.toLowerCase().includes(normalized);
      })
      .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
      .map(publicMemory);
  }

  get(id) {
    const memory = this.memories.get(id);
    return memory ? publicMemory(memory) : null;
  }

  graph() {
    const nodes = this.list().map(({ id, title, tags, source, updatedAt, memoryState, memoryType }) => ({
      id,
      title,
      tags,
      source,
      updatedAt,
      memoryState,
      memoryType,
    }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = [];
    const seen = new Set();
    for (const memory of this.memories.values()) {
      for (const connection of memory.connections) {
        if (connection.archived || !nodeIds.has(connection.target) || connection.target === memory.id) continue;
        const key = `${connection.source}::${connection.target}::${connection.relationType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          id: key,
          source: connection.source,
          target: connection.target,
          label: connection.relationType,
          relationType: connection.relationType,
          weight: connection.weight,
          confidence: connection.confidence,
          creationSource: connection.creationSource,
          activationCount: connection.activationCount,
          lastActivatedAt: connection.lastActivatedAt,
          archived: connection.archived,
          state: "approved",
        });
      }
    }
    return { nodes, edges };
  }

  retrieve(query, limit = 4, memoryType = null) {
    const words = queryWords(query);
    return [...this.memories.values()]
      .filter((memory) => !memoryType || memory.memoryType === memoryType)
      .map((memory) => {
        const title = memory.title.toLowerCase();
        const body = memory.body.toLowerCase();
        const tags = memory.tags.map((tag) => tag.toLowerCase());
        let score = tags.includes("identity") ? 0.5 : 0;
        let matchedWords = 0;
        for (const word of words) {
          const matched = title.includes(word) || tags.some((tag) => tag.includes(word)) || body.includes(word);
          if (matched) matchedWords += 1;
          if (title.includes(word)) score += 6;
          if (tags.some((tag) => tag.includes(word))) score += 4;
          if (body.includes(word)) score += 1;
        }
        if (memory.memoryType === "shared_lesson" && matchedWords > 0) score += 3;
        if (/\b(i|me|my|myself|where do i|who am i)\b/i.test(query) && tags.includes("identity")) score += 8;
        if (memory.memoryState === "superseded") score -= 4;
        return { memory, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt))
      .slice(0, limit)
      .map((item) => publicMemory(item.memory));
  }

  async create(input, source = "user") {
    const title = safeTitle(input.title);
    const id = cleanText(input.id) || randomUUID();
    if (this.memories.has(id)) throw new MemoryConflictError("a memory with this id already exists");
    const memoryType = normalizeMemoryType(input.memoryType);
    if (source === "agent-managed" && !AGENT_MANAGED_MEMORY_TYPES.has(memoryType)) {
      throw Object.assign(new Error("agents may only auto-write agent instructions, projects, or shared lessons"), { statusCode: 400 });
    }
    const memory = {
      id,
      title,
      body: String(input.body ?? "").trim(),
      tags: stringList(input.tags),
      links: stringList(input.links).filter((link) => link !== id),
      source: source === "agent" || source === "agent-approved" || source === "agent-managed" ? source : "user",
      memoryType,
      managedKey: cleanText(input.managedKey) || null,
      memoryState: "active",
      supersededBy: null,
    };
    const creationSource = Array.isArray(input.consolidationMembers) ? "consolidation" : "manual";
    memory.connections = memory.links.map((target) => normalizeConnection({
      target,
      relationType: creationSource === "consolidation" ? "derived_from" : "related",
      weight: creationSource === "consolidation" ? 0.86 : 1,
      confidence: creationSource === "consolidation" ? 0.9 : 1,
      creationSource,
    }, id));
    const usedPaths = new Set([...this.memories.values()].map((item) => item.path.toLowerCase()));
    const base = `${this.folder}/${pathTitle(title)}.md`;
    const notePath = usedPaths.has(base.toLowerCase())
      ? `${this.folder}/${pathTitle(title)}-${id.slice(0, 8)}.md`
      : base;
    await this.mcp.writeNote(notePath, serializeMemory(null, memory), false);
    await this.refresh();
    await this.#maintainWiki("create", this.memories.get(id));
    return this.get(id);
  }

  async update(id, input) {
    const cached = this.memories.get(id);
    if (!cached) throw Object.assign(new Error("memory not found"), { statusCode: 404 });
    const current = parseMemory(cached.path, await this.mcp.readNote(cached.path));
    if (input.revision && input.revision !== current.revision) {
      await this.refresh();
      throw new MemoryConflictError("This memory changed in Obsidian. Reload it before saving your edits.");
    }
    const fields = {
      id,
      title: safeTitle(input.title),
      body: String(input.body ?? "").trim(),
      tags: stringList(input.tags),
      links: stringList(input.links).filter((link) => link !== id && this.memories.has(link)),
      source: current.source,
      memoryType: current.memoryType,
      managedKey: current.managedKey,
      memoryState: current.memoryState,
      supersededBy: current.supersededBy,
    };
    const automatic = current.connections.filter((connection) => connection.creationSource !== "manual");
    const manual = fields.links.map((target) => normalizeConnection({
      target,
      relationType: "related",
      creationSource: "manual",
      weight: 1,
      confidence: 1,
    }, id, { createdAt: current.createdAt }));
    fields.connections = mergeConnections([...automatic, ...manual]);
    await this.mcp.writeNote(current.path, serializeMemory(current, fields), true);
    await this.refresh();
    await this.#maintainWiki("update", this.memories.get(id));
    return this.get(id);
  }

  async addRelationship(fromId, toId, metadata = {}) {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (!from || !to) throw Object.assign(new Error("relationship memory not found"), { statusCode: 404 });
    if (fromId === toId) throw Object.assign(new Error("a memory cannot link to itself"), { statusCode: 400 });
    const current = this.memories.get(fromId);
    const manualExists = current.connections.some(
      (connection) => connection.target === toId && connection.creationSource === "manual",
    );
    if (manualExists) return from;
    const automaticExists = current.connections.some(
      (connection) =>
        connection.target === toId &&
        connection.relationType === (metadata.relationType ?? metadata.label ?? "related") &&
        connection.creationSource === metadata.creationSource,
    );
    if (automaticExists) return from;
    const connection = normalizeConnection({
      source: fromId,
      target: toId,
      relationType: metadata.relationType ?? metadata.label ?? "related",
      weight: metadata.weight,
      confidence: metadata.confidence,
      creationSource: metadata.creationSource ?? "agent-approved",
      activationCount: metadata.activationCount,
      lastActivatedAt: metadata.lastActivatedAt,
      createdAt: metadata.createdAt,
    }, fromId);
    return this.replaceConnections(fromId, mergeConnections([...current.connections, connection]), "connect");
  }

  async markSuperseded(id, supersededBy) {
    const current = this.memories.get(id);
    if (!current) throw Object.assign(new Error("memory not found"), { statusCode: 404 });
    if (!this.memories.has(supersededBy)) {
      throw Object.assign(new Error("superseding memory not found"), { statusCode: 404 });
    }
    return this.#writeFields(current, {
      ...current,
      memoryState: "superseded",
      supersededBy,
      connections: current.connections,
    }, "supersede");
  }

  async replaceConnections(id, connections, operation = "connections") {
    const current = this.memories.get(id);
    if (!current) throw Object.assign(new Error("memory not found"), { statusCode: 404 });
    return this.#writeFields(current, { ...current, connections: mergeConnections(connections) }, operation);
  }

  async #writeFields(cached, fields, operation) {
    const current = parseMemory(cached.path, await this.mcp.readNote(cached.path));
    await this.mcp.writeNote(current.path, serializeMemory(current, {
      id: current.id,
      title: fields.title,
      body: fields.body,
      tags: fields.tags,
      source: fields.source,
      memoryType: fields.memoryType,
      managedKey: fields.managedKey,
      connections: fields.connections,
      memoryState: fields.memoryState,
      supersededBy: fields.supersededBy,
    }), true);
    await this.refresh();
    await this.#maintainWiki(operation, this.memories.get(current.id));
    return this.get(current.id);
  }

  async delete(id, input = {}) {
    const cached = this.memories.get(id);
    if (!cached) throw Object.assign(new Error("memory not found"), { statusCode: 404 });
    const current = parseMemory(cached.path, await this.mcp.readNote(cached.path));
    if (input.revision && input.revision !== current.revision) {
      await this.refresh();
      throw new MemoryConflictError("This memory changed in Obsidian. Reload it before deleting it.");
    }

    for (const related of this.memories.values()) {
      if (related.id === id || !related.links.includes(id)) continue;
      const latest = parseMemory(related.path, await this.mcp.readNote(related.path));
      await this.mcp.writeNote(
        latest.path,
        serializeMemory(latest, {
          id: latest.id,
          title: latest.title,
          body: latest.body,
          tags: latest.tags,
          source: latest.source,
          memoryType: latest.memoryType,
          managedKey: latest.managedKey,
          connections: latest.connections.filter((connection) => connection.target !== id),
          memoryState: latest.memoryState,
          supersededBy: latest.supersededBy === id ? null : latest.supersededBy,
        }),
        true,
      );
    }

    await this.mcp.deleteNote(current.path);
    await this.refresh();
    await this.#maintainWiki("delete", current);
    return { id: current.id, title: current.title };
  }

  async #maintainWiki(operation, changedMemory) {
    const grouped = new Map([
      ["Agent Instructions", []],
      ["Projects", []],
      ["Shared Lessons", []],
      ["People", []],
      ["Preferences", []],
      ["Decisions", []],
      ["Other", []],
    ]);
    for (const memory of this.list()) {
      const tags = memory.tags.map((tag) => tag.toLowerCase());
      const section = memory.memoryType === "agent_instruction"
        ? "Agent Instructions"
        : memory.memoryType === "project"
          ? "Projects"
          : memory.memoryType === "shared_lesson"
            ? "Shared Lessons"
          : tags.some((tag) => ["person", "people", "identity"].includes(tag))
            ? "People"
        : tags.some((tag) => ["preference", "preferences"].includes(tag))
          ? "Preferences"
          : tags.some((tag) => ["decision", "decisions"].includes(tag))
            ? "Decisions"
            : "Other";
      grouped.get(section).push(memory);
    }
    const sections = [...grouped.entries()]
      .filter(([, items]) => items.length)
      .map(
        ([section, items]) =>
          `## ${section}\n\n${items.map((memory) => `- [[${memory.path.replace(/\.md$/i, "")}\|${memory.title}]] — ${memory.excerpt || "No summary yet."}`).join("\n")}`,
      )
      .join("\n\n");
    const index = `# Second Brain Index\n\nThe index is the routing map for approved wiki pages. Jarvis updates it after an approved write.\n\n${sections}\n\n## Status\n\n- Approved wiki pages: ${this.memories.size}\n- Automatic conversation capture: disabled\n`;
    await this.mcp.writeNote(`${this.folder}/index.md`, index, true);
    if (changedMemory) {
      const date = new Date().toISOString().slice(0, 10);
      await this.mcp.appendNote(
        `${this.folder}/log.md`,
        `\n## [${date}] ${operation} | ${changedMemory.title}\n\nApproved wiki page ${operation}d through Jarvis.\n`,
        true,
      );
    }
  }

  findManaged(memoryType, managedKey) {
    return this.list().find(
      (memory) => memory.memoryType === memoryType && memory.managedKey === cleanText(managedKey),
    ) ?? null;
  }
}
