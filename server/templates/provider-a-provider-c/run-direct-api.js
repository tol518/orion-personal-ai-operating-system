// Public placeholder entrypoint for the bundled comparison extractor.
//
// The private deployment ships a proven package here. It is withheld from the public
// repository because it encodes provider endpoints, destination codes, and request
// protocols for authorized systems — see README.md in this directory.
//
// The contract this file stands in for is the one the bundled manifest declares:
//
//   node source/run-direct-api.js --sites=<SITE_A>,<SITE_B> \
//     --start=<travelStart> --end=<travelEnd> --no-telegram
//
// A real package parses those arguments, extracts each site for every departure date
// in the range, writes per-site result CSVs plus a combined comparison CSV into its own
// run folder, and reports progress through lib/extraction-runtime.js so Pause, Stop,
// and Resume keep working. It exits non-zero on failure so the scheduler can record it.
//
// Failing loudly is deliberate: a silent no-op would look like a successful run with no
// rows, which is the one outcome the scheduler cannot distinguish from a blocked site.

console.error(
  [
    "This is the public placeholder for the bundled comparison extractor.",
    "",
    "Replace server/templates/provider-a-provider-c/ with a package that honours the",
    "documented run contract, or build an extractor from the Extraction page instead —",
    "Codex writes those into the workspace and never touches this directory.",
  ].join("\n"),
);
process.exit(1);
