import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentProfileStore } from "./agent-profile-store.js";

const animationSpec = {
  columns: 3,
  rows: 2,
  animations: {
    idle: [0],
    walking: [1, 2],
    sitting: [3],
    working: [4, 5],
    dancing: [4, 5],
  },
};

test("persists and updates agent room profile metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-agent-profiles-"));
  try {
    const store = new AgentProfileStore(path.join(dir, "test.sqlite"));
    store.set({
      agentId: "navigator",
      role: "Research navigator",
      appearanceAttachmentId: "appearance-1",
      referenceAttachmentIds: ["reference-1", "reference-2"],
      appearancePrompt: "Silver flight suit",
      animationSpec,
      appearanceModel: "openai/gpt-5.4",
    });
    assert.deepEqual(
      {
        ...store.get("navigator"),
        createdAt: "ignored",
        updatedAt: "ignored",
      },
      {
        agentId: "navigator",
        role: "Research navigator",
        appearanceAttachmentId: "appearance-1",
        referenceAttachmentIds: ["reference-1", "reference-2"],
        appearancePrompt: "Silver flight suit",
        animationSpec,
        appearanceModel: "openai/gpt-5.4",
        createdAt: "ignored",
        updatedAt: "ignored",
      },
    );
    store.set({
      agentId: "navigator",
      role: "Deep-space research navigator",
      appearanceAttachmentId: "appearance-2",
      referenceAttachmentIds: ["reference-3"],
      appearancePrompt: "Blue visor",
      animationSpec,
      appearanceModel: "openai/gpt-5.4",
    });
    assert.equal(store.get("navigator").role, "Deep-space research navigator");
    store.remove("navigator");
    assert.equal(store.get("navigator"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persists the GPT-5.4 analysis that authorizes an uploaded sheet for agent creation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orion-agent-analysis-"));
  try {
    const store = new AgentProfileStore(path.join(dir, "test.sqlite"));
    store.setAnalysis({
      attachmentId: "sprite-1",
      provider: "openai",
      model: "openai/gpt-5.4",
      animationSpec,
      prompt: "Map this sprite sheet",
    });
    assert.deepEqual(
      { ...store.getAnalysis("sprite-1"), analyzedAt: "ignored" },
      {
        attachmentId: "sprite-1",
        provider: "openai",
        model: "openai/gpt-5.4",
        animationSpec,
        prompt: "Map this sprite sheet",
        analyzedAt: "ignored",
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
