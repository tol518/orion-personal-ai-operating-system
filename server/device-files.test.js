import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { deviceFileOperation } from "./device-file-worker.js";
import {
  DeviceFiles,
  filePresentation,
  parseFileRange,
  parseFileRoots,
  parseStreamUrl,
  TEXT_PREVIEW_BYTES,
} from "./device-files.js";
import { createDeviceFilesApi, createNodeFilesApi } from "./device-files-api.js";
import { DROP_ROOT_ID, FileDrops, dropName, parseDropLimit } from "./file-drops.js";
import { createBrowserAuth } from "./browser-auth.js";
import { createDesktopApi } from "./desktop-api.js";
import { DesktopAccess } from "./desktop-access.js";

const run = promisify(execFile);
test("helper timeouts explain folder permissions and malformed output fails closed", async () => {
  // Bind test programs to the production launcher without adding a client-controlled hook.
  const bindProgram = (posix) =>
    new Function("deviceFilePrograms", `return (${deviceFileOperation.toString()})`)({ posix });
  const timeout = await bindProgram("import signal, time; signal.alarm(1); time.sleep(5)")({});
  assert.equal(timeout.statusCode, 504);
  assert.match(timeout.error, /Files and Folders permissions/);
  const malformed = await bindProgram("print('not-json')")({});
  assert.equal(malformed.statusCode, 503);
});
test("descriptor-relative boundary resists deterministic path-replacement races", async () => {
  const result = await run(process.platform === "darwin" ? "/usr/bin/python3" : "python3", [
    "-I",
    new URL("./device-file-posix-test.py", import.meta.url).pathname,
  ]);
  assert.match(result.stderr, /OK/);
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "orion-files-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const shared = path.join(root, "shared");
  await fs.mkdir(shared);
  await fs.mkdir(path.join(shared, "Projects"));
  await fs.writeFile(path.join(shared, "hello.txt"), "Hello from a device.\n");
  await fs.writeFile(path.join(shared, ".env"), "not shared");
  await fs.writeFile(path.join(root, "private.txt"), "outside root");
  const roots = [{ id: "docs", label: "Documents", path: shared }];
  const operation = (input) => deviceFileOperation({ roots, rootId: "docs", path: "", ...input });
  return { root, shared, roots, operation };
}

test("shared folders expose ids and labels without absolute paths", async (t) => {
  const { operation } = await fixture(t);
  assert.deepEqual(await operation({ operation: "roots" }), {
    ok: true,
    roots: [{ id: "docs", label: "Documents" }],
  });
});
test("listing sorts folders first and excludes hidden files and links", async (t) => {
  const { shared, root, operation } = await fixture(t);
  await fs.symlink(root, path.join(shared, "escape"));
  const listing = await operation({ operation: "list" });
  assert.deepEqual(
    listing.entries.map(({ name, kind }) => ({ name, kind })),
    [
      { name: "Projects", kind: "directory" },
      { name: "hello.txt", kind: "file" },
    ],
  );
});
test("rejects traversal, absolute paths, hidden segments and Windows paths", async (t) => {
  const { operation } = await fixture(t);
  for (const target of [
    "../private.txt",
    "/private.txt",
    "Projects/../../private.txt",
    ".env",
    "Projects/.git/config",
    "C:\\private.txt",
    "Projects\\..\\private.txt",
    "hello.txt:secret",
    "Projects//x",
  ]) {
    const response = await operation({ operation: "stat", path: target });
    assert.equal(response.ok, false, target);
    assert.ok([400, 403].includes(response.statusCode), target);
  }
});
test("refuses links through any path segment", async (t) => {
  const { shared, root, operation } = await fixture(t);
  await fs.symlink(root, path.join(shared, "escape"));
  await fs.symlink(path.join(root, "private.txt"), path.join(shared, "linked.txt"));
  for (const target of ["escape/private.txt", "linked.txt"]) {
    assert.equal(
      (await operation({ operation: "read", path: target, offset: 0, length: 12 })).statusCode,
      403,
    );
  }
});
test("unknown roots are refused and missing-file errors contain no host paths", async (t) => {
  const { operation, shared } = await fixture(t);
  assert.equal((await operation({ operation: "stat", rootId: "nope" })).statusCode, 404);
  const missing = await operation({ operation: "stat", path: "missing.txt" });
  assert.equal(missing.statusCode, 404);
  assert.ok(!missing.error.includes(shared));
});
test("folder pagination is bounded to 100 entries", async (t) => {
  const { shared, operation } = await fixture(t);
  await Promise.all(
    Array.from({ length: 110 }, (_, i) =>
      fs.writeFile(path.join(shared, `item-${String(i).padStart(3, "0")}.txt`), "x"),
    ),
  );
  const first = await operation({ operation: "list" });
  const second = await operation({ operation: "list", offset: first.nextOffset });
  assert.equal(first.entries.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(second.entries.length, 12);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.name)).size, 112);
});
test("bounded reads preserve bytes and reject a changed file revision", async (t) => {
  const { shared, operation } = await fixture(t);
  const info = await operation({ operation: "stat", path: "hello.txt" });
  const read = await operation({
    operation: "read",
    path: "hello.txt",
    offset: 6,
    length: 4,
    revision: info.revision,
  });
  assert.equal(Buffer.from(read.base64, "base64").toString(), "from");
  assert.equal(
    (await operation({ operation: "read", path: "hello.txt", offset: 0, length: 65537 }))
      .statusCode,
    400,
  );
  await fs.writeFile(path.join(shared, "hello.txt"), "new content");
  assert.equal(
    (
      await operation({
        operation: "read",
        path: "hello.txt",
        offset: 0,
        length: 3,
        revision: info.revision,
      })
    ).statusCode,
    409,
  );
});
test("shared-folder configuration supports empty shares and validates ids and paths", () => {
  assert.deepEqual(parseFileRoots(), {});
  assert.deepEqual(parseFileRoots('{"local":[]}'), { local: [] });
  for (const config of [
    "[]",
    "null",
    "{",
    '{"local":[{"id":"x","label":"x","path":"../private"}]}',
    '{"local":[{"id":"../x","label":"x","path":"/shared"}]}',
  ]) {
    assert.throws(() => parseFileRoots(config));
  }
  assert.equal(
    parseFileRoots('{"pc":[{"id":"docs","label":"Documents","path":"C:\\\\Shared"}]}').pc[0].id,
    "docs",
  );
});
test("active formats are served as text and unknown files download", () => {
  for (const name of ["script.html", "diagram.svg", "readme.md", "app.js"])
    assert.equal(filePresentation(name).previewKind, "text");
  assert.equal(filePresentation("photo.PNG").mimeType, "image/png");
  assert.equal(filePresentation("installer.exe").previewKind, "unsupported");
  for (const name of ["constructor", "report.__proto__", "notes.constructor"])
    assert.deepEqual(filePresentation(name), {
      previewKind: "unsupported",
      mimeType: "application/octet-stream",
    });
});
test("HTTP ranges support seeking, suffixes, clipping and empty files", () => {
  assert.deepEqual(parseFileRange(undefined, 0), { start: 0, end: -1, partial: false });
  assert.deepEqual(parseFileRange("bytes=2-5", 10), { start: 2, end: 5, partial: true });
  assert.deepEqual(parseFileRange("bytes=8-", 10), { start: 8, end: 9, partial: true });
  assert.deepEqual(parseFileRange("bytes=-3", 10), { start: 7, end: 9, partial: true });
  assert.deepEqual(parseFileRange("bytes=0-999", 10), { start: 0, end: 9, partial: true });
  for (const header of [
    "bytes=10-",
    "bytes=8-2",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=999999999999999999999-",
  ]) {
    assert.throws(() => parseFileRange(header, 10), { statusCode: 416 });
  }
  assert.throws(() => parseFileRange("bytes=0-", 0), { statusCode: 416 });
});

function remoteGateway(roots, overrides = {}) {
  const calls = [];
  let node = {
    nodeId: "test-pc",
    displayName: "Test PC",
    platform: process.platform,
    connected: true,
    paired: true,
    commands: ["system.run"],
    ...overrides,
  };
  return {
    calls,
    setNode: (next) => {
      node = next;
    },
    async request(method, params) {
      if (method === "node.list") return { nodes: node ? [node] : [] };
      assert.equal(method, "node.invoke");
      calls.push(params);
      assert.equal(params.command, "system.run");
      assert.equal(params.params.suppressNotifyOnExit, true);
      // Native Windows hosts are refused before any invocation, so the binding limit is Linux's
      // single-argument cap (MAX_ARG_STRLEN, 128 KiB), not Windows' 32,767-character command line.
      assert.ok(params.params.command[2].length < 131072, "fits one Linux argument");
      const command = params.params.command;
      const input = JSON.parse(Buffer.from(command[3], "base64"));
      assert.deepEqual(input.roots, roots);
      const result = await run(process.execPath, command.slice(1), { maxBuffer: 200000 });
      return { payload: { success: true, truncated: false, ...result } };
    },
  };
}
test("remote operations run the actual worker and stream binary data across multiple chunks", async (t) => {
  const { roots, shared } = await fixture(t);
  const bytes = Buffer.from(Array.from({ length: 180000 }, (_, i) => i % 256));
  await fs.writeFile(path.join(shared, "video.mp4"), bytes);
  const gateway = remoteGateway(roots);
  const files = new DeviceFiles({ gateway, roots: { "test-pc": roots } });
  const location = { rootId: "docs", path: "video.mp4" };
  const info = await files.stat("test-pc", location);
  assert.equal(info.previewKind, "video");
  const chunks = [];
  for await (const chunk of files.chunks("test-pc", location, info, 0, bytes.length - 1))
    chunks.push(chunk);
  assert.equal(chunks.length, 3);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(gateway.calls.length, 4);
});
test("unknown, offline, unpaired and incapable nodes cannot read files", async () => {
  for (const [node, status] of [
    [null, 404],
    [{ nodeId: "test-pc", connected: false }, 503],
    [{ nodeId: "test-pc", connected: true, paired: false }, 404],
    [{ nodeId: "test-pc", connected: true, commands: [] }, 409],
  ]) {
    const files = new DeviceFiles({
      gateway: { request: async () => ({ nodes: node ? [node] : [] }) },
    });
    await assert.rejects(files.rootsFor("test-pc"), { statusCode: status });
  }
});
test("local folders remain accessible when the gateway is unavailable", async (t) => {
  const { roots } = await fixture(t);
  const files = new DeviceFiles({
    roots: { local: roots },
    gateway: {
      request: async () => {
        throw new Error("unreachable");
      },
    },
  });
  assert.equal((await files.devices()).gatewayUnavailable, true);
  assert.equal((await files.rootsFor("local")).roots.length, 1);
});
test("Windows sharing fails closed without invoking a pathname-based fallback", async () => {
  const gateway = remoteGateway([], { platform: "win32" });
  const files = new DeviceFiles({ gateway });
  assert.equal((await files.devices()).devices.find((d) => d.id === "test-pc").available, false);
  await assert.rejects(files.rootsFor("test-pc"), { statusCode: 501 });
  assert.equal(gateway.calls.length, 0);
});
test("device discovery and remote reads can be cancelled while the gateway is silent", async () => {
  const files = new DeviceFiles({ gateway: { request: () => new Promise(() => {}) } });
  for (const request of [
    (signal) => files.devices(signal),
    (signal) => files.rootsFor("test-pc", signal),
  ]) {
    const controller = new AbortController();
    const pending = request(controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
  }
});
test("revocation and cancellation stop subsequent transfer chunks", async (t) => {
  const { roots, shared } = await fixture(t);
  await fs.writeFile(path.join(shared, "large.bin"), Buffer.alloc(150000));
  const gateway = remoteGateway(roots);
  const files = new DeviceFiles({ gateway, roots: { "test-pc": roots } });
  const location = { rootId: "docs", path: "large.bin" };
  const info = await files.stat("test-pc", location);
  const chunks = files.chunks("test-pc", location, info, 0, 149999);
  await chunks.next();
  gateway.setNode(null);
  await assert.rejects(chunks.next(), { statusCode: 404 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(files.rootsFor("local", controller.signal), { name: "AbortError" });
});

async function httpFixture(t) {
  const fixtureData = await fixture(t);
  const gateway = { request: async () => ({ nodes: [] }), status: () => ({ connected: true }) };
  const drops = new FileDrops({ directory: path.join(fixtureData.root, "dropped"), maxBytes: 1_000_000 });
  const files = new DeviceFiles({ gateway, roots: { local: fixtureData.roots }, drops });
  const auth = createBrowserAuth({ password: "test-dashboard-password", port: 4820 });
  const access = new DesktopAccess({ pairingSecret: "test-pairing-secret" });
  const app = express();
  app.use(express.json());
  auth.mountRoutes(app);
  app.use("/api/v1/desktop", createDesktopApi({ gateway, access, files }));
  app.use("/api", auth.gate);
  app.use("/api/files", createDeviceFilesApi({ files }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4820" },
    body: JSON.stringify({ password: "test-dashboard-password" }),
  });
  const headers = { Cookie: response.headers.get("set-cookie").split(";")[0] };
  return { ...fixtureData, base, headers, access, drops };
}
test("browser and desktop file routes reject unauthenticated access", async (t) => {
  const { base } = await httpFixture(t);
  for (const prefix of ["/api/files", "/api/v1/desktop/files"]) {
    for (const route of [
      "/devices",
      "/local/roots",
      "/local/list?root=docs",
      "/local/content?root=docs&path=hello.txt",
    ]) {
      assert.equal((await fetch(`${base}${prefix}${route}`)).status, 401);
    }
  }
});
test("content downloads, HEAD, ranges, Unicode names and empty files use safe headers", async (t) => {
  const { base, headers, shared } = await httpFixture(t);
  const url = `${base}/api/files/local/content?root=docs&path=hello.txt`;
  const response = await fetch(url, { headers });
  assert.equal(await response.text(), "Hello from a device.\n");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const partial = await fetch(url, { headers: { ...headers, Range: "bytes=6-9" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 6-9/21");
  assert.equal(await partial.text(), "from");
  const head = await fetch(url, { headers, method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "21");
  assert.equal(await head.text(), "");
  const invalid = await fetch(url, { headers: { ...headers, Range: "bytes=999-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */21");
  await fs.writeFile(path.join(shared, "notes & plans.txt"), "safe");
  const download = await fetch(
    `${base}/api/files/local/content?root=docs&path=notes%20%26%20plans.txt&download=1`,
    { headers },
  );
  assert.match(
    download.headers.get("content-disposition"),
    /^attachment; filename\*=UTF-8''notes%20%26%20plans.txt$/,
  );
  await download.text();
  await fs.writeFile(path.join(shared, "empty.txt"), "");
  const empty = await fetch(`${base}/api/files/local/content?root=docs&path=empty.txt`, {
    headers,
  });
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
});
test("text previews are bounded, HTML cannot execute, and downloads contain the complete file", async (t) => {
  const { base, headers, shared } = await httpFixture(t);
  const bytes = Buffer.alloc(TEXT_PREVIEW_BYTES + 100, "x");
  await fs.writeFile(path.join(shared, "large.html"), bytes);
  const url = `${base}/api/files/local/content?root=docs&path=large.html`;
  const preview = await fetch(`${url}&preview=1`, { headers });
  assert.equal((await preview.arrayBuffer()).byteLength, TEXT_PREVIEW_BYTES);
  assert.equal(preview.headers.get("x-orion-preview-truncated"), "true");
  assert.match(preview.headers.get("content-type"), /^text\/plain/);
  assert.match(preview.headers.get("content-security-policy"), /sandbox/);
  const download = await fetch(`${url}&download=1`, { headers });
  assert.equal((await download.arrayBuffer()).byteLength, bytes.length);
});
test("desktop tokens access only shared roots and audit without filenames or content", async (t) => {
  const { base, access, shared } = await httpFixture(t);
  const pair = access.pair({
    pairingSecret: "test-pairing-secret",
    clientId: "test-mac",
    clientName: "Test Mac",
    platform: "macos",
    clientKey: "local",
  });
  const headers = { Authorization: `Bearer ${pair.token}` };
  const prefix = `${base}/api/v1/desktop/files/local`;
  const response = await fetch(`${prefix}/content?root=docs&path=hello.txt`, { headers });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Hello/);
  const denied = await fetch(`${prefix}/content?root=docs&path=..%2Fprivate.txt`, { headers });
  assert.equal(denied.status, 403);
  const audit = JSON.stringify(access.audit());
  assert.match(audit, /files.content/);
  for (const secret of ["hello.txt", shared, "Hello from a device", pair.token])
    assert.ok(!audit.includes(secret));
  access.revoke(pair.token);
  assert.equal((await fetch(`${prefix}/roots`, { headers })).status, 401);
});

async function streamServer(t, files) {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/node", createNodeFilesApi({ files }));
  app.use("/api/files", createDeviceFilesApi({ files }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
const invokes = (gateway) => gateway.calls.map((call) => JSON.parse(Buffer.from(call.params.command[3], "base64")).operation);

test("stream addresses keep any path prefix and refuse credentials, queries and other schemes", () => {
  assert.equal(parseStreamUrl(""), null);
  assert.equal(parseStreamUrl("https://mini.example.ts.net:8443"), "https://mini.example.ts.net:8443/api/v1/node/files");
  assert.equal(parseStreamUrl("https://host.example/orion/"), "https://host.example/orion/api/v1/node/files");
  for (const value of ["ftp://host", "https://user:pw@host", "https://host/?x=1", "not a url"])
    assert.throws(() => parseStreamUrl(value), /ORION_NODE_STREAM_URL/, value);
});
test("a paired computer streams a whole range through one invocation and a one-time ticket", async (t) => {
  const { roots, shared } = await fixture(t);
  const bytes = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => (i * 7) % 256));
  await fs.writeFile(path.join(shared, "film.mp4"), bytes);
  const gateway = remoteGateway(roots);
  const files = new DeviceFiles({ gateway, roots: { "test-pc": roots } });
  const base = await streamServer(t, files);
  files.streamUrl = parseStreamUrl(base);
  const url = `${base}/api/files/test-pc/content?root=docs&path=film.mp4`;
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
  const partial = await fetch(url, { headers: { Range: "bytes=1000000-1999999" } });
  assert.equal(partial.status, 206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(1_000_000, 2_000_000));
  assert.deepEqual(invokes(gateway), ["stat", "stream", "stat", "stream"]);
  for (const call of gateway.calls.filter((_, i) => i % 2)) {
    const input = JSON.parse(Buffer.from(call.params.command[3], "base64"));
    assert.match(input.upload.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(call.params.timeoutMs > 60 * 60 * 1000, "a film may outlast the 20-second request limit");
  }
  assert.equal(files.tickets.waiting.size, 0);
});
test("the upload route takes only a live ticket, once, for exactly the requested length", async (t) => {
  const files = new DeviceFiles({ gateway: { request: async () => ({ nodes: [] }) } });
  const base = await streamServer(t, files);
  const post = (ticket, body, length = body.length) =>
    fetch(`${base}/api/v1/node/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${ticket}`, "x-orion-stream-length": String(length) },
      body,
    });
  assert.equal((await post("A".repeat(43), "hello")).status, 401);
  const wrongLength = files.tickets.issue(5);
  assert.equal((await post(wrongLength.value, "hello", 6)).status, 400);
  await assert.rejects(wrongLength.arrival, { statusCode: 502 });
  const ticket = files.tickets.issue(5);
  // The computer's request is answered only once the waiting reader has taken every byte.
  const sent = post(ticket.value, "hello");
  const received = [];
  for await (const chunk of await ticket.arrival) received.push(chunk);
  assert.equal(Buffer.concat(received).toString(), "hello");
  assert.equal((await sent).status, 200);
  assert.equal((await post(ticket.value, "hello")).status, 401, "a ticket is good for one delivery");
  const oversized = files.tickets.issue(3);
  const refused = post(oversized.value, "hello", 3).catch(() => null);
  const extra = await oversized.arrival;
  await assert.rejects(async () => {
    for await (const _ of extra);
  }, /more than was requested/);
  await refused;
});
test("a computer that cannot reach the stream address falls back to 64 KiB requests", async (t) => {
  const { roots, shared } = await fixture(t);
  const bytes = Buffer.alloc(150_000, 7);
  await fs.writeFile(path.join(shared, "large.bin"), bytes);
  const gateway = remoteGateway(roots);
  const files = new DeviceFiles({ gateway, roots: { "test-pc": roots } });
  const base = await streamServer(t, files);
  const closed = express().listen(0, "127.0.0.1");
  await new Promise((resolve) => closed.once("listening", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  files.streamUrl = parseStreamUrl(`http://127.0.0.1:${port}`);
  const url = `${base}/api/files/test-pc/content?root=docs&path=large.bin`;
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
  assert.deepEqual(invokes(gateway), ["stat", "stream", "read", "read", "read"]);
  gateway.calls.length = 0;
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
  assert.deepEqual(invokes(gateway), ["stat", "read", "read", "read"], "no retry until the back-off passes");
  assert.equal(files.tickets.waiting.size, 0);
});
test("local downloads stream from one helper run and a closed browser stops it", async (t) => {
  const { roots, shared } = await fixture(t);
  const bytes = Buffer.alloc(5_000_000, 3);
  await fs.writeFile(path.join(shared, "big.bin"), bytes);
  const operations = [];
  const files = new DeviceFiles({
    gateway: { request: async () => ({ nodes: [] }) },
    roots: { local: roots },
    worker: (input, sink) => {
      operations.push(input.operation);
      return deviceFileOperation(input, sink);
    },
  });
  const base = await streamServer(t, files);
  const url = `${base}/api/files/local/content?root=docs&path=big.bin`;
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), bytes);
  assert.deepEqual(operations, ["stat", "stream"]);
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(Buffer.from(await (await fetch(url, { headers: { Range: "bytes=0-9" } })).arrayBuffer()), bytes.subarray(0, 10));
});

test("dropped-file names stay openable and visible, and the size limit is configurable", () => {
  assert.equal(dropName("Report: Q3/final\\v2.pdf"), "Report- Q3-final-v2.pdf");
  assert.equal(dropName("  café.txt "), "café.txt");
  for (const name of [".env", "", "..", "x".repeat(256), undefined])
    assert.throws(() => dropName(name), { statusCode: 400 }, String(name));
  assert.equal(parseDropLimit(""), 2 * 1024 ** 3);
  assert.equal(parseDropLimit("10"), 10 * 1024 * 1024);
  assert.throws(() => parseDropLimit("lots"), /ORION_DROP_MAX_MB/);
});
test("selected files dropped from a client appear as the server's Dropped files and can be taken back", async (t) => {
  const { base, headers, drops, access, shared } = await httpFixture(t);
  const drop = (name, body, extra = {}) =>
    fetch(`${base}/api/files/local/drops?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", ...extra },
      body,
    });
  assert.equal((await fetch(`${base}/api/files/local/drops?name=x.txt`, { method: "POST", body: "x" })).status, 401);
  const first = await drop("notes.txt", "from the MacBook");
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { ok: true, rootId: DROP_ROOT_ID, path: "notes.txt", name: "notes.txt", sizeBytes: 16 });
  assert.equal((await (await drop("notes.txt", "second")).json()).name, "notes (2).txt", "never overwrites");
  const roots = await (await fetch(`${base}/api/files/local/roots`, { headers })).json();
  assert.deepEqual(roots.roots.at(-1), { id: DROP_ROOT_ID, label: "Dropped files", writable: true });
  assert.equal(roots.roots[0].id, "docs", "shared folders still open first");
  assert.ok(!JSON.stringify(roots).includes(drops.directory), "the folder's path stays on the server");
  const listing = await (await fetch(`${base}/api/files/local/list?root=${DROP_ROOT_ID}`, { headers })).json();
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["notes (2).txt", "notes.txt"]);
  const content = await fetch(`${base}/api/files/local/content?root=${DROP_ROOT_ID}&path=notes.txt`, { headers });
  assert.equal(await content.text(), "from the MacBook");
  assert.equal((await drop(".env", "secret")).status, 400);
  assert.equal((await drop("big.bin", Buffer.alloc(1_000_001))).status, 413);
  assert.equal((await fetch(`${base}/api/files/other-pc/drops?name=a.txt`, { method: "POST", headers, body: "a" })).status, 404);
  const removed = await fetch(`${base}/api/files/local/drops?name=notes.txt`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${base}/api/files/local/drops?name=notes.txt`, { method: "DELETE", headers })).status, 404);
  for (const name of ["..%2Fshared%2Fhello.txt", "hello.txt"]) {
    const refused = await fetch(`${base}/api/files/local/drops?name=${name}`, { method: "DELETE", headers });
    assert.ok([400, 404].includes(refused.status), name);
  }
  assert.equal(await fs.readFile(path.join(shared, "hello.txt"), "utf8"), "Hello from a device.\n", "only dropped files can be removed");
  assert.deepEqual((await fs.readdir(drops.directory)).sort(), ["notes (2).txt"], "no temporary files remain");
  const pair = access.pair({ pairingSecret: "test-pairing-secret", clientId: "test-mac", clientName: "Test Mac", platform: "macos", clientKey: "local" });
  const native = await fetch(`${base}/api/v1/desktop/files/local/drops?name=${encodeURIComponent("Photo 1.jpg")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pair.token}`, "Content-Type": "application/octet-stream" },
    body: Buffer.from([1, 2, 3]),
  });
  assert.equal(native.status, 201);
  const audit = JSON.stringify(access.audit());
  assert.match(audit, /files\.drop/);
  assert.ok(!audit.includes("Photo 1.jpg"), "the audit names the action, not the file");
});
test("an interrupted drop leaves nothing behind, and a restart clears stray uploads", async (t) => {
  const { base, headers, drops } = await httpFixture(t);
  const controller = new AbortController();
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(new Uint8Array(1000));
    },
  });
  const pending = fetch(`${base}/api/files/local/drops?name=partial.bin`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": "5000" },
    body,
    duplex: "half",
    signal: controller.signal,
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 200));
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await fs.readdir(drops.directory), []);
  await fs.writeFile(path.join(drops.directory, ".incoming-stale"), "x");
  new FileDrops({ directory: drops.directory });
  assert.deepEqual(await fs.readdir(drops.directory), []);
});
test("the server keeps a long upload open for as long as a stream may run", async () => {
  const { LONGEST_UPLOAD_MS } = await import("./device-files.js");
  assert.ok(LONGEST_UPLOAD_MS > 2 * 60 * 60 * 1000);
  const source = await fs.readFile(new URL("./index.js", import.meta.url), "utf8");
  assert.match(source, /^httpServer\.requestTimeout = LONGEST_UPLOAD_MS;$/m);
});

test("a dropped folder keeps its structure, gets a name of its own, and goes back out whole", async (t) => {
  const { base, headers, drops } = await httpFixture(t);
  const call = (method, route, query, body) =>
    fetch(`${base}/api/files/local/${route}?path=${encodeURIComponent(query)}`, {
      method,
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body,
    });
  const folder = await (await call("POST", "drops/folders", "Photos")).json();
  assert.deepEqual(folder, { ok: true, rootId: DROP_ROOT_ID, path: "Photos" });
  assert.equal((await (await call("POST", "drops/folders", "Photos")).json()).path, "Photos (2)", "a second drop never merges into the first");
  assert.equal((await call("POST", "drops/folders", "Photos/Trips/Empty")).status, 201, "empty folders survive");
  const nested = await (await call("POST", "drops", "Photos/Trips/2026/beach.jpg", "sand")).json();
  assert.deepEqual(nested, { ok: true, rootId: DROP_ROOT_ID, path: "Photos/Trips/2026/beach.jpg", name: "beach.jpg", sizeBytes: 4 });
  const listing = await (await fetch(`${base}/api/files/local/list?root=${DROP_ROOT_ID}&path=Photos%2FTrips`, { headers })).json();
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["2026", "Empty"]);
  const content = await fetch(`${base}/api/files/local/content?root=${DROP_ROOT_ID}&path=Photos%2FTrips%2F2026%2Fbeach.jpg`, { headers });
  assert.equal(await content.text(), "sand");
  for (const unsafe of ["Photos/../escape.txt", "Photos/.git/config", "Photos//x.txt", `${"a/".repeat(33)}x.txt`]) {
    const refused = await call("POST", "drops", unsafe, "x");
    assert.equal(refused.status, 400, unsafe);
  }
  await fs.symlink(path.dirname(drops.directory), path.join(drops.directory, "Photos", "link"));
  assert.equal((await call("POST", "drops", "Photos/link/planted.txt", "x")).status, 409, "a link inside the drop folder is never followed");
  assert.equal((await call("DELETE", "drops", "Photos/link/anything")).status, 409);
  await assert.rejects(fs.access(path.join(path.dirname(drops.directory), "planted.txt")));
  assert.equal((await call("DELETE", "drops", "Photos/Trips/2026/beach.jpg")).status, 200);
  assert.equal((await call("DELETE", "drops", "Photos")).status, 200, "a whole dropped folder goes back out");
  assert.deepEqual(await fs.readdir(drops.directory), ["Photos (2)"]);
  assert.equal((await call("DELETE", "drops", "Photos")).status, 404);
});
