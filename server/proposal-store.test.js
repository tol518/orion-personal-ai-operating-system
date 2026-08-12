import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProposalStore } from "./proposal-store.js";

test("proposal fingerprints prevent duplicate neural candidates across runs", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jarvis-proposals-"));
  const store = new ProposalStore(path.join(directory, "test.sqlite"));
  const first = store.createUnique("relationship", { fingerprint: "a:b:supports" });
  const second = store.createUnique("relationship", { fingerprint: "a:b:supports" });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.proposal.id, first.proposal.id);
  assert.equal(store.list("pending").length, 1);
});
