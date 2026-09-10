# Source and Data Classification

**Purpose:** tell a human or coding agent which material may enter Git, which must stay on the
Mac mini, and which must never leave the runtime that owns it.

This note is a control for the rule in the implementation plan: *the MacBook must not receive
gateway or provider credentials*, and *runtime state is never committed*.

## Class A — source, safe to commit

Application source and its tests, configuration **examples** with placeholder values,
documentation, and build scripts.

- `client/` React/Vite control surface
- `server/*.js` BFF modules and `server/**/*.test.js`
- `openclaw-plugin/` plugin policy code
- `apps/macos/` native client source
- `docs/`, `scripts/`, `ops/`
- `server/.env.example` — placeholders only

## Class B — runtime state, never committed

Generated at run time by the BFF or the gateway. Recoverable only from a private encrypted
backup, never from Git.

- `server/data/` — SQLite databases, execution targets, cover letters, job-hunt state
- attachment, artifact, and session directories
- extraction outputs and downloads
- logs, PID files, sockets

## Class C — secrets, never committed and never shipped to the MacBook

- `GATEWAY_TOKEN` — OpenClaw operator token
- `JARVIS_ACCESS_PASSWORD`, `MEMORY_ACCESS_PASSWORD`, `HUNTING_ACCESS_PASSWORD`
- `ORION_DESKTOP_PAIRING_SECRET` — desktop pairing secret (Mini-side only)
- provider keys, broker credentials, `SCREENPIPE_API_KEY`
- any `.pem`, `.key`, `.p12`, `.pfx`

The desktop client receives **one** credential: a revocable desktop client token, issued by the
Mini at pairing time and stored in the macOS Keychain. It is not any of the values above, and
revoking it does not require rotating the gateway token.

## Class D — private personal content

Memory/Second Brain note bodies, CVs, cover letters, application history, browser profiles,
screenshots, and prompt content. These stay in their existing trusted location. They are reachable
only through a deliberately implemented BFF endpoint, and they are excluded from audit events.

## Enforcement

1. `.gitignore` blocks Class B and Class C by path and extension.
2. `scripts/verify-public-release.mjs` fails on `.env` files, runtime directories, private keys,
   personal macOS paths, provider tokens, and denylist terms. Run it before any promotion to the
   public repository:

   ```sh
   node scripts/verify-public-release.mjs
   ```

3. Audit events emitted by the desktop boundary record actor, action, and outcome only — never
   credentials, prompt text, or memory content.

## Authoritative runtime

The **Mac mini** is the single authoritative OpenClaw runtime. The MacBook runs `Orion.app` as a
client of it. No agent, session, or memory store is copied to the MacBook. Changing that is the
separate, explicitly gated migration described in Phase 5 of the implementation plan.
