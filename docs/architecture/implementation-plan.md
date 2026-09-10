# ORION Architecture Implementation Plan (Revised)

**Status:** architecture direction, not an implementation claim
**Audience:** the developer or coding agent building the native macOS application
**Basis:** the public ORION repository at commit `a0dee74795a507a6328b99c8c5aecacf85b7026f` and the current Orion deployment model.

## Decision Summary

Build the MacBook application as a native **client of the existing Mac mini deployment**. Do not move, clone, or recreate the existing agents for the first release.

The Mac mini remains the single runtime owner of OpenClaw, configured agents, sessions, tools, provider credentials, OpenClaw-managed state, Orion's BFF state, memory integration, and existing paired nodes. The MacBook runs Orion.app, connects privately to the Mini, and presents that same runtime through a native UI.

This preserves the agents already created in Orion without requiring a risky transfer. A later move from the Mini to the MacBook is a separate migration project, not a by-product of building Orion.app.

## What Is True Today

The published Orion repository is a React/Vite client plus an Express backend-for-frontend (BFF). The BFF connects to OpenClaw over an authenticated WebSocket and converts its state/events into browser-facing REST and SSE surfaces.

| Boundary | Current owner | Consequence for Orion.app |
| --- | --- | --- |
| UI and browser state | React client | Reuse its product behavior and contracts where useful; do not assume it is a native macOS app. |
| Credentials, Orion persistence, orchestration, safety checks, local service integrations | Express BFF | Keep these on the Mac mini. The MacBook must not receive gateway or provider credentials. |
| Agent definitions, sessions, models, tools, node execution, browser control, LLM runs | OpenClaw gateway | Existing agents remain on the Mini and are reached through the BFF. |
| Human-readable Second Brain | Configured Obsidian/MCP integration | Keep its existing trusted location; expose selected read/write actions through the BFF only when deliberately implemented. |
| Nodes | OpenClaw | A MacBook can later be paired as an additional node. That is not an agent transfer. |

The public repository is intentionally sanitized. It is sufficient as a code foundation and reference for the web/BFF architecture, but it does **not** reproduce the existing private deployment or its agents when cloned on another machine. Runtime state, local configuration, private integrations, credentials, databases, sessions, and memories are intentionally absent.

## Product Scope

### V1 goal

From the MacBook, the user can securely open a native Orion app, see the existing Orion/OpenClaw status, choose an existing agent, continue or start a session, receive streamed replies, and inspect the status of existing nodes.

### Explicitly out of scope for the MacBook app V1

- Extraction and extraction scheduling.
- Hunting/job-application workflows.
- Finance Lab and broker/trading controls.
- Workflow-learning capture and replay.
- Arbitrary terminal execution, browser takeover, file-system browsing, and remote desktop streaming.
- Moving existing agents, sessions, or memory stores from the Mini.
- A new device router, job manager, or policy service that duplicates existing OpenClaw/BFF responsibilities.

The Mini may continue to run private capabilities that are excluded from the MacBook UI. Excluding a feature from Orion.app does not remove it from the Mini.

## Target Architecture

```text
                         MacBook
                  Orion.app (SwiftUI)
           UI, menu bar, notifications, Keychain
                               |
                    HTTPS / WSS over Tailscale
                               |
                               v
                        Mac mini
               Orion BFF / desktop API boundary
                  authenticated gateway client
                               |
                 authenticated OpenClaw gateway
                               |
       existing agents, sessions, tools, memory, nodes
                               |
                     existing Windows node
```

### Ownership rules

1. There is one authoritative OpenClaw runtime in V1: the Mac mini.
2. Orion.app is a client, never a second gateway owner.
3. The MacBook talks to the BFF, not directly to the OpenClaw gateway.
4. OpenClaw provider tokens, gateway tokens, broker credentials, database files, and private memory content never ship inside Orion.app or its repository.
5. A future MacBook node is an optional new execution device. It does not duplicate or migrate the Mini's agents.

## Existing Agents: Access First, Migration Later

### V1: no agent transfer

The user's existing agents remain where they are: in the OpenClaw configuration and runtime on the Mac mini. Orion.app obtains the agent and session list through the Mini BFF and starts or continues those same sessions through the gateway.

This is the correct path because agent behavior is not only a source-code artifact. It depends on gateway configuration, agent workspaces and instruction files, enabled models/tools, sessions, agent-scoped data, BFF profiles, and related private integrations. Cloning a Git repository does not copy that operating state.

### What transfers automatically in V1

Nothing is copied. The MacBook sees the same live agents remotely, provided it can authenticate to the Mini BFF. New agents created through the established BFF/OpenClaw path appear to both the web UI and Orion.app because both read the same Mini runtime.

### Future: explicit migration only if retiring the Mini

Do not start this phase until the product decision is “the MacBook replaces the Mini as the runtime owner.” Create a tested, private migration runbook then. It must include:

1. Make encrypted, private backups of the Mini's OpenClaw configuration, agent-owned persistent data, BFF database/state, and memory integration metadata. Do not put those backups in Git.
2. Record the current OpenClaw and BFF versions, enabled plugins, model/tool configuration, and node pairings.
3. Stop new agent work during a defined maintenance window. Never operate two active runtimes against one copied state directory.
4. Restore into an isolated MacBook runtime first. Validate agent discovery, session creation, tool availability, BFF state, memory access, and node connectivity before any cutover.
5. Re-pair devices and re-authorize integrations where required. Device identity and local permissions are machine-specific.
6. Cut over one authoritative runtime only after validation. Preserve the Mini backup for rollback.

Until that process is complete, the Mini stays authoritative. There is no safe “automatic transfer agents” button.

## Repository Strategy

### Private source repository

Create a new private repository by cloning/forking the public Orion source into a private location before native development begins. Use it as the coding-agent source of truth.

Import only reviewed source changes from the private deployment. Before every import, inspect for secrets, personal data, private hostnames, browser profiles, generated artifacts, databases, screenshots, CVs, memories, and local paths. Keep those out of Git even in the private repository unless there is a deliberate encrypted-backup system outside normal source control.

Suggested incremental layout:

```text
orion-private/
├── client/                    # Existing React/Vite control surface
├── server/                    # Existing Express BFF; Mini runtime owner
├── openclaw-plugin/           # Existing plugin policy code
├── apps/
│   └── macos/                 # New SwiftUI Orion.app, added after API contract exists
├── docs/
│   └── architecture/          # This plan and contract notes
├── server/.env.example        # Placeholders only
├── .gitignore
└── README.md
```

Do not split the existing BFF into `core`, `device-router`, `jobs`, and `policy` services pre-emptively. First extend the current BFF with a narrow desktop-facing contract. Extract a service only after real, measured ownership or deployment pressure makes the boundary necessary.

### Public repository

The public repository remains a sanitized portfolio/release artifact. It is not a runtime-state synchronization mechanism and not a source for recovering the Mini's private configuration. Promote selected source-only changes from private to public through an explicit redaction review.

### Never commit

```gitignore
.env
.env.*
!.env.example

server/data/
state/
sessions/
artifacts/
attachments/
backups/

*.sqlite
*.sqlite-*
*.db
*.pem
*.key
*.p12
```

The exact ignore list must be checked against the actual private repository before use. It is a baseline, not proof that every private runtime path is covered.

## Network and Authentication

Use Tailscale as the private network transport between the MacBook and Mini. Prefer MagicDNS names over embedded IP addresses. Do not expose the Orion BFF or OpenClaw gateway to the public internet, and do not expose raw RDP/VNC publicly.

Tailscale alone is not the application authorization layer. Before Orion.app can connect remotely, implement and validate all of the following in the BFF:

1. An authenticated desktop-client boundary.
2. A restricted client identity or token that can be revoked without rotating the gateway token.
3. Server-side authorization for every desktop action.
4. An allowlist for trusted client/device identities where appropriate.
5. Audit events without credentials, private prompt content, or secret values.

Store the desktop connection configuration and any revocable client credential in the macOS Keychain. Orion.app must never embed an OpenClaw gateway token, model key, broker credential, or production `.env` value.

## Desktop API Boundary

The existing browser client uses the current BFF API. Preserve it. For native development, add a small **additive** API surface rather than renaming existing browser endpoints or coupling SwiftUI to gateway protocol details.

Proposed namespace: `/api/v1/desktop`. This is a proposed contract, not a claim that these endpoints already exist.

| Contract | Purpose | Notes |
| --- | --- | --- |
| `GET /api/v1/desktop/health` | Authenticated reachability and component status | Redacts internal configuration. |
| `GET /api/v1/desktop/agents` | Existing agent list and supported models | Sourced from the connected gateway/BFF projection. |
| `GET /api/v1/desktop/sessions` | Sessions available to the authenticated user | Never exposes another user's data if multi-user support appears later. |
| `POST /api/v1/desktop/sessions` | Create or select a session for an existing agent | Delegates to the current gateway integration. |
| `POST /api/v1/desktop/chat` | Submit a chat turn | BFF preserves current context, memory, attachment, and safety behavior. |
| `GET /api/v1/desktop/events` | Stream selected status/session/chat events | Reuse SSE semantics where possible; do not implement a second event model without need. |
| `GET /api/v1/desktop/nodes` | Project paired-node status and capabilities | Read-only in V1. |

The server implementation must map each endpoint to existing BFF/gateway functions after inspecting the private code. Do not invent a parallel agent, memory, session, or node store for the desktop app.

## Native macOS Application

### Recommended V1 stack

```text
Swift + SwiftUI
URLSession for HTTPS and SSE/WebSocket transport as required
Keychain for connection secrets
UserNotifications for local notifications
AppKit only for menu-bar, window, or global-shortcut interop
```

The public Orion repository currently contains no native macOS application target. `apps/macos/` is a new private-project addition, not a component that already exists.

### V1 screens

1. **Connection:** Mini reachability, signed-in state, retry/error state.
2. **Home:** gateway/BFF status, active sessions, and node summary.
3. **Agents:** existing agent list and model availability as supplied by the BFF.
4. **Chat:** select agent/session, send a turn, stream reply/events, display recoverable failures.
5. **Nodes:** read-only status and capabilities for the Mini, Windows node, and later MacBook node.
6. **Settings:** trusted Mini address, connection/session controls, notifications, and permissions.

### Native integrations after the core flow works

- Menu-bar entry point.
- Local notifications for agent completion or connection failure.
- A global shortcut that opens a compact command/chat panel.
- App Intents limited to safe actions such as opening Orion, checking connection status, and starting a chat.
- Push-to-talk only after chat and authentication are stable.

Do not send selected text, clipboard contents, screen data, or active-window metadata by default. Each context source requires a visible user setting and platform permission.

## Node and Device Model

OpenClaw already owns node execution. Orion.app should consume the BFF's projection of paired OpenClaw nodes rather than introducing a second generic “Orion Node” protocol in V1.

The initial device representation should be read-only and capability-based:

```ts
type DeviceStatus = "online" | "offline" | "unknown";

interface DesktopNodeSummary {
  id: string;
  name: string;
  platform: "macos" | "windows" | "linux" | "unknown";
  status: DeviceStatus;
  capabilities: string[];
  lastSeenAt?: string;
}
```

Treat a future MacBook node as a separately paired executor with its own consent and permissions. Do not use it to take ownership of Mini agents.

Remote desktop, terminal, filesystem, screen control, clipboard synchronization, and arbitrary device commands are follow-on work. They require a specific existing OpenClaw/BFF capability, an authorization contract, a policy review, a user-visible audit trail, and a focused test plan. They are not part of V1 merely because a node is online.

## Implementation Phases

### Phase 0: establish a safe private source base

- Create the private source repository from the public repository.
- Add this plan and a source/data classification note.
- Audit imported files before committing them.
- Ensure runtime state, personal data, credentials, and generated artifacts are ignored.
- Document the Mini as the current authoritative runtime.

**Exit:** a coding agent can see the required source without receiving a copy of production credentials or private runtime data.

### Phase 1: prove the remote-control-plane connection

- Inspect the private BFF and map the current authentication, agent, session, event, and node functions.
- Design the additive desktop contract around existing behavior.
- Add desktop authentication and authorization before exposing the BFF remotely.
- Build a minimal SwiftUI app that reaches authenticated health status over Tailscale.

**Exit:** Orion.app can securely identify whether the Mini BFF and OpenClaw gateway are reachable.

### Phase 2: existing-agent access

- Implement the agents and sessions read models.
- Implement chat submission and event streaming using the BFF's current gateway flow.
- Make reconnect, cancellation display, and error states explicit.
- Verify an agent/session started in Orion.app is visible through the existing web application, and vice versa.

**Exit:** the MacBook uses the user's existing Mini-hosted agents without copying or re-registering them.

### Phase 3: node visibility and MacBook pairing

- Show existing paired nodes and capability summaries.
- Optionally pair the MacBook as a new OpenClaw node through the supported product path.
- Start with status and a very small set of consented, low-risk actions only if the existing capability contract supports them.

**Exit:** Orion.app accurately displays Mini, Windows, and optional MacBook node state without creating a shadow node registry.

### Phase 4: native ergonomics

- Add menu bar, command panel, notifications, and safe App Intents.
- Add optional permissioned context sources one at a time.
- Keep all entry points on the same desktop client/API path; do not create Siri-only agent logic.

**Exit:** Orion is convenient to open and use from macOS while behavior remains consistent with the web client.

### Phase 5: optional runtime migration

Only begin if the Mini will be retired as the authoritative runtime. Follow the migration process in “Existing Agents: Access First, Migration Later.”

**Exit:** exactly one validated, authoritative runtime is operating after cutover, with a private rollback backup.

## First Vertical Slice

Build this exact flow before adding device control, voice, or App Intents:

```text
MacBook Orion.app
  -> authenticated desktop API over Tailscale
  -> Mac mini BFF
  -> existing OpenClaw gateway
  -> existing selected agent/session
  -> BFF event stream
  -> Orion.app chat UI
```

Acceptance criteria:

1. The app does not contain provider, gateway, broker, or runtime secrets.
2. The Mini remains the only agent-runtime owner.
3. The user can select an existing agent and create/continue a session from the MacBook.
4. A response streams into the native UI and correctly surfaces failure/reconnect state.
5. The same session remains visible through the existing Orion web interface.
6. Stopping the MacBook app does not stop an agent run on the Mini.

## Coding-Agent Rules

1. Read the current private BFF and public repository before creating files or endpoints.
2. Prefer existing BFF, gateway, session, node, memory, and authentication mechanisms over new parallel services.
3. Treat all endpoint names in this plan as proposed until mapped to actual code.
4. Do not hardcode agent names, team names, node names, hosts, IP addresses, or credentials.
5. Do not copy runtime state, `.env` files, databases, vault content, browser profiles, or sessions into Git or the MacBook app bundle.
6. Do not connect the MacBook directly to the OpenClaw gateway in V1.
7. Do not expose the BFF/gateway to the public internet.
8. Do not include extraction, Hunting, workflow learning, Finance Lab, or broker controls in the native app V1.
9. Do not build a custom remote-desktop transport in V1.
10. Add high-risk device actions only after a specific authorization and audit model is implemented and tested.
11. Keep the existing web UI working throughout the change.
12. Before any runtime migration, write and test a private migration runbook; never run old and copied agent stores as two live authorities.

## Open Questions To Resolve Before Implementation

| Question | Why it matters |
| --- | --- |
| Which current BFF authentication mechanism can be safely extended to a remote native client? | The existing BFF must not become reachable merely because it is on Tailscale. |
| Which existing endpoints and SSE events can be projected directly for desktop use? | Prevents a duplicate session/event implementation. |
| Which data in the private BFF is Orion UI profile state versus OpenClaw agent state? | Determines what must be remotely accessed and what belongs in a future migration backup. |
| What OpenClaw node capabilities are actually paired and enabled? | Keeps the device screen accurate and avoids designing unsupported controls. |
| Will the Mini remain the long-term runtime owner? | Determines whether Phase 5 is needed at all. |

## Reference

- Public architecture and ownership model: <https://github.com/tol518/orion-personal-ai-operating-system/blob/main/README.md>
- Public codebase: <https://github.com/tol518/orion-personal-ai-operating-system>
