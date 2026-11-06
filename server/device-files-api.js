import express from "express";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseFileRange, TEXT_PREVIEW_BYTES } from "./device-files.js";
import { DROP_ROOT_ID } from "./file-drops.js";

const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/**
 * Where paired computers deliver streamed file ranges. Mounted ahead of the browser gate: a
 * computer has no session, so it authenticates with the one-time ticket its request carried,
 * and the bytes go straight to the request waiting for them without touching disk.
 */
export function createNodeFilesApi({ files }) {
  const router = express.Router();
  router.post("/files", (req, res) => {
    res.set({ "Cache-Control": "no-store", Connection: "close" });
    const ticket = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get("authorization") ?? "")?.[1];
    const waiting = files.tickets.claim(ticket);
    if (!waiting) {
      res.status(401).json({ ok: false, error: "This file ticket is unknown, expired, or already used." });
      return;
    }
    if (req.get("x-orion-stream-length") !== String(waiting.length)) {
      waiting.reject(fail("The computer offered a different range than was requested.", 502));
      res.status(400).json({ ok: false, error: "The stream length does not match the ticket." });
      return;
    }
    let received = 0;
    const body = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > waiting.length ? fail("The computer sent more than was requested.", 502) : null, chunk);
      },
      flush(callback) {
        callback(received === waiting.length ? null : fail("The file stream ended early.", 502));
      },
    });
    body.once("end", () => res.status(200).json({ ok: true }));
    body.once("close", () => {
      // Cut short: drop the computer's connection so its upload, and its helper, stop. Destroying
      // only the request would leave a fully received upload waiting for an answer.
      if (!body.readableEnded) res.destroy();
    });
    pipeline(req, body).catch(() => {});
    waiting.resolve(body);
  });
  return router;
}

// The caller mounts this router after its browser-session or desktop-token boundary.
export function createDeviceFilesApi({ files, audit = () => {} }) {
  const router = express.Router();
  const active = new Map();
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  function route(handler, action) {
    return async (req, res) => {
      const controller = new AbortController();
      const close = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", close);
      const name = action ?? `files.${req.path.split("/").pop()}`;
      try {
        await handler(req, res, controller.signal);
        audit(req, name, "completed");
      } catch (error) {
        audit(req, name, controller.signal.aborted ? "cancelled" : "failed");
        if (controller.signal.aborted) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error.statusCode === 416) res.set("Content-Range", `bytes */${error.sizeBytes}`);
        res
          .status(error.statusCode || 502)
          .json({ ok: false, error: error.message || "File access is unavailable." });
      } finally {
        res.removeListener("close", close);
      }
    };
  }
  function location(req) {
    const rootId = req.query.root;
    const path = req.query.path ?? "";
    if (
      typeof rootId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(rootId) ||
      typeof path !== "string"
    ) {
      throw Object.assign(new Error("Choose a shared folder and a valid path."), {
        statusCode: 400,
      });
    }
    const revision = req.query.revision;
    if (revision !== undefined && (typeof revision !== "string" || revision.length > 200)) {
      throw Object.assign(new Error("Invalid file revision."), { statusCode: 400 });
    }
    return { rootId, path, ...(revision ? { revision } : {}) };
  }
  router.get(
    "/devices",
    route(async (_req, res, signal) => res.json({ ok: true, ...(await files.devices(signal)) })),
  );
  router.get(
    "/:deviceId/roots",
    route(async (req, res, signal) => res.json(await files.rootsFor(req.params.deviceId, signal))),
  );
  router.get(
    "/:deviceId/list",
    route(async (req, res, signal) => {
      const offset = req.query.offset ?? "0";
      if (typeof offset !== "string" || !/^\d{1,4}$/.test(offset))
        throw Object.assign(new Error("Invalid folder page."), { statusCode: 400 });
      res.json(
        await files.list(req.params.deviceId, { ...location(req), offset: Number(offset) }, signal),
      );
    }),
  );
  router.get(
    "/:deviceId/stat",
    route(async (req, res, signal) =>
      res.json(await files.stat(req.params.deviceId, location(req), signal)),
    ),
  );
  // Dropping is the Files API's one write: a single chosen file into the server's own drop folder.
  function drops(deviceId) {
    if (deviceId !== "local" || !files.drops)
      throw Object.assign(new Error("Only the Orion server accepts dropped files."), { statusCode: 404 });
    return files.drops;
  }
  router.post(
    "/:deviceId/drops",
    route(async (req, res) => {
      const saved = await drops(req.params.deviceId).receive(req, req.query.name);
      res.status(201).json({ ok: true, rootId: DROP_ROOT_ID, ...saved });
    }, "files.drop"),
  );
  router.delete(
    "/:deviceId/drops",
    route(async (req, res) => {
      await drops(req.params.deviceId).remove(req.query.name);
      res.json({ ok: true });
    }, "files.drop_removed"),
  );
  router.get(
    "/:deviceId/content",
    route(async (req, res, signal) => {
      const deviceId = req.params.deviceId;
      const count = active.get(deviceId) ?? 0;
      if (count >= 3)
        throw Object.assign(
          new Error(
            "Three files are already transferring from this device. Wait for one to finish.",
          ),
          { statusCode: 429 },
        );
      active.set(deviceId, count + 1);
      try {
        const at = location(req);
        const info = await files.stat(deviceId, at, signal);
        const range = parseFileRange(req.get("Range"), info.sizeBytes);
        const textPreview = req.query.preview === "1" && info.previewKind === "text";
        if (textPreview) {
          range.start = 0;
          range.end = Math.min(info.sizeBytes, TEXT_PREVIEW_BYTES) - 1;
          range.partial = false;
        }
        const download = req.query.download === "1" || info.previewKind === "unsupported";
        const encodedName = encodeURIComponent(info.name).replace(
          /['()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        const headers = {
          "Content-Type": info.mimeType,
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodedName}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(Math.max(0, range.end - range.start + 1)),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Orion-Preview-Truncated": String(textPreview && info.sizeBytes > TEXT_PREVIEW_BYTES),
        };
        if (range.partial)
          headers["Content-Range"] = `bytes ${range.start}-${range.end}/${info.sizeBytes}`;
        if (req.method === "HEAD") {
          res
            .status(range.partial ? 206 : 200)
            .set(headers)
            .end();
          return;
        }
        const streamed = await files.stream(deviceId, at, info, range.start, range.end, signal);
        if (streamed) {
          res.status(range.partial ? 206 : 200).set(headers);
          await pipeline(streamed, res, { signal });
          return;
        }
        const chunks = files.chunks(deviceId, at, info, range.start, range.end, signal);
        // Read the first bounded chunk before headers so node permission failures remain useful JSON errors.
        const first = await chunks.next();
        res.status(range.partial ? 206 : 200).set(headers);
        const stream = Readable.from(
          (async function* () {
            try {
              if (!first.done) yield first.value;
              yield* chunks;
            } finally {
              await chunks.return();
            }
          })(),
        );
        await pipeline(stream, res, { signal });
      } finally {
        const remaining = (active.get(deviceId) ?? 1) - 1;
        if (remaining) active.set(deviceId, remaining);
        else active.delete(deviceId);
      }
    }),
  );
  return router;
}
