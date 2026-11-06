export type FileDevice = {
  id: string;
  name: string;
  platform: string;
  connected: boolean;
  available: boolean;
  local: boolean;
};
// `writable` marks the Orion server's Dropped files, the one folder that accepts new files.
export type FileRoot = { id: string; label: string; writable?: boolean };
export type DeviceFile = {
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
  revision: string;
};
export type FileListing = {
  ok: true;
  rootId: string;
  path: string;
  entries: DeviceFile[];
  nextOffset: number | null;
  scanTruncated: boolean;
};
export type FileInfo = DeviceFile & {
  previewKind: "text" | "image" | "pdf" | "video" | "audio" | "unsupported";
  mimeType: string;
};

export function fileQuery(root: string, path: string, revision?: string) {
  return new URLSearchParams({ root, path, ...(revision ? { revision } : {}) }).toString();
}
