# Orion File Sharing: Feature and Security Notes

Repository: [orion-personal-ai-operating-system](https://github.com/tol518/orion-personal-ai-operating-system)

Orion's **Files** feature lets an authenticated user browse shared folders on the
Orion server and supported paired computers, preview files, and download their
original contents. It is available in both the web dashboard and native Mac app.
Shared folders are read-only. The one write is **Dropped files**: files and folders you choose
to send to the Orion server. It is not whole-drive access or background synchronization.

This document explains the feature and the security decisions made while adding
it. For configuration, API details, and exact limits, see
[Files Across Devices](device-files.md).

## What You Can Do

- Choose the Orion server or an available paired computer.
- Browse shared folders, open subfolders, and inspect file metadata.
- Preview text, code, images, PDFs, and supported audio/video in the web dashboard.
- Preview downloaded temporary copies with Quick Look in the Mac app.
- Download original files using the browser download flow or the Mac Save dialog.
- Send chosen files and folders to the Orion server's Dropped files by dragging them onto Files
  or using the send buttons, and remove them again. Folders keep their structure; hidden files
  inside them stay on your computer.

Text, HTML, SVG, and scripts preview as inert text rather than executable content.
Text previews are limited to the first 256 KiB; downloads contain the full file.
Media playback depends on the client and its supported codecs.

Apart from Dropped files, there is no Files API for uploading, editing, renaming, deleting,
executing files, or synchronizing folders. Uploads only ever land in the Orion server's own drop
folder, never on a paired computer. Downloading does not automatically run an executable.

## How Computers Connect

The Orion server is available as the local file source. To share another computer's
folders, that computer must run a paired, connected OpenClaw Node host with Node.js,
Python 3.8+, the required filesystem capabilities, and permission to run Orion's
fixed file worker through the existing `system.run` execution policy.

Pairing Orion.app with the server makes it a client; it does not automatically
share the Mac's own folders. Sharing those folders also requires a Node host on
that Mac. A remote-desktop connection alone does not provide file access.

| Device or environment | Browse files on supported sources | Share its own folders |
| --- | --- | --- |
| macOS | Web dashboard or native Mac app | Supported with the required runtime and OS permissions |
| Native Linux | Web dashboard | Supported when the required filesystem capabilities are present |
| Native Windows | Web dashboard | Native Node host support not yet tested end to end |
| Windows through WSL | Web dashboard | Supported with the WSL Node host and Windows Python 3.8+ |
| iPhone or iPad | Web dashboard when the private server connection works | Not implemented |

A connected device can still be unable to share files. Connection, execution
approval, filesystem support, and OS folder permissions are separate checks.

By default, each user's Home folder is shared, together with shortcuts to existing
standard folders. WSL also shares the Windows user profile and known folders. An operator
can replace these defaults with a smaller set using `ORION_FILE_ROOTS_JSON` in
the server's private environment. An empty array disables sharing for a device;
devices without an explicit mapping retain their defaults.

**Review the shared folders before enabling access.** Files inside a shared root
are intentionally available to authenticated Orion clients. Prefer a dedicated
Shared folder when broad access to standard user folders is unnecessary. Keep
real paths, node mappings, and credentials out of Git.

## Security Concern: Checking a Path Is Not Enough

The initial concern was a time-of-check/time-of-use race. A pathname can appear
to be inside a shared folder during validation, then be replaced by another local
process before it is opened. A symbolic link or directory junction can redirect
the later operation to a location that was never intended to be shared.

Authentication does not solve this: it controls who requests a file, not whether
the operating system opens the same directory that the server checked. Rejecting
static links or checking a resolved pathname alone does not close that race.

The macOS/native Linux implementation therefore uses a fixed Python helper that
opens each path component relative to an already-open directory descriptor, with
`O_NOFOLLOW`. Root ancestors are traversed this way too. Directory enumeration and
child metadata remain descriptor-relative; file reads use the opened file handle
and check its revision before and after reading.

This prevents a replacement symbolic link from redirecting an operation outside
the acquired directory capability on supported filesystems. It is not a promise
that a directory's pathname remains under the root after another process renames
it: a directory already acquired remains that request's capability.

This is **not a complete filesystem sandbox**. Hard-link provenance, privileged
mount changes, a compromised host, and kernel changes are outside this boundary.
Normal OS access controls and deliberate selection of shared content still matter.

## Windows and WSL Security

The POSIX implementation cannot provide the required isolation guarantee for
Windows-mounted files accessed through WSL.

During implementation testing, static Windows junctions were rejected, but a
synthetic junction-replacement race on a WSL Windows-mounted filesystem broke
the directory-descriptor assumption. The tested behavior could re-resolve a
renamed directory by pathname, allowing later access to be redirected. Passing
ordinary browsing tests or rejecting a junction that already exists was not
enough evidence of safety.

The updated implementation uses a Windows Python helper for Windows folders and
opens each component relative to a held Windows directory handle. It refuses
symbolic links, junctions, and mount points. The POSIX helper handles WSL's
Linux files but refuses unsafe mounted filesystems, including WSL's Windows
drive mounts. Configure Windows folders using Windows paths, not `/mnt/c/...`.

The Windows helper has junction-replacement regression tests. Windows sharing
through WSL requires Windows Python 3.8+; native Windows Node hosts remain
unsupported until tested end to end. See the detailed guide for prerequisites.

## Other Protections and Limits

- Web routes require the dashboard session. Native routes require a verified
  desktop bearer token. Gateway credentials are not sent to either client.
- Clients choose a device, root ID, and relative path; they cannot provide an
  arbitrary absolute path or shell command through the Files API.
- Hidden path segments, traversal attempts, symbolic links, and Windows alternate
  data stream syntax are refused. Linked default roots are omitted.
- Remote access runs the same fixed worker through authenticated `node.invoke`.
  Parameters are encoded as data, not interpolated into client-provided code.
  Existing node execution policy remains in force.
- Python runs in isolated mode without site startup hooks or bytecode writes.
  Fallback reads are bounded to 64 KiB; configured remote streaming can transfer
  a whole range using a single worker and a short-lived one-time ticket.
- Transfers support HTTP ranges and backpressure. Revision checks reject detected
  changes; this is not a snapshot or a guarantee against a privileged malicious host.
- File responses are uncached, MIME sniffing is disabled, and previews use
  restrictive content policies. Native preview files are cleaned up when closed,
  cancelled, or when leaving Files.
- Desktop audit events record actor, action, and outcome, not filenames, absolute
  paths, credentials, or file contents. The server does not persist transferred bytes.

On macOS, access to protected folders may also require approval under
**System Settings > Privacy & Security > Files and Folders** for the responsible
server or Node-host process on the computer owning the files. Approve only the
intended folders, restart the owning service, and retry. Orion does not grant
itself OS privacy permissions or disable those checks.

Remote transfers fall back to sequential requests if streaming is not configured
or reachable, so large files can be slower. Files are read on demand; there is no
background replication of a source computer's folders.

## Validation and Publication Boundary

The implementation includes descriptor-relative path-replacement regression tests
in `server/device-file-posix-test.py`, Windows junction tests in
`server/device-file-windows-test.py`, and service and transfer tests in
`server/device-files.test.js`. The original WSL junction probe found the race that
motivated the Windows handle-based implementation.

These checks support the documented boundary; they are not a security certification
or a guarantee for every filesystem. Revalidate the boundary when changing the
helper, filesystem backend, execution transport, or platform support.

Public changes are limited to reviewed source, tests, documentation, and sanitized
examples. Do not publish `.env` files, passwords, tokens, real root mappings,
device identifiers, databases, logs, screenshots, downloads, temporary previews,
private personal content, or generated app/build bundles. Run
`node scripts/verify-public-release.mjs` before publication and use the private
denylist when configured. See [Source and Data Classification](architecture/data-classification.md).

The native Files addition does not expose Hunting, extraction, Finance Lab,
workflow learning, broker controls, arbitrary terminal execution, or screen control
through its API. Adding Files does not authorize publishing private integrations
or other excluded features.
