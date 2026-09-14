import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9.-]{1,63}$/;
const ROUTE_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const ELEMENT_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const ICONS = new Set(["chart", "flask", "landmark", "plug"]);

export function parseOrionPluginPaths(value) {
  if (!value) return [];
  return [...new Set(String(value).split(",").map((entry) => entry.trim()).filter(Boolean))];
}

export async function loadOrionPlugins({
  paths,
  app,
  express,
  dataRoot,
  broadcast,
  logger = console,
}) {
  const plugins = [];
  const errors = [];
  const shutdownCallbacks = [];
  const claimedRoutes = new Set();
  const claimedIds = new Set();

  for (const configuredPath of paths) {
    let loadedPlugin;
    try {
      const rootDir = fs.realpathSync(path.resolve(configuredPath));
      const packageJson = readPackageJson(rootDir);
      const entry = resolveEntry(rootDir, packageJson);
      const imported = await import(pathToFileURL(entry).href);
      const plugin = imported.default;
      validatePlugin(plugin);
      loadedPlugin = plugin;
      if (claimedIds.has(plugin.id)) throw new Error(`plugin id '${plugin.id}' is already registered`);

      const ui = [];
      const pluginRoutes = new Set();
      let apiRouter = null;
      let assetsDirectory = null;
      const apiBase = `/api/plugins/${plugin.id}`;
      const assetBase = `${apiBase}/assets`;
      const dataDir = path.join(dataRoot, plugin.id);
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

      const context = {
        pluginId: plugin.id,
        rootDir,
        dataDir,
        logger,
        mountApi(router) {
          if (apiRouter) throw new Error(`${plugin.id} already mounted an API router`);
          if (typeof router !== "function") throw new Error(`${plugin.id} API router is invalid`);
          apiRouter = router;
          return apiBase;
        },
        mountAssets(directory) {
          if (assetsDirectory) throw new Error(`${plugin.id} already mounted an asset directory`);
          const resolved = resolveInside(rootDir, directory);
          if (!fs.statSync(resolved).isDirectory()) {
            throw new Error(`${plugin.id} asset path is not a directory`);
          }
          assetsDirectory = resolved;
          return assetBase;
        },
        registerUi(contribution) {
          const normalized = validateUiContribution(contribution);
          if (claimedRoutes.has(normalized.route) || pluginRoutes.has(normalized.route)) {
            throw new Error(`plugin route '${normalized.route}' is already registered`);
          }
          pluginRoutes.add(normalized.route);
          ui.push({ ...normalized, moduleUrl: `${assetBase}/${normalized.modulePath}` });
        },
        broadcast(event, data) {
          const safeEvent = String(event ?? "").trim();
          if (!/^[a-z][a-z0-9.-]{1,80}$/.test(safeEvent)) {
            throw new Error("plugin event name is invalid");
          }
          broadcast(`plugin.${plugin.id}.${safeEvent}`, data);
        },
      };

      await plugin.initialize(context);
      if (ui.length > 0 && !assetsDirectory) {
        throw new Error(`${plugin.id} registered UI without mounting its assets`);
      }
      if (apiRouter) app.use(apiBase, apiRouter);
      if (assetsDirectory) {
        app.use(assetBase, express.static(assetsDirectory, { fallthrough: false, index: false }));
      }
      claimedIds.add(plugin.id);
      for (const route of pluginRoutes) claimedRoutes.add(route);
      if (typeof plugin.shutdown === "function") shutdownCallbacks.push(() => plugin.shutdown());
      plugins.push({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: typeof plugin.description === "string" ? plugin.description : "",
        apiBase: apiRouter ? apiBase : null,
        ui,
      });
      logger.info(`[orion-plugin] loaded ${plugin.id} v${plugin.version}`);
    } catch (error) {
      if (typeof loadedPlugin?.shutdown === "function") {
        await Promise.resolve(loadedPlugin.shutdown()).catch(() => {});
      }
      const detail = String(error?.message ?? error);
      errors.push({ path: configuredPath, detail });
      logger.error(`[orion-plugin] could not load ${configuredPath}: ${detail}`);
    }
  }

  return {
    manifest() {
      return { plugins, errors };
    },
    async shutdown() {
      await Promise.allSettled(shutdownCallbacks.map((shutdown) => shutdown()));
    },
  };
}

function readPackageJson(rootDir) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
}

function resolveEntry(rootDir, packageJson) {
  const configured = packageJson?.orion?.plugin;
  if (typeof configured !== "string" || !configured.trim()) {
    throw new Error("package.json must declare orion.plugin");
  }
  const entry = resolveInside(rootDir, configured);
  if (!fs.statSync(entry).isFile()) throw new Error("orion.plugin entry is not a file");
  return entry;
}

function resolveInside(rootDir, candidate) {
  const resolved = path.resolve(rootDir, candidate);
  const relative = path.relative(rootDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("plugin path must resolve inside its package root");
  }
  const realPath = fs.realpathSync(resolved);
  const realRelative = path.relative(rootDir, realPath);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("plugin path must not escape its package root through a symlink");
  }
  return realPath;
}

function validatePlugin(plugin) {
  if (!plugin || typeof plugin !== "object") throw new Error("plugin entry must export an object");
  if (!PLUGIN_ID_PATTERN.test(plugin.id ?? "")) throw new Error("plugin id is invalid");
  if (typeof plugin.name !== "string" || !plugin.name.trim()) throw new Error("plugin name is required");
  if (typeof plugin.version !== "string" || !plugin.version.trim()) {
    throw new Error("plugin version is required");
  }
  if (typeof plugin.initialize !== "function") throw new Error("plugin initialize() is required");
}

function validateUiContribution(contribution) {
  if (!contribution || typeof contribution !== "object") throw new Error("UI contribution is invalid");
  const route = String(contribution.route ?? "").trim();
  const label = String(contribution.label ?? "").trim();
  const elementName = String(contribution.elementName ?? "").trim();
  const modulePath = String(contribution.modulePath ?? "").trim();
  const icon = ICONS.has(contribution.icon) ? contribution.icon : "plug";
  if (!ROUTE_PATTERN.test(route)) throw new Error("plugin UI route is invalid");
  if (!label || label.length > 40) throw new Error("plugin UI label is invalid");
  if (!ELEMENT_PATTERN.test(elementName)) throw new Error("plugin UI elementName is invalid");
  if (!modulePath || path.isAbsolute(modulePath) || modulePath.split(/[\\/]/).includes("..")) {
    throw new Error("plugin UI modulePath is invalid");
  }
  return {
    route,
    label,
    description: String(contribution.description ?? "").trim().slice(0, 240),
    icon,
    elementName,
    modulePath: modulePath.replaceAll("\\", "/"),
  };
}
