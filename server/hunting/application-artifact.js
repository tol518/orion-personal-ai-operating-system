// Staging for the tailored CV that a browser has to attach.
//
// The browser plugin only accepts upload paths inside its own managed roots, and in a
// containerised gateway the browser's filesystem is not the BFF's filesystem. Staging into
// the inbound media directory and handing the browser a `media://inbound/<name>` reference
// satisfies both: the reference is resolved on the browser's side, so no host path crosses
// the boundary. Writing anywhere else (the old /tmp/openclaw/uploads path) is rejected by
// the browser with "must stay within inbound media directory" and nothing gets attached.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const DEFAULT_ARTIFACT_DIR = path.join(os.homedir(), ".openclaw", "media", "inbound");
// One filename for every application. Per-job names meant a recruiter saw a different attachment
// each time and the user could not recognise his own file in a form; the CV is the same document
// every time, so the name is too. Re-staging overwrites in place rather than accumulating copies.
export const APPLICATION_CV_FILENAME = "ExampleUserCV.pdf";

/** The reference the browser resolves. Managed inbound dirs stay host-agnostic. */
export function browserArtifactReference(dir, name) {
  const isManagedInbound =
    path.basename(dir) === "inbound" && path.basename(path.dirname(dir)) === "media";
  return isManagedInbound ? `media://inbound/${encodeURIComponent(name)}` : path.join(dir, name);
}

/** Write the prepared PDF and return the audit record the checkpoint stores. */
export function stageApplicationArtifact({ dir, name, bytes }) {
  fs.mkdirSync(dir, { recursive: true });
  const hostPath = path.join(dir, name);
  fs.writeFileSync(hostPath, bytes, { mode: 0o600 });
  return {
    name,
    hostPath,
    browserRef: browserArtifactReference(dir, name),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    createdAt: new Date().toISOString(),
  };
}

/** Re-describe an already staged artifact so a resumed run does not regenerate a CV. */
export function describeStagedArtifact({ dir, name }) {
  if (!name) return null;
  const hostPath = path.join(dir, path.basename(name));
  let contents;
  try {
    contents = fs.readFileSync(hostPath);
  } catch {
    return null;
  }
  return {
    name: path.basename(name),
    hostPath,
    browserRef: browserArtifactReference(dir, path.basename(name)),
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.length,
    createdAt: fs.statSync(hostPath).mtime.toISOString(),
  };
}

/**
 * Remove old staged CVs. The inbound media directory is shared with other OpenClaw media,
 * so deletion is limited to names this app recorded and never a directory sweep.
 */
export function pruneStagedArtifacts({ dir, managedNames = [], keepNames = [], maxAgeMs = 30 * 86_400_000 }) {
  const keep = new Set(keepNames.filter(Boolean).map((name) => path.basename(name)));
  const removed = [];
  const cutoff = Date.now() - maxAgeMs;
  for (const managed of new Set(managedNames.filter(Boolean).map((name) => path.basename(name)))) {
    if (keep.has(managed)) continue;
    const hostPath = path.join(dir, managed);
    try {
      if (fs.statSync(hostPath).mtimeMs > cutoff) continue;
      fs.unlinkSync(hostPath);
      removed.push(managed);
    } catch {
      // Already gone, or not ours to remove — nothing to report either way.
    }
  }
  return removed;
}
