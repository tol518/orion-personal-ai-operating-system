const MANAGED_TYPES = new Set(["agent_instruction", "project", "shared_lesson"]);
const WORD = /[a-z0-9]+/g;
const STOP_WORDS = new Set([
  "agent", "agents", "and", "for", "from", "into", "project", "responsibilities",
  "responsibility", "role", "task", "tasks", "that", "the", "their", "this", "with",
]);

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stringList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))].slice(0, 20)
    : [];
}

function lessonKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function isStructuredLesson(body) {
  const match = body.match(
    /^Trigger:\s*([\s\S]+?)\n+\s*Better approach:\s*([\s\S]+?)\n+\s*Avoid:\s*([\s\S]+?)\n+\s*Verify:\s*([\s\S]+?)\s*$/i,
  );
  return Boolean(match?.slice(1).every((section) => text(section).length >= 3));
}

function terms(value) {
  return new Set((text(value).toLowerCase().match(WORD) ?? []).filter(
    (word) => word.length > 2 && !STOP_WORDS.has(word),
  ));
}

export function normalizeManagedUpsert(raw, actorAgentId = "main") {
  if (!raw || typeof raw !== "object") return null;
  const memoryType = text(raw.memoryType ?? raw.memory_type);
  if (!MANAGED_TYPES.has(memoryType)) return null;
  const title = text(raw.title).slice(0, 120);
  const bodyLimit = memoryType === "shared_lesson" ? 8_000 : 20_000;
  const body = String(raw.body ?? "").trim().slice(0, bodyLimit);
  if (!title || !body) return null;
  const requestedKey = text(raw.managedKey ?? raw.managed_key);
  const managedKey = memoryType === "shared_lesson"
    ? lessonKey(requestedKey)
    : requestedKey || (memoryType === "agent_instruction" ? actorAgentId : "");
  if (!managedKey) return null;
  if (memoryType === "agent_instruction" && actorAgentId !== "main" && managedKey !== actorAgentId) {
    return null;
  }
  if (memoryType === "shared_lesson" && !isStructuredLesson(body)) return null;
  const tags = memoryType === "shared_lesson"
    ? [...new Set(["shared-lesson", "procedural-memory", `learned-by:${actorAgentId}`, ...stringList(raw.tags)])].slice(0, 20)
    : stringList(raw.tags);
  return {
    memoryType,
    managedKey: managedKey.slice(0, 120),
    title,
    body,
    tags,
  };
}

export function shouldLinkInstructionToProject(instruction, project) {
  if (instruction?.memoryType !== "agent_instruction" || project?.memoryType !== "project") return false;
  const projectText = `${project.title}\n${project.body}\n${project.tags?.join(" ") ?? ""}`.toLowerCase();
  const agentName = text(instruction.title)
    .replace(/\s+(agent\s+)?instructions?$/i, "")
    .toLowerCase();
  if (agentName.length > 2 && projectText.includes(agentName)) return true;
  if (instruction.managedKey && projectText.includes(instruction.managedKey.toLowerCase())) return true;

  const instructionTerms = terms(`${instruction.title} ${instruction.body} ${instruction.tags?.join(" ") ?? ""}`);
  const projectTerms = terms(projectText);
  let shared = 0;
  for (const term of instructionTerms) if (projectTerms.has(term)) shared += 1;
  return shared >= 3;
}

export function shouldLinkLessonToProject(lesson, project) {
  if (lesson?.memoryType !== "shared_lesson" || project?.memoryType !== "project") return false;
  const lessonTags = new Set(lesson.tags?.map((tag) => text(tag).toLowerCase()).filter(Boolean));
  const projectTags = new Set(project.tags?.map((tag) => text(tag).toLowerCase()).filter(Boolean));
  for (const tag of lessonTags) if (projectTags.has(tag)) return true;

  const lessonTerms = terms(`${lesson.title} ${lesson.body} ${lesson.tags?.join(" ") ?? ""}`);
  const projectTerms = terms(`${project.title} ${project.body} ${project.tags?.join(" ") ?? ""}`);
  let shared = 0;
  for (const term of lessonTerms) if (projectTerms.has(term)) shared += 1;
  return shared >= 3;
}

function lessonAuthorIds(lesson) {
  return (lesson.tags ?? [])
    .map((tag) => text(tag).match(/^learned-by:(.+)$/i)?.[1])
    .filter(Boolean);
}

export function contextForAgent(memories, agentId, relevant = []) {
  const trusted = memories.filter(
    (memory) =>
      memory.memoryType === "project" ||
      (memory.memoryType === "agent_instruction" && (agentId === "main" || memory.managedKey === agentId)),
  );
  const merged = new Map([...trusted, ...relevant].map((memory) => [memory.id, memory]));
  return [...merged.values()];
}

export class ManagedMemoryService {
  constructor(memoryStore) {
    this.memories = memoryStore;
  }

  async ensure(input) {
    const existing = this.memories.findManaged(input.memoryType, input.managedKey);
    return existing ?? this.memories.create(input, "agent-managed");
  }

  async upsert(raw, actorAgentId = "main") {
    const input = normalizeManagedUpsert(raw, actorAgentId);
    if (!input) throw Object.assign(new Error("invalid managed memory upsert"), { statusCode: 400 });
    const existing = this.memories.findManaged(input.memoryType, input.managedKey);
    const existingLessonProvenance = existing?.tags.filter(
      (tag) => tag === "shared-lesson" || tag === "procedural-memory" || tag.startsWith("learned-by:"),
    ) ?? [];
    const mergedInput = existing && input.memoryType === "shared_lesson"
      ? { ...input, tags: [...new Set([...input.tags, ...existingLessonProvenance, ...existing.tags])].slice(0, 20) }
      : input;
    const memory = existing
      ? await this.memories.update(existing.id, { ...mergedInput, links: existing.manualLinks, revision: existing.revision })
      : await this.memories.create(mergedInput, "agent-managed");
    await this.syncProjectLinks();
    return memory;
  }

  async apply(actions, actorAgentId = "main") {
    const results = [];
    for (const action of actions.slice(0, 5)) {
      const normalized = normalizeManagedUpsert(action, actorAgentId);
      if (!normalized) continue;
      results.push(await this.upsert(normalized, actorAgentId));
    }
    return results;
  }

  async syncProjectLinks() {
    const all = this.memories.list();
    const instructions = all.filter((memory) => memory.memoryType === "agent_instruction");
    const projects = all.filter((memory) => memory.memoryType === "project");
    const lessons = all.filter((memory) => memory.memoryType === "shared_lesson");
    for (const instruction of instructions) {
      for (const project of projects) {
        if (!shouldLinkInstructionToProject(instruction, project)) continue;
        await this.memories.addRelationship(instruction.id, project.id, {
          relationType: "same_project",
          weight: 0.92,
          confidence: 0.95,
          creationSource: "agent-managed",
        });
      }
    }
    for (const lesson of lessons) {
      const authors = new Set(lessonAuthorIds(lesson));
      for (const instruction of instructions) {
        if (!authors.has(instruction.managedKey)) continue;
        await this.memories.addRelationship(lesson.id, instruction.id, {
          relationType: "derived_from",
          weight: 0.92,
          confidence: 0.98,
          creationSource: "agent-managed",
        });
      }
      for (const project of projects) {
        if (!shouldLinkLessonToProject(lesson, project)) continue;
        await this.memories.addRelationship(lesson.id, project.id, {
          relationType: "same_project",
          weight: 0.9,
          confidence: 0.95,
          creationSource: "agent-managed",
        });
      }
    }
  }
}
