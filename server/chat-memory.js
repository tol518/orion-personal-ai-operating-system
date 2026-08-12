const CITATION_MARKER = /<!--\s*jarvis-memory-citations\s*:\s*([\s\S]*?)-->/i;
const PROPOSAL_MARKER = /<!--\s*jarvis-memory-proposals\s*:\s*([\s\S]*?)-->/i;
const MANAGED_UPSERT_MARKER = /<!--\s*jarvis-managed-memory-upserts\s*:\s*([\s\S]*?)-->/i;
const ALL_MARKERS = /<!--\s*jarvis-(?:memory-(?:citations|proposals)|managed-memory-upserts)\s*:[\s\S]*?-->/gi;

function attribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseMarker(text, pattern, fallback) {
  const match = text.match(pattern);
  if (!match) return fallback;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return fallback;
  }
}

function messageText(message) {
  if (typeof message === "string") return message;
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((item) => (typeof item === "string" ? item : item?.text ?? "")).join("");
  }
  return "";
}

function withMessageText(message, text) {
  if (typeof message === "string") return text;
  if (typeof message?.text === "string") return { ...message, text };
  if (typeof message?.content === "string") return { ...message, content: text };
  if (Array.isArray(message?.content)) {
    let replaced = false;
    return {
      ...message,
      content: message.content.map((item) => {
        if (replaced) return item;
        if (typeof item === "string") {
          replaced = true;
          return text;
        }
        if (typeof item?.text === "string") {
          replaced = true;
          return { ...item, text };
        }
        return item;
      }),
    };
  }
  return message;
}

export function buildMemoryAwareMessage(userMessage, memories, executionPolicy = "", attachments = {}) {
  const context = memories.length
    ? memories
        .map(
          (memory) =>
            `<memory id="${attribute(memory.id)}" title="${attribute(memory.title)}" type="${attribute(memory.memoryType)}" managedKey="${attribute(memory.managedKey)}">\n${memory.body}\n</memory>`,
        )
        .join("\n")
    : "(No relevant approved memories were retrieved.)";
  const executionContext = executionPolicy
    ? `<jarvis-execution-policy>\n${executionPolicy}\n</jarvis-execution-policy>\n\n`
    : "";
  const attachmentContext = [...(attachments.user ?? []), ...(attachments.memory ?? [])].length
    ? `<jarvis-attachments>\n${JSON.stringify({ user: attachments.user ?? [], memory: attachments.memory ?? [] })}\n</jarvis-attachments>\n\n`
    : "";
  return `<jarvis-memory-context>\n${context}\n</jarvis-memory-context>\n\n` +
    executionContext +
    attachmentContext +
    `User message:\n${userMessage}\n\n` +
    `Memory rules:\n` +
    `- Use only memories that are genuinely relevant to the answer.\n` +
    `- Never claim that an unprovided memory exists.\n` +
    `- Do not save a memory or relationship yourself except through the hidden markers below.\n` +
    `- Exception: you may create or update Agent Instructions, Projects, and Shared Lessons by appending one hidden marker: ` +
    `<!-- jarvis-managed-memory-upserts:[{"memoryType":"shared_lesson","managedKey":"stable-task-family","title":"...","body":"Trigger: ...\\n\\nBetter approach: ...\\n\\nAvoid: ...\\n\\nVerify: ...","tags":["specific","retrieval","terms"]}] -->\n` +
    `- Agent Instructions and Projects are only for current operating instructions or active project context. Never auto-write personal facts or ordinary conversation memories.\n` +
    `- Shared Lessons are procedural memory for every current and future agent. At the end of the turn, silently add or update one only when evidence from this task would make a future similar task materially better: a user correction, a resolved mistake, a proven non-trivial workflow, or a verification step that prevented failure.\n` +
    `- A Shared Lesson must be reusable and evidence-based. Use the exact Trigger / Better approach / Avoid / Verify body shape above, a stable class-level managedKey, and discriminative tags. If a relevant Shared Lesson is already provided, update that same managedKey with the complete improved lesson instead of creating a duplicate.\n` +
    `- Never save secrets, raw transcripts, one-off task narratives, generic advice, temporary setup failures, or claims that a tool is permanently broken. If a retry or setup change solved a failure, save the proven fix and verification—not the transient failure. No-op is preferred when there is no durable lesson.\n` +
    `- When delegating or spawning an agent, include its Agent Instructions, relevant Project context, and relevant Shared Lessons in the assigned task.\n` +
    `- If you used memory context, append exactly one hidden marker with the used ids: ` +
    `<!-- jarvis-memory-citations:["memory-id"] -->\n` +
    `- If a durable memory or relationship is worth keeping, append one hidden marker with JSON memory actions: ` +
    `<!-- jarvis-memory-proposals:[{"type":"memory","title":"...","body":"...","tags":[],"attachmentIds":["an available attachment id"]}] -->\n` +
    `- Attachment ids may only come from <jarvis-attachments>. Include them when the user asks to save an attached file, or when the file is durable and essential to the proposed memory.\n` +
    `- J.A.R.V.I.S. saves valid marked memories and relationships automatically. Do not create a memory for every conversation; use this only for durable, relevant information.`;
}

export function decorateChatEvent(payload, memoryStore) {
  const text = messageText(payload?.message);
  if (!text) return payload;
  const requestedIds = parseMarker(text, CITATION_MARKER, []);
  const citations = Array.isArray(requestedIds)
    ? requestedIds
        .map((id) => memoryStore.get(String(id)))
        .filter(Boolean)
        .map(({ id, title }) => ({ id, title }))
    : [];

  const rawProposals = parseMarker(text, PROPOSAL_MARKER, []);
  const rawManagedUpserts = parseMarker(text, MANAGED_UPSERT_MARKER, []);
  const memoryActions = [];
  if (Array.isArray(rawProposals)) {
    for (const raw of rawProposals.slice(0, 5)) {
      const normalized = normalizeProposal(raw);
      if (!normalized) continue;
      memoryActions.push(normalized);
    }
  }
  const cleanText = text.replace(ALL_MARKERS, "").trimEnd();
  return {
    ...payload,
    message: withMessageText(payload.message, cleanText),
    memoryCitations: citations,
    memoryActions,
    managedMemoryUpserts: Array.isArray(rawManagedUpserts) ? rawManagedUpserts.slice(0, 5) : [],
  };
}

function normalizeProposal(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "memory") {
    const title = String(raw.title ?? "").trim();
    const body = String(raw.body ?? "").trim();
    if (!title || !body) return null;
    return {
      kind: "memory",
      payload: {
        title: title.slice(0, 120),
        body: body.slice(0, 10_000),
        tags: Array.isArray(raw.tags) ? raw.tags.map(String).slice(0, 20) : [],
        attachmentIds: Array.isArray(raw.attachmentIds)
          ? [...new Set(raw.attachmentIds.map(String).filter(Boolean))].slice(0, 5)
          : [],
      },
    };
  }
  if (raw.type === "relationship") {
    const fromId = String(raw.fromId ?? "").trim();
    const toId = String(raw.toId ?? "").trim();
    if (!fromId || !toId || fromId === toId) return null;
    return {
      kind: "relationship",
      payload: {
        fromId,
        toId,
        label: String(raw.label ?? "related").trim().slice(0, 80),
      },
    };
  }
  return null;
}
