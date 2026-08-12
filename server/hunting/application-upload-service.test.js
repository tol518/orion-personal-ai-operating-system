import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationUploadService,
  chooseChooserRef,
  parseSnapshotControls,
  canContinueAfterEmbeddedUpload,
  chooseFileInput,
  classifyUploadError,
  findSnapshotAttachmentEvidence,
} from "./application-upload-service.js";
import { resolveSiteAdapter } from "./site-adapters.js";

const ARTIFACT = {
  name: "Example-User-Acme-Engineer-1234abcd.pdf",
  sha256: "abc",
  bytes: 94_320,
  browserRef: "media://inbound/Example-User-Acme-Engineer-1234abcd.pdf",
  hostPath: "/Users/example/.openclaw/media/inbound/Example-User-Acme-Engineer-1234abcd.pdf",
};
const ADAPTER = resolveSiteAdapter("https://www.linkedin.com/jobs/view/4443869815");

test("verified attachment reports uploaded with page evidence", async () => {
  const browser = fakeBrowser({ attachOnSetFiles: true });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.attempts, 1);
  assert.equal(result.evidence.method, "file-input-read");
  assert.equal(result.evidence.filename, ARTIFACT.name);
  assert.equal(result.evidence.artifactSha256, "abc");
  // The upload is bound to a marked input, never to a blind click.
  assert.match(browser.calls.setInputFiles[0].element, /data-jarvis-upload-target/);
});

test("an artifact the browser host cannot read is artifact_unavailable and is not retried", async () => {
  const browser = fakeBrowser({
    setInputFilesError: "Invalid path: must stay within inbound media directory (/home/node/.openclaw/media/inbound)",
  });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "artifact_unavailable");
  assert.equal(result.reasonCode, "artifact_not_visible_to_browser");
  assert.equal(result.attempts, 1);
  assert.equal(result.evidence.browserRef, ARTIFACT.browserRef);
});

test("a page with no file input is input_not_found rather than a claimed upload", async () => {
  const browser = fakeBrowser({ fileInputs: [] });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "input_not_found");
  assert.equal(result.reasonCode, "no_file_input_on_page");
  assert.equal(browser.calls.setInputFiles.length, 0);
});

test("a form that mounts after the page loads is waited for, not called unreachable", async () => {
  // Live failure: readyState was "complete" but Greenhouse had not rendered the application
  // form yet, so the upload saw zero file inputs on a page that held 121 fields moments later.
  const input = { index: 0, id: "resume", name: null, accept: ".pdf", label: "Resume", visible: true };
  const browser = fakeBrowser({ fileInputsByPoll: [[], [], [input]], attachOnSetFiles: true });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.attempts, 1);
});

test("a mounted form with genuinely no file input is not waited on for the full timeout", async () => {
  const browser = fakeBrowser({ fileInputs: [], formControls: 40 });
  const service = new ApplicationUploadService({ browser });
  const started = Date.now();
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "input_not_found");
  // Two identical control counts prove the form settled; the poll must stop there.
  assert.ok(Date.now() - started < 5_000, "gave up waiting once the form had settled");
});

test("a component-owned CV is verified from its visible filename when no native input is reachable", async () => {
  const browser = fakeBrowser({ fileInputs: [], snapshotText: `- text \"${ARTIFACT.name}\"` });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.reasonCode, "already_attached_in_snapshot");
  assert.equal(result.evidence.method, "snapshot-filename");
});

test("LinkedIn final review controls verify its existing resume without a reachable file input", async () => {
  const snapshotText = [
    '- button "Edit Resume" [ref=e109]',
    '- button "View document" [ref=e110]',
    '- button "Submit application" [ref=e118]',
  ].join("\n");
  const browser = fakeBrowser({ fileInputs: [], snapshotText });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });

  assert.equal(result.outcome, "uploaded");
  assert.equal(result.reasonCode, "already_attached_in_snapshot");
  assert.equal(result.evidence.method, "site-review-controls");
  assert.deepEqual(result.evidence.controls, ["edit resume", "view document", "submit application"]);
  assert.equal(browser.calls.setInputFiles.length, 0);
  assert.equal(browser.calls.snapshot.at(-1).maxChars, 30_000);
  assert.equal(browser.calls.snapshot.at(-1).interactive, true);
});

test("partial LinkedIn review controls are not enough to claim a resume attachment", () => {
  assert.equal(
    findSnapshotAttachmentEvidence({
      snapshot: '- button "Edit Resume" [ref=e109]\n- button "Submit application" [ref=e118]',
      artifact: ARTIFACT,
      adapter: ADAPTER,
    }),
    null,
  );
});

test("a resumed embedded upload can continue filling without claiming the CV is verified", () => {
  assert.equal(
    canContinueAfterEmbeddedUpload({
      resume: true,
      observedAttached: true,
      upload: { outcome: "input_not_found" },
    }),
    true,
  );
  assert.equal(
    canContinueAfterEmbeddedUpload({
      resume: false,
      observedAttached: true,
      upload: { outcome: "input_not_found" },
    }), false);
  assert.equal(
    canContinueAfterEmbeddedUpload({
      resume: true,
      observedAttached: false,
      upload: { outcome: "input_not_found" },
    }), false);
});

test("an accepted call with nothing attached is verification_failed and retried once", async () => {
  const browser = fakeBrowser({ attachOnSetFiles: false });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.reasonCode, "no_file_attached");
  assert.equal(result.attempts, 2);
});

test("a mismatched attachment is not accepted as the prepared CV", async () => {
  const browser = fakeBrowser({ attachOnSetFiles: true, attachedName: "old-cv.pdf", attachedSize: 1_000 });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "verification_failed");
  assert.equal(result.reasonCode, "attached_file_mismatch");
});

test("a resumed run recognises the file the form already holds and does not re-upload", async () => {
  const browser = fakeBrowser({ preAttached: true });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.reasonCode, "already_attached");
  assert.equal(browser.calls.setInputFiles.length, 0);
});

test("with page evaluation disabled, adapter selectors are tried and the snapshot must show the filename", async () => {
  const browser = fakeBrowser({ evaluateDisabled: true, snapshotText: `- button "Choose file: ${ARTIFACT.name}"` });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "uploaded");
  assert.equal(result.evidence.method, "snapshot-filename");
  assert.equal(browser.calls.setInputFiles[0].element, ADAPTER.fileInputSelectors[0]);

  const blind = new ApplicationUploadService({
    browser: fakeBrowser({ evaluateDisabled: true, snapshotText: "- button \"Upload file\"" }),
  });
  const unproven = await blind.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(unproven.outcome, "verification_failed");
  assert.equal(unproven.reasonCode, "no_observable_evidence");
});

test("an unreachable browser is tool_unavailable", async () => {
  const browser = fakeBrowser({ setInputFilesError: "browser request timed out" });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({ targetId: "T1", artifact: ARTIFACT, adapter: ADAPTER });
  assert.equal(result.outcome, "tool_unavailable");
  assert.equal(result.attempts, 2);
});

test("upload error classification separates artifact, element, and transport failures", () => {
  assert.equal(classifyUploadError("Invalid media reference: media://inbound/x").outcome, "artifact_unavailable");
  assert.equal(classifyUploadError("Timeout 30000ms exceeded waiting for locator('input')").outcome, "input_not_found");
  assert.equal(classifyUploadError("gateway not connected").outcome, "tool_unavailable");
  assert.equal(classifyUploadError("form refused the file type").outcome, "rejected");
});

test("resume and CV inputs win over unrelated file inputs", () => {
  const chosen = chooseFileInput([
    { index: 0, id: "cover-letter", name: "cover", accept: null, label: "Cover letter", visible: true },
    { index: 1, id: "resume-upload", name: "file", accept: "application/pdf", label: "Resume", visible: false },
  ]);
  assert.equal(chosen.index, 1);
});

/**
 * Stands in for the browser control server: `evaluate` answers the file-input probe and the
 * marking call, `setInputFiles` optionally flips the probe's answer to "attached".
 */
function fakeBrowser({
  fileInputs = [{ index: 0, id: "jobs-document-upload-file-input", name: "file", accept: "application/pdf", label: "Resume", visible: false }],
  attachOnSetFiles = false,
  attachedName = ARTIFACT.name,
  attachedSize = ARTIFACT.bytes,
  preAttached = false,
  setInputFilesError = null,
  evaluateDisabled = false,
  snapshotText = "",
  // Reads before the form mounts: each entry is the file-input list for one poll.
  fileInputsByPoll = null,
  formControls = 40,
} = {}) {
  let attached = preAttached;
  let poll = 0;
  const calls = { setInputFiles: [], evaluate: [], snapshot: [] };
  return {
    calls,
    async status() {
      return { ok: true, payload: { profile: "openclaw", transport: "cdp", status: { userDataDir: "/home/node/.openclaw/browser" } } };
    },
    async evaluate({ fn }) {
      calls.evaluate.push(fn);
      if (evaluateDisabled) return { ok: false, error: "browser evaluate is disabled by configuration" };
      if (fn.includes("setAttribute")) return { ok: true, payload: { result: { marked: true } } };
      if (fn.includes('[role="combobox"]')) return { ok: true, payload: { result: formControls } };
      const list = fileInputsByPoll ? (fileInputsByPoll[poll++] ?? fileInputsByPoll.at(-1)) : fileInputs;
      return {
        ok: true,
        payload: {
          result: list.map((input) => ({
            ...input,
            fileName: attached ? attachedName : null,
            fileSize: attached ? attachedSize : null,
          })),
        },
      };
    },
    async setInputFiles(body) {
      calls.setInputFiles.push(body);
      if (setInputFilesError) return { ok: false, error: setInputFilesError };
      if (attachOnSetFiles || evaluateDisabled) attached = true;
      return { ok: true, payload: { ok: true } };
    },
    async armFileChooserAndClick(body) {
      calls.setInputFiles.push(body);
      return { ok: true, payload: { ok: true } };
    },
    async snapshot(args) {
      calls.snapshot.push(args);
      return { ok: true, payload: { snapshot: snapshotText } };
    },
  };
}

test("an artifact in the wrong root names the root the browser will accept", () => {
  // The browser can move hosts (container -> Mac node), and each host has its own upload
  // root; quoting the one it named turns a config mismatch into a one-line fix.
  const detail =
    'selector [data-jarvis-upload-target="t1"]: Invalid path: must stay within inbound media directory (/Users/example/.openclaw-node-mac-mini/media/inbound)';
  const match = /inbound media directory \(([^)]+)\)/.exec(detail);
  assert.equal(match?.[1], "/Users/example/.openclaw-node-mac-mini/media/inbound");
  assert.equal(classifyUploadError(detail).outcome, "artifact_unavailable");
});

const GREENHOUSE_SNAPSHOT = [
  '- button "Apply" [ref=e1]',
  '- textbox "First Name" [ref=e3]',
  '- button "Attach" [ref=e12]',
  '- button "Attach" [ref=e13] [nth=1]',
].join("\n");

test("snapshot controls are parsed with their refs", () => {
  const controls = parseSnapshotControls(GREENHOUSE_SNAPSHOT);
  assert.deepEqual(controls.slice(0, 2), [
    { role: "button", name: "Apply", ref: "e1" },
    { role: "textbox", name: "First Name", ref: "e3" },
  ]);
  assert.equal(controls.length, 4);
});

test("a chooser ref that went stale is re-found in a fresh snapshot", () => {
  // The live failures: 'Unknown ref "ax56"' and 'Element "e204" not found or not visible'. A ref is
  // only valid for the snapshot it came from, and the page re-renders while the CV is prepared.
  const stale = chooseChooserRef({ snapshot: GREENHOUSE_SNAPSHOT, chooserRef: "ax56", purpose: "resume" });
  assert.equal(stale.ref, "e12");
  assert.match(stale.reason, /went stale/);

  // A ref that is still on the page is left alone.
  const live = chooseChooserRef({ snapshot: GREENHOUSE_SNAPSHOT, chooserRef: "e13", purpose: "resume" });
  assert.equal(live.ref, "e13");
  assert.match(live.reason, /still present/);
});

test("a labelled cover-letter chooser never receives the CV", () => {
  // Attaching the CV to the wrong chooser would still pass the postcondition check, because a file
  // with the right name and size would be present somewhere on the page.
  const snapshot = [
    '- button "Attach cover letter" [ref=e20]',
    '- button "Attach resume" [ref=e21]',
  ].join("\n");
  assert.equal(chooseChooserRef({ snapshot, chooserRef: "gone", purpose: "resume" }).ref, "e21");
  assert.equal(chooseChooserRef({ snapshot, chooserRef: "gone", purpose: "cover-letter" }).ref, "e20");
});

test("a page with no upload control reports that instead of clicking something else", () => {
  const snapshot = '- button "Submit application" [ref=e40]\n- textbox "Email" [ref=e41]';
  const chosen = chooseChooserRef({ snapshot, chooserRef: "e204", purpose: "resume" });
  assert.equal(chosen.ref, null);
  assert.match(chosen.reason, /no upload control/);
});

test("a stale chooser ref is reported as such rather than clicked blindly", async () => {
  const browser = fakeBrowser({ fileInputs: [], snapshotText: '- button "Submit" [ref=e40]' });
  const service = new ApplicationUploadService({ browser });
  const result = await service.attach({
    targetId: "T1",
    artifact: ARTIFACT,
    adapter: ADAPTER,
    chooserRef: "ax56",
  });
  assert.equal(result.outcome, "input_not_found");
  assert.equal(result.reasonCode, "chooser_ref_stale");
  // The dead ref was never sent to the browser.
  assert.equal(browser.calls.setInputFiles.length, 0);
});
