// What one drop onto Orion will send: chosen files, and every file and folder inside chosen
// folders. Paths are relative to Dropped files and start with the chosen item's own name.
export type DropPlan = {
  folders: string[];
  files: { file: File; path: string }[];
  /** Hidden files and folders, which stay on this computer. */
  skipped: number;
};

export const DROP_FILE_LIMIT = 5000;
const hidden = (name: string) => name.startsWith(".");
const emptyPlan = (): DropPlan => ({ folders: [], files: [], skipped: 0 });

function addFile(plan: DropPlan, file: File, path: string) {
  plan.files.push({ file, path });
  if (plan.files.length > DROP_FILE_LIMIT)
    throw new Error(`That is more than ${DROP_FILE_LIMIT} files. Choose a smaller folder, or send it in parts.`);
}

/** Two chosen items with one name (two "Photos" folders) stay apart. */
function uniqueTop(plan: DropPlan, name: string) {
  const taken = (candidate: string) =>
    plan.folders.includes(candidate) || plan.files.some((entry) => entry.path === candidate);
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let copy = 2; ; copy += 1) {
    const candidate = `${stem} (${copy})${extension}`;
    if (!taken(candidate)) return candidate;
  }
}

function readEntries(directory: FileSystemDirectoryEntry) {
  const reader = directory.createReader();
  // readEntries answers in batches until it returns an empty one.
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const entries: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(entries);
        entries.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function addEntry(plan: DropPlan, entry: FileSystemEntry, path: string) {
  if (hidden(entry.name)) {
    plan.skipped += 1;
  } else if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    addFile(plan, file, path);
  } else if (entry.isDirectory) {
    plan.folders.push(path);
    for (const child of await readEntries(entry as FileSystemDirectoryEntry))
      await addEntry(plan, child, `${path}/${child.name}`);
  } else {
    plan.skipped += 1;
  }
}

/**
 * Takes what a drop carries. The browser lets go of a drop's items once the event handler
 * returns, so this must be called inside it; the folder walk itself can happen afterwards.
 */
export function dropSource(transfer: DataTransfer): () => Promise<DropPlan> {
  const items = [...transfer.items].filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  const files = [...transfer.files];
  return async () => {
    const plan = emptyPlan();
    if (entries.length && entries.every(Boolean)) {
      for (const entry of entries as FileSystemEntry[]) {
        if (hidden(entry.name)) plan.skipped += 1;
        else await addEntry(plan, entry, uniqueTop(plan, entry.name));
      }
    } else {
      for (const file of files) {
        if (hidden(file.name)) plan.skipped += 1;
        else addFile(plan, file, uniqueTop(plan, file.name));
      }
    }
    return plan;
  };
}

/** Files from a picker. A folder picker gives each file its path inside the chosen folder. */
export function pickedPlan(files: File[]): DropPlan {
  const plan = emptyPlan();
  const folders = new Set<string>();
  for (const file of files) {
    const segments = (file.webkitRelativePath || file.name).split("/");
    if (segments.some(hidden)) {
      plan.skipped += 1;
      continue;
    }
    for (let depth = 1; depth < segments.length; depth += 1) folders.add(segments.slice(0, depth).join("/"));
    addFile(plan, file, segments.length > 1 ? segments.join("/") : uniqueTop(plan, file.name));
  }
  plan.folders = [...folders];
  return plan;
}
