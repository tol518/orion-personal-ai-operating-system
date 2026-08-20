import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentInstructions,
  createAgentWithMemory,
  normalizeAgentId,
} from "./agent-creator.js";

function fixture({ memoryError = null, connected = true } = {}) {
  const gatewayCalls = [];
  const profiles = new Map();
  const memoryLinks = [];
  const deps = {
    gateway: {
      request: async (method, params) => {
        gatewayCalls.push({ method, params });
        if (method === "agents.create") {
          return { ok: true, agentId: "vega-navigator", name: "Vega Navigator", workspace: params.workspace };
        }
        return { ok: true };
      },
    },
    attachmentStore: {
      get: (id) => ({ id, mimeType: "image/png" }),
      list: (ids) => ids.map((id) => ({ id, mimeType: "image/png" })),
      setForMemory: (memoryId, ids) => memoryLinks.push({ memoryId, ids }),
      removeMemory: () => undefined,
    },
    profiles: {
      set: (profile) => profiles.set(profile.agentId, profile),
      get: (agentId) => profiles.get(agentId) ?? null,
      getAnalysis: (attachmentId) => ({
        attachmentId,
        provider: "openai",
        model: "openai/gpt-5.4",
        animationSpec: {
          columns: 4,
          rows: 2,
          animations: {
            idle: [0],
            walking: [1, 2],
            sitting: [3],
            working: [4, 5],
            dancing: [6, 7],
          },
        },
      }),
      remove: (agentId) => profiles.delete(agentId),
    },
    memories: {
      version: "v1",
      status: () => ({ connected }),
      findManaged: () => null,
      list: () => [],
      delete: async () => undefined,
    },
    managedMemories: {
      upsert: async (input) => {
        if (memoryError) throw memoryError;
        return { id: "memory-1", revision: "rev-1", ...input };
      },
    },
    neuralEngine: { runNow: async () => ({}) },
    broadcast: () => undefined,
  };
  return { deps, gatewayCalls, profiles, memoryLinks };
}

const input = {
  name: "Vega Navigator",
  role: "Research specialist",
  instructions: "Map sources, compare evidence, and report uncertainty.",
  model: "openai/gpt-5.5",
  appearanceAttachmentId: "appearance-1",
  appearancePrompt: "Silver suit and blue visor",
  referenceAttachmentIds: ["reference-1"],
};

test("normalizes agent IDs the same way as the gateway path-safe fallback", () => {
  assert.equal(normalizeAgentId("  Vega Navigator!  "), "vega-navigator");
});

test("creates an OpenClaw agent, writes instructions, and records Second Brain memory", async () => {
  const { deps, gatewayCalls, profiles, memoryLinks } = fixture();
  const result = await createAgentWithMemory(deps, input);
  assert.equal(result.agent.agentId, "vega-navigator");
  assert.deepEqual(gatewayCalls[0], {
    method: "agents.create",
    params: {
      name: "Vega Navigator",
      workspace: "~/.openclaw/workspace-vega-navigator",
      model: "openai/gpt-5.5",
    },
  });
  assert.equal(gatewayCalls[1].method, "agents.files.set");
  assert.match(gatewayCalls[1].params.content, /Map sources, compare evidence/);
  assert.equal(profiles.get("vega-navigator").role, "Research specialist");
  assert.equal(profiles.get("vega-navigator").appearanceModel, "openai/gpt-5.4");
  assert.deepEqual(memoryLinks, [{
    memoryId: "memory-1",
    ids: ["appearance-1", "reference-1"],
  }]);
});

test("removes the new config entry when Second Brain persistence fails", async () => {
  const { deps, gatewayCalls, profiles } = fixture({ memoryError: new Error("vault offline") });
  await assert.rejects(() => createAgentWithMemory(deps, input), /vault offline/);
  assert.deepEqual(gatewayCalls.at(-1), {
    method: "agents.delete",
    params: { agentId: "vega-navigator", deleteFiles: false },
  });
  assert.equal(profiles.has("vega-navigator"), false);
});

test("refuses creation while Second Brain is disconnected", async () => {
  const { deps, gatewayCalls } = fixture({ connected: false });
  await assert.rejects(() => createAgentWithMemory(deps, input), /Second Brain is unavailable/);
  assert.equal(gatewayCalls.length, 0);
});

test("formats role and instructions into the canonical AGENTS.md file", () => {
  const content = buildAgentInstructions({
    name: "Vega",
    role: "Navigator",
    instructions: "Verify every coordinate.",
  });
  assert.match(content, /^# AGENTS\.md/);
  assert.match(content, /- Role: Navigator/);
  assert.match(content, /Verify every coordinate\./);
});
