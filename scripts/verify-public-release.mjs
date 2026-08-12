import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const denylistPath = process.env.JARVIS_PUBLIC_DENYLIST_FILE;
const findings = [];

const excludedDirectories = new Set([".git", "node_modules"]);
const forbiddenNames = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /\.sqlite(?:-|$)/,
  /\.db(?:-|$)/,
  /\.log$/,
  /\.tsbuildinfo$/,
  /^\.DS_Store$/,
];
const forbiddenDirectories = ["client/dist", "server/data"];
const sensitivePatterns = [
  { label: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "personal macOS path", pattern: /\/Users\/(?!example(?:\/|$))[^/\s]+\// },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "GitHub token", pattern: /\bgh[psuro]_[A-Za-z0-9_]{20,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

const privateTerms = loadPrivateTerms(denylistPath);
walk(root);

if (findings.length > 0) {
  console.error("Public-release verification failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Public-release verification passed for ${root}`);
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (forbiddenDirectories.includes(relative)) {
        findings.push(`${relative}: forbidden runtime/generated directory`);
        continue;
      }
      walk(absolute);
      continue;
    }
    if (!entry.isFile()) {
      findings.push(`${relative}: symbolic links and special files are not allowed`);
      continue;
    }
    if (forbiddenNames.some((pattern) => pattern.test(entry.name))) {
      findings.push(`${relative}: forbidden release artifact`);
      continue;
    }
    inspectFile(absolute, relative);
  }
}

function inspectFile(absolute, relative) {
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  for (const { label, pattern } of sensitivePatterns) {
    if (pattern.test(text)) findings.push(`${relative}: ${label}`);
  }
  for (const term of privateTerms) {
    if (text.toLocaleLowerCase().includes(term) || relative.toLocaleLowerCase().includes(term)) {
      findings.push(`${relative}: private denylist term`);
      break;
    }
  }
  if (relative.endsWith(".example")) validateExampleEnvironment(text, relative);
}

function validateExampleEnvironment(text, relative) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !/(TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL)/.test(match[1])) continue;
    const value = match[2].trim();
    if (value && !/^(YOUR_|<|example|change-me)/i.test(value)) {
      findings.push(`${relative}: ${match[1]} must be empty or an explicit placeholder`);
    }
  }
}

function loadPrivateTerms(file) {
  if (!file) return [];
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`Private denylist not found: ${resolved}`);
  return fs
    .readFileSync(resolved, "utf8")
    .split(/\r?\n/)
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value && !value.startsWith("#"));
}
