// Is the CV we are about to attach actually readable by an applicant tracking system?
//
// Borrowed from https://github.com/MadsLorentzen/ai-job-search, which compiles a CV and then reads
// the PDF's text layer back before trusting it. Nothing here checked that: the upload service
// proves a file is attached, and the form-state reader proves fields hold values, but neither can
// tell whether the bytes contain extractable text. A PDF whose text layer is empty or mangled looks
// perfect on screen, uploads cleanly, reports `uploaded | verified`, and scores near zero in every
// ATS — a silent failure with no signal anywhere in the checkpoint.
//
// This is a readability check, not a keyword optimiser. It answers one question: can a machine read
// the words that are on the page? Content is the user's business.
import { normalizeCvText } from "./cv-document.js";

// Below this, a two-page CV has effectively no text layer: the page is an image or the glyphs are
// not mapped to characters.
const MIN_EXTRACTABLE_WORDS = 80;
// How much of the canonical CV's wording must survive the round trip through the PDF.
const MIN_CONTENT_RETAINED = 0.6;

/**
 * Read the text layer back out of the PDF bytes and compare it with the CV it was made from.
 *
 * Returns a closed result rather than throwing: a CV that cannot be checked must not block an
 * application, it just stops being something we claim is verified.
 */
export async function checkCvReadability({ bytes, expectedText }) {
  let extracted = "";
  try {
    extracted = await extractPdfText(bytes);
  } catch (error) {
    return {
      readable: null,
      reasonCode: "extraction_failed",
      detail: `The PDF text layer could not be read (${String(error?.message ?? error).slice(0, 160)}).`,
      words: 0,
      retained: null,
    };
  }
  const words = countWords(extracted);
  if (words < MIN_EXTRACTABLE_WORDS) {
    return {
      readable: false,
      reasonCode: "no_text_layer",
      detail: `Only ${words} words could be extracted, so an ATS would parse this as a scanned image rather than a CV.`,
      words,
      retained: null,
    };
  }
  const retained = retainedFraction({ extracted, expectedText });
  if (retained !== null && retained < MIN_CONTENT_RETAINED) {
    return {
      readable: false,
      reasonCode: "text_layer_mismatch",
      detail: `Only ${Math.round(retained * 100)}% of the CV's wording survives into the PDF's text layer, so the glyphs are probably not mapped to characters.`,
      words,
      retained,
    };
  }
  return {
    readable: true,
    reasonCode: "text_layer_verified",
    detail: `${words} words are machine-readable in the attached PDF.`,
    words,
    retained,
  };
}

async function extractPdfText(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n\n");
  } finally {
    await document.destroy();
  }
}

function countWords(text) {
  return normalizeCvText(text).split(/\s+/).filter(Boolean).length;
}

/**
 * What share of the CV's distinctive words made it into the text layer.
 *
 * Compared as a set of longer words: the PDF renderer reflows whitespace and line breaks, so a
 * literal diff would fail on a perfectly good document. Short words are dropped because "the" and
 * "and" survive almost any encoding failure and would mask a broken one.
 */
function retainedFraction({ extracted, expectedText }) {
  const expected = distinctiveWords(expectedText);
  if (expected.size < 20) return null;
  const found = distinctiveWords(extracted);
  let hits = 0;
  for (const word of expected) if (found.has(word)) hits += 1;
  return hits / expected.size;
}

function distinctiveWords(text) {
  return new Set(
    normalizeCvText(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 5),
  );
}
