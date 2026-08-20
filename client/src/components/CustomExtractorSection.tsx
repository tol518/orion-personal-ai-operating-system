import { useRef, useState, type DragEvent } from "react";
import { FolderCode, FolderUp, Loader2, Play, Plus, TriangleAlert, X } from "lucide-react";
import type { CustomExtractor, CustomExtractorUpload } from "../lib/api";

type PendingFile = { file: File; path: string };
function readEntry(entry: FileSystemEntry, prefix = ""): Promise<PendingFile[]> {
  const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    return new Promise((resolve, reject) =>
      fileEntry.file((file) => resolve([{ file, path: entryPath }]), reject),
    );
  }
  if (!entry.isDirectory) return Promise.resolve([]);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  return new Promise((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          Promise.all(entries.map((child) => readEntry(child, entryPath)))
            .then((groups) => resolve(groups.flat()))
            .catch(reject);
          return;
        }
        entries.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function uploads(files: PendingFile[]): Promise<CustomExtractorUpload[]> {
  return await Promise.all(
    files.map(async ({ file, path }) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32_768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
      }
      return { path, contentBase64: btoa(binary) };
    }),
  );
}

function selectedFiles(list: FileList): PendingFile[] {
  return Array.from(list)
    .filter((file) => file.name !== ".DS_Store")
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

export default function CustomExtractorSection({
  extractors,
  busy,
  onCreate,
  onUse,
}: {
  extractors: CustomExtractor[];
  busy: boolean;
  onCreate: (input: { name: string; description: string; files: CustomExtractorUpload[] }) => Promise<void>;
  onUse: (extractor: CustomExtractor) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setFolderInput = (node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.setAttribute("webkitdirectory", "");
    node?.setAttribute("directory", "");
  };

  const addDropped = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    setError(null);
    try {
      const entries = Array.from(event.dataTransfer.items)
        .map((item) => item.webkitGetAsEntry())
        .filter((entry): entry is FileSystemEntry => Boolean(entry));
      const dropped = entries.length
        ? (await Promise.all(entries.map((entry) => readEntry(entry)))).flat()
        : selectedFiles(event.dataTransfer.files);
      setFiles(dropped.filter(({ file }) => file.name !== ".DS_Store"));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  const submit = async () => {
    setError(null);
    try {
      await onCreate({ name, description, files: await uploads(files) });
      setCreating(false);
      setName("");
      setDescription("");
      setFiles([]);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };

  return (
    <section className="mb-3 border-b border-hudborder pb-3" aria-labelledby="custom-extractors-title">
      <div className="mb-2 flex items-center gap-2">
        <FolderCode size={13} className="text-fuchsia-300" />
        <h3 id="custom-extractors-title" className="hud-label text-[0.6rem]">
          Custom extractors
        </h3>
        <button
          type="button"
          onClick={() => setCreating((current) => !current)}
          className="ml-auto grid size-7 place-items-center rounded border border-hudborder text-gray-400 hover:border-accent/50 hover:text-accent"
          aria-label={creating ? "Close custom extractor form" : "Create custom extractor"}
          title={creating ? "Close custom extractor form" : "Create custom extractor"}
        >
          {creating ? <X size={14} /> : <Plus size={14} />}
        </button>
      </div>

      {creating && (
        <div className="mb-2 space-y-2 rounded-lg border border-accent/30 bg-surface-2 p-2.5">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Extractor name"
            aria-label="Custom extractor name"
            className="w-full rounded border border-hudborder bg-surface-1 px-2 py-1.5 font-mono text-xs text-gray-200 outline-none focus:border-accent/60"
          />
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe the extraction and expected output"
            aria-label="Custom extractor description"
            rows={3}
            className="w-full resize-y rounded border border-hudborder bg-surface-1 px-2 py-1.5 font-mono text-xs text-gray-200 outline-none focus:border-accent/60"
          />
          <div
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={addDropped}
            className={`flex min-h-20 items-center justify-center rounded-lg border border-dashed px-3 py-2 text-center transition-colors ${
              dragging ? "border-accent bg-accent/10" : "border-hudborder bg-surface-1"
            }`}
          >
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex flex-col items-center gap-1 font-mono text-[0.62rem] text-gray-400 hover:text-accent-hover"
            >
              <FolderUp size={18} />
              <span>{files.length ? `${files.length} files selected` : "Drop folder or choose folder"}</span>
            </button>
            <input
              ref={setFolderInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => event.currentTarget.files && setFiles(selectedFiles(event.currentTarget.files))}
            />
          </div>
          {error && <p className="font-mono text-[0.6rem] text-red-300">{error}</p>}
          <button
            type="button"
            onClick={submit}
            disabled={busy || !name.trim() || (!description.trim() && files.length === 0)}
            className="flex w-full items-center justify-center gap-1.5 rounded border border-accent/50 bg-accent/10 px-3 py-1.5 font-mono text-[0.65rem] text-accent-hover hover:bg-accent/20 disabled:opacity-40"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <FolderCode size={12} />}
            {busy ? "Sending to WALL-E…" : "Build with WALL-E"}
          </button>
        </div>
      )}

      <div className="space-y-1.5">
        {extractors.map((extractor) => (
          <div key={extractor.id} className="rounded-lg border border-hudborder bg-surface-2 px-2.5 py-2">
            <div className="flex items-start gap-2">
              {extractor.status === "building" ? (
                <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent" />
              ) : extractor.status === "failed" ? (
                <TriangleAlert size={13} className="mt-0.5 shrink-0 text-red-300" />
              ) : (
                <FolderCode size={13} className="mt-0.5 shrink-0 text-fuchsia-300" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[0.68rem] text-gray-200">{extractor.name}</span>
                  <span className="ml-auto shrink-0 font-mono text-[0.52rem] text-gray-500">
                    {extractor.status}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 font-mono text-[0.56rem] text-gray-500">
                  {extractor.buildDetail || extractor.description}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-2 font-mono text-[0.54rem] text-gray-600">
                  <span>{extractor.sites.join(" + ")}</span>
                  <span className="text-sky-300">WALL-E → Black Noir</span>
                  {extractor.fileCount > 0 && <span>{extractor.fileCount} files</span>}
                </div>
              </div>
            </div>
            {extractor.status === "ready" && (
              <button
                type="button"
                onClick={() => onUse(extractor)}
                className="mt-1.5 flex items-center gap-1 rounded border border-hudborder px-1.5 py-0.5 font-mono text-[0.55rem] text-emerald-300 hover:bg-surface-3"
              >
                <Play size={10} /> Use extractor
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
