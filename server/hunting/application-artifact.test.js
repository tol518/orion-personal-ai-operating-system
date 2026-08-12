import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  APPLICATION_CV_FILENAME,
  browserArtifactReference,
  describeStagedArtifact,
  pruneStagedArtifacts,
  stageApplicationArtifact,
} from "./application-artifact.js";

test("a managed inbound directory yields a host-agnostic media reference", () => {
  const inbound = path.join("/Users/example/.openclaw", "media", "inbound");
  assert.equal(browserArtifactReference(inbound, "cv.pdf"), "media://inbound/cv.pdf");
  // Any other directory can only be offered as a path, which a remote browser may not see.
  assert.equal(browserArtifactReference("/tmp/openclaw/uploads", "cv.pdf"), "/tmp/openclaw/uploads/cv.pdf");
});

test("staging records the audit fields a checkpoint needs", () => {
  withInboundDir((dir) => {
    const artifact = stageApplicationArtifact({ dir, name: "cv.pdf", bytes: Buffer.from("%PDF-1.4 test") });
    assert.equal(artifact.browserRef, "media://inbound/cv.pdf");
    assert.equal(artifact.bytes, 13);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(artifact.hostPath, "utf8"), "%PDF-1.4 test");
    assert.equal(fs.statSync(artifact.hostPath).mode & 0o777, 0o600);

    const described = describeStagedArtifact({ dir, name: "cv.pdf" });
    assert.equal(described.sha256, artifact.sha256);
    assert.equal(describeStagedArtifact({ dir, name: "missing.pdf" }), null);
  });
});

test("pruning only removes recorded artifacts, never other inbound media", () => {
  withInboundDir((dir) => {
    stageApplicationArtifact({ dir, name: "old.pdf", bytes: Buffer.from("old") });
    stageApplicationArtifact({ dir, name: "keep.pdf", bytes: Buffer.from("keep") });
    fs.writeFileSync(path.join(dir, "someone-elses-photo.jpg"), "image");
    const removed = pruneStagedArtifacts({
      dir,
      managedNames: ["old.pdf", "keep.pdf"],
      keepNames: ["keep.pdf"],
      maxAgeMs: -1,
    });
    assert.deepEqual(removed, ["old.pdf"]);
    assert.ok(fs.existsSync(path.join(dir, "keep.pdf")));
    // Media this app did not record stays put even though it is older than the cutoff.
    assert.ok(fs.existsSync(path.join(dir, "someone-elses-photo.jpg")));
    assert.deepEqual(pruneStagedArtifacts({ dir, managedNames: [], maxAgeMs: -1 }), []);
  });
});

function withInboundDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-artifact-"));
  const dir = path.join(root, "media", "inbound");
  try {
    fs.mkdirSync(dir, { recursive: true });
    run(dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("every application stages one file under the same name, refreshed in place", () => {
  // Per-job filenames meant a recruiter saw a different attachment on each application. The CV is
  // the same document every time, so re-staging must overwrite rather than pile up copies.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-artifact-"));
  try {
    assert.equal(APPLICATION_CV_FILENAME, "ExampleUserCV.pdf");
    const first = stageApplicationArtifact({
      dir,
      name: APPLICATION_CV_FILENAME,
      bytes: Buffer.from("%PDF-1.4 first"),
    });
    const second = stageApplicationArtifact({
      dir,
      name: APPLICATION_CV_FILENAME,
      bytes: Buffer.from("%PDF-1.4 second edit"),
    });
    assert.equal(first.name, second.name);
    assert.equal(first.hostPath, second.hostPath);
    assert.deepEqual(fs.readdirSync(dir), [APPLICATION_CV_FILENAME]);
    // Same name, different document: the hash and size must follow the current bytes.
    assert.notEqual(first.sha256, second.sha256);
    assert.equal(second.bytes, Buffer.byteLength("%PDF-1.4 second edit"));
    // A resumed run finds it by that stable name.
    assert.equal(describeStagedArtifact({ dir, name: APPLICATION_CV_FILENAME }).sha256, second.sha256);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
