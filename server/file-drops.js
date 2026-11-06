import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DROP_ROOT_ID = "orion-drops";
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });

/**
 * A dropped file's name as stored. Characters the read helper refuses become dashes, so a dropped
 * file can always be opened again; a leading dot would hide it from Files, so it is refused.
 */
export function dropName(value) {
  if (typeof value !== "string") throw fail("Name the file being dropped.", 400);
  const name = value.normalize("NFC").replace(/[\x00-\x1f\x7f/\\:]/g, "-").trim();
  if (!name || name === "." || name === "..") throw fail("Name the file being dropped.", 400);
  if (name.startsWith(".")) throw fail("Names starting with a dot stay hidden in Files, so they cannot be dropped.", 400);
  if (Buffer.byteLength(name) > 255) throw fail("That file name is too long.", 400);
  return name;
}

export function parseDropLimit(value = "") {
  if (!value.trim()) return DEFAULT_MAX_BYTES;
  const megabytes = Number(value);
  if (!Number.isSafeInteger(megabytes) || megabytes < 1) throw new Error("ORION_DROP_MAX_MB must be a whole number of megabytes.");
  return megabytes * 1024 * 1024;
}

/**
 * Files someone chose to drop onto Orion from a client: the one place the Files API writes.
 * Each upload is a single file streamed to a hidden temporary name in a folder Orion owns, then
 * given its own name without replacing anything. Reads go back through the same hardened helper
 * as every other shared folder, so nothing here serves bytes.
 */
export class FileDrops {
  constructor({ directory, maxBytes = DEFAULT_MAX_BYTES }) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The read helper refuses links anywhere in a root's path, so keep the canonical one.
    this.directory = fs.realpathSync(directory);
    this.maxBytes = maxBytes;
    // An upload cut short by a restart leaves only a hidden temporary file behind.
    for (const name of fs.readdirSync(this.directory)) {
      if (name.startsWith(".incoming-")) fs.rmSync(path.join(this.directory, name), { force: true });
    }
  }

  get root() {
    return { id: DROP_ROOT_ID, label: "Dropped files", path: this.directory };
  }

  /** Stores one request body as a new file; never overwrites, so a repeat name gets " (2)". */
  async receive(req, requestedName) {
    const name = dropName(requestedName);
    const declared = Number(req.get("content-length"));
    if (!req.get("content-length") || !Number.isSafeInteger(declared) || declared < 0)
      throw fail("Send the file with its size.", 411);
    if (declared > this.maxBytes)
      throw fail(`Files up to ${Math.floor(this.maxBytes / 1024 ** 2)} MB can be dropped.`, 413);
    const temporary = path.join(this.directory, `.incoming-${randomUUID()}`);
    let received = 0;
    const counted = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > declared ? fail("The upload was larger than its declared size.", 400) : null, chunk);
      },
    });
    try {
      await pipeline(req, counted, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (received !== declared) throw fail("The upload ended before the whole file arrived.", 400);
      return { name: await this.#place(temporary, name), sizeBytes: received };
    } catch (error) {
      if (error.code === "ENOSPC") throw fail("The Orion server is out of disk space.", 507);
      throw error;
    } finally {
      await fsp.rm(temporary, { force: true });
    }
  }

  async #place(temporary, name) {
    const { name: stem, ext } = path.parse(name);
    for (let copy = 1; copy <= 999; copy += 1) {
      const candidate = copy === 1 ? name : `${stem} (${copy})${ext}`;
      try {
        // link() fails rather than replacing an existing file, unlike rename().
        await fsp.link(temporary, path.join(this.directory, candidate));
        return candidate;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    throw fail("Too many dropped files share this name.", 409);
  }

  /** Takes one dropped file back out of Orion. Only plain files directly in the folder. */
  async remove(requestedName) {
    const name = dropName(requestedName);
    if (name !== requestedName) throw fail("No dropped file has that name.", 404);
    const target = path.join(this.directory, name);
    try {
      if (!(await fsp.lstat(target)).isFile()) throw fail("Only dropped files can be removed.", 403);
      await fsp.unlink(target);
    } catch (error) {
      if (error.code === "ENOENT") throw fail("That dropped file is already gone.", 404);
      throw error;
    }
  }
}
