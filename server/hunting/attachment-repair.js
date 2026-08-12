// File fields, put right after the form has been filled.
//
// Two things go wrong that only the page can reveal, so both are handled here rather than in a
// prompt:
//
//   1. The CV field ends up empty even though the upload was verified earlier. Filling a form
//      can re-render it (Ashby's resume autofill rebuilds the field), and a re-rendered file
//      input starts empty. Re-attaching is cheap; a blocked application is not.
//   2. A cover letter field accepts a file and nothing else, so there is nothing to type into.
//      The letter is offered as plain text first, then as a PDF for forms that reject .txt,
//      and skipped if it is optional and neither lands. It is never attached to the CV input.
import path from "node:path";
import { stageApplicationArtifact } from "./application-artifact.js";
import { renderCoverLetterPdf, renderCoverLetterText } from "./cover-letter-service.js";

const RESUME_FIELD = /resume|cv|curriculum/i;
const COVER_FIELD = /cover|letter|motivation|supporting/i;
// Ordered the way the user asked for it: type, then .txt, then .pdf, then give up.
const COVER_LETTER_FORMATS = [
  { format: "txt", extension: ".txt", render: (letter) => renderCoverLetterText(letter) },
  { format: "pdf", extension: ".pdf", render: (letter) => renderCoverLetterPdf(letter) },
];

/**
 * Inspect the form's file inputs and fix what is fixable.
 *
 * Returns one record per document with a closed outcome, plus `changed` so the caller knows
 * whether the form is worth re-reading.
 */
export async function repairAttachments({
  uploads,
  targetId,
  adapter,
  formState,
  cvArtifact,
  coverLetter = null,
  stagingDir,
}) {
  const fileFields = (formState?.fields ?? []).filter((field) => field.type === "file");
  const results = { cv: null, coverLetter: null, changed: false };
  if (!fileFields.length) return results;

  const cvField = fileFields.find((field) => RESUME_FIELD.test(field.label ?? "")) ?? fileFields[0];
  if (cvField && !cvField.value && cvArtifact) {
    const attached = await uploads.attach({ targetId, artifact: cvArtifact, adapter, purpose: "resume" });
    results.cv = {
      field: cvField.label || "CV",
      required: cvField.required,
      outcome: attached.outcome,
      reasonCode: attached.reasonCode,
      detail: attached.detail,
      evidence: attached.evidence,
    };
    if (attached.outcome === "uploaded") results.changed = true;
  }

  const coverField = fileFields.find(
    (field) => COVER_FIELD.test(field.label ?? "") && !RESUME_FIELD.test(field.label ?? ""),
  );
  const coverHasExpectedFile = coverLetter && coverField
    ? isExpectedCoverLetterFile(coverField.value, coverLetter.name)
    : Boolean(coverField?.value);
  if (coverField && !coverHasExpectedFile) {
    results.coverLetter = coverLetter
      ? await attachCoverLetterFile({
          uploads,
          targetId,
          adapter,
          field: coverField,
          coverLetter,
          stagingDir,
        })
      : {
          field: coverField.label || "Cover letter",
          required: coverField.required,
          outcome: "skipped",
          reasonCode: "no_cover_letter_available",
          detail: "No cover letter was generated for this application.",
          format: null,
        };
    if (results.coverLetter.outcome === "uploaded") results.changed = true;
  }
  return results;
}

function isExpectedCoverLetterFile(value, sourceName) {
  if (!value || !sourceName) return false;
  const expectedStem = path.basename(String(sourceName), path.extname(String(sourceName))).toLowerCase();
  const actual = path.basename(String(value)).toLowerCase();
  return actual === `${expectedStem}.txt` || actual === `${expectedStem}.pdf`;
}

async function attachCoverLetterFile({ uploads, targetId, adapter, field, coverLetter, stagingDir }) {
  const accepted = String(field.accept ?? "").toLowerCase();
  const attempts = [];
  for (const candidate of COVER_LETTER_FORMATS) {
    // Skip a format the input openly refuses rather than burning an attempt on it.
    if (accepted && !acceptsExtension(accepted, candidate.extension)) {
      attempts.push({ format: candidate.format, outcome: "not_accepted", detail: `input accepts ${accepted}` });
      continue;
    }
    let artifact;
    try {
      artifact = stageApplicationArtifact({
        dir: stagingDir,
        name: `${path.basename(coverLetter.name, ".md")}${candidate.extension}`,
        bytes: await candidate.render(coverLetter.letter),
      });
    } catch (err) {
      attempts.push({ format: candidate.format, outcome: "render_failed", detail: String(err?.message ?? err) });
      continue;
    }
    const attached = await uploads.attach({ targetId, artifact, adapter, purpose: "cover-letter" });
    attempts.push({ format: candidate.format, outcome: attached.outcome, detail: attached.detail });
    if (attached.outcome === "uploaded") {
      return {
        field: field.label || "Cover letter",
        required: field.required,
        outcome: "uploaded",
        reasonCode: `uploaded_as_${candidate.format}`,
        detail: `Attached the cover letter as ${artifact.name}.`,
        format: candidate.format,
        artifact: { name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes },
        attempts,
        evidence: attached.evidence,
      };
    }
  }
  return {
    field: field.label || "Cover letter",
    required: field.required,
    // Optional means this is simply passed over; required means the user has to do it.
    outcome: field.required ? "failed" : "skipped",
    reasonCode: "no_accepted_format",
    detail: `The cover letter could not be attached as text or PDF (${attempts
      .map((attempt) => `${attempt.format}: ${attempt.outcome}`)
      .join("; ")}).`,
    format: null,
    attempts,
  };
}

/** An `accept` list can name extensions, MIME types, or wildcards. */
export function acceptsExtension(accept, extension) {
  const tokens = String(accept ?? "")
    .toLowerCase()
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return true;
  const mime = extension === ".pdf" ? "application/pdf" : "text/plain";
  return tokens.some(
    (token) =>
      token === extension ||
      token === mime ||
      token === "*/*" ||
      (token.endsWith("/*") && mime.startsWith(token.slice(0, -1))),
  );
}
