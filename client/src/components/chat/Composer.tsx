import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, X } from "lucide-react";
import {
  ATTACHMENT_ACCEPT,
  useAttachmentDrop,
} from "../../hooks/useAttachmentDrop";
import { api, type StoredAttachment } from "../../lib/api";
import { composerKey } from "../../lib/chat/workspace";

function FileChip({ file, remove }: { file: File; remove: () => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const image = file.type.startsWith("image/");
  return (
    <span className="flex max-w-full items-center gap-1 rounded border border-hudborder p-1 text-xs">
      <button
        type="button"
        className="flex min-w-0 items-center gap-1"
        onClick={() => setPreview(true)}
      >
        {image && <img alt="" className="h-7 w-7 object-cover" src={url} />}
        <span className="truncate">{file.name}</span>
      </button>
      <button type="button" aria-label={"Remove " + file.name} onClick={remove}>
        <X size={13} />
      </button>
      {preview && (
        <dialog
          open
          aria-label={file.name}
          className="fixed inset-0 z-50 m-auto max-w-[85vw] rounded bg-surface-2 p-4 text-white"
        >
          <button autoFocus onClick={() => setPreview(false)}>
            Close preview
          </button>
          {image ? (
            <img src={url} alt={file.name} className="max-h-[72vh]" />
          ) : file.type.startsWith("video/") ? (
            <video controls src={url} className="max-h-[72vh]" />
          ) : file.type.startsWith("audio/") ? (
            <audio controls src={url} />
          ) : (
            <a download={file.name} href={url}>
              {file.name}
            </a>
          )}
        </dialog>
      )}
    </span>
  );
}

type SendMessage = (text: string, files: StoredAttachment[]) => Promise<void>;

export function useComposer(disabled: boolean, send: SendMessage) {
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  const uploads = useRef(new WeakMap<File, StoredAttachment>());
  function add(incoming: File[]) {
    if (files.length + incoming.length > 8) {
      setError("Attach up to eight files per message.");
      return;
    }
    setError("");
    setFiles((prev) => [...prev, ...incoming]);
  }
  const { dropProps, pasteProps, isDragging } = useAttachmentDrop({
    onFiles: add,
    disabled: disabled || sending,
    pasteWhenUnfocused: true,
  });
  async function submit() {
    if (disabled || sending || (!input.trim() && !files.length)) return;
    setSending(true);
    setError("");
    try {
      const stored = [];
      for (const file of files) {
        let attachment = uploads.current.get(file);
        if (!attachment) {
          [attachment] = (await api.uploadAttachments([file])).attachments;
          uploads.current.set(file, attachment);
        }
        stored.push(attachment);
      }
      await send(input.trim(), stored);
      setInput("");
      setFiles([]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send message",
      );
    } finally {
      setSending(false);
    }
  }
  return {
    dropProps,
    pasteProps,
    isDragging,
    fields: {
      input,
      setInput,
      files,
      setFiles,
      sending,
      error,
      picker,
      add,
      submit,
      disabled,
    },
  };
}

export function Composer({
  fields,
  busy,
  stopping,
  stop,
}: {
  fields: ReturnType<typeof useComposer>["fields"];
  busy: boolean;
  stopping: boolean;
  stop: () => void;
}) {
  const {
    input,
    setInput,
    files,
    setFiles,
    sending,
    error,
    picker,
    add,
    submit,
    disabled,
  } = fields;
  return (
    <div className="mt-2 rounded-lg">
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {files.map((file, i) => (
          <FileChip
            key={i}
            file={file}
            remove={() => {
              if (!sending) setFiles(files.filter((_, j) => j !== i));
            }}
          />
        ))}
      </div>
      <div className="flex items-end gap-2">
        <input
          ref={picker}
          hidden
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={(e) => {
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          className="btn-hud p-2"
          aria-label="Attach files"
          disabled={disabled || sending}
          onClick={() => picker.current?.click()}
        >
          <Paperclip size={16} />
        </button>
        <textarea
          rows={1}
          aria-label="Message"
          value={input}
          disabled={disabled || sending}
          onChange={(e) => setInput(e.target.value)}
          className="min-h-9 max-h-60 min-w-0 flex-1 resize-y rounded-lg border border-hudborder bg-surface-2 px-3 py-2 text-sm [field-sizing:content]"
          placeholder={
            busy ? "Add a message to the current reply…" : "Message the agent…"
          }
          onKeyDown={(e) => {
            const action = composerKey(
              e.key,
              e.shiftKey,
              e.nativeEvent.isComposing || e.keyCode === 229,
            );
            if (action === "send") {
              e.preventDefault();
              void submit();
            }
            if (action === "stop" && busy) {
              e.preventDefault();
              stop();
            }
          }}
        />
        {busy && (
          <button
            className="btn-hud p-2 text-xs"
            disabled={stopping}
            onClick={stop}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        )}
        <button
          aria-label="Send message"
          className="btn-hud p-2"
          disabled={disabled || sending || (!input.trim() && !files.length)}
          onClick={submit}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
