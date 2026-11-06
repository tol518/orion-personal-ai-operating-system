import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  FolderUp,
  FolderOpen,
  HardDrive,
  Image,
  LoaderCircle,
  Monitor,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  WifiOff,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { dropSource, pickedPlan } from "../lib/drop-plan";
import type { DropPlan } from "../lib/drop-plan";
import type { DeviceFile, FileDevice, FileInfo, FileListing, FileRoot } from "../lib/file-types";
import "./FilesPage.css";

function sizeLabel(bytes: number) {
  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: bytes >= 1048576 ? "megabyte" : "kilobyte",
    maximumFractionDigits: 1,
  }).format(bytes / (bytes >= 1048576 ? 1048576 : 1024));
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Files are unavailable. Try again.";
}
function childPath(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export default function FilesPage() {
  const [devices, setDevices] = useState<FileDevice[]>([]);
  const [deviceId, setDeviceId] = useState("local");
  const [error, setError] = useState<string | null>(null);
  const [gatewayUnavailable, setGatewayUnavailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<string | null>(null);
  const [showDrops, setShowDrops] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  async function send(planned: () => Promise<DropPlan> | DropPlan) {
    if (sending) return;
    let plan: DropPlan;
    try {
      setSending("Reading what you chose...");
      plan = await planned();
    } catch (failure) {
      setSending(null);
      setSendNote(errorMessage(failure));
      return;
    }
    if (!plan.files.length && !plan.folders.length) {
      setSending(null);
      setSendNote("Nothing to send: hidden files stay on your computer.");
      return;
    }
    const failures: string[] = [];
    // A chosen folder may get a new name on Orion ("Photos (2)"); its contents follow it.
    const placed = new Map<string, string>();
    const failedFolders = new Set<string>();
    const onOrion = (path: string) => {
      const top = path.split("/")[0];
      if (failedFolders.has(top)) return null;
      return (placed.get(top) ?? top) + path.slice(top.length);
    };
    for (const folder of plan.folders) {
      const nested = folder.includes("/");
      const target = onOrion(folder);
      if (target === null) continue;
      try {
        const created = await api.createDropFolder(target);
        if (!nested) placed.set(folder, created.path);
      } catch (failure) {
        if (!nested) failedFolders.add(folder);
        failures.push(`${folder}: ${errorMessage(failure)}`);
      }
    }
    let sent = 0;
    for (const [index, { file, path }] of plan.files.entries()) {
      const target = onOrion(path);
      if (target === null) continue;
      setSending(`Sending ${index + 1} of ${plan.files.length}: ${path}`);
      try {
        await api.dropFile(file, target);
        sent += 1;
      } catch (failure) {
        failures.push(`${path}: ${errorMessage(failure)}`);
      }
    }
    setSending(null);
    setSendNote(
      [
        `Sent ${sent} of ${plan.files.length} files to Orion.`,
        plan.folders.length ? "Folders keep their structure." : "",
        plan.skipped ? "Hidden files were left on your computer." : "",
        ...failures,
      ]
        .filter(Boolean)
        .join(" "),
    );
    setDeviceId("local");
    setShowDrops((value) => value + 1);
  }
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes("Files");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await api.fileDevices(controller.signal);
        if (controller.signal.aborted) return;
        setDevices(result.devices);
        setGatewayUnavailable(result.gatewayUnavailable);
        setError(null);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 10_000);
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [refresh]);

  const device = devices.find((entry) => entry.id === deviceId);
  return (
    <section
      className="files-page"
      aria-labelledby="files-title"
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        setDragging(false);
        // Taken now: the browser lets go of the dropped items once this handler returns.
        void send(dropSource(event.dataTransfer));
      }}
    >
      {dragging && (
        <div className="files-dropzone" aria-hidden="true">
          <Upload size={28} />
          <strong>Drop to send to Orion's Dropped files</strong>
          <span>Files and folders. Hidden files stay on your computer.</span>
        </div>
      )}
      <header className="files-heading">
        <div>
          <p className="files-eyebrow">CONNECTED WORKSPACE</p>
          <h1 id="files-title">Files</h1>
          <p>Your computers. One place to find what you need.</p>
        </div>
        <div className="files-heading__actions">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              void send(() => pickedPlan(files));
            }}
          />
          <input
            ref={folderPicker}
            type="file"
            hidden
            // Non-standard but supported by every current browser: pick one whole folder.
            {...{ webkitdirectory: "" }}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              void send(() => pickedPlan(files));
            }}
          />
          <button
            className="files-button"
            disabled={Boolean(sending)}
            onClick={() => picker.current?.click()}
          >
            <Upload size={15} /> Send files
          </button>
          <button
            className="files-button"
            disabled={Boolean(sending)}
            onClick={() => folderPicker.current?.click()}
          >
            <FolderUp size={15} /> Send a folder
          </button>
          <button className="files-button" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw size={15} /> Refresh devices
          </button>
        </div>
      </header>
      {(sending || sendNote) && (
        <div className="files-notice files-notice--info" role="status">
          {sending ? <LoaderCircle className="animate-spin" size={14} /> : null}
          {sending ?? sendNote}
          {!sending && <button onClick={() => setSendNote(null)}>Dismiss</button>}
        </div>
      )}
      {error && (
        <div className="files-notice" role="alert">
          {error}
        </div>
      )}
      {gatewayUnavailable && (
        <div className="files-notice" role="status">
          The gateway is unavailable. Files on this server are still accessible; other computers
          will return when it reconnects.
        </div>
      )}
      <div className="files-devices" aria-label="File devices">
        {devices.map((entry) => (
          <button
            key={entry.id}
            className="files-device"
            aria-pressed={deviceId === entry.id}
            onClick={() => setDeviceId(entry.id)}
          >
            <span className="files-device__icon">
              {entry.local ? <HardDrive size={22} /> : <Monitor size={22} />}
            </span>
            <span className="files-device__name">
              <strong>{entry.name}</strong>
              <small>{entry.local ? "Orion server" : entry.platform}</small>
            </span>
            <span className="files-device__status" data-online={entry.available}>
              {entry.available ? "Connected" : entry.connected ? "Unavailable" : "Offline"}
            </span>
          </button>
        ))}
      </div>
      {!devices.length && !error && (
        <div className="files-empty">
          <LoaderCircle className="animate-spin" size={25} />
          <p>Finding your computers...</p>
        </div>
      )}
      {device ? (
        <DeviceWorkspace key={device.id} device={device} showDrops={showDrops} />
      ) : devices.length ? (
        <div className="files-empty">
          <Monitor size={30} />
          <p>Choose a computer to browse its shared folders.</p>
        </div>
      ) : null}
      <footer className="files-footer">
        <ShieldCheck size={16} />
        <span>
          Read-only access to shared folders. Files stay on their device until you preview or
          download them. Dropped files holds copies of files and folders you chose to send to the
          Orion server.
        </span>
      </footer>
    </section>
  );
}

function DeviceWorkspace({ device, showDrops }: { device: FileDevice; showDrops: number }) {
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [rootId, setRootId] = useState("");
  const [path, setPath] = useState("");
  const [offset, setOffset] = useState(0);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [selected, setSelected] = useState<DeviceFile | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [rootsLoading, setRootsLoading] = useState(true);

  useEffect(() => {
    if (!device.available) return;
    const controller = new AbortController();
    setRootsLoading(true);
    setError(null);
    api
      .fileRoots(device.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setRoots(result.roots);
        // After sending files, show them where they went.
        const drops = showDrops ? result.roots.find((entry) => entry.writable) : undefined;
        if (drops) {
          setPath("");
          setOffset(0);
        }
        setRootId((current) =>
          drops
            ? drops.id
            : result.roots.some(({ id }) => id === current)
              ? current
              : (result.roots[0]?.id ?? ""),
        );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRootsLoading(false);
      });
    return () => controller.abort();
  }, [device.id, device.available, refresh, showDrops]);

  useEffect(() => {
    setSelected(null);
    setListing(null);
    setFilter("");
    if (!rootId || !device.available) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .fileList(device.id, rootId, path, offset, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setListing(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [device.id, device.available, rootId, path, offset, refresh, showDrops]);

  const openFolder = (nextPath: string) => {
    setPath(nextPath);
    setOffset(0);
    setSelected(null);
  };
  if (!device.available)
    return (
      <div className="files-empty">
        <WifiOff size={34} />
        <h2>{device.connected ? "File access is unavailable" : "This computer is offline"}</h2>
        <p>
          {device.connected
            ? "Hardened sharing requires macOS or Linux, Python 3.8+, and an OpenClaw Node host with Node.js and file execution permission. Windows sharing is not available yet."
            : "Reconnect this computer to Orion, then its shared folders will appear here."}
        </p>
      </div>
    );
  const root = roots.find(({ id }) => id === rootId);
  const removeDropped = async (entry: DeviceFile) => {
    const question =
      entry.kind === "directory"
        ? `Remove the folder ${entry.name} and everything in it from Orion? Originals stay on your computer.`
        : `Remove ${entry.name} from Orion? The copy on the Orion server is deleted; the original stays on your computer.`;
    if (!window.confirm(question)) return;
    try {
      await api.removeDropped(childPath(path, entry.name));
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const entries =
    listing?.entries.filter((entry) =>
      entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
    ) ?? [];

  return (
    <div className="files-workspace">
      <aside className="files-roots" aria-label="Shared folders">
        <p className="files-eyebrow">SHARED FOLDERS</p>
        {roots.map((entry) => (
          <button
            key={entry.id}
            aria-pressed={entry.id === rootId}
            onClick={() => {
              setRootId(entry.id);
              openFolder("");
            }}
          >
            <FolderOpen size={16} />
            {entry.label}
          </button>
        ))}
        {rootsLoading && <p className="files-muted">Reading folders...</p>}
        {!rootsLoading && !roots.length && !error && (
          <p className="files-muted">
            No shared folders. Configure folder roots on the Orion server.
          </p>
        )}
      </aside>
      <div className="files-browser">
        <div className="files-toolbar">
          <button
            className="files-icon-button"
            aria-label="Go to parent folder"
            disabled={!path}
            onClick={() => openFolder(path.split("/").slice(0, -1).join("/"))}
          >
            <ArrowLeft size={17} />
          </button>
          <nav className="files-breadcrumbs" aria-label="Folder path">
            <button disabled={!root} onClick={() => openFolder("")}>
              {root?.label ?? "Shared folders"}
            </button>
            {path
              .split("/")
              .filter(Boolean)
              .map((part, index, parts) => (
                <span key={index}>
                  <ChevronRight size={13} />
                  <button onClick={() => openFolder(parts.slice(0, index + 1).join("/"))}>
                    {part}
                  </button>
                </span>
              ))}
          </nav>
          <button
            className="files-icon-button"
            aria-label="Refresh folder"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {error && (
          <div className="files-notice" role="alert">
            {error}
            <button onClick={() => setRefresh((value) => value + 1)}>Try again</button>
          </div>
        )}
        {rootId && (
          <label className="files-filter">
            <Search size={15} />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter this page"
              aria-label="Filter files on this page"
            />
          </label>
        )}
        {rootId && loading ? (
          <div className="files-empty" role="status">
            <LoaderCircle className="animate-spin" size={26} />
            <p>Reading files from {device.name}...</p>
          </div>
        ) : listing ? (
          <>
            <div className="files-content" data-preview={Boolean(selected)}>
              <div className="files-table-wrap">
                <table className="files-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Size</th>
                      <th>Modified</th>
                      <th>
                        <span className="sr-only">Download</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.name} data-selected={selected?.name === entry.name}>
                        <td>
                          <button
                            className="files-entry"
                            onClick={() =>
                              entry.kind === "directory"
                                ? openFolder(childPath(path, entry.name))
                                : setSelected(entry)
                            }
                            aria-label={`${entry.kind === "directory" ? "Open folder" : "Preview"} ${entry.name}`}
                          >
                            {entry.kind === "directory" ? (
                              <Folder size={19} className="files-folder-icon" />
                            ) : /\.(png|jpe?g|webp|gif|avif)$/i.test(entry.name) ? (
                              <Image size={18} />
                            ) : (
                              <FileText size={18} />
                            )}
                            <span>{entry.name}</span>
                          </button>
                        </td>
                        <td>
                          {entry.kind === "directory" ? "Folder" : sizeLabel(entry.sizeBytes)}
                        </td>
                        <td>{new Date(entry.modifiedAt).toLocaleDateString()}</td>
                        <td>
                          {root?.writable && (
                            <button
                              className="files-icon-button"
                              aria-label={`Remove ${entry.name} from Orion`}
                              onClick={() => void removeDropped(entry)}
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                          {entry.kind === "file" && (
                            <a
                              className="files-icon-button"
                              aria-label={`Download ${entry.name}`}
                              href={api.fileUrl(
                                device.id,
                                rootId,
                                childPath(path, entry.name),
                                entry.revision,
                                true,
                              )}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Download size={16} />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!entries.length && (
                  <div className="files-empty">
                    <FolderOpen size={30} />
                    <p>{filter ? "No files match this filter." : "This folder is empty."}</p>
                  </div>
                )}
              </div>
              {selected && (
                <FilePreview
                  key={`${path}/${selected.name}:${selected.revision}`}
                  device={device}
                  rootId={rootId}
                  path={childPath(path, selected.name)}
                  file={selected}
                  onClose={() => setSelected(null)}
                />
              )}
            </div>
            <div className="files-pagination">
              <span>
                {listing.entries.length} items on page {offset / 100 + 1}
              </span>
              <div>
                <button
                  className="files-button"
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - 100))}
                >
                  Previous
                </button>
                <button
                  className="files-button"
                  disabled={listing.nextOffset === null}
                  onClick={() => setOffset(listing.nextOffset ?? 0)}
                >
                  Next
                </button>
              </div>
            </div>
            {listing.scanTruncated && (
              <p className="files-muted">
                Showing the first 5,000 visible entries. Open a subfolder to narrow the list.
              </p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function FilePreview({
  device,
  rootId,
  path,
  file,
  onClose,
}: {
  device: FileDevice;
  rootId: string;
  path: string;
  file: DeviceFile;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const url = api.fileUrl(device.id, rootId, path, file.revision);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const next = await api.fileInfo(device.id, rootId, path, file.revision, controller.signal);
        if (controller.signal.aborted) return;
        setInfo(next);
        if (next.previewKind === "text") {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            const body = await response.json();
            throw new Error(body.error || "Preview unavailable.");
          }
          const content = await response.text();
          if (controller.signal.aborted) return;
          if (content.includes("\0"))
            throw new Error("This file contains binary data. Download it to open it locally.");
          setText(content);
          setTruncated(response.headers.get("X-Orion-Preview-Truncated") === "true");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      }
    }
    void load();
    return () => controller.abort();
  }, [device.id, rootId, path, file.revision, url]);
  return (
    <aside className="files-preview" aria-label={`Preview of ${file.name}`}>
      <header>
        <h2>Preview</h2>
        <button className="files-icon-button" aria-label="Close preview" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <h3>{file.name}</h3>
      <p className="files-muted">
        {sizeLabel(file.sizeBytes)} / {device.name}
      </p>
      {error ? (
        <p className="files-notice" role="alert">
          {error}
        </p>
      ) : !info ? (
        <p role="status">Loading preview...</p>
      ) : info.previewKind === "text" ? (
        text === null ? (
          <p role="status">Reading preview...</p>
        ) : (
          <>
            <pre>{text || "Empty file"}</pre>
            {truncated && (
              <p className="files-muted">
                Preview shows the first 256 KB. Download for the complete file.
              </p>
            )}
          </>
        )
      ) : info.previewKind === "image" ? (
        <img
          src={url}
          alt={file.name}
          onError={() =>
            setError("This image could not be previewed. Download it to open it locally.")
          }
        />
      ) : info.previewKind === "pdf" ? (
        <iframe title={`PDF preview of ${file.name}`} src={url} />
      ) : info.previewKind === "video" ? (
        <video
          controls
          preload="metadata"
          src={url}
          onError={() =>
            setError("This browser cannot play this video. Download it to open it locally.")
          }
        />
      ) : info.previewKind === "audio" ? (
        <audio
          controls
          preload="metadata"
          src={url}
          onError={() =>
            setError("This browser cannot play this audio. Download it to open it locally.")
          }
        />
      ) : (
        <div className="files-empty">
          <File size={30} />
          <p>No preview for this file type. Download it to open it on your computer.</p>
        </div>
      )}
      <a
        className="files-button files-download"
        href={api.fileUrl(device.id, rootId, path, file.revision, true)}
        target="_blank"
        rel="noreferrer"
      >
        <Download size={16} /> Download file
      </a>
    </aside>
  );
}
