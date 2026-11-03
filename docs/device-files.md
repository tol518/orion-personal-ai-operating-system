# Files Across Devices

The **Files** view is available in the web dashboard and native Mac app. It browses the Orion
server and paired OpenClaw computers, previews supported files, and downloads originals. This is
read-only access: no upload, deletion, rename, background synchronization, or agent execution is
exposed by the Files API.

## Connect a computer

The Orion server appears even when no execution nodes are paired. Other computers must be
paired OpenClaw Node hosts running macOS or Linux, connected to the gateway, advertise `system.run`,
and have `node` and Python 3.8+ available. macOS uses `/usr/bin/python3`; Linux uses `python3`
on the host's executable search path. Python must support descriptor-relative opens, non-following
stat, descriptor directory scans, and positioned reads. Missing capabilities fail closed. Windows
sharing is not available until an equivalent native handle-based backend is implemented and tested;
there is no less-safe fallback. Existing node execution policy still applies; Orion
does not approve commands or weaken that policy automatically.

Pairing Orion.app to the server makes the Mac a client. To share that Mac's own folders back
through Orion, also connect an OpenClaw Node host on it. A remote desktop address alone does
not provide file access. macOS may separately require permission to read Desktop, Documents,
Downloads, or removable volumes in the process hosting the server or Node host.

If roots and metadata work but a preview or download times out, inspect **System Settings >
Privacy & Security > Files and Folders on the device owning those files**. Approve only the
folders intended for sharing for the responsible server or Node-host process (often `node`).
A background service can be unable to complete the permission prompt. The helper stops after
15 seconds instead of waiting indefinitely; restart the owning service after approval and retry.
Or configure an explicit shared directory outside protected Desktop/Documents/Downloads folders.
Orion never grants OS privacy permission, edits the privacy database, or disables this gate.

## Shared folders

By default, existing Desktop, Documents, Downloads, Pictures, Music, and Movies (macOS) or Videos
(Linux) folders under each host user's home are available to authenticated Orion
clients. Files does not expose a whole drive, hidden files, or symbolic links. This includes
configured roots and their ancestors: configure the actual directory path, not a symlink alias.
Linked default folders are omitted rather than followed.

To replace the defaults, set `ORION_FILE_ROOTS_JSON` **only in the server's private environment**.
It maps `local` and gateway node IDs to arrays of `{id, label, path}`. Paths are resolved on the
device that owns them; they are never returned to the client. An empty array disables sharing
for that device. Devices absent from this object keep the defaults.

Sanitized example:

```dotenv
ORION_FILE_ROOTS_JSON={"local":[{"id":"shared","label":"Shared","path":"/Users/example/Shared"}],"node-example":[{"id":"work","label":"Work","path":"/home/example/Shared"}]}
```

Keep real root paths and node IDs out of Git. Use this setting for actual canonical folder paths,
network mounts, or a smaller set of folders. Restart the BFF after changing it. Invalid root
configuration fails startup rather than silently enabling a different share.

## Browse, preview, download

- Select a computer, then a shared folder. The web view has clickable breadcrumbs; the Mac app
  opens folders on double-click and includes an Up action.
- Listings show folders first, 100 entries per page, with a filter for the current page. A scan
  stops at 5,000 visible entries and says so; browse a subfolder to narrow it.
- Text, code, Markdown, HTML, and SVG preview as inert text, bounded to the first 256 KiB. The
  download contains the complete original. Raster images, PDF, and supported audio/video have
  browser previews; playback depends on browser codec support.
- The Mac app downloads a preview to a private temporary directory and opens Quick Look. Text
  previews receive a `.txt` extension so scripts and markup cannot become active content.
  Preview files are removed when closed, cancelled, or when leaving Files. Media previews may
  need to finish downloading before Quick Look opens.
- Download uses the browser's download handling or the Mac's Save dialog. The native app
  streams to a temporary file before replacing the user-selected destination. It never opens a
  downloaded executable automatically.

## Transport and access boundary

Both clients use one `DeviceFiles` service and the same read-only worker. Browser routes live
under `/api/files` after the dashboard session gate. Native routes live under
`/api/v1/desktop/files` after desktop bearer-token verification. Clients receive no gateway
credentials and cannot supply shell code or an arbitrary absolute path.

For remote hosts, Orion runs its fixed worker through the existing authenticated `node.invoke`
channel. The Node launcher embeds the same fixed Python helper used locally. Python runs in
isolated mode without site startup hooks or bytecode writes, with bounded output and a 15-second
helper lifetime. File parameters are encoded as data in a separate argument. Reads are at most 64 KiB
per request, below the Node host's captured-output limit; HTTP backpressure controls subsequent
reads. The BFF stores no file bytes. Remote transfers are sequential and may be slower than a
direct file-sharing protocol, particularly for large video.

Root acquisition and every child traversal open one component relative to an already-open
directory descriptor with `O_NOFOLLOW`. Directory scans and child metadata remain descriptor-relative;
file metadata and bytes come from the same open file handle. Replacing a pathname with a link
cannot redirect an operation outside the acquired directory capability. A renamed directory
already acquired during a request remains that request's capability; this is not a guarantee that
its pathname stays beneath the root for the whole request. Hard-link provenance and privileged
mount or kernel changes are outside this boundary. Configure only folders whose contents you
intend to share, and retain normal OS access controls.

`content` supports HTTP byte ranges, suffix ranges, HEAD requests, and seekable media. Revision
checks reject files changed during a transfer. Offline, revoked, or incapable nodes return a
specific error. Cancelling a request stops further reads; a worker already executing can finish
its current bounded read. Each router permits three simultaneous content transfers per device.

Text responses use `text/plain`, MIME sniffing is disabled, content has a restrictive sandbox
policy, and every response is uncached. Desktop audit events record actor, action, and outcome,
without filenames, absolute paths, credentials, or file contents. Downloaded files and preview
material remain private user content and must never be committed or bundled in a release.

## API

The following routes exist under both prefixes:

| Method and Path                                               | Result                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /devices`                                                | Server plus paired computer availability; `gatewayUnavailable` if discovery failed. |
| `GET /:deviceId/roots`                                        | Shared root IDs and labels only.                                                    |
| `GET /:deviceId/list?root=id&path=relative&offset=0`          | Entries, `nextOffset`, and `scanTruncated`.                                         |
| `GET /:deviceId/stat?root=id&path=relative&revision=value`    | File metadata, MIME type, and preview kind.                                         |
| `GET /:deviceId/content?root=id&path=relative&revision=value` | Original bytes; supports `Range` and `HEAD`.                                        |

`preview=1` bounds text previews; `download=1` forces attachment disposition. File locations
consist of device ID, root ID, and a slash-separated relative path. No route writes to the source
device. Requests outside a share, hidden segments, symlinks, or Windows alternate data streams
are refused.

## Public source promotion

Promote only reviewed source, tests, placeholder examples, and documentation. Keep the private
running deployment separate. Run the existing server tests, client build, native tests, and
`node scripts/verify-public-release.mjs` before publication, with the private denylist when one
is configured. Exclude build output, downloaded files, root mappings, temporary previews,
screenshots, databases, `.env`, and all runtime state.

The native addition is limited to Files. Hunting, extraction, Finance Lab, workflow learning,
broker controls, arbitrary terminal execution, and screen control remain outside its API.
