import path from "node:path";

export const MAX_CV_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_CV_TEXT_LENGTH = 250_000;

const FORMAT_BY_MIME = new Map([
  ["text/plain", "text"],
  ["text/markdown", "markdown"],
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
]);

const FORMAT_BY_EXTENSION = new Map([
  [".txt", "text"],
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".pdf", "pdf"],
  [".docx", "docx"],
]);

export async function extractCvDocument(upload) {
  const sourceName = cleanFileName(upload?.name);
  const sourceFormat = detectFormat(sourceName, upload?.type);
  const buffer = decodeBase64(upload?.data);
  if (buffer.byteLength > MAX_CV_UPLOAD_BYTES) {
    throw Object.assign(new Error("CV file must be 6 MB or smaller"), { statusCode: 413 });
  }

  let content;
  if (sourceFormat === "pdf") content = await extractPdf(buffer);
  else if (sourceFormat === "docx") content = await extractDocx(buffer);
  else content = buffer.toString("utf8");

  content = normalizeCvText(content);
  if (content.length < 40) throw new Error("The uploaded CV did not contain enough readable text");
  if (content.length > MAX_CV_TEXT_LENGTH) {
    throw Object.assign(new Error("The extracted CV is too long to edit safely"), { statusCode: 413 });
  }
  return {
    content,
    sourceName,
    sourceFormat,
    originalPdf: sourceFormat === "pdf" ? buffer : null,
  };
}

export function normalizeCvText(value) {
  return String(value ?? "")
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function cleanFileName(value) {
  const name = path.basename(String(value ?? "").trim()).slice(0, 180);
  if (!name) throw new Error("CV filename is required");
  return name;
}

function detectFormat(name, mime) {
  const format = FORMAT_BY_MIME.get(String(mime ?? "").toLowerCase()) ??
    FORMAT_BY_EXTENSION.get(path.extname(name).toLowerCase());
  if (!format) throw new Error("Upload a PDF, DOCX, Markdown, or plain-text CV");
  return format;
}

function decodeBase64(value) {
  const encoded = String(value ?? "").replace(/^data:[^,]+,/, "");
  if (!encoded || !/^[a-z0-9+/=\s]+$/i.test(encoded)) throw new Error("CV upload data is invalid");
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.byteLength) throw new Error("CV file is empty");
  return buffer;
}

async function extractDocx(buffer) {
  const module = await import("mammoth");
  const mammoth = module.default ?? module;
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractPdf(buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      pages.push(text.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n\n");
  } finally {
    await document.destroy();
  }
}
