const MAX_INSTRUCTIONS_LENGTH = 20_000;

export function normalizeAgentId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function validateCreateAgentInput(raw) {
  const name = clean(raw?.name);
  const role = clean(raw?.role);
  const instructions = String(raw?.instructions ?? "").trim();
  const model = clean(raw?.model) || undefined;
  const appearanceAttachmentId = clean(raw?.appearanceAttachmentId);
  const appearancePrompt = clean(raw?.appearancePrompt);
  const referenceAttachmentIds = uniqueStrings(raw?.referenceAttachmentIds).slice(0, 1);
  const agentId = normalizeAgentId(name);

  if (!name || name.length > 64) throw badRequest("Agent name is required and must be 64 characters or fewer");
  if (!agentId || agentId === "main") throw badRequest("Choose a different agent name");
  if (!role || role.length > 100) throw badRequest("Role is required and must be 100 characters or fewer");
  if (!instructions) throw badRequest("Agent instructions are required");
  if (instructions.length > MAX_INSTRUCTIONS_LENGTH) throw badRequest("Agent instructions must be 20,000 characters or fewer");
  if (!appearanceAttachmentId) throw badRequest("Analyze a sprite sheet before creating the agent");
  if (referenceAttachmentIds.length !== 1) throw badRequest("Create the appearance from one uploaded sprite sheet");

  return {
    name,
    role,
    instructions,
    model,
    agentId,
    appearanceAttachmentId,
    appearancePrompt,
    referenceAttachmentIds,
  };
}

export function buildAgentInstructions(input) {
  return `# AGENTS.md

## Identity

- Name: ${input.name}
- Role: ${input.role}

## Operating instructions

${input.instructions.trim()}
`;
}

export function buildAgentMemory(input, appearance) {
  return {
    memoryType: "agent_instruction",
    managedKey: input.agentId,
    title: `${input.name} Agent Instructions`,
    tags: ["agent", "agent-instructions", input.agentId],
    body: [
      `Name: ${input.name}`,
      `Agent ID: ${input.agentId}`,
      `Role: ${input.role}`,
      `Model: ${input.model ?? "OpenClaw default"}`,
      `Appearance: Uploaded sprite sheet animated by ${appearance.model} through the existing ChatGPT OAuth connection.`,
      `Animation grid: ${appearance.animationSpec.columns} columns × ${appearance.animationSpec.rows} rows.`,
      "",
      "Instructions:",
      input.instructions.trim(),
    ].join("\n"),
  };
}

export async function createAgentWithMemory(deps, rawInput) {
  const input = validateCreateAgentInput(rawInput);
  const appearance = deps.attachmentStore.get(input.appearanceAttachmentId);
  const references = deps.attachmentStore.list(input.referenceAttachmentIds);
  const appearanceAnalysis = deps.profiles.getAnalysis(input.appearanceAttachmentId);
  if (!appearance?.mimeType?.startsWith("image/")) throw badRequest("Uploaded appearance image was not found");
  if (references.length !== input.referenceAttachmentIds.length || references.some((file) => !file.mimeType.startsWith("image/"))) {
    throw badRequest("The sprite sheet must be an uploaded image");
  }
  if (!appearanceAnalysis || appearanceAnalysis.model !== "openai/gpt-5.4") {
    throw badRequest("Analyze this sprite sheet with GPT-5.4 before creating the agent");
  }
  if (deps.memories.status().connected !== true) {
    throw Object.assign(new Error("Second Brain is unavailable. Reconnect Obsidian before creating an agent."), { statusCode: 503 });
  }
  if (deps.memories.findManaged("agent_instruction", input.agentId)) {
    throw Object.assign(new Error("Second Brain already contains instructions for this agent ID"), { statusCode: 409 });
  }

  let gatewayAgent = null;
  let memory = null;
  try {
    gatewayAgent = await deps.gateway.request("agents.create", {
      name: input.name,
      workspace: `~/.openclaw/workspace-${input.agentId}`,
      ...(input.model ? { model: input.model } : {}),
    });
    await deps.gateway.request("agents.files.set", {
      agentId: gatewayAgent.agentId,
      name: "AGENTS.md",
      content: buildAgentInstructions(input),
    });
    deps.profiles.set({
      agentId: gatewayAgent.agentId,
      role: input.role,
      appearanceAttachmentId: input.appearanceAttachmentId,
      referenceAttachmentIds: input.referenceAttachmentIds,
      appearancePrompt: input.appearancePrompt,
      animationSpec: appearanceAnalysis.animationSpec,
      appearanceModel: appearanceAnalysis.model,
    });
    memory = await deps.managedMemories.upsert(buildAgentMemory(input, appearanceAnalysis), "main");
    deps.attachmentStore.setForMemory(memory.id, uniqueStrings([
      input.appearanceAttachmentId,
      ...input.referenceAttachmentIds,
    ]));
    deps.broadcast("memory.changed", {
      version: deps.memories.version,
      count: deps.memories.list().length,
    });
    deps.neuralEngine.runNow().catch(() => undefined);
    return { agent: gatewayAgent, memory, profile: deps.profiles.get(gatewayAgent.agentId) };
  } catch (error) {
    if (memory) {
      try {
        deps.attachmentStore.removeMemory(memory.id);
        await deps.memories.delete(memory.id);
      } catch {
        // Preserve the original error; the managed memory can be repaired from Second Brain.
      }
    }
    if (gatewayAgent?.agentId) {
      deps.profiles.remove(gatewayAgent.agentId);
      try {
        // Remove the failed config entry but keep the workspace so no pre-existing files are erased.
        await deps.gateway.request("agents.delete", { agentId: gatewayAgent.agentId, deleteFiles: false });
      } catch {
        // Preserve the original creation error.
      }
    }
    throw error;
  }
}

function uniqueStrings(value) {
  return Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
