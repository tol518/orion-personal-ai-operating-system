import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryAwareMessage, decorateChatEvent } from "./chat-memory.js";

test("chat context identifies shared lessons and requests evidence-based reflection", () => {
  const message = buildMemoryAwareMessage("Retry the browser task", [{
    id: "lesson-1",
    title: "Recover the browser session",
    body: "Trigger: Page lost\n\nBetter approach: Reconnect\n\nAvoid: Duplicate sessions\n\nVerify: Check URL",
    memoryType: "shared_lesson",
    managedKey: "browser-recovery",
  }]);

  assert.match(message, /type="shared_lesson" managedKey="browser-recovery"/);
  assert.match(message, /procedural memory for every current and future agent/);
  assert.match(message, /No-op is preferred when there is no durable lesson/);
  assert.match(message, /include its Agent Instructions, relevant Project context, and relevant Shared Lessons/);
  assert.match(message, /saves valid marked memories and relationships automatically/);
});

test("final chat metadata strips the hidden marker and exposes a managed lesson action", () => {
  const payload = {
    state: "final",
    sessionKey: "agent:codex:dashboard:test",
    message: {
      role: "assistant",
      content: "Done.\n<!-- jarvis-managed-memory-upserts:[{\"memoryType\":\"shared_lesson\",\"managedKey\":\"browser-recovery\",\"title\":\"Recover the browser session\",\"body\":\"Trigger: Page lost\\n\\nBetter approach: Reconnect\\n\\nAvoid: Duplicate sessions\\n\\nVerify: Check URL\",\"tags\":[\"browser\"]}] -->",
    },
  };
  const memoryStore = { get: () => null };
  const result = decorateChatEvent(payload, memoryStore);

  assert.equal(result.message.content, "Done.");
  assert.equal(result.managedMemoryUpserts.length, 1);
  assert.equal(result.managedMemoryUpserts[0].memoryType, "shared_lesson");
  assert.equal(result.managedMemoryUpserts[0].managedKey, "browser-recovery");
});

test("attached files are named in context and can be linked by an agent memory action", () => {
  const attachment = { id: "file-1", fileName: "evidence.pdf", mimeType: "application/pdf", sizeBytes: 42 };
  const prompt = buildMemoryAwareMessage("Remember this", [], "", { user: [attachment], memory: [] });
  assert.match(prompt, /<jarvis-attachments>/);
  assert.match(prompt, /"id":"file-1"/);

  const result = decorateChatEvent({
    state: "final",
    message: {
      role: "assistant",
      content: 'Saved.\n<!-- jarvis-memory-proposals:[{"type":"memory","title":"Evidence","body":"Reference document","tags":["evidence"],"attachmentIds":["file-1"]}] -->',
    },
  }, { get: () => null });
  assert.deepEqual(result.memoryActions[0].payload.attachmentIds, ["file-1"]);
});
