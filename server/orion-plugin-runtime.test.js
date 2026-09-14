import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrionPlugins, parseOrionPluginPaths } from "./orion-plugin-runtime.js";

test("plugin paths are explicit, trimmed, and deduplicated", () => {
  assert.deepEqual(parseOrionPluginPaths(" /one, /two,/one ,,"), ["/one", "/two"]);
  assert.deepEqual(parseOrionPluginPaths(""), []);
});

test("a plugin contributes API and UI only after successful initialization", async (t) => {
  const root = pluginFixture(t, `
    export default {
      id: "example.finance",
      name: "Example Finance",
      version: "1.0.0",
      initialize(context) {
        context.mountApi((_req, _res, next) => next());
        context.mountAssets("assets");
        context.registerUi({
          route: "finance",
          label: "Finance",
          icon: "chart",
          elementName: "example-finance",
          modulePath: "entry.js"
        });
      }
    };
  `);
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "entry.js"), "export {};\n");
  const mounted = [];
  const runtime = await loadOrionPlugins({
    paths: [root],
    app: { use: (...args) => mounted.push(args) },
    express: { static: (directory, options) => ({ directory, options }) },
    dataRoot: path.join(root, "data"),
    broadcast() {},
    logger: silentLogger,
  });
  const manifest = runtime.manifest();
  assert.equal(manifest.errors.length, 0);
  assert.equal(manifest.plugins[0].ui[0].moduleUrl, "/api/plugins/example.finance/assets/entry.js");
  assert.deepEqual(mounted.map(([route]) => route), [
    "/api/plugins/example.finance",
    "/api/plugins/example.finance/assets",
  ]);
});

test("failed initialization leaves no mounted route or claimed UI path", async (t) => {
  const failed = pluginFixture(t, `
    export default {
      id: "failed.plugin",
      name: "Failed",
      version: "1.0.0",
      initialize(context) {
        context.mountApi((_req, _res, next) => next());
        context.registerUi({ route: "finance", label: "Finance", elementName: "failed-plugin", modulePath: "entry.js" });
        throw new Error("fixture failure");
      }
    };
  `);
  const valid = pluginFixture(t, `
    export default {
      id: "valid.plugin",
      name: "Valid",
      version: "1.0.0",
      initialize(context) {
        context.mountAssets("assets");
        context.registerUi({ route: "finance", label: "Finance", elementName: "valid-plugin", modulePath: "entry.js" });
      }
    };
  `);
  fs.mkdirSync(path.join(valid, "assets"));
  fs.writeFileSync(path.join(valid, "assets", "entry.js"), "export {};\n");
  const mounted = [];
  const runtime = await loadOrionPlugins({
    paths: [failed, valid],
    app: { use: (...args) => mounted.push(args) },
    express: { static: (directory) => ({ directory }) },
    dataRoot: path.join(valid, "data"),
    broadcast() {},
    logger: silentLogger,
  });
  assert.equal(runtime.manifest().errors.length, 1);
  assert.equal(runtime.manifest().plugins[0].id, "valid.plugin");
  assert.deepEqual(mounted.map(([route]) => route), ["/api/plugins/valid.plugin/assets"]);
});

test("real paths cannot escape the plugin root through a symlink", async (t) => {
  const root = pluginFixture(t, "export default {};\n", { entry: "entry-link.js" });
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orion-plugin-outside-"));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, "entry.js");
  fs.writeFileSync(outside, "export default {};\n");
  fs.symlinkSync(outside, path.join(root, "entry-link.js"));
  const runtime = await loadOrionPlugins({
    paths: [root],
    app: { use() {} },
    express: { static() {} },
    dataRoot: path.join(root, "data"),
    broadcast() {},
    logger: silentLogger,
  });
  assert.match(runtime.manifest().errors[0].detail, /symlink/);
});

const silentLogger = { info() {}, warn() {}, error() {} };

function pluginFixture(t, source, { entry = "entry.js" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orion-plugin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module", orion: { plugin: `./${entry}` } }));
  if (entry === "entry.js") fs.writeFileSync(path.join(root, entry), source);
  return root;
}
