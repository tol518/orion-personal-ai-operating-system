import { randomUUID } from "node:crypto";
import os from "node:os";
import { deviceFileOperation, deviceFilePrograms } from "./device-file-worker.js";

const CHUNK_BYTES = 65536;
export const TEXT_PREVIEW_BYTES = 256 * 1024;
const REMOTE_TIMEOUT_MS = 30_000;
const remoteProgram = `const deviceFilePrograms = ${JSON.stringify(deviceFilePrograms)}; (${deviceFileOperation.toString()})(JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'))).then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.stderr.write('File operation failed'); process.exitCode = 1; });`;
const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

export function parseFileRoots(value = "") {
  if (!value.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("ORION_FILE_ROOTS_JSON must be a JSON object.");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
    throw new Error("ORION_FILE_ROOTS_JSON must be a JSON object.");
  for (const roots of Object.values(parsed)) {
    if (!Array.isArray(roots) || roots.length > 20)
      throw new Error("Each file device must have at most 20 shared folders.");
    const ids = new Set();
    for (const root of roots) {
      if (
        !root ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(root.id) ||
        ids.has(root.id) ||
        typeof root.label !== "string" ||
        !root.label.trim() ||
        root.label.length > 80 ||
        typeof root.path !== "string" ||
        !/^(?:\/|[A-Za-z]:[\\/])/.test(root.path) ||
        /[\x00-\x1f]/.test(root.path)
      ) {
        throw new Error("Each shared folder needs a unique id, label, and absolute path.");
      }
      ids.add(root.id);
    }
  }
  return parsed;
}

export function filePresentation(name) {
  const extension = name.split(".").pop().toLowerCase();
  const images = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
  };
  const video = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
  const audio = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
  };
  if (Object.hasOwn(images, extension))
    return { previewKind: "image", mimeType: images[extension] };
  if (Object.hasOwn(video, extension)) return { previewKind: "video", mimeType: video[extension] };
  if (Object.hasOwn(audio, extension)) return { previewKind: "audio", mimeType: audio[extension] };
  if (extension === "pdf") return { previewKind: "pdf", mimeType: "application/pdf" };
  if (
    "txt md log csv tsv json jsonl yaml yml toml ini srt vtt py js mjs cjs ts tsx jsx css html htm xml svg sh ps1 bat sql rs go swift c cpp h java kt"
      .split(" ")
      .includes(extension)
  ) {
    return { previewKind: "text", mimeType: "text/plain; charset=utf-8" };
  }
  return { previewKind: "unsupported", mimeType: "application/octet-stream" };
}

export function parseFileRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const invalid = () => {
    throw Object.assign(fail("Requested file range is unavailable.", 416), { sizeBytes: size });
  };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return invalid();
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return invalid();
  const start = first ?? Math.max(0, size - last);
  const end = first === null ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if (start >= size || start > end || (first === null && last === 0)) return invalid();
  return { start, end, partial: true };
}

export class DeviceFiles {
  constructor({
    gateway,
    roots = {},
    localName = os.hostname(),
    worker = deviceFileOperation,
  } = {}) {
    this.gateway = gateway;
    this.roots = roots;
    this.worker = worker;
    this.localName = localName;
  }

  async gatewayRequest(method, params, signal, timeoutMs = REMOTE_TIMEOUT_MS) {
    signal?.throwIfAborted();
    let timer;
    let rejectAbort = () => {};
    const aborted = () => rejectAbort(signal.reason ?? fail("File request cancelled.", 499));
    try {
      return await Promise.race([
        this.gateway.request(method, params),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(fail("The computer did not answer. Try again when it is connected.", 504)),
            timeoutMs,
          );
        }),
        new Promise((_, reject) => {
          rejectAbort = reject;
          signal?.addEventListener("abort", aborted, { once: true });
          if (signal?.aborted) aborted();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    }
  }

  async devices(signal) {
    let nodes = [];
    let gatewayUnavailable = false;
    try {
      nodes = (await this.gatewayRequest("node.list", {}, signal, 10_000))?.nodes ?? [];
    } catch {
      signal?.throwIfAborted();
      gatewayUnavailable = true;
    }
    return {
      devices: [
        {
          id: "local",
          name: this.localName,
          platform: os.platform(),
          connected: true,
          available: ["darwin", "linux"].includes(os.platform()),
          local: true,
        },
        ...nodes
          .filter((node) => node.paired !== false && node.approvalState !== "pending")
          .map((node) => ({
            id: node.nodeId,
            name: node.displayName || "Paired computer",
            platform: node.platform ?? "unknown",
            connected: Boolean(node.connected),
            local: false,
            available: Boolean(
              node.connected &&
              node.commands?.includes("system.run") &&
              !/^(windows|win32)$/i.test(node.platform ?? ""),
            ),
          })),
      ],
      gatewayUnavailable,
    };
  }

  async operation(deviceId, operation, parameters = {}, signal) {
    signal?.throwIfAborted();
    if (typeof deviceId !== "string" || !deviceId || deviceId.length > 200)
      throw fail("Choose a file device.", 400);
    const input = { ...parameters, operation };
    if (Object.hasOwn(this.roots, deviceId)) input.roots = this.roots[deviceId];
    let result;
    if (deviceId === "local") {
      result = await this.worker(input);
    } else {
      let payload;
      try {
        payload = await this.gatewayRequest("node.list", {}, signal, 10_000);
      } catch {
        signal?.throwIfAborted();
        throw fail("The device connection is unavailable. Reconnect Orion and try again.", 503);
      }
      const node = payload?.nodes?.find((entry) => entry.nodeId === deviceId);
      if (!node || node.paired === false || node.approvalState === "pending")
        throw fail("This computer is not paired with Orion.", 404);
      if (!node.connected)
        throw fail("This computer is offline. Reconnect it to browse its files.", 503);
      if (/^(windows|win32)$/i.test(node.platform ?? ""))
        throw fail("Hardened file sharing is not available on Windows yet.", 501);
      if (!node.commands?.includes("system.run"))
        throw fail(
          "This device does not support file access. Connect an OpenClaw Node host with Node.js installed.",
          409,
        );
      const requestParams = {
        nodeId: deviceId,
        command: "system.run",
        idempotencyKey: randomUUID(),
        timeoutMs: 25_000,
        params: {
          command: [
            "node",
            "-e",
            remoteProgram,
            Buffer.from(JSON.stringify(input)).toString("base64"),
          ],
          timeoutMs: 20_000,
          suppressNotifyOnExit: true,
        },
      };
      try {
        const response = await this.gatewayRequest("node.invoke", requestParams, signal);
        const run = response?.payload ?? response;
        if (!run?.success || run.truncated)
          throw fail(
            "The device could not read files. Check its Node.js installation and OpenClaw execution permissions.",
            502,
          );
        try {
          result = JSON.parse(run.stdout);
        } catch {
          throw fail("The device returned an incomplete file response.", 502);
        }
      } catch (error) {
        if (error.statusCode || signal?.aborted) throw error;
        throw fail(
          "File access was refused by the device. Check its OpenClaw execution permissions.",
          502,
        );
      }
    }
    signal?.throwIfAborted();
    if (result?.ok !== true)
      throw fail(
        result?.error || "The device could not read this folder.",
        result?.statusCode || 502,
      );
    return result;
  }

  rootsFor(deviceId, signal) {
    return this.operation(deviceId, "roots", {}, signal);
  }
  list(deviceId, location, signal) {
    return this.operation(deviceId, "list", location, signal);
  }
  async stat(deviceId, location, signal) {
    const info = await this.operation(deviceId, "stat", location, signal);
    return { ...info, ...filePresentation(info.name) };
  }
  async *chunks(deviceId, location, info, start, end, signal) {
    let offset = start;
    while (offset <= end) {
      signal?.throwIfAborted();
      const length = Math.min(CHUNK_BYTES, end - offset + 1);
      const result = await this.operation(
        deviceId,
        "read",
        { ...location, revision: info.revision, offset, length },
        signal,
      );
      const bytes = Buffer.from(result.base64, "base64");
      if (bytes.length !== length || result.offset !== offset)
        throw fail("The file changed or the transfer was interrupted. Refresh and try again.", 409);
      yield bytes;
      offset += bytes.length;
    }
  }
}
