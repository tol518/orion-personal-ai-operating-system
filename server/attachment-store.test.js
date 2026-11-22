import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttachmentStore } from "./attachment-store.js";

test("stores files, builds gateway payloads, and links them to memories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-attachments-"));
  try {
    const store = new AttachmentStore(path.join(dir, "test.sqlite"), path.join(dir, "files"));
    const [saved] = store.saveMany([{ fileName: "screen.png", mimeType: "image/png", content: Buffer.from("image").toString("base64") }]);
    assert.equal(saved.fileName, "screen.png");
    assert.equal(saved.sizeBytes, 5);
    assert.deepEqual(store.gatewayPayloads([saved.id]), [{ type: "image", mimeType: "image/png", fileName: "screen.png", content: Buffer.from("image").toString("base64") }]);
    assert.deepEqual(store.setForMemory("memory-1", [saved.id]).map(({ id }) => id), [saved.id]);
    assert.deepEqual(store.forMemories(["memory-1"]), [saved.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects malformed and oversized attachment payloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-attachments-"));
  try {
    const store = new AttachmentStore(path.join(dir, "test.sqlite"), path.join(dir, "files"));
    assert.throws(() => store.saveMany([{ fileName: "bad.txt", mimeType: "text/plain", content: "%%%" }]), /invalid file content/);
    assert.throws(() => store.saveMany(new Array(9).fill({ fileName: "x.txt", mimeType: "text/plain", content: "eA==" })), /at most 8/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("eight attachments are accepted and an invalid batch leaves no partial files", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orion-attachments-"));
  const store = new AttachmentStore(":memory:", directory);
  t.after(() => {store.database.close(); fs.rmSync(directory,{force:true,recursive:true})});
  const file = {fileName:"test.txt",mimeType:"text/plain",content:"eA=="};
  assert.throws(()=>store.saveMany([file,{...file,content:""}]),/invalid file content/);
  assert.deepEqual(fs.readdirSync(directory),[]);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM attachments").get().n,0);
  assert.equal(store.saveMany(Array(8).fill(file)).length,8);
});
