import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "./memory-store.js";

class MemoryMcp {
  configured = true;
  connected = true;
  notes = new Map();

  async listNotes(prefix) {
    return [...this.notes.keys()].filter((path) => path.startsWith(prefix));
  }

  async readNote(path) {
    const note = this.notes.get(path);
    if (note === undefined) throw new Error(`missing note: ${path}`);
    return note;
  }

  async writeNote(path, body) {
    this.notes.set(path, body);
  }

  async appendNote(path, body) {
    this.notes.set(path, `${this.notes.get(path) ?? ""}${body}`);
  }

  async deleteNote(path) {
    this.notes.delete(path);
  }

  stop() {}
}

test("shared lessons are persisted as agent-managed memory and retrieved by task relevance", async () => {
  const store = new MemoryStore({ mcp: new MemoryMcp(), intervalMs: 60_000 });
  const lesson = await store.create({
    id: "lesson-browser-recovery",
    memoryType: "shared_lesson",
    managedKey: "browser-recovery",
    title: "Recover the browser session",
    body: "Trigger: Browser page is lost.\n\nBetter approach: Reconnect to the page.\n\nAvoid: Duplicate sessions.\n\nVerify: Check the URL.",
    tags: ["browser", "recovery", "shared-lesson"],
  }, "agent-managed");
  await store.create({
    id: "general-preference",
    title: "Favorite tea",
    body: "The user likes mint tea.",
    tags: ["preference"],
  });

  assert.equal(lesson.memoryType, "shared_lesson");
  assert.equal(lesson.source, "agent-managed");
  assert.deepEqual(
    store.retrieve("browser session recovery", 2, "shared_lesson").map(({ id }) => id),
    ["lesson-browser-recovery"],
  );
  assert.equal(store.retrieve("mint tea", 2, "shared_lesson").length, 0);
  assert.deepEqual(
    store.retrieve("browser mint tea", 4, "general").map(({ id }) => id),
    ["general-preference"],
  );
});

test("nearest-neighbor relationships retain their explicit graph relation type", async () => {
  const store = new MemoryStore({ mcp: new MemoryMcp(), intervalMs: 60_000 });
  await store.create({ id: "first", title: "First", body: "One", tags: [] });
  await store.create({ id: "second", title: "Second", body: "Two", tags: [] });

  await store.addRelationship("first", "second", {
    relationType: "nearest_neighbor",
    creationSource: "neural-nearest-neighbor",
    weight: 0.35,
    confidence: 0.2,
  });

  assert.equal(store.get("first").connections[0].relationType, "nearest_neighbor");
  assert.equal(store.graph().edges[0].relationType, "nearest_neighbor");
});
