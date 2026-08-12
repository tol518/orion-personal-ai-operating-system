import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { listMergedPdfLinks, listPdfLinks, revisePdfHyperlink } from "./cv-pdf-links.js";

const OLD_URL = "https://www.youtube.com/watch?v=old";
const NEW_URL =
  "https://github.com/tol518/MCTS-Playing-Agent-with-Neural-Networks-Final-Year-Project.git";

test("updates the link associated with a named CV title without changing its text", async () => {
  const original = await linkedPdf([
    { label: "AI Integrated MVN Repository", url: "https://www.youtube.com/watch?v=other" },
    { label: "Go Playing AI", url: OLD_URL },
  ]);
  const before = await pdfText(original);

  const revision = await revisePdfHyperlink({
    pdf: original,
    instruction: `For the Go Playing AI title, replace its link with ${NEW_URL}`,
  });

  assert.equal(revision?.label, "Go Playing AI");
  assert.equal(revision?.oldUrl, OLD_URL);
  assert.equal(revision?.newUrl, NEW_URL);
  assert.equal(await pdfText(revision.pdf), before);
  const links = await listPdfLinks(revision.pdf);
  assert.equal(links.find((link) => link.label === "Go Playing AI")?.url, NEW_URL);
  assert.equal(links.find((link) => link.label.includes("AI Integrated"))?.url.includes("other"), true);
});

test("refuses an ambiguous link instruction instead of restyling the PDF", async () => {
  const original = await linkedPdf([
    { label: "Project Alpha", url: "https://example.com/alpha" },
    { label: "Project Beta", url: "https://example.com/beta" },
  ]);

  await assert.rejects(
    revisePdfHyperlink({ pdf: original, instruction: `Replace the project link with ${NEW_URL}` }),
    /could not identify one linked CV title confidently/,
  );
});

test("recovers links dropped by a later generated PDF while preferring its current URLs", async () => {
  const current = await linkedPdf([
    { label: "LinkedIn", url: "https://linkedin.com/current" },
  ]);
  const earlier = await linkedPdf([
    { label: "LinkedIn", url: "https://linkedin.com/old" },
    { label: "Go Playing AI | Python, Git", url: NEW_URL },
  ]);

  const links = await listMergedPdfLinks([current, earlier]);

  assert.equal(links.find((link) => link.label === "LinkedIn")?.url, "https://linkedin.com/current");
  assert.equal(links.find((link) => link.label.startsWith("Go Playing"))?.url, NEW_URL);
});

async function linkedPdf(entries) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.TimesRoman);
  const annotations = [];
  entries.forEach((entry, index) => {
    const x = 48;
    const y = 700 - index * 40;
    const size = 12;
    page.drawText(entry.label, { x, y, size, font });
    const annotation = document.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y - 2, x + font.widthOfTextAtSize(entry.label, size), y + size],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(entry.url) },
    });
    annotations.push(document.context.register(annotation));
  });
  page.node.set(PDFName.of("Annots"), document.context.obj(annotations));
  return Buffer.from(await document.save());
}

async function pdfText(pdf) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl = `${fileURLToPath(
    new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
  )}/`;
  const document = await getDocument({
    data: new Uint8Array(pdf),
    disableWorker: true,
    standardFontDataUrl,
  }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
  } finally {
    await document.destroy();
  }
}
