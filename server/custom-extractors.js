// Persistent Custom Extractor library.
//
// Metadata lives in Jarvis's shared SQLite database. Source folders and generated extractor
// packages are named user artifacts, so they live in the OpenClaw workspace where Codex can
// build them and Black Noir can run them.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const CUSTOM_EXTRACTOR_STATUSES = ["building", "ready", "failed"];
export const CUSTOM_EXTRACTOR_BUILDER = "codex";
export const CUSTOM_EXTRACTOR_RUNNER = "black-noir";

const MAX_FILES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
const SENSITIVE_PATH = /(^|\/)(?:\.env(?:\.|$)|id_(?:rsa|ed25519)|credentials?(?:\.|$)|secrets?(?:\.|$))/i;

function reject(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function cleanText(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function slugify(value) {
  return (
    cleanText(value, 100)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "custom-extractor"
  );
}

function safeRelativePath(value) {
  const candidate = String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(candidate);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    reject(`Unsafe uploaded path: ${value}`);
  }
  if (SENSITIVE_PATH.test(normalized)) reject(`Sensitive files cannot be uploaded: ${normalized}`);
  return normalized.slice(0, 300);
}

function decodeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  if (files.length > MAX_FILES) reject(`Upload at most ${MAX_FILES} files per extractor`);
  let totalBytes = 0;
  return files.map((file) => {
    const relativePath = safeRelativePath(file?.path);
    const encoded = String(file?.contentBase64 ?? "");
    const content = Buffer.from(encoded, "base64");
    if (content.length > MAX_FILE_BYTES) reject(`${relativePath} exceeds the 2 MB per-file limit`);
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) reject("The uploaded folder exceeds the 15 MB limit");
    return { relativePath, content };
  });
}

function normalizeManifest(input = {}, fallback = {}) {
  const sites = Array.isArray(input.sites)
    ? [...new Set(input.sites.map((site) => cleanText(site, 80)).filter(Boolean))].slice(0, 8)
    : fallback.sites ?? [];
  if (sites.length === 0) reject("The extractor manifest must name at least one site");
  const requestedMaxTravelDates = Number(input.maxTravelDates ?? fallback.maxTravelDates ?? 120);
  const maxTravelDates = Number.isFinite(requestedMaxTravelDates)
    ? Math.max(1, Math.min(366, Math.floor(requestedMaxTravelDates)))
    : 120;
  const supportedPairs = (Array.isArray(input.supportedPairs)
    ? input.supportedPairs
    : fallback.supportedPairs ?? [])
    .filter((pair) => Array.isArray(pair) && pair.length === 2)
    .map((pair) => pair.map((site) => cleanText(site, 80)).filter(Boolean))
    .filter((pair) => pair.length === 2)
    .slice(0, 8);
  const pairMode = input.pairMode === "any-two" || fallback.pairMode === "any-two" ? "any-two" : "fixed";
  return {
    name: cleanText(input.name ?? fallback.name, 120),
    description: cleanText(input.description ?? fallback.description, 1_000),
    sites,
    supportedPairs,
    pairMode,
    entrypoint: cleanText(input.entrypoint, 300) || null,
    runInstructions: cleanText(input.runInstructions, 4_000),
    defaults: {
      destination: cleanText(input.defaults?.destination ?? fallback.defaults?.destination, 120),
      travelStart: cleanText(input.defaults?.travelStart ?? fallback.defaults?.travelStart, 10),
      travelEnd: cleanText(input.defaults?.travelEnd ?? fallback.defaults?.travelEnd, 10),
      nights: cleanText(input.defaults?.nights ?? fallback.defaults?.nights ?? "7", 20),
    },
    maxTravelDates,
  };
}

function rowToExtractor(row) {
  const config = JSON.parse(row.config_json);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    sites: JSON.parse(row.sites_json),
    supportedPairs: config.supportedPairs ?? [],
    pairMode: config.pairMode ?? "fixed",
    status: row.status,
    sourceKind: row.source_kind,
    artifactDir: row.artifact_dir,
    fileCount: row.file_count,
    builderAgentId: row.builder_agent_id,
    runnerAgentId: row.runner_agent_id,
    buildDetail: row.build_detail,
    entrypoint: config.entrypoint ?? null,
    runInstructions: config.runInstructions ?? "",
    defaults: config.defaults ?? {},
    maxTravelDates: config.maxTravelDates ?? 120,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Server-owned task fields; client values can never change the builder/runner boundary. */
export function customExtractorTaskInput(input, extractor) {
  if (!extractor) reject("Custom extractor not found");
  if (extractor.status !== "ready") {
    throw Object.assign(new Error("Custom extractor is not ready"), { statusCode: 409 });
  }
  const requestedSites = Array.isArray(input.sites) ? input.sites : [];
  const sites = extractor.pairMode === "any-two" ? requestedSites : extractor.sites;
  if (
    extractor.pairMode === "any-two" &&
    (sites.length !== 2 || sites[0] === sites[1] || sites.some((site) => !extractor.sites.includes(site)))
  ) {
    reject(`Choose two different sites supported by ${extractor.name}`);
  }
  return {
    ...input,
    customExtractorId: extractor.id,
    agentId: CUSTOM_EXTRACTOR_RUNNER,
    sites,
  };
}

function countFiles(root) {
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const target = path.join(root, entry.name);
    count += entry.isDirectory() ? countFiles(target) : 1;
  }
  return count;
}

export class CustomExtractorStore {
  constructor(databasePath, { root, bundledTemplateRoot }) {
    this.root = root;
    this.bundledTemplateRoot = bundledTemplateRoot;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(this.root, { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS custom_extractors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        sites_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed')),
        source_kind TEXT NOT NULL,
        artifact_dir TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        builder_agent_id TEXT NOT NULL,
        runner_agent_id TEXT NOT NULL,
        build_detail TEXT,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS custom_extractors_status ON custom_extractors (status, updated_at DESC);
    `);
  }

  ensureBundledProviderAProviderC() {
    const id = "provider-a-provider-c";
    const existing = this.get(id);
    if (existing?.pairMode === "any-two") return existing;
    const artifactDir = path.join(this.root, id);
    const sourceDir = path.join(artifactDir, "source");
    fs.mkdirSync(artifactDir, { recursive: true });
    if (!fs.existsSync(sourceDir)) {
      fs.cpSync(this.bundledTemplateRoot, sourceDir, {
        recursive: true,
        filter: (source) => path.basename(source) !== ".DS_Store",
      });
    }
    const manifest = normalizeManifest({
      name: "Dynamic Travel Comparison",
      description:
        "Antalya comparison extractor supporting any two configured travel sites.",
      sites: ["ProviderA", "ProviderC", "ProviderB", "ProviderD"],
      pairMode: "any-two",
      entrypoint: "source/run-direct-api.js",
      runInstructions:
        "Run node source/run-direct-api.js --sites=<SITE_A>,<SITE_B> --start=<task travelStart> --end=<task travelEnd> --no-telegram. Choose any two of ProviderA, ProviderC, ProviderB, and ProviderD.",
      defaults: {
        destination: "Antalya",
        travelStart: "2027-04-01",
        travelEnd: "2027-10-31",
        nights: "7",
      },
      maxTravelDates: 240,
    });
    fs.writeFileSync(path.join(artifactDir, "extractor.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (existing) {
      this.database
        .prepare(
          "UPDATE custom_extractors SET name = ?, description = ?, sites_json = ?, config_json = ?, file_count = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          manifest.name,
          manifest.description,
          JSON.stringify(manifest.sites),
          JSON.stringify(manifest),
          countFiles(sourceDir),
          new Date().toISOString(),
          id,
        );
      return this.get(id);
    }
    return this.#insert({
      id,
      slug: id,
      manifest,
      status: "ready",
      sourceKind: "bundled-folder",
      artifactDir,
      fileCount: countFiles(sourceDir),
      buildDetail: "Imported from the tested bundled comparison template.",
    });
  }

  recoverInterruptedBuilds() {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        "UPDATE custom_extractors SET status = 'failed', build_detail = ?, updated_at = ? WHERE status = 'building'",
      )
      .run("Codex build was interrupted when JARVIS restarted. Create it again to retry.", now);
    return result.changes;
  }

  list() {
    return this.database
      .prepare("SELECT * FROM custom_extractors ORDER BY created_at ASC")
      .all()
      .map(rowToExtractor);
  }

  get(id) {
    const row = this.database.prepare("SELECT * FROM custom_extractors WHERE id = ?").get(id);
    return row ? rowToExtractor(row) : null;
  }

  createDraft({ name, description, files }) {
    const title = cleanText(name, 120);
    const brief = cleanText(description, 4_000);
    if (!title) reject("Name the custom extractor");
    const decodedFiles = decodeFiles(files);
    if (!brief && decodedFiles.length === 0) reject("Describe the extractor or attach a folder");

    const id = randomUUID();
    const slug = `${slugify(title)}-${id.slice(0, 8)}`;
    const artifactDir = path.join(this.root, slug);
    const sourceDir = path.join(artifactDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const file of decodedFiles) {
      const target = path.join(sourceDir, ...file.relativePath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }
    fs.writeFileSync(
      path.join(artifactDir, "REQUEST.md"),
      `# Custom Extractor Request\n\n${brief || "Build from the supplied source folder."}\n`,
    );
    return this.#insert({
      id,
      slug,
      manifest: normalizeManifest({ name: title, description: brief, sites: ["Pending Codex analysis"] }),
      status: "building",
      sourceKind: decodedFiles.length ? (brief ? "brief-and-folder" : "folder") : "brief",
      artifactDir,
      fileCount: decodedFiles.length,
      buildDetail: "Codex is analysing the request and building the reusable extractor.",
    });
  }

  readManifest(id) {
    const extractor = this.get(id);
    if (!extractor) return null;
    const manifestPath = path.join(extractor.artifactDir, "extractor.json");
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return normalizeManifest(parsed, extractor);
  }

  markReady(id, manifest, detail) {
    const normalized = normalizeManifest(manifest, this.get(id));
    this.database
      .prepare(
        `UPDATE custom_extractors
            SET name = ?, description = ?, sites_json = ?, status = 'ready', config_json = ?,
                build_detail = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        normalized.name,
        normalized.description,
        JSON.stringify(normalized.sites),
        JSON.stringify(normalized),
        cleanText(detail, 1_000) || "Codex built and validated the extractor.",
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  markFailed(id, detail) {
    this.database
      .prepare("UPDATE custom_extractors SET status = 'failed', build_detail = ?, updated_at = ? WHERE id = ?")
      .run(cleanText(detail, 1_000) || "Codex could not build this extractor.", new Date().toISOString(), id);
    return this.get(id);
  }

  #insert({ id, slug, manifest, status, sourceKind, artifactDir, fileCount, buildDetail }) {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO custom_extractors
          (id, name, slug, description, sites_json, status, source_kind, artifact_dir, file_count,
           builder_agent_id, runner_agent_id, build_detail, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        manifest.name,
        slug,
        manifest.description,
        JSON.stringify(manifest.sites),
        status,
        sourceKind,
        artifactDir,
        fileCount,
        CUSTOM_EXTRACTOR_BUILDER,
        CUSTOM_EXTRACTOR_RUNNER,
        buildDetail,
        JSON.stringify(manifest),
        now,
        now,
      );
    return this.get(id);
  }
}

export const __testing = { decodeFiles, normalizeManifest, safeRelativePath };
