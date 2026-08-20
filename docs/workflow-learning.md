# Workflow learning

Record a task once, let ORION write down how it is done, then have it do the task again.

```
screen recording        →  Screenpipe local memory   (raw observation, stays on this Mac)
Screenpipe memory       →  AI extracts a workflow    (redacted text only, no frames)
extracted workflow      →  ORION memory + store      (the reusable recipe, you approve it first)
ORION agent             →  replays it later          (stopping at every checkpoint you kept)
```

Screenpipe is treated as the **observation layer only**. Everything reusable — the recipe, its
variables, its safety rules, and its execution history — lives in ORION.

## 0. Licensing — free for this use

Screenpipe is **source-available**, not fully open source: *"personal, non-commercial use permitted,
commercial use requires a license"*. Running it for your own tasks on your own machine is free, and
nothing in this integration calls a Screenpipe cloud endpoint or needs an account — only
`http://127.0.0.1:3030`.

The $25/month Standard plan covers the pre-built signed desktop app and commercial use. **This
install is personal and non-commercial, so no subscription is needed.** The line to watch: using it
for TravelVogue work rather than your own would cross into commercial use and need a licence.

If that ever changes, the capture layer is swappable — Screenpipe is confined to
[`screenpipe-client.js`](../server/workflows/screenpipe-client.js) and `normalizeItem()` in
`observation-window.js`. Everything else in this feature is capture-agnostic.

## 1. Run Screenpipe locally

Screenpipe is a separate local app. It records continuously into its own SQLite database on this
machine; ORION never starts, stops, or configures it, and never copies its media.

```bash
npx screenpipe record
```

Or install the desktop app from <https://screenpi.pe/onboarding>, which auto-updates. Either way the
local REST API comes up on port **3030**. Check it:

```bash
curl http://localhost:3030/health
```

Check what it is allowed to do — this matters more than it looks:

```bash
npx screenpipe doctor
```

Three macOS permissions, granted to **whichever app runs the recorder** (the terminal emulator when
run via `npx`, or Screenpipe itself for the desktop app):

| Permission | Needed for | Without it |
| --- | --- | --- |
| Screen & System Audio Recording | frames and OCR | nothing is captured at all |
| **Accessibility** | input events, app/window attribution | `content_type=input` returns 0 rows and the recording can collapse into one segment — the biggest hit to draft quality |
| Microphone | spoken narration | narration is unavailable (it is opt-in anyway) |

Grant them in System Settings → Privacy & Security, then restart the recorder.

Then set two values in `server/.env` and restart the BFF:

```
SCREENPIPE_URL=http://127.0.0.1:3030
SCREENPIPE_API_KEY=<output of: npx screenpipe auth token>
```

The key is required — `/search` answers 401 without it. The Workflows header distinguishes the two
failures: red for "not answering", amber for "running but not readable" (usually a missing or stale
key), green only when ORION has actually read a row.

Restart the BFF and the Workflows page header will show `Screenpipe up`.

### What ORION reads, and what it never reads

ORION calls exactly one Screenpipe endpoint, `GET /search`, once per content type per recorded
window (`ui`, `ocr`, `input`, and `audio` only if you ticked narration for that recording):

- **`include_frames` is never sent, and `/frames` is never called.** Screenshot and video bytes stay
  inside Screenpipe's database. Only text ever reaches ORION.
- **Audio is opt-in per recording.** The "read my spoken narration" checkbox is off by default.
- **Credential-shaped text is masked before it is stored**, in
  [`observation-window.js`](../server/workflows/observation-window.js): password/token/OTP/card-shaped
  strings become `[redacted]`, keeping the label so a step can still say "enter your password"
  without carrying the value.
- **Password managers and authenticators are never observed at all** — 1Password, Bitwarden,
  LastPass, Dashlane, Keeper, Keychain Access, and authenticator apps are dropped by window name.
  Add your own with `JARVIS_WORKFLOW_EXCLUDE_APPS=Messages,Signal`.
- **Nothing extra is persisted.** The raw capture is discarded after the redacted digest is built;
  ORION does not keep a second copy of your recording.

The model that extracts the workflow is the one this app already uses for Hunting (a Codex-routed
`openai/gpt-5.6-terra` turn over your existing OAuth account). It receives the redacted text
timeline — never images, never audio, never a transcript you did not opt into.

## 2. Learn a workflow

Open **Workflows** in the sidebar.

1. Type what you are about to do ("Submit monthly invoice") and press **Record workflow**. If
   Screenpipe is not answering, the button is disabled — you cannot narrate a task into a recorder
   that is not running.
2. Do the task once, at a normal pace. Backtracking is fine; the extractor is told to drop mistakes,
   pauses, notifications, and unrelated tabs.
3. Press **Stop**. ORION reads the window back from Screenpipe and shows what it captured: how many
   screen segments, which apps, how much was redacted or excluded.
4. Press **Extract workflow**. One model turn converts the timeline into a `LearnedWorkflow`.
5. **Review the draft.** This is not a formality — read every step, fix the anchors and values, and
   check which steps are gated. Nothing is stored until you press **Save to ORION memory**.

On save, two things happen:

- the executable spec goes into `server/data/jarvis.sqlite` (`learned_workflows`), and
- a readable page — `Workflow · Submit monthly invoice` — is written into your Obsidian memory
  vault, tagged `workflow`, so the ordinary chat memory path can retrieve it.

That second half is what makes *"run the invoice workflow for Client X"* work in chat: the recipe is
an ordinary memory page, not a hidden table.

## 3. Replay it

Pick the workflow, fill in this run's values, press **Run workflow**.

Each step is executed on one of two paths:

| Step | Path | What "it worked" means |
| --- | --- | --- |
| has a URL, or names a browser app, or follows a step that opened a tab | deterministic, through the same `BrowserControl` client Hunting uses | a `ref` was resolved from a live accessibility snapshot and `/act` returned ok; if the step declares a `successCheck`, the live page was re-read and shown to contain it |
| names a desktop app | one bounded agent turn on the run's own session, with the tools the gateway exposes | the turn returned `{"status":"done"}` with a detail; anything else is a failure |

Anchors are resolved by **visible text**, never by recorded coordinates: a click at (840, 312) means
nothing at a different window size. Where the recording only had coordinates, the draft carries a
`visualDescription` and a `fallback` instead — and the fallback is genuinely tried when the direct
attempt cannot find its anchor.

### The confirmation gates

Two of them, and neither is the model's decision:

- **Before the first step**, if `requiresConfirmationBeforeRun` is set. The run is stored as
  `awaiting_confirmation` and not one browser call is made until you answer.
- **Before any step that sends, submits, publishes, pays, orders, deletes, archives, or shares.**
  `markStepConfirmations()` in [`learned-workflow.js`](../server/workflows/learned-workflow.js)
  forces the flag on for those steps even when the draft claimed they were safe. A model can add
  caution; it cannot remove it.

Answering "no" **cancels** the run rather than skipping the step — a declined destructive step means
the task should stop, not continue without it. Approving the pre-run gate is not approving a gated
first step; you will be asked twice, deliberately.

On top of that, the actions in `safety.blockedActions` always include the list nobody may delegate,
shared with the job-application runner
([`consent-policy.js`](../server/hunting/consent-policy.js)): passwords, one-time codes,
CAPTCHAs, identity verification, account creation, payment details.

## 4. Verify it without recording anything

The whole feature is covered by unit tests against a mocked Screenpipe response and a mocked
gateway, so none of this needs a real recording, a real vault, or a model call:

```bash
cd server && node --test "workflows/*.test.js"
```

The fixtures are worth reading:

- [`fixtures/screenpipe-invoice-session.json`](../server/workflows/fixtures/screenpipe-invoice-session.json)
  — a recorded "submit monthly invoice" session in the exact shape `GET /search` returns, including
  the awkward cases on purpose: OCR repeating a line every frame, a revealed password, a
  1Password window, a click with coordinates but no element name, and an unrelated Slack
  notification. Every one of those is asserted to be handled rather than passed through.
- [`fixtures/demo-invoice-workflow.json`](../server/workflows/fixtures/demo-invoice-workflow.json)
  — the learned workflow a user would get from that recording: three variables, seven steps, text
  anchors, success checks, fallbacks, and a gated send step.

To try the demo workflow in the running app without recording:

```bash
curl -s -X POST http://127.0.0.1:4820/api/workflows \
  -H 'Content-Type: application/json' \
  -d "{\"spec\": $(cat server/workflows/fixtures/demo-invoice-workflow.json)}" | head -c 400
```

It will appear under **Saved workflows** with its memory page written, ready to run against a real
Ledgerly-shaped site (the demo URLs are `.example`, so a real run stops at the first navigation —
which is itself a useful check that failures are reported honestly).

## Where the code lives

| File | Responsibility |
| --- | --- |
| [`server/workflows/screenpipe-client.js`](../server/workflows/screenpipe-client.js) | the only place raw observation enters the app; `/health`, `/search`, the no-frames rule |
| [`server/workflows/observation-window.js`](../server/workflows/observation-window.js) | redaction, exclusion, dedupe, and the deterministic prompt timeline |
| [`server/workflows/learned-workflow.js`](../server/workflows/learned-workflow.js) | the schema, forced confirmations, derived risk, variable filling, the memory note |
| [`server/workflows/workflow-store.js`](../server/workflows/workflow-store.js) | learning sessions, executable specs, run history in `jarvis.sqlite` |
| [`server/workflows/workflow-learner.js`](../server/workflows/workflow-learner.js) | the one model turn, on its own session key |
| [`server/workflows/workflow-runner.js`](../server/workflows/workflow-runner.js) | replay, the two execution paths, the checkpoint state machine |
| [`client/src/components/WorkflowsPage.tsx`](../client/src/components/WorkflowsPage.tsx) | record → review → replay |

## Known limits

- **A learning session is a bookmark, not a recorder.** Screenpipe records continuously; ORION marks
  a start and end and reads that window back. If Screenpipe was not running, the window is empty —
  which is why starting a session health-checks it first.
- **The `/health` response body is undocumented**, so nothing reads its fields. A 200 means the
  recorder answers, and that is the only claim made about it.
- **One run at a time.** Two workflows would fight over the same browser tab, so a second start is
  refused with a 409 naming the active run.
- **Deleting a workflow leaves its Obsidian page in place.** Removing a workflow from this app is not
  consent to delete a page from your second brain; delete it in the vault if you want it gone.
- **Live-verified against screenpipe 0.4.32** on 2026-07-29. Two things the published API reference
  gets wrong, both of which broke the integration until a live call caught them:
  - **`/search` requires a bearer token** that the reference does not mention; without it every read
    is a 401. Get it with `npx screenpipe auth token` and set `SCREENPIPE_API_KEY` in `server/.env`.
    `/health` needs no token, which is why `health()` probes both — a recorder can be perfectly
    healthy and refuse every read.
  - **`content_type=ui` does not exist.** It is a 400 `unknown variant`, and the accepted value is
    `accessibility` — while the rows it returns are tagged `type: "UI"`. Asking for the wrong word
    silently cost the entire accessibility layer.
- **Input events need the macOS Accessibility permission.** Without it `screenpipe doctor` reports
  `accessibility: missing (input capture will be disabled)`, `content_type=input` returns 0 rows, and
  app/window attribution degrades so the whole recording can collapse into one segment. Grant it to
  whichever app runs the recorder, then restart it. This is the single biggest lever on draft
  quality: input events are where element names — and therefore stable text anchors — come from.
- **Real OCR is one blob of the whole screen per frame**, not discrete lines, and consecutive blobs
  differ by a mis-read glyph. Exact-match dedupe was not enough, so `isNearDuplicate()` collapses
  reads by word overlap at 0.7 — measured, not guessed: over 164 live rows, unrelated screens peak at
  0.39 overlap while re-reads of one screen sit at 0.7–1.0.
