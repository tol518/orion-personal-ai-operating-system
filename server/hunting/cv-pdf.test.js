import assert from "node:assert/strict";
import test from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCvPdf } from "./cv-pdf.js";

test("creates a readable, multi-section CV PDF", async () => {
  const pdf = await createCvPdf({
    content: [
      "Example User +1 202-555-0100 | exampleUser@example.com | linkedin.com/in/example-user",
      "Professional Summary Software engineer focused on reliable web applications.",
      "Experience Full Stack Software Developer - Built React interfaces. • Added Node.js APIs.",
      "Education BSc Computer Science, Example University, University of London.",
      "Technical Skills TypeScript, React, Node.js, SQL",
    ].join("\n\n"),
    sourceName: "Example-User-CV.pdf",
  });

  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const document = await getDocument({
    data: new Uint8Array(pdf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    assert.equal(document.numPages, 1);
    const page = await document.getPage(1);
    const text = await page.getTextContent();
    const rendered = text.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    const compact = rendered.replaceAll(" ", "");
    assert.match(rendered, /Example User/);
    assert.match(compact, /ProfessionalSummary/);
    assert.match(compact, /TechnicalSkills/);
  } finally {
    await document.destroy();
  }
});

test("flows long CV content across multiple PDF pages", async () => {
  const pdf = await createCvPdf({
    content: `Jane Example jane@example.com\n\nExperience ${"Delivered measurable software improvements. ".repeat(650)}`,
  });
  const document = await getDocument({
    data: new Uint8Array(pdf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    assert.ok(document.numPages > 1);
  } finally {
    await document.destroy();
  }
});
