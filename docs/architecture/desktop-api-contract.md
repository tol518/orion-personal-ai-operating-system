# Desktop API Contract (`/api/v1/desktop`)

**Status:** implemented as an additive surface on the existing BFF. Every route below is mapped to
code that already exists; none of them introduce a parallel agent, session, memory, or node store.

The browser API under `/api/...` is unchanged. No existing route was renamed, and the existing
cookie/same-origin auth path still governs it.

## Why a separate surface was required

The browser boundary authenticates with a password that sets an `httpOnly` cookie
(`server/index.js` `/api/auth/login`), and both login and every privileged action are gated on
`requestIsSameOrigin(req)` — a check against `ALLOWED_ORIGINS`. A native macOS client has no
browser origin and cannot satisfy that check, so reusing `/api/auth/login` from `Orion.app` would
have meant weakening the browser's own protection.

Instead the desktop boundary uses a **bearer token bound to a client identity**, issued by a
pairing exchange, verified by `server/desktop-access.js`, and revocable per device. This answers
open question 1 in the implementation plan: the browser mechanism is *not* safely extensible to a
remote native client, so an adjacent, narrower one was added.

## Mounting order

The desktop router is mounted **before** `app.use("/api", cookieAuthMiddleware)` in
`server/index.js`. Express matches `/api` as a prefix, so mounting it after that middleware would
have subjected native requests to the cookie check. Order is load-bearing.

## Authentication

| Route | Purpose |
| --- | --- |
| `POST /api/v1/desktop/pair` | Exchange the pairing secret plus a client identity for a bearer token. |
| `POST /api/v1/desktop/unpair` | Revoke the calling token. |
| `GET /api/v1/desktop/clients` | List paired clients (identity and timestamps, never tokens). |
| `DELETE /api/v1/desktop/clients/:clientId` | Revoke every token for one client. |

Pairing requires `ORION_DESKTOP_PAIRING_SECRET` to be set on the Mini. When it is unset the entire
desktop surface answers `503` and the native app cannot connect — the deliberate default.

`ORION_DESKTOP_ALLOWED_CLIENTS`, when non-empty, is an allowlist of client ids permitted to pair.

Every authenticated route expects `Authorization: Bearer <token>`. Failures are throttled per
client key (5 attempts / 5 minutes) by the same logic the existing access gates use.

## Data routes

| Contract | Maps to | Notes |
| --- | --- | --- |
| `GET /api/v1/desktop/health` | `gateway.status()` | Reports reachability and gateway connection. Redacts URLs, tokens, scopes detail, and internal error strings beyond a short reason. |
| `GET /api/v1/desktop/agents` | gateway `agents.list`, then `config.get` for per-agent models | Same projection the web client sees, minus sprite/appearance payloads the native UI does not use. |
| `GET /api/v1/desktop/sessions` | gateway `sessions.list` | `includeDerivedTitles` and `includeLastMessage`, matching `/api/sessions`. Projected to a stable native shape: the agent id is derived from the session key the same way the web client derives it, and the title falls back through `derivedTitle` → `label` → `displayName`. |
| `POST /api/v1/desktop/sessions` | gateway `sessions.create` | Requires an existing `agentId`. Does not create agents. |
| `GET /api/v1/desktop/sessions/:key/history` | gateway `chat.history` | Bounded by the same `CHAT_HISTORY_MAX_CHARS` envelope as `/api/history`. |
| `POST /api/v1/desktop/chat` | the BFF's existing `submitChatTurn` path | Delegates to the *same* function `/api/chat` uses, so memory retrieval, execution policy, attachment grants, and safety behavior are identical. The desktop app does not re-implement any of it. |
| `GET /api/v1/desktop/events` | the existing SSE fan-out | Registers with the same `broadcast()` used by `/api/events`, filtered to a desktop event allowlist. One event model, not two. |
| `GET /api/v1/desktop/nodes` | gateway `node.list` | Read-only in V1, projected to `DesktopNodeSummary`. No shadow node registry. |
| `GET /api/v1/desktop/remote-access` | `server/remote-access.js` | Which native remote-desktop service is reachable per node, and at what address. Discovery only. |
| `POST /api/v1/desktop/remote-access/:nodeId/session` | `server/remote-access.js` | Records that a session was opened and returns host, port, and scheme. |
| `GET /api/v1/desktop/remote-access/audit` | `server/remote-access.js` | Remote-session audit events: actor, node, service, time. |

## Event allowlist

The desktop stream carries only:

`gateway.status`, `gateway.disconnected`, `chat`, `agent`, `session.tool`, `session.message`,
`sessions.changed`, `node.presence.alive`.

Hunting, extraction, workflow-learning, and memory-mutation events are deliberately excluded —
those features are out of scope for the native app in V1, so their events are not exposed to it.

## Node projection

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

`capabilities` is derived from the gateway's `commands` array, coarsened to stable capability
names (`exec`, `screen`, `browser`, `canvas`) so the native UI does not depend on gateway
command spellings.

## Remote desktop: discovery, not transport

The plan forbids a custom remote-desktop transport, and the existing `human-screen-control.js`
path is not a substitute for one: it serves still snapshots and supports click and scroll only,
with Mac clicks driven through AppleScript `System Events`, "scrolling" emulated with arrow keys,
primary display only, no keyboard entry, and a 40ms floor between inputs. That is a remote-assist
tool, not a desktop.

So Orion carries no pixels. macOS Screen Sharing and Windows RDP already do that properly —
hardware video decode, audio, clipboard sync, file drag-and-drop, multiple displays — and both
run over the same private network the BFF already uses. The BFF's role is to answer *which of
them is reachable on each node, and at what address*, and to record that a session was opened.

Address resolution, in order:

1. An explicit `ORION_REMOTE_ACCESS_HOSTS` entry for the node id.
2. A tailnet peer whose short name matches the node, and **only if the match is unambiguous** —
   two candidates resolve to nothing, because pointing a screen viewer at the wrong machine is
   worse than reporting no address.

A node with no resolvable address reports `host: null` with a hint naming the setting to add.

The session route returns `{ host, port, scheme }` rather than a URL. The client builds the URL
itself and validates the scheme against a two-entry allowlist (`vnc`, `rdp`) and the host against
an explicit character and label check. That URL is handed to the window server to launch an
application, so a compromised or buggy server must not be able to choose an arbitrary one.

### Interface exposure

Each remote-access service entry carries an `exposure` block:

```ts
{ bind: "all-interfaces" | "specific" | "tailnet-only" | "loopback-only" | "not-listening" | "unknown",
  scope: "lan" | "private" | "local" | null,
  fix: { summary, command, shell, rollback } | null }
```

Reachability alone is the wrong question: a service that answers on the tailnet *because it
answers on every interface* is also reachable from the machine's LAN. The BFF inspects the
Mini's own listeners with `netstat`, and paired nodes' with the same read-only `system.run` path
it already uses (`netstat` on Unix, `Get-NetTCPConnection` on Windows). Results are cached like
probes. An unavailable inspection reports `unknown`, never a false `private`.

`fix` is populated only for `scope: "lan"` and is advisory. Applying it is a device action; the
BFF does not run firewall commands.

## Deliberate omissions in V1

No extraction, Hunting, Finance Lab, workflow learning, broker control, terminal execution,
filesystem browsing, screen control, or remote desktop route exists on this surface. The Mini
continues to serve those to the web client; they are simply not reachable from `Orion.app`.

`DELETE` on sessions and nodes is also omitted: V1 is read-plus-chat, and destructive gateway
calls stay behind the browser boundary until a per-action authorization model is tested.
