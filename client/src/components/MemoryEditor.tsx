import { useEffect, useMemo, useState } from "react";
import { Check, Link2, LoaderCircle, Paperclip, Save, Upload, X } from "lucide-react";
import { ATTACHMENT_ACCEPT, useAttachmentDrop } from "../hooks/useAttachmentDrop";
import { api, type StoredAttachment } from "../lib/api";
import type { Memory, MemoryType } from "../lib/memory-types";

export default function MemoryEditor({
  memory,
  creating,
  allMemories,
  onSaved,
  onCancel,
}: {
  memory: Memory | null;
  creating: boolean;
  allMemories: Memory[];
  onSaved: (memory: Memory) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [memoryType, setMemoryType] = useState<MemoryType>("general");
  const [links, setLinks] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<StoredAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [baseRevision, setBaseRevision] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  function loadMemory(nextMemory: Memory | null) {
    setTitle(nextMemory?.title ?? "");
    setBody(nextMemory?.body ?? "");
    setTags(nextMemory?.tags.join(", ") ?? "");
    setMemoryType(nextMemory?.memoryType ?? "general");
    setLinks(nextMemory?.manualLinks ?? nextMemory?.links ?? []);
    setAttachments(nextMemory?.attachments ?? []);
    setBaseRevision(nextMemory?.revision ?? "");
    setMessage(null);
  }

  useEffect(() => {
    loadMemory(memory);
  }, [creating, memory?.id]);

  const externalChanged = Boolean(memory && baseRevision && memory.revision !== baseRevision);

  const dirty = useMemo(() => {
    if (creating) return Boolean(title.trim() || body.trim() || tags.trim() || links.length || attachments.length || memoryType !== "general");
    if (!memory) return false;
    return (
      title !== memory.title ||
      body !== memory.body ||
      tags !== memory.tags.join(", ") ||
      links.join("|") !== (memory.manualLinks ?? memory.links).join("|")
      || attachments.map(({ id }) => id).join("|") !== (memory.attachments ?? []).map(({ id }) => id).join("|")
    );
  }, [attachments, body, creating, links, memory, memoryType, tags, title]);

  async function save() {
    if (!title.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    const payload = {
      title: title.trim(),
      body: body.trim(),
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      memoryType,
      ...(creating && memoryType !== "general"
        ? { managedKey: title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }
        : {}),
      links,
      attachmentIds: attachments.map(({ id }) => id),
      ...(memory ? { revision: baseRevision } : {}),
    };
    try {
      const response = memory
        ? await api.updateMemory(memory.id, payload)
        : await api.createMemory(payload);
      setMessage({ kind: "success", text: "Saved to Obsidian" });
      setBaseRevision(response.memory.revision);
      onSaved(response.memory);
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Unable to save memory",
      });
    } finally {
      setSaving(false);
    }
  }

  async function addFiles(files: FileList | File[] | null) {
    if (!files?.length || uploading) return;
    setUploading(true);
    setMessage(null);
    try {
      const response = await api.uploadAttachments(Array.from(files));
      setAttachments((current) => [...current, ...response.attachments].slice(0, 5));
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Unable to upload files" });
    } finally {
      setUploading(false);
    }
  }

  function toggleLink(id: string) {
    setLinks((current) =>
      current.includes(id) ? current.filter((link) => link !== id) : [...current, id],
    );
  }

  const { isDragging, dropProps, pasteProps } = useAttachmentDrop({
    onFiles: addFiles,
    disabled: (!memory && !creating) || uploading || attachments.length >= 5,
  });

  if (!memory && !creating) {
    return (
      <aside className="memory-editor memory-editor--empty">
        <div className="memory-empty-inspector">
          <Link2 size={28} />
          <strong>Select a memory</strong>
          <span>Open a node or list item to inspect and edit it.</span>
        </div>
      </aside>
    );
  }

  const connectable = allMemories.filter((item) => item.id !== memory?.id);
  const neuralConnections = memory?.connections.filter((connection) => connection.creationSource !== "manual" && !connection.archived) ?? [];

  return (
    <aside
      {...dropProps}
      {...pasteProps}
      className={`memory-editor${isDragging ? " attachment-dropzone" : ""}`}
      aria-label={creating ? "Create memory" : "Edit memory"}
    >
      <div className="memory-panel-heading">
        <div>
          <div className="hud-label">{creating ? "NEW WIKI PAGE" : "WIKI PAGE"}</div>
          <div className="memory-panel-subtitle">
            {externalChanged ? "Changed externally" : dirty ? "Unsaved changes" : "Up to date with vault"}
          </div>
        </div>
        {creating ? (
          <button className="memory-icon-button" onClick={onCancel} aria-label="Cancel new memory">
            <X size={16} />
          </button>
        ) : null}
      </div>

      <label className="memory-field">
        <span>Category</span>
        <select
          value={memoryType}
          onChange={(event) => setMemoryType(event.target.value as MemoryType)}
          disabled={!creating}
        >
          <option value="general">General memory</option>
          <option value="agent_instruction">Agent Instructions</option>
          <option value="project">Projects</option>
          <option value="shared_lesson">Shared Lessons</option>
        </select>
      </label>

      <label className="memory-field">
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
      </label>

      <label className="memory-field memory-field--body">
        <span>Body <small>Markdown</small></span>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} />
      </label>

      <div className="memory-field memory-attachments">
        <span>Files <small>{attachments.length}/5</small></span>
        <label className="btn-hud memory-attachment-upload">
          {uploading ? <LoaderCircle className="animate-spin" size={14} /> : <Upload size={14} />}
          {uploading ? "Uploading" : "Add files"}
          <input className="sr-only" type="file" multiple accept={ATTACHMENT_ACCEPT} disabled={uploading || attachments.length >= 5} onChange={(event) => { void addFiles(event.target.files); event.currentTarget.value = ""; }} />
        </label>
        {attachments.length ? (
          <div className="memory-attachment-list">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="memory-attachment-row">
                <a href={attachment.url} target="_blank" rel="noreferrer"><Paperclip size={12} /><span>{attachment.fileName}</span></a>
                <button type="button" aria-label={`Remove ${attachment.fileName}`} onClick={() => setAttachments((current) => current.filter(({ id }) => id !== attachment.id))}><X size={13} /></button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <label className="memory-field">
        <span>Tags <small>comma separated</small></span>
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder="person, preference, decision"
        />
      </label>

      <div className="memory-connections">
        <div className="memory-field-label">
          Manual connections <span>{links.length}</span>
        </div>
        {connectable.length ? (
          <div className="memory-connection-list">
            {connectable.map((candidate) => {
              const checked = links.includes(candidate.id);
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className={checked ? "memory-connection memory-connection--checked" : "memory-connection"}
                  onClick={() => toggleLink(candidate.id)}
                >
                  <span className="memory-connection__check">{checked ? <Check size={13} /> : null}</span>
                  <span>{candidate.title}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="memory-connection-empty">No other memories to connect yet.</div>
        )}
      </div>

      {neuralConnections.length ? (
        <div className="memory-connections memory-neural-connections">
          <div className="memory-field-label">
            Neural connections <span>{neuralConnections.length}</span>
          </div>
          <div className="memory-connection-list">
            {neuralConnections.map((connection) => {
              const target = allMemories.find((item) => item.id === connection.target);
              return (
                <div className="memory-connection memory-connection--neural" key={`${connection.target}:${connection.relationType}`}>
                  <span>{target?.title ?? connection.target}</span>
                  <small>{connection.relationType.replaceAll("_", " ")} · {Math.round(connection.weight * 100)}%</small>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {memory ? (
        <dl className="memory-provenance">
          <div><dt>Provenance</dt><dd>{memory.source === "user" ? "User created" : memory.memoryType === "shared_lesson" ? "Learned by shared brain" : "Agent created"}</dd></div>
          <div><dt>Created</dt><dd>{formatDate(memory.createdAt)}</dd></div>
          <div><dt>Updated</dt><dd>{formatDate(memory.updatedAt)}</dd></div>
          <div><dt>Memory state</dt><dd>{memory.memoryState === "superseded" ? "Superseded" : "Active"}</dd></div>
          <div><dt>Vault path</dt><dd title={memory.path}>{memory.path}</dd></div>
        </dl>
      ) : null}

      <div className="memory-save-area">
        {externalChanged ? (
          <div className="memory-external-change">
            <span>This page changed in Obsidian while it was open.</span>
            <button onClick={() => loadMemory(memory)}>Reload vault version</button>
          </div>
        ) : null}
        {message ? <div className={`memory-save-message memory-save-message--${message.kind}`}>{message.text}</div> : null}
        <button className="btn-hud memory-save-button" onClick={save} disabled={!title.trim() || saving || externalChanged || (!dirty && !creating)}>
          <Save size={16} />
          {saving ? "Saving…" : creating ? "Create memory" : "Save changes"}
        </button>
        <p>Manual and agent saves write directly to Markdown. Agents add only durable, relevant memories—not every conversation.</p>
      </div>
    </aside>
  );
}

function formatDate(value: string) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
