import { useCallback, useEffect, useRef, useState } from "react";

/** Kept in one place so the picker, a drop, and a paste all accept the same things. */
export const ATTACHMENT_ACCEPT = "image/*,video/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.zip";

type Options = {
  onFiles: (files: File[]) => void | Promise<void>;
  disabled?: boolean;
  /** Also catch a paste made with nothing focused. Only one surface should own this. */
  pasteWhenUnfocused?: boolean;
};

/**
 * Drag-and-drop and clipboard paste for the attachment surfaces.
 *
 * Pasting a screenshot was the case that did not work at all: macOS puts it on the clipboard as a
 * file with no useful name, and without preventDefault the browser drops the image into the text
 * box as nothing at all. Both paths end at the same `onFiles` the file picker already uses, so an
 * attachment behaves identically however it arrived.
 */
export function useAttachmentDrop({ onFiles, disabled = false, pasteWhenUnfocused = false }: Options) {
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave fire for every child element crossed, so a boolean flickers. Counting
  // enters and leaves keeps the highlight steady while the pointer moves across the panel.
  const depth = useRef(0);

  const deliver = useCallback(
    (files: File[]) => {
      if (disabled || !files.length) return;
      void onFiles(files);
    },
    [disabled, onFiles],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent | React.ClipboardEvent) => {
      if (disabled) return;
      const clipboard = "clipboardData" in event ? event.clipboardData : null;
      const files = filesFromClipboard(clipboard);
      if (!files.length) return;
      // Only claim the paste when it actually carries files; pasting text must still work.
      event.preventDefault();
      deliver(files);
    },
    [deliver, disabled],
  );

  useEffect(() => {
    if (!pasteWhenUnfocused || disabled) return;
    const onWindowPaste = (event: ClipboardEvent) => {
      // A paste aimed at a focused field belongs to that field's own handler.
      const active = document.activeElement;
      if (active && active !== document.body) return;
      handlePaste(event);
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [disabled, handlePaste, pasteWhenUnfocused]);

  const dropProps = {
    onDragEnter: (event: React.DragEvent) => {
      if (disabled || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth.current += 1;
      setIsDragging(true);
    },
    onDragOver: (event: React.DragEvent) => {
      if (disabled || !hasFiles(event.dataTransfer)) return;
      // Without this the browser navigates to the dropped file instead of handing it over.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: () => {
      if (disabled) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsDragging(false);
    },
    onDrop: (event: React.DragEvent) => {
      if (disabled) return;
      event.preventDefault();
      depth.current = 0;
      setIsDragging(false);
      deliver(namedFiles(Array.from(event.dataTransfer?.files ?? [])));
    },
  };

  return { isDragging, dropProps, pasteProps: { onPaste: handlePaste } };
}

function hasFiles(transfer: DataTransfer | null) {
  if (!transfer) return false;
  return Array.from(transfer.types ?? []).includes("Files");
}

function filesFromClipboard(clipboard: DataTransfer | null) {
  if (!clipboard) return [];
  const direct = Array.from(clipboard.files ?? []);
  if (direct.length) return namedFiles(direct);
  // Screenshots often arrive only as items rather than in `files`.
  const fromItems = Array.from(clipboard.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  return namedFiles(fromItems);
}

/**
 * Give a pasted file a name worth reading.
 *
 * The clipboard hands over "image.png", or nothing at all, for every screenshot. Uploading three
 * of those leaves three identical rows that no one can tell apart, so each gets a timestamp.
 */
function namedFiles(files: File[]) {
  return files.map((file, index) => {
    if (file.name && file.name !== "image.png") return file;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const extension = file.type.split("/")[1]?.split("+")[0] || "png";
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return new File([file], `pasted-${stamp}${suffix}.${extension}`, {
      type: file.type || "image/png",
    });
  });
}
