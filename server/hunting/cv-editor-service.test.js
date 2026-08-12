import assert from "node:assert/strict";
import test from "node:test";
import { applyCvOperations } from "./cv-editor-service.js";

test("applies a targeted CV edit without changing unrelated formatting", () => {
  const content = "Projects  Go Playing AI  • Existing bullet.  Technical Skills  Languages: Python";
  const revised = applyCvOperations(content, [
    {
      type: "insert_after",
      anchor: "• Existing bullet.",
      text: "  • Added neural-network bullet.  • Added training-pipeline bullet.",
    },
  ]);
  assert.equal(
    revised,
    "Projects  Go Playing AI  • Existing bullet.  • Added neural-network bullet.  • Added training-pipeline bullet.  Technical Skills  Languages: Python",
  );
});

test("rejects ambiguous or fabricated edit anchors", () => {
  assert.throws(
    () => applyCvOperations("Repeated passage. Repeated passage.", [
      { type: "replace", oldText: "Repeated passage.", newText: "Changed passage." },
    ]),
    /one exact CV passage safely/,
  );
  assert.throws(
    () => applyCvOperations("Original CV content that is long enough to validate.", [
      { type: "replace", oldText: "Missing passage", newText: "Changed passage" },
    ]),
    /one exact CV passage safely/,
  );
});

test("matches one normalized whitespace anchor without rewriting the original text", () => {
  const content = "Go Playing AI  • Architected an autonomous AI agent with UCB1 for  optimal balance.  Mobile Demo";
  const revised = applyCvOperations(content, [
    {
      type: "insert_after",
      anchor: "Architected an autonomous AI agent with UCB1 for optimal balance.",
      text: "  • Added model bullet.",
    },
  ]);
  assert.equal(
    revised,
    "Go Playing AI  • Architected an autonomous AI agent with UCB1 for  optimal balance.  • Added model bullet.  Mobile Demo",
  );
});
