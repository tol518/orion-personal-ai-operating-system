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
  TEXT_PREVIEW_BYTES,
} from "./device-files.js";
import { createDeviceFilesApi } from "./device-files-api.js";
import { createBrowserAuth } from "./browser-auth.js";
import { createDesktopApi } from "./desktop-api.js";
import { DesktopAccess } from "./desktop-access.js";

const run = promisify(execFile);
test("helper timeouts explain folder permissions and malformed output fails closed", async () => {
  // Bind test programs to the production launcher without adding a client-controlled hook.
  const bindProgram = new Function(
    "deviceFileProgram",
    `return (${deviceFileOperation.toString()})`,
  );
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
      assert.ok(params.params.command.join(" ").length < 32767, "fits Windows command-line limit");
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
  const files = new DeviceFiles({ gateway, roots: { local: fixtureData.roots } });
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
  return { ...fixtureData, base, headers, access };
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
