import assert from "node:assert/strict";
import test from "node:test";
import { extractCvDocument, normalizeCvText } from "./cv-document.js";

test("extracts and normalizes a text CV", async () => {
  const document = await extractCvDocument({
    name: "the user CV.txt",
    type: "text/plain",
    data: Buffer.from("Example User\r\n\r\nSoftware engineer with TypeScript and React experience.\r\n").toString("base64"),
  });
  assert.equal(document.sourceName, "the user CV.txt");
  assert.equal(document.sourceFormat, "text");
  assert.equal(document.content.includes("\r"), false);
  assert.equal(document.originalPdf, null);
});

test("extracts readable text from a PDF CV", async () => {
  const pdf = minimalPdf("Example User - Software engineer with TypeScript and React experience");
  const document = await extractCvDocument({
    name: "the user CV.pdf",
    type: "application/pdf",
    data: pdf.toString("base64"),
  });
  assert.equal(document.sourceFormat, "pdf");
  assert.deepEqual(document.originalPdf, pdf);
  assert.match(document.content, /Example User/);
  assert.match(document.content, /TypeScript/);
});

test("rejects unsupported uploads", async () => {
  await assert.rejects(
    extractCvDocument({
      name: "cv.pages",
      type: "application/octet-stream",
      data: Buffer.from("not a supported CV document").toString("base64"),
    }),
    /PDF, DOCX, Markdown, or plain-text/,
  );
});

test("normalization keeps sections while removing binary nulls", () => {
  assert.equal(normalizeCvText("A\u0000\r\n\r\n\r\n\r\nB  \n"), "A\n\n\nB");
});

function minimalPdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
