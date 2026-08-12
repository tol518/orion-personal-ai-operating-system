import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CvStore } from "./cv-store.js";

test("stores one canonical CV with optimistic revisions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cv-store-"));
  try {
    const store = new CvStore(path.join(directory, "jarvis.sqlite"));
    assert.equal(store.get(), null);

    const first = store.save({
      content: "# Example User\n\nSoftware engineer with verified experience.",
      sourceName: "cv.md",
      sourceFormat: "markdown",
      expectedVersion: 0,
    });
    assert.equal(first.version, 1);
    assert.equal(first.canUndo, false);
    assert.equal(store.get()?.sourceName, "cv.md");
    assert.equal(store.get()?.hasOriginalPdf, false);

    const second = store.save({
      ...first,
      content: `${first.content}\n\n## Skills\nTypeScript`,
      expectedVersion: 1,
    });
    assert.equal(second.version, 2);
    assert.equal(second.canUndo, true);
    assert.throws(
      () => store.save({ ...second, expectedVersion: 1 }),
      /changed in another session/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restores saved CV versions one step at a time", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cv-undo-"));
  try {
    const store = new CvStore(path.join(directory, "jarvis.sqlite"));
    const first = store.save({
      content: "Example User\n\nOriginal CV content with enough detail to save safely.",
      sourceName: "cv.md",
      sourceFormat: "markdown",
      expectedVersion: 0,
    });
    const second = store.save({
      ...first,
      content: `${first.content}\n\nAdded project bullet.`,
      expectedVersion: first.version,
    });

    const restored = store.undo({ expectedVersion: second.version });
    assert.equal(restored.content, first.content);
    assert.equal(restored.version, 3);
    assert.equal(restored.canUndo, false);
    assert.throws(() => store.undo({ expectedVersion: restored.version }), /no earlier CV version/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves exact PDF bytes only while canonical content matches the upload", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cv-source-pdf-"));
  try {
    const store = new CvStore(path.join(directory, "jarvis.sqlite"));
    const content = "Example User\n\nSoftware engineer with verified React and Node.js experience.";
    const originalPdf = Buffer.from("%PDF-1.7\nexact-original-pdf-bytes\n%%EOF");
    const sourcePdfToken = store.stageOriginalPdf({
      pdf: originalPdf,
      content,
      sourceName: "ExampleUser_CV.pdf",
    });

    assert.deepEqual(
      store.sourcePdfFor({ content, draftToken: sourcePdfToken })?.data,
      originalPdf,
    );
    assert.equal(
      store.sourcePdfFor({ content: `${content}\nEdited`, draftToken: sourcePdfToken }),
      null,
    );

    const saved = store.save({
      content,
      sourceName: "ExampleUser_CV.pdf",
      sourceFormat: "pdf",
      sourcePdfToken,
      expectedVersion: 0,
    });
    assert.equal(saved.hasOriginalPdf, true);
    assert.deepEqual(store.sourcePdfFor({ content })?.data, originalPdf);

    const edited = store.save({ ...saved, content: `${content}\nEdited`, expectedVersion: 1 });
    assert.equal(edited.hasOriginalPdf, false);
    assert.equal(store.get()?.hasOriginalPdf, false);
    assert.equal(store.sourcePdfFor({ content: `${content}\nEdited` }), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
