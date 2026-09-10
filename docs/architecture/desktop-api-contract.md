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
| `GET /api/v1/desktop/sessions` | gateway `sessions.list` | `includeDerivedTitles` and `includeLastMessage`, matching `/api/sessions`. |
| `POST /api/v1/desktop/sessions` | gateway `sessions.create` | Requires an existing `agentId`. Does not create agents. |
| `GET /api/v1/desktop/sessions/:key/history` | gateway `chat.history` | Bounded by the same `CHAT_HISTORY_MAX_CHARS` envelope as `/api/history`. |
| `POST /api/v1/desktop/chat` | the BFF's existing `submitChatTurn` path | Delegates to the *same* function `/api/chat` uses, so memory retrieval, execution policy, attachment grants, and safety behavior are identical. The desktop app does not re-implement any of it. |
| `GET /api/v1/desktop/events` | the existing SSE fan-out | Registers with the same `broadcast()` used by `/api/events`, filtered to a desktop event allowlist. One event model, not two. |
| `GET /api/v1/desktop/nodes` | gateway `node.list` | Read-only in V1, projected to `DesktopNodeSummary`. No shadow node registry. |

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

## Deliberate omissions in V1

No extraction, Hunting, Finance Lab, workflow learning, broker control, terminal execution,
filesystem browsing, screen control, or remote desktop route exists on this surface. The Mini
continues to serve those to the web client; they are simply not reachable from `Orion.app`.

`DELETE` on sessions and nodes is also omitted: V1 is read-plus-chat, and destructive gateway
calls stay behind the browser boundary until a per-action authorization model is tested.
