# Bundled comparison extractor template (public placeholder)

The private deployment ships a proven multi-site comparison package here, and
`CustomExtractorStore.ensureBundledProviderAProviderC()` copies this directory into
`Custom_Extractors/provider-a-provider-c/source/` on first start.

The real package is intentionally **not** part of the public repository: it contains
provider endpoints, destination codes, and request protocols for authorized systems.
Publishing them would expose the private mapping between the neutral `ProviderA` –
`ProviderE` identifiers and their operational targets.

What is public is everything that decides *how* a reusable extractor is built, stored,
validated, and run:

- `custom-extractors.js` — the SQLite-backed extractor library, upload safety limits,
  manifest normalization, and the builder/runner ownership boundary.
- `custom-extractor-builder.js` — how Codex is asked to build a package, and why the
  uploaded source is treated as untrusted reference data.
- `extraction-scheduler.js` — how a task with `customExtractorId` is dispatched to
  Black Noir, and how its run folder and CSV output are verified.

## Replacing this placeholder

Drop a real package in this directory. The store expects:

```text
server/templates/provider-a-provider-c/
├── run-direct-api.js     # entrypoint named by the bundled manifest
└── ...                   # any supporting modules the entrypoint imports
```

The bundled manifest declares `entrypoint: "source/run-direct-api.js"` and a run
contract of the form:

```text
node source/run-direct-api.js --sites=<SITE_A>,<SITE_B> \
  --start=<task travelStart> --end=<task travelEnd> --no-telegram
```

Any package that honours that contract and writes standard result CSVs into its own
run folder works without changing the server. Extractors you build through the UI do
not use this directory at all: Codex writes those into the workspace.
