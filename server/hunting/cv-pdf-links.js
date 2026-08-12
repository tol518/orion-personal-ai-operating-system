import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "pdf-lib";

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/giu;
const LINK_EDIT_PATTERN = /\b(change|edit|link|point|replace|update|url)\b/iu;
const MIN_LABEL_SCORE = 0.55;
const MIN_SCORE_MARGIN = 0.15;
const IGNORED_LABEL_WORDS = new Set(["and", "for", "the", "with"]);

export async function revisePdfHyperlink({ pdf, instruction }) {
  const urls = instructionUrls(instruction);
  if (!urls.length || !LINK_EDIT_PATTERN.test(instruction)) return null;

  const newUrl = validatedHttpsUrl(urls.at(-1));
  const links = await listPdfLinks(pdf);
  const explicitOldUrl = urls.length > 1 ? urls[0] : null;
  const target = explicitOldUrl
    ? links.find((link) => link.url === explicitOldUrl)
    : selectLinkByLabel(links, instruction, newUrl);
  if (!target) {
    throw userError(
      "I found a link edit, but could not identify one linked CV title confidently. Name the linked title exactly and try again.",
    );
  }

  const updatedPdf = await updatePdfLink(pdf, target, newUrl);
  return {
    pdf: updatedPdf,
    label: target.label || "selected CV item",
    oldUrl: target.url,
    newUrl,
  };
}

export async function listPdfLinks(pdf) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(pdf),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    const links = [];
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1);
      const [annotations, textContent] = await Promise.all([
        page.getAnnotations({ intent: "display" }),
        page.getTextContent(),
      ]);
      const textItems = textContent.items.filter(
        (item) => "str" in item && item.str.trim() && Array.isArray(item.transform),
      );
      annotations.forEach((annotation, annotationIndex) => {
        const url = String(annotation.url ?? annotation.unsafeUrl ?? "").trim();
        if (!url || !Array.isArray(annotation.rect)) return;
        const rect = normalizedRect(annotation.rect);
        const label = textItems
          .filter((item) => rectanglesOverlap(rect, textItemRect(item)))
          .sort((left, right) => right.transform[5] - left.transform[5] || left.transform[4] - right.transform[4])
          .map((item) => item.str.trim())
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
        links.push({ pageIndex, annotationIndex, url, label });
      });
    }
    return links;
  } finally {
    await document.destroy();
  }
}

export async function listMergedPdfLinks(pdfs) {
  const merged = new Map();
  for (const pdf of pdfs.filter(Boolean)) {
    for (const link of await listPdfLinks(pdf)) {
      const key = link.label.toLocaleLowerCase("en-US").replace(/\s+/gu, "");
      if (key && !merged.has(key)) merged.set(key, link);
    }
  }
  return [...merged.values()];
}

async function updatePdfLink(pdf, target, newUrl) {
  const document = await PDFDocument.load(pdf, { updateMetadata: false });
  const page = document.getPages()[target.pageIndex];
  const annotations = page?.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const annotation = annotations?.lookupMaybe(target.annotationIndex, PDFDict);
  const action = annotation?.lookupMaybe(PDFName.of("A"), PDFDict);
  const uri = action?.lookupMaybe(PDFName.of("URI"), PDFString, PDFHexString);
  if (!action || uri?.decodeText() !== target.url) {
    throw new Error("The selected PDF link changed before it could be updated");
  }
  action.set(PDFName.of("URI"), PDFString.of(newUrl));
  return Buffer.from(await document.save());
}

function selectLinkByLabel(links, instruction, newUrl) {
  const hintTokens = new Set(tokens(instruction.replace(newUrl, "")));
  const ranked = links
    .map((link) => {
      const labelTokens = tokens(link.label);
      const matches = labelTokens.filter((token) => hintTokens.has(token)).length;
      return { link, score: labelTokens.length ? matches / labelTokens.length : 0 };
    })
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < MIN_LABEL_SCORE) return null;
  if (runnerUp && best.score - runnerUp.score < MIN_SCORE_MARGIN) return null;
  return best.link;
}

function instructionUrls(instruction) {
  return Array.from(String(instruction).matchAll(URL_PATTERN), ([match]) =>
    match.replace(/[.,;:!?]+$/u, ""),
  );
}

function validatedHttpsUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error();
    return url.href;
  } catch {
    throw userError("CV links must use a valid HTTPS URL");
  }
}

function tokens(value) {
  return String(value)
    .toLowerCase()
    .match(/[a-z0-9]+/gu)
    ?.filter((token) => token.length > 1 && !IGNORED_LABEL_WORDS.has(token)) ?? [];
}

function normalizedRect(rect) {
  return {
    left: Math.min(rect[0], rect[2]),
    bottom: Math.min(rect[1], rect[3]),
    right: Math.max(rect[0], rect[2]),
    top: Math.max(rect[1], rect[3]),
  };
}

function textItemRect(item) {
  const left = item.transform[4];
  const bottom = item.transform[5] - Math.max(1, item.height * 0.2);
  return {
    left,
    bottom,
    right: left + item.width,
    top: bottom + Math.max(1, item.height),
  };
}

function rectanglesOverlap(left, right) {
  return !(
    left.right < right.left ||
    right.right < left.left ||
    left.top < right.bottom ||
    right.top < left.bottom
  );
}

function userError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
