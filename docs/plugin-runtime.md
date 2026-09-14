# Local plugin runtime

ORION can load independent local feature packages without importing them into core. Core owns only package discovery, authenticated mount points, lifecycle, UI registration, and the small `@orion-os/plugin-sdk` contract.

## Install a local plugin

Build the plugin first, then add its absolute package root to the uncommitted `server/.env`:

```dotenv
ORION_PLUGIN_PATHS=/absolute/path/to/plugin-one,/absolute/path/to/plugin-two
```

Restart the BFF. `GET /api/plugins` returns successfully loaded contributions and isolated load errors. Plugin routes remain behind ORION's whole-dashboard authentication.

## Package contract

The package must declare its entry:

```json
{
  "type": "module",
  "orion": {
    "plugin": "./src/plugin/index.js"
  }
}
```

The entry exports one object compatible with `@orion-os/plugin-sdk`:

```js
export default {
  id: "example.research",
  name: "Research",
  version: "1.0.0",
  async initialize(context) {
    context.mountApi(router);
    context.mountAssets("ui/dist");
    context.registerUi({
      route: "research",
      label: "Research",
      icon: "flask",
      elementName: "example-research",
      modulePath: "entry.js"
    });
  },
  async shutdown() {}
};
```

## Context methods

| Method | Contract |
| --- | --- |
| `mountApi(router)` | Mount one Express router at `/api/plugins/<plugin-id>`. The parent dashboard auth is already active. |
| `mountAssets(directory)` | Serve one real directory contained by the plugin root at `/api/plugins/<plugin-id>/assets`. |
| `registerUi(contribution)` | Register a unique route, label, supported icon, custom-element name, and module path. UI requires mounted assets. |
| `broadcast(event, data)` | Publish a namespaced SSE event as `plugin.<plugin-id>.<event>`. |

`context.dataDir` is the plugin's private directory under `server/data/plugins/<plugin-id>`. Runtime state belongs there, not in the plugin source tree.

## Browser contract

ORION fetches the authenticated plugin manifest once, adds each contribution to desktop and mobile navigation, dynamically imports its ES module, and creates the registered custom element. The host supplies:

- `api-base`: authenticated plugin API base;
- `orion-route`: registered host route.

Plugins should isolate component styles, preferably with shadow DOM. They must not receive gateway credentials or dashboard passwords.

## Failure isolation

- Entry and asset real paths must remain inside the declared package root, including through symlinks.
- IDs, routes, custom-element names, icon names, module paths, and event names are validated.
- Duplicate plugin IDs and routes are rejected.
- API and asset routes are mounted only after initialization finishes successfully.
- A failed plugin does not reserve its route, and its shutdown hook is attempted.
- Other configured plugins continue loading; errors appear in `/api/plugins`.
- Successful plugin shutdown hooks run before the BFF closes its HTTP server.

The runtime does not install dependencies, build plugin assets, watch plugin files, expose arbitrary HTML, or grant plugins direct access to OpenClaw credentials. Plugins are trusted local server code and must be reviewed before adding their path.
