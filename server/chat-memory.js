import { BLACK_NOIR_AGENT_ID, canAgentReadMemory, EXTRACTION_MEMORY_TAG } from "./managed-memory.js";

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

function catalogJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function blackNoirExtractionCatalog(catalog) {
  if (!catalog) return "";
  const supportedSites = Array.isArray(catalog.supportedSites)
    ? [...new Set(catalog.supportedSites.map((site) => String(site).trim()).filter(Boolean))].slice(0, 20)
    : [];
  const serverManagedSites = Array.isArray(catalog.serverManagedSites)
    ? [...new Set(catalog.serverManagedSites.map((site) => String(site).trim()).filter(Boolean))]
        .filter((site) => supportedSites.includes(site))
        .slice(0, 20)
    : [];
  const customExtractors = Array.isArray(catalog.customExtractors)
    ? catalog.customExtractors.slice(0, 20).map((extractor) => ({
        name: String(extractor?.name ?? "").trim().slice(0, 120),
        sites: Array.isArray(extractor?.sites)
          ? [...new Set(extractor.sites.map((site) => String(site).trim()).filter(Boolean))].slice(0, 8)
          : [],
      })).filter((extractor) => extractor.name && extractor.sites.length > 0)
    : [];
  return `<jarvis-extraction-catalog>\n${catalogJson({ supportedSites, serverManagedSites, customExtractors })}\n</jarvis-extraction-catalog>\n\n`;
}

export function buildMemoryAwareMessage(
  userMessage,
  memories,
  executionPolicy = "",
  attachments = {},
  agentId = "main",
  extractionCatalog = null,
) {
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
  const extractionCatalogContext = agentId === BLACK_NOIR_AGENT_ID
    ? blackNoirExtractionCatalog(extractionCatalog)
    : "";
  const memoryRules = agentId === BLACK_NOIR_AGENT_ID
    ? `Memory rules:\n` +
      `- You are isolated to Extraction work, with one read-only exception: you may answer direct questions about a person when relevant person-labelled memories are provided.\n` +
      `- A person-profile answer may describe that person from the supplied memory, even when the question is not about extraction. Do not use this exception to inspect or operate Hunting, applications, CVs, workflows, general website features, or unrelated projects. Hand those tasks back to J.A.R.V.I.S.\n` +
      `- Use only the provided memories. They are limited to your own instruction, memories labelled ${EXTRACTION_MEMORY_TAG}, and relevant person memories. Never infer that any other memory exists.\n` +
      `- Do not create general memories, Projects, Agent Instructions, or relationships.\n` +
      `- You may save one reusable extraction procedure as a Shared Lesson by appending: ` +
      `<!-- jarvis-managed-memory-upserts:[{"memoryType":"shared_lesson","managedKey":"stable-extraction-task-family","title":"...","body":"Trigger: ...\\n\\nBetter approach: ...\\n\\nAvoid: ...\\n\\nVerify: ...","tags":["${EXTRACTION_MEMORY_TAG}","specific-retrieval-term"]}] -->\n` +
      `- Only save a proven, durable extraction lesson. Never save secrets, raw transcripts, one-off task narratives, or unrelated facts. No-op is preferred.\n` +
      `- If you receive <jarvis-extraction-catalog>, it is the authoritative list of sites Black Noir can currently accept extraction tasks for. When asked which sites or websites you support, name its supportedSites and ready custom extractors. Do not say the list is unavailable.\n` +
      `- Sites in serverManagedSites are still supported through Black Noir, but J.A.R.V.I.S. performs their browser execution on Black Noir's behalf. Explain that distinction only when relevant; do not remove those sites from Black Noir's supported list.\n` +
      `- Do not claim you can check or extract an arbitrary URL. For a site outside the catalog, say it is not currently verified for Black Noir and that J.A.R.V.I.S. can ask Codex to build and test a custom extractor.\n` +
      `- If you used memory context, append exactly one hidden marker with the used ids: ` +
      `<!-- jarvis-memory-citations:["memory-id"] -->`
    : `Memory rules:\n` +
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
  return `<jarvis-memory-context>\n${context}\n</jarvis-memory-context>\n\n` +
    executionContext +
    attachmentContext +
    extractionCatalogContext +
    `User message:\n${userMessage}\n\n` +
    memoryRules;
}

export function decorateChatEvent(payload, memoryStore, actorAgentId = "main") {
  const text = messageText(payload?.message);
  if (!text) return payload;
  const requestedIds = parseMarker(text, CITATION_MARKER, []);
  const citations = Array.isArray(requestedIds)
    ? requestedIds
        .map((id) => memoryStore.get(String(id)))
        .filter((memory) => memory && canAgentReadMemory(memory, actorAgentId))
        .map(({ id, title }) => ({ id, title }))
    : [];

  const rawProposals = parseMarker(text, PROPOSAL_MARKER, []);
  const rawManagedUpserts = parseMarker(text, MANAGED_UPSERT_MARKER, []);
  const memoryActions = [];
  if (actorAgentId !== BLACK_NOIR_AGENT_ID && Array.isArray(rawProposals)) {
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
