import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptsExtension, repairAttachments } from "./attachment-repair.js";
import { chooseFileInput } from "./application-upload-service.js";
import { resolveSiteAdapter } from "./site-adapters.js";

const ADAPTER = resolveSiteAdapter("https://jobs.ashbyhq.com/exampleco/abc");
const CV = { name: "Example-User-CV.pdf", sha256: "a".repeat(64), bytes: 1000, browserRef: "media://inbound/Example-User-CV.pdf" };
const LETTER = { name: "ExampleCo-Automation-Engineer-9a9a952e.md", letter: "Dear ExampleCo Hiring Team,\n\nBody.\n\nYours faithfully,\nExample User" };

test("a CV field emptied by the form is re-attached", async () => {
  // Filling a form can re-render it, and a re-rendered file input starts empty.
  await withStaging(async (dir) => {
    const uploads = fakeUploads();
    const result = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: { fields: [{ index: 0, type: "file", label: "CV", required: true, value: "", accept: ".pdf" }] },
      cvArtifact: CV,
      stagingDir: dir,
    });
    assert.equal(result.cv.outcome, "uploaded");
    assert.equal(result.changed, true);
    assert.deepEqual(uploads.calls.map((call) => call.purpose), ["resume"]);
    assert.equal(uploads.calls[0].artifact.name, "Example-User-CV.pdf");
  });
});

test("a CV field that already holds the file is left alone", async () => {
  await withStaging(async (dir) => {
    const uploads = fakeUploads();
    const result = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [{ index: 0, type: "file", label: "CV", required: true, value: "Example-User-CV.pdf", accept: ".pdf" }],
      },
      cvArtifact: CV,
      stagingDir: dir,
    });
    assert.equal(result.cv, null);
    assert.equal(uploads.calls.length, 0);
  });
});

test("a file-only cover letter field takes plain text first", async () => {
  await withStaging(async (dir) => {
    const uploads = fakeUploads();
    const result = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [
          { index: 0, type: "file", label: "CV", required: true, value: "Example-User-CV.pdf" },
          { index: 1, type: "file", label: "Cover note", required: false, value: "", accept: null },
        ],
      },
      cvArtifact: CV,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(result.coverLetter.outcome, "uploaded");
    assert.equal(result.coverLetter.format, "txt");
    assert.match(result.coverLetter.artifact.name, /\.txt$/);
    assert.equal(fs.readFileSync(path.join(dir, result.coverLetter.artifact.name), "utf8").startsWith("Dear ExampleCo"), true);
    assert.deepEqual(uploads.calls.map((call) => call.purpose), ["cover-letter"]);
  });
});

test("a cover-letter field containing the CV is replaced with the generated letter", async () => {
  await withStaging(async (dir) => {
    const uploads = fakeUploads();
    const result = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [
          { index: 0, type: "file", label: "Resume/CV", required: true, value: "Example-User-CV.pdf" },
          { index: 1, type: "file", label: "Cover Letter", required: false, value: "Example-User-CV.pdf" },
        ],
      },
      cvArtifact: CV,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(result.coverLetter.outcome, "uploaded");
    assert.equal(result.coverLetter.format, "txt");
    assert.deepEqual(uploads.calls.map((call) => call.purpose), ["cover-letter"]);
    assert.match(uploads.calls[0].artifact.name, /\.txt$/);
  });
});

test("a stale cover-letter file is replaced but the generated letter is retained", async () => {
  await withStaging(async (dir) => {
    const staleUploads = fakeUploads();
    const stale = await repairAttachments({
      uploads: staleUploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: { fields: [{ index: 0, type: "file", label: "Cover letter", required: false, value: "old-letter.pdf" }] },
      cvArtifact: CV,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(stale.coverLetter.outcome, "uploaded");

    const retainedUploads = fakeUploads();
    const retained = await repairAttachments({
      uploads: retainedUploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: { fields: [{ index: 0, type: "file", label: "Cover letter", required: false, value: "ExampleCo-Automation-Engineer-9a9a952e.pdf" }] },
      cvArtifact: CV,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(retained.coverLetter, null);
    assert.equal(retainedUploads.calls.length, 0);
  });
});

test("a rejected .txt falls through to a PDF", async () => {
  await withStaging(async (dir) => {
    // The form takes the file but the page never shows it — the .txt did not stick.
    const uploads = fakeUploads({ failFor: (artifact) => artifact.name.endsWith(".txt") });
    const result = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [{ index: 0, type: "file", label: "Cover letter", required: false, value: "", accept: null }],
      },
      cvArtifact: null,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(result.coverLetter.outcome, "uploaded");
    assert.equal(result.coverLetter.format, "pdf");
    assert.deepEqual(result.coverLetter.attempts.map((a) => `${a.format}:${a.outcome}`), [
      "txt:verification_failed",
      "pdf:uploaded",
    ]);
    const pdf = fs.readFileSync(path.join(dir, result.coverLetter.artifact.name));
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  });
});

test("a PDF-only field skips straight to the PDF", async () => {
  await withStaging(async (dir) => {
    const uploads = fakeUploads();
    const result = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [{ index: 0, type: "file", label: "Cover letter", required: false, value: "", accept: ".pdf,.doc" }],
      },
      cvArtifact: null,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(result.coverLetter.format, "pdf");
    assert.equal(result.coverLetter.attempts[0].outcome, "not_accepted");
  });
});

test("when neither format lands, an optional field is skipped and a required one fails", async () => {
  await withStaging(async (dir) => {
    const uploads = fakeUploads({ failFor: () => true });
    const optional = await repairAttachments({
      uploads,
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [{ index: 0, type: "file", label: "Cover letter", required: false, value: "", accept: null }],
      },
      cvArtifact: null,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(optional.coverLetter.outcome, "skipped");
    assert.match(optional.coverLetter.detail, /txt: verification_failed; pdf: verification_failed/);
    assert.equal(optional.changed, false);

    const required = await repairAttachments({
      uploads: fakeUploads({ failFor: () => true }),
      targetId: "T1",
      adapter: ADAPTER,
      formState: {
        fields: [{ index: 0, type: "file", label: "Cover letter", required: true, value: "", accept: null }],
      },
      cvArtifact: null,
      coverLetter: LETTER,
      stagingDir: dir,
    });
    assert.equal(required.coverLetter.outcome, "failed");
  });
});

test("a cover letter is never attached to the CV input", () => {
  const inputs = [
    { index: 0, id: "resume-upload", name: "resume", label: "CV", accept: ".pdf", visible: true },
    { index: 1, id: "cover", name: "cover_letter", label: "Cover letter", accept: null, visible: true },
  ];
  assert.equal(chooseFileInput(inputs, "resume").index, 0);
  assert.equal(chooseFileInput(inputs, "cover-letter").index, 1);
  // With only a CV field present there is nowhere safe to put a letter.
  assert.equal(chooseFileInput([inputs[0]], "cover-letter"), null);
  // A lone unlabelled input is still assumed to be the CV field.
  assert.equal(chooseFileInput([{ index: 0, id: "", name: "", label: "", accept: null, visible: true }], "resume").index, 0);
});

test("accept lists are read as extensions, MIME types, or wildcards", () => {
  assert.equal(acceptsExtension("", ".txt"), true);
  assert.equal(acceptsExtension(".pdf,.docx", ".txt"), false);
  assert.equal(acceptsExtension(".pdf,.docx", ".pdf"), true);
  assert.equal(acceptsExtension("text/plain", ".txt"), true);
  assert.equal(acceptsExtension("application/pdf", ".pdf"), true);
  assert.equal(acceptsExtension("*/*", ".txt"), true);
  assert.equal(acceptsExtension("text/*", ".txt"), true);
  assert.equal(acceptsExtension("text/*", ".pdf"), false);
});

async function withStaging(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-attach-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeUploads({ failFor = () => false } = {}) {
  const calls = [];
  return {
    calls,
    async attach({ artifact, purpose }) {
      calls.push({ artifact, purpose });
      return failFor(artifact)
        ? { outcome: "verification_failed", reasonCode: "no_file_attached", detail: "not shown on the page", evidence: {} }
        : { outcome: "uploaded", reasonCode: "verified", detail: `Attached ${artifact.name}.`, evidence: { filename: artifact.name } };
    },
  };
}
