import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CustomExtractorBuilder } from "./custom-extractor-builder.js";
import { customExtractorTaskInput, CustomExtractorStore, __testing } from "./custom-extractors.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-custom-extractors-"));
  const bundled = path.join(root, "bundled");
  fs.mkdirSync(bundled);
  fs.writeFileSync(path.join(bundled, "launch.sh"), "echo ready\n");
  const store = new CustomExtractorStore(path.join(root, "jarvis.sqlite"), {
    root: path.join(root, "artifacts"),
    bundledTemplateRoot: bundled,
  });
  return { root, store };
}

test("the bundled comparison extractor is ready for Codex-built, Black-Noir-run tasks", () => {
  const { root, store } = fixture();
  try {
    const extractor = store.ensureBundledProviderAProviderC();
    assert.equal(extractor.status, "ready");
    assert.equal(extractor.builderAgentId, "codex");
    assert.equal(extractor.runnerAgentId, "black-noir");
    assert.deepEqual(extractor.sites, ["ProviderA", "ProviderC", "ProviderB", "ProviderD"]);
    assert.equal(extractor.pairMode, "any-two");
    assert.deepEqual(extractor.supportedPairs, []);
    assert.equal(extractor.entrypoint, "source/run-direct-api.js");
    assert.match(extractor.runInstructions, /Choose any two/);
    assert.equal(extractor.defaults.travelStart, "2027-04-01");
    assert.equal(extractor.maxTravelDates, 240);
    assert.ok(fs.existsSync(path.join(extractor.artifactDir, "source", "launch.sh")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a folder upload is bounded, staged safely, and starts as a Codex build", () => {
  const { root, store } = fixture();
  try {
    const draft = store.createDraft({
      name: "Hotel parser",
      description: "Extract hotel prices.",
      files: [{ path: "sample/parser.js", contentBase64: Buffer.from("export {};\n").toString("base64") }],
    });
    assert.equal(draft.status, "building");
    assert.equal(draft.sourceKind, "brief-and-folder");
    assert.equal(draft.fileCount, 1);
    assert.ok(fs.existsSync(path.join(draft.artifactDir, "source", "sample", "parser.js")));
    assert.throws(
      () => store.createDraft({ name: "bad", files: [{ path: "../.env", contentBase64: "" }] }),
      /Unsafe uploaded path|Sensitive files/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex completion is accepted only after a valid manifest exists", async () => {
  const { root, store } = fixture();
  try {
    const builder = new CustomExtractorBuilder({
      store,
      dispatch: async (extractor) => {
        fs.writeFileSync(
          path.join(extractor.artifactDir, "extractor.json"),
          JSON.stringify({
            name: "Hotel parser",
            description: "Ready",
            sites: ["Example Travel"],
            entrypoint: "package/run.js",
            runInstructions: "Run it with the task parameters.",
            defaults: { destination: "Antalya", travelStart: "2027-04-01", travelEnd: "2027-04-07", nights: "7" },
            maxTravelDates: 30,
          }),
        );
        return "Syntax tests passed.";
      },
    });
    const draft = builder.create({ name: "Hotel parser", description: "Build it" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const ready = store.get(draft.id);
    assert.equal(ready.status, "ready");
    assert.equal(ready.runnerAgentId, "black-noir");
    assert.match(ready.buildDetail, /Syntax tests passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uploaded secret-like files are rejected before Codex sees them", () => {
  assert.throws(() => __testing.safeRelativePath("project/.env.local"), /Sensitive files/);
  assert.throws(() => __testing.safeRelativePath("credentials.json"), /Sensitive files/);
});

test("a malformed Codex date limit falls back to the safe default", () => {
  assert.equal(__testing.normalizeManifest({ sites: ["Example"], maxTravelDates: "many" }).maxTravelDates, 120);
  assert.equal(__testing.normalizeManifest({ sites: ["Example"], maxTravelDates: 10.9 }).maxTravelDates, 10);
});

test("custom tasks are always assigned to Black Noir with manifest-owned sites", () => {
  const input = customExtractorTaskInput(
    { agentId: "main", sites: ["Untrusted site"], destination: "Antalya" },
    {
      id: "custom-1",
      status: "ready",
      sites: ["ProviderA", "ProviderC"],
    },
  );
  assert.equal(input.agentId, "black-noir");
  assert.equal(input.customExtractorId, "custom-1");
  assert.deepEqual(input.sites, ["ProviderA", "ProviderC"]);
});

test("an any-two custom extractor preserves and validates the requested pair", () => {
  const extractor = {
    id: "dynamic-1",
    name: "Dynamic Travel Comparison",
    status: "ready",
    pairMode: "any-two",
    sites: ["ProviderA", "ProviderC", "ProviderB", "ProviderD"],
  };
  const input = customExtractorTaskInput(
    { agentId: "main", sites: ["ProviderD", "ProviderA"], destination: "Antalya" },
    extractor,
  );
  assert.deepEqual(input.sites, ["ProviderD", "ProviderA"]);
  assert.throws(
    () => customExtractorTaskInput({ sites: ["ProviderD", "Unknown"] }, extractor),
    /Choose two different sites/,
  );
});
