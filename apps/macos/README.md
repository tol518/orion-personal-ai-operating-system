# Orion.app (native macOS client)

A SwiftUI client for the Orion runtime on the Mac mini. It is a **client, not a second runtime**:
agents, sessions, tools, memory, and node pairings all stay on the Mini, and this app reads and
drives them through the Mini's authenticated desktop API.

Closing or quitting this app does not stop a run. The run belongs to the Mini.

## What it holds

One secret: a revocable desktop token issued by the Mini at pairing time, stored in the login
Keychain. No gateway token, no provider key, no broker credential, no `.env` value ever reaches
this app. Revoking it on the Mini does not require rotating anything else.

## Build

```sh
swift build          # compile
swift test           # 66 offline unit tests
make app             # assemble build/Orion.app (ad-hoc signed)
make run             # assemble and launch
```

`make app` builds a bundle because macOS needs one for the menu-bar item, notification
permission, and a stable Keychain identity. The ad-hoc signature is for local use — re-sign with
a Developer ID and notarize for distribution. Re-signing with a different identity makes the
stored token unreadable, so the app will ask to pair again.

## Enable desktop access on the Mini

The desktop surface is closed until you turn it on. In the Mini's `server/.env`:

```sh
ORION_DESKTOP_PAIRING_SECRET=$(openssl rand -base64 32)
# Optional, recommended once you know this Mac's client id:
ORION_DESKTOP_ALLOWED_CLIENTS=macbook-orion
```

Restart the BFF. Without the secret every desktop route answers `503`, and this app says so
rather than failing obscurely.

The BFF binds to `127.0.0.1` by default. To reach it from another machine, bind it to the Mini's
**Tailscale address** — not `0.0.0.0` — and never expose the port publicly.

### HTTP over Tailscale, and how to stop needing it

App Transport Security blocks plain HTTP to a `.ts.net` name, because ATS sees an ordinary public
domain. `Info.plist` carries an exception scoped to `ts.net` and nothing else: a tailnet address
is not routable from the public internet and its traffic is already WireGuard-encrypted, so this
is not cleartext on the wire.

To remove the need for the exception entirely, give the Mini a real certificate for its MagicDNS
name and serve the BFF over TLS:

```sh
tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
```

Then enter the address in the app with an explicit `https://` — that is honoured and preferred.

## Pair this Mac

1. Launch Orion.app.
2. Enter the Mini's address, e.g. `mini.your-tailnet.ts.net` (port `4820` is assumed).
3. Enter the pairing secret. It is exchanged once for a token and is not stored by this app.

The app shows the client id it will pair as; that is the value for
`ORION_DESKTOP_ALLOWED_CLIENTS`. **Settings → Unpair this Mac** revokes the token on the Mini.

## Screens

| Screen | Shows |
| --- | --- |
| Connection | Mini reachability, pairing, retry and error state |
| Home | Gateway/BFF status, recent sessions, node summary |
| Agents | Existing agents and their available models; start a session |
| Chat | Session list, transcript, streamed replies, failure state |
| Nodes | Read-only status and capabilities per paired node |
| Settings | Address, pairing, notifications, and what this app can reach |

## Not in this release

Extraction, Hunting, Finance Lab, workflow learning, broker controls, terminal execution, file
browsing, screen control, and remote desktop. These still run on the Mini; they are simply not
reachable from this app. Each needs its own authorization contract and audit trail before a
native surface is appropriate — a node being online is not permission to drive it.

App Intents, a global command panel, push-to-talk, and context sources (selected text, clipboard,
screen) are also deliberately absent: the plan orders them after the core flow is stable, and each
context source needs a visible setting and a platform permission first.

## Architecture

```
OrionKit
├── Model/       Codable mirrors of the desktop contract; transcript normalization
├── Services/    Keychain, REST transport, SSE parser and stream, notifications
├── Store/       OrionStore — the single source of truth; settings persistence
└── Views/       Six V1 screens plus the menu-bar panel
```

Everything testable lives in `OrionKit`; the `OrionApp` executable is one line. `OrionStore` holds
no cached copy of the Mini's runtime — a stale local list would misrepresent the authoritative
state, so every screen renders what the Mini most recently reported.

## Testing against a stack

Unit tests are offline. The live slice runs only when pointed at a BFF with desktop access on:

```sh
ORION_TEST_HOST=127.0.0.1:4899 \
ORION_TEST_PAIRING_SECRET=... \
swift test --filter LiveIntegrationTests
```

It pairs, lists agents, creates a session, sends a turn, and asserts the reply streams back —
the acceptance criteria from the plan's First Vertical Slice.
