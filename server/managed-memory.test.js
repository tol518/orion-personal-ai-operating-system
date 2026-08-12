import test from "node:test";
import assert from "node:assert/strict";
import {
  contextForAgent,
  ManagedMemoryService,
  normalizeManagedUpsert,
  shouldLinkInstructionToProject,
  shouldLinkLessonToProject,
} from "./managed-memory.js";

test("only trusted managed types can bypass approval", () => {
  assert.equal(normalizeManagedUpsert({ memoryType: "general", title: "No", body: "No" }), null);
  assert.equal(normalizeManagedUpsert({ memoryType: "project", managedKey: "jarvis", title: "Jarvis", body: "Build it" })?.memoryType, "project");
});

test("shared lessons require reusable procedural structure", () => {
  const lesson = normalizeManagedUpsert({
    memoryType: "shared_lesson",
    managedKey: " Browser / Retry Workflow ",
    title: "Retry browser automation after reconnecting",
    body: [
      "Trigger: Browser automation loses its active page.",
      "Better approach: Reconnect to the existing page before retrying the action.",
      "Avoid: Starting a second browser session immediately.",
      "Verify: Confirm the page URL and title before continuing.",
    ].join("\n\n"),
    tags: ["browser", "recovery"],
  }, "codex");

  assert.deepEqual(lesson, {
    memoryType: "shared_lesson",
    managedKey: "browser-retry-workflow",
    title: "Retry browser automation after reconnecting",
    body: [
      "Trigger: Browser automation loses its active page.",
      "Better approach: Reconnect to the existing page before retrying the action.",
      "Avoid: Starting a second browser session immediately.",
      "Verify: Confirm the page URL and title before continuing.",
    ].join("\n\n"),
    tags: ["shared-lesson", "procedural-memory", "learned-by:codex", "browser", "recovery"],
  });
  assert.equal(normalizeManagedUpsert({
    memoryType: "shared_lesson",
    managedKey: "browser-retry-workflow",
    title: "Unstructured",
    body: "Remember to retry the browser.",
  }, "codex"), null);
  assert.equal(normalizeManagedUpsert({
    memoryType: "shared_lesson",
    managedKey: "browser-retry-workflow",
    title: "Empty verification",
    body: "Trigger: Failure\n\nBetter approach: Retry\n\nAvoid: Guessing\n\nVerify: ",
  }, "codex"), null);
});

test("required shared lesson tags cannot be crowded out", () => {
  const lesson = normalizeManagedUpsert({
    memoryType: "shared_lesson",
    managedKey: "browser-retry-workflow",
    title: "Retry browser automation",
    body: "Trigger: Browser failure\n\nBetter approach: Reconnect first\n\nAvoid: Duplicate sessions\n\nVerify: Check the URL",
    tags: Array.from({ length: 20 }, (_, index) => `custom-${index}`),
  }, "black-noir");

  assert.deepEqual(lesson?.tags.slice(0, 3), [
    "shared-lesson",
    "procedural-memory",
    "learned-by:black-noir",
  ]);
  assert.equal(lesson?.tags.length, 20);
});

test("an agent cannot rewrite another agent instruction", () => {
  assert.equal(normalizeManagedUpsert({ memoryType: "agent_instruction", managedKey: "main", title: "Main", body: "Lead" }, "codex"), null);
  assert.equal(normalizeManagedUpsert({ memoryType: "agent_instruction", managedKey: "codex", title: "Codex", body: "Code" }, "codex")?.managedKey, "codex");
});

test("project mentions create a relevant agent link", () => {
  const instruction = { memoryType: "agent_instruction", managedKey: "black-noir", title: "Black Noir Instructions", body: "Role: stealth operations and field reconnaissance", tags: [] };
  const project = { memoryType: "project", title: "Night Watch", body: "Black Noir handles stealth operations for this project.", tags: [] };
  assert.equal(shouldLinkInstructionToProject(instruction, project), true);
});

test("shared lessons link to their author and tagged project", async () => {
  const lesson = {
    id: "lesson",
    memoryType: "shared_lesson",
    title: "J.A.R.V.I.S. backend test location",
    body: "Trigger: Backend test request.\n\nBetter approach: Run npm test in the server folder.\n\nAvoid: Running it from the project root.\n\nVerify: Report the passing test count.",
    tags: ["shared-lesson", "procedural-memory", "learned-by:codex", "jarvis", "backend"],
  };
  const codex = { id: "codex", memoryType: "agent_instruction", managedKey: "codex", tags: [] };
  const project = { id: "project", memoryType: "project", title: "J.A.R.V.I.S. Control App", body: "Dashboard work", tags: ["project", "jarvis"] };
  const links = [];
  const service = new ManagedMemoryService({
    list: () => [lesson, codex, project],
    addRelationship: async (source, target, metadata) => links.push({ source, target, metadata }),
  });

  assert.equal(shouldLinkLessonToProject(lesson, project), true);
  await service.syncProjectLinks();

  assert.deepEqual(links, [
    { source: "lesson", target: "codex", metadata: { relationType: "derived_from", weight: 0.92, confidence: 0.98, creationSource: "agent-managed" } },
    { source: "lesson", target: "project", metadata: { relationType: "same_project", weight: 0.9, confidence: 0.95, creationSource: "agent-managed" } },
  ]);
});

test("spawn context includes projects and only the selected agent instruction", () => {
  const memories = [
    { id: "p", memoryType: "project", managedKey: "p" },
    { id: "main", memoryType: "agent_instruction", managedKey: "main" },
    { id: "codex", memoryType: "agent_instruction", managedKey: "codex" },
  ];
  assert.deepEqual(contextForAgent(memories, "codex").map(({ id }) => id), ["p", "codex"]);
  assert.deepEqual(contextForAgent(memories, "main").map(({ id }) => id), ["p", "main", "codex"]);
});

test("relevant shared lessons flow to existing and future agents", () => {
  const memories = [
    { id: "p", memoryType: "project", managedKey: "p" },
    { id: "main", memoryType: "agent_instruction", managedKey: "main" },
    { id: "future", memoryType: "agent_instruction", managedKey: "future" },
  ];
  const lesson = { id: "lesson", memoryType: "shared_lesson", managedKey: "browser-retry" };

  assert.deepEqual(
    contextForAgent(memories, "future", [lesson]).map(({ id }) => id),
    ["p", "future", "lesson"],
  );
  assert.deepEqual(
    contextForAgent(memories, "new-agent-without-custom-code", [lesson]).map(({ id }) => id),
    ["p", "lesson"],
  );
});

test("a second agent improves the same shared lesson instead of duplicating it", async () => {
  const existing = {
    id: "lesson",
    memoryType: "shared_lesson",
    managedKey: "browser-retry",
    title: "Recover browser tasks",
    body: "old",
    tags: [
      "shared-lesson",
      "procedural-memory",
      "learned-by:main",
      ...Array.from({ length: 17 }, (_, index) => `existing-${index}`),
    ],
    manualLinks: [],
    revision: "revision-1",
  };
  let updateCount = 0;
  const memoryStore = {
    findManaged: () => existing,
    list: () => [existing],
    create: async () => { throw new Error("unexpected duplicate"); },
    update: async (id, input) => {
      updateCount += 1;
      return { ...existing, ...input, id };
    },
    addRelationship: async () => undefined,
  };
  const service = new ManagedMemoryService(memoryStore);

  const updated = await service.upsert({
    memoryType: "shared_lesson",
    managedKey: "browser-retry",
    title: "Recover browser tasks",
    body: "Trigger: Browser task loses its page.\n\nBetter approach: Reconnect to the page.\n\nAvoid: Opening duplicate sessions.\n\nVerify: Check the page URL.",
    tags: ["browser"],
  }, "codex");

  assert.equal(updateCount, 1);
  assert.equal(updated.id, "lesson");
  assert.ok(updated.tags.includes("learned-by:main"));
  assert.ok(updated.tags.includes("learned-by:codex"));
});
