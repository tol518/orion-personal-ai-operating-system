# J.A.R.V.I.S. Hunting Logic

Updated: 2026-07-27  
Audience: engineers and agents extending the private **Hunting** feature.

## What Hunting does

Hunting is J.A.R.V.I.S.'s private job-search workspace. It keeps a canonical CV, a job-search brief, a ranked queue, and a checkpointed application workflow.

The design principle is **prepare and verify, then hand off irreversible or security-sensitive steps to the user**. It is not an anti-bot or CAPTCHA-bypass system.

## Main user flow

```text
Unlock Hunting
  -> save canonical CV + search brief
  -> discover fresh, diverse listings
  -> shortlist or dismiss listings
  -> Apply with J.A.R.V.I.S.
  -> tailor CV and cover letter
  -> open form and verify the browser tab
  -> attach and verify the CV
  -> fill only source-backed answers
  -> re-read the live form
  -> ready for review / human checkpoint / submitted (only where explicitly enabled)
```

## System boundaries

| Area | Current behavior | Owner |
| --- | --- | --- |
| Access | Hunting is hidden behind the app's password gate and locks again after refresh. | `server/hunting/hunting-access.js` |
| CV | Original PDF remains the source asset; editable HTML/CSS preserves the imported visual design. | `cv-store.js`, `cv-editor-service.js`, `cv-pdf*.js` |
| Discovery | GPT-5.6 Terra searches public listings, ranks them against the brief/CV, and returns structured JSON. | `job-discovery-service.js` |
| Queue | SQLite stores jobs, search runs, applications, attempts, statuses, and freshness metadata. | `job-hunt-store.js` |
| Application | One application may run at a time. Its phases are checkpointed and resumable. | `job-application-runner.js`, `server/index.js` |
| Browser | The agent opens and reads the application; BFF code attaches files and verifies page state. | `browser-control.js`, `application-upload-service.js`, `form-state.js` |
| Memory | Verified identity/application memories ground field answers. Proven recovery guidance and per-site playbooks may be saved as Shared Lessons. | `managed-memory`, `site-playbook.js`, `site-strategy.js` |
| Human takeover | The user can mirror/control the application browser for challenges or other human-only steps. | `browser-takeover.js`, `BrowserTakeover.tsx` |

## Discovery logic

`POST /api/hunting/discover` starts a run only after a search profile exists.

The discovery prompt must:

- search LinkedIn Jobs, Indeed, and first-party career pages separately;
- report an explicit source status for each of those sources;
- prefer listings posted or materially updated within seven days;
- use up to fourteen-day-old listings only when needed;
- return direct public listing URLs only;
- prefer source diversity, with a maximum of two new listings from one source family;
- avoid re-discovering canonical URLs already in the queue;
- never sign in, apply, interact with a challenge, or retry a CAPTCHA/anti-bot block.

Every run is persisted. Jobs retain `firstSeenAt`, `lastSeenAt`, `lastRunId`, canonical URL, source family, match score, listed date, and queue state. The UI can show a run, current, or all-history view, and labels listings as new/current/stale/historical.

Key files:

- `server/hunting/job-discovery-service.js`
- `server/hunting/job-hunt-store.js`
- `client/src/components/HuntingPage.tsx`

## Application state machine

```text
queued
  -> preparing_cv
  -> opening_form
  -> uploading_cv
  -> filling_verified_fields
  -> ready_for_review
  -> submitted

Any phase -> needs_human_action | failed
```

The server records a structured attempt row for every significant phase. A resume request starts from the stored checkpoint, reuses the existing application session where possible, and can include bounded user guidance plus up to five screenshots, videos, or files.

Only one application may hold the runner slot. If the user starts another application, the UI offers to cancel the first. Cancellation aborts owned model turns and now waits for the old runner slot to release before retrying the new job. This prevents the confirmation dialog from repeating in a loop.

Key API routes:

| Route | Purpose |
| --- | --- |
| `GET /api/hunting/jobs?scope=run|current|all` | Queue and current discovery run |
| `POST /api/hunting/discover` | Run discovery |
| `PUT /api/hunting/jobs/:id/status` | Shortlist or dismiss a job |
| `POST /api/hunting/jobs/:id/apply` | Start or resume an application |
| `POST /api/hunting/jobs/:id/cancel` | Abort the active application safely |
| `GET /api/hunting/applications` | Application checkpoints |
| `GET /api/hunting/applications/:jobId/attempts` | Audit trail |
| `POST /api/hunting/applications/:jobId/submitted` | Record a user-confirmed submission |

## What an application run does

1. Loads the canonical CV and the required verified memories before inspecting fields:
   - `memory-example-user`
   - `memory-example-job-application-profile`
   - approved `general` memories directly linked to either canonical applicant memory
2. Creates or reuses a role-specific tailored CV artifact.
3. Writes a role-specific cover letter when possible. A cover letter failure is non-blocking.
4. The server opens or recovers a labeled application tab through the same controlled-browser route used by uploads.
5. The application agent receives that server-owned target; a gateway policy forces its browser calls to the browser node and model-reported IDs never replace the owned target.
   LinkedIn, Indeed, and other source boards may redirect to an employer ATS; the server adopts that page and scopes site policy to the live form host.
6. Detects sign-in walls, CAPTCHA, verification, and other human checkpoints before filling.
7. Attaches the CV using the browser's file-input primitive, then verifies on the page that the file is present.
8. Fills only answers directly supported by the CV, job listing, or verified application/identity memories.
9. Re-reads the form after the model turn. Required empty fields block completion; optional unknown fields are skipped.
10. Re-attaches the CV if a form re-render cleared it; handles file-only cover-letter fields deterministically and replaces a CV or stale letter found in the cover-letter slot.
11. Saves a `ready_for_review`, `needs_human_action`, or `failed` checkpoint.

The server, rather than the model, owns uploads, completion assessment, attachment repair, attempt recording, and any enabled auto-submit action.

## Answer policy

The application model may answer only fields explicitly supported by verified sources. Every filled-field record identifies its source.

The application profile, `the user (me)`, and their approved linked personal memories are first-pass sources. A linked memory may supply a field only when its text explicitly states the fact about the user; details about another person or organisation are not applicant facts.

The current application memory is intended to supply facts such as UK right-to-work and sponsorship status. Approved right-to-work/sponsorship, salary, notice-period, and referral-source answers are used on the first pass. If the first pass recognises one of those answers but a live control does not retain it, the runner makes one bounded automatic retry before involving the user. The live form remains authoritative: searchable dropdown answers must be committed to a real option and verified after selection.

Do not invent dates, experience, qualifications, salary expectations, contact details, declarations, or demographic answers. Optional questions that cannot be grounded should remain blank.

Key files:

- `server/hunting/field-policy.js`
- `server/hunting/form-state.js`
- `server/hunting/attachment-repair.js`
- `server/hunting/job-application-runner.js`

## Human checkpoints and browser takeover

The agent must stop for:

- CAPTCHA, anti-bot, Cloudflare, or similar challenges;
- email verification, MFA, and one-time codes;
- legal declarations that the user has not explicitly delegated for the live form host, and final submission unless that host is explicitly configured for auto-submit;
- a form the browser cannot inspect or upload to;
- sign-in or account creation under the current implementation.

The checkpoint card exposes Browser Takeover so the user can control the exact application tab from J.A.R.V.I.S. The user can clear a challenge or sign in there, then click Resume. The agent must never interact with the challenge itself.

Delegable privacy, terms, retention, and application acknowledgement controls expose a one-click acceptance. That grant is stored against the current employer-form host, including after a source-board redirect, and is loaded before the first resumed model turn. CAPTCHA, verification, credentials, account creation, and payment remain non-delegable.

The takeover is authenticated behind the Hunting gate and is implemented by:

- `server/hunting/browser-takeover.js`
- `client/src/components/BrowserTakeover.tsx`

## Account creation: current status and safe next step

**Current status:** J.A.R.V.I.S. intentionally does not create accounts or enter passwords. The job runner's safety rules prohibit it, and the checkpoint tells the user to sign in manually.

Do not place passwords, OTPs, recovery codes, session cookies, or other credentials in Second Brain, application guidance, site playbooks, logs, or model prompts.

If account creation becomes a product requirement, implement a separate **Account Vault** first:

1. Store one site-scoped credential locally in macOS Keychain, not SQLite/Obsidian/Markdown.
2. Require explicit user approval for each site's first use.
3. Expose a narrow BFF-to-browser secret-fill capability that never passes the secret through model context or UI logs.
4. Allow normal signup fields and account creation only after the vault operation is available.
5. Still stop for email verification, MFA, CAPTCHA, legal declarations, and final submission.

Do not weaken the current prompt rule merely to make an agent type a plaintext password from chat.

## Auto-submit and anti-spam policy

Auto-submit is disabled by default. It is enabled only for hosts named in `JARVIS_AUTO_SUBMIT_HOSTS`; `JARVIS_PREPARE_ONLY_HOSTS` excludes a host from automatic form entry when it has rejected automated activity.

Before any auto-submit, the server checks:

- the host is explicitly allowed and not prepare-only;
- the application is `ready_for_review`;
- the CV is verified as uploaded or the form does not require one;
- required fields are complete.

There is no automatic retry after a submission failure. If a site flags a submission as spam, record the rejection, downgrade the site to prepare-only, and direct the user to complete it in their own browser. Do not add fingerprint spoofing, human-like timing, proxy rotation, CAPTCHA solving, or other detection-evasion behavior.

Key files:

- `server/hunting/submit-service.js`
- `server/hunting/site-adapters.js`
- `server/hunting/site-strategy.js`

## Learning from completed work

Two learning paths exist:

1. **Resume guidance lesson:** a user instruction becomes a Shared Lesson only after the live form verifies that the retry succeeded. Sensitive guidance is discarded.
2. **Site playbook:** structured attempt data creates one safe Shared Lesson per host. It records mechanics such as a sign-in wall, a successful CV upload method, or an employer's spam rejection. It must not store field values or credentials.

Site playbooks can reduce automation for a host, such as setting it to prepare-only. They can never grant new permissions such as auto-submit.

## Important operational details

- The app's state lives in `server/data/jarvis.sqlite`; do not add JSON sidecars for Hunting state.
- The controlled browser must be the same browser seen by both the agent and BFF. A split between a container browser and Mac Chrome results in `application_tab_missing`.
- `openclaw-plugin/` rejects browser calls from Hunting application sessions unless they explicitly use `target: "node"`. Codex native hooks fail closed on argument rewrites, so invalid targets are denied rather than rewritten. Ordinary chat browser calls are unaffected.
- Upload paths are browser-host-specific. Use the configured inbound media root and verify attachment postconditions.
- Model turns are aborted on timeout and before a new turn starts, avoiding runs that queue behind abandoned work.
- `JARVIS_DISCOVERY_TIMEOUT_MS`, `JARVIS_APPLICATION_OPEN_TIMEOUT_MS`, and `JARVIS_APPLICATION_FILL_TIMEOUT_MS` tune time limits.

## Validation checklist for changes

- Update or add focused tests beside every changed Hunting module.
- Run the relevant `node --test server/hunting/<module>.test.js` tests.
- Run `npm run build` after client changes.
- Manually verify a locked Hunting page, a discovery run, and a non-submitting application checkpoint when the local environment is available.
- For browser work, test against the actual routed browser host and confirm agent/BFF tab parity.
- Never use a CAPTCHA or anti-bot challenge as a test fixture that is automated through.

## Further reading

`HUNTING_HANDOFF.md` is the detailed operational handoff containing incident history, browser routing evidence, and site-specific lessons. Keep this file as the concise source of current architecture and update it whenever the workflow, boundaries, routes, or state machine change.
