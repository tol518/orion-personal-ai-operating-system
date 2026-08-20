import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ImagePlus,
  LoaderCircle,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import {
  api,
  type AgentModels,
  type GeneratedAgentAppearance,
  type StoredAttachment,
} from "../lib/api";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
};

const MAX_REFERENCE_FILES = 1;

export default function CreateAgentDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [appearanceDescription, setAppearanceDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [referenceAttachments, setReferenceAttachments] = useState<StoredAttachment[]>([]);
  const [generated, setGenerated] = useState<GeneratedAgentAppearance | null>(null);
  const [modelChoices, setModelChoices] = useState<AgentModels | null>(null);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = generating || creating;

  useEffect(() => {
    const next = files.map((file) => URL.createObjectURL(file));
    setPreviews(next);
    return () => next.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  useEffect(() => {
    if (!open || modelChoices) return;
    api.agentModels("main")
      .then(setModelChoices)
      .catch(() => setModelChoices({ agentId: "main", current: null, models: [] }));
  }, [modelChoices, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose, open]);

  if (!open) return null;

  function chooseFiles(nextFiles: File[]) {
    const images = nextFiles.filter((file) => file.type.startsWith("image/")).slice(0, MAX_REFERENCE_FILES);
    setFiles(images);
    setReferenceAttachments([]);
    setGenerated(null);
    setError(
      nextFiles.length > MAX_REFERENCE_FILES
        ? "Upload one sprite sheet at a time."
        : images.length === nextFiles.length
          ? null
          : "Only an image sprite sheet can be used.",
    );
  }

  function onFileInput(event: ChangeEvent<HTMLInputElement>) {
    chooseFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!busy) chooseFiles(Array.from(event.dataTransfer.files));
  }

  async function generateAppearance() {
    if (busy) return;
    if (!name.trim() || !role.trim() || files.length !== 1) {
      setError("Add a name, role, and one sprite sheet.");
      return;
    }

    setGenerating(true);
    setGenerated(null);
    setError(null);
    try {
      const uploaded = referenceAttachments.length
        ? referenceAttachments
        : (await api.uploadAttachments(files)).attachments;
      setReferenceAttachments(uploaded);
      const result = await api.generateAgentAppearance({
        name: name.trim(),
        role: role.trim(),
        description: appearanceDescription.trim(),
        referenceAttachmentIds: uploaded.map(({ id }) => id),
      });
      setGenerated(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not generate the agent appearance");
    } finally {
      setGenerating(false);
    }
  }

  async function createAgent(event: FormEvent) {
    event.preventDefault();
    if (!generated || busy) return;
    if (!name.trim() || !role.trim() || !instructions.trim()) {
      setError("Name, role, and operating instructions are required.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await api.createAgent({
        name: name.trim(),
        role: role.trim(),
        instructions: instructions.trim(),
        ...(model ? { model } : {}),
        appearanceAttachmentId: generated.attachment.id,
        appearancePrompt: appearanceDescription.trim(),
        referenceAttachmentIds: referenceAttachments.map(({ id }) => id),
      });
      await onCreated();
      setName("");
      setRole("");
      setInstructions("");
      setModel("");
      setAppearanceDescription("");
      setFiles([]);
      setReferenceAttachments([]);
      setGenerated(null);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the agent");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="create-agent-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <form
        className="create-agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        aria-busy={busy}
        onSubmit={createAgent}
      >
        <header className="create-agent-dialog__header">
          <div className="create-agent-dialog__emblem" aria-hidden="true"><Bot size={24} /></div>
          <div>
            <span>ORION AGENT FORGE</span>
            <h2 id="create-agent-title">Create a new agent</h2>
            <p>Configure its purpose, teach Second Brain, and animate your sprite sheet.</p>
          </div>
          <button type="button" aria-label="Close create agent" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="create-agent-dialog__steps" aria-hidden="true">
          <span className={name && role ? "is-complete" : "is-active"}><i>01</i> Identity</span>
          <span className={instructions ? "is-complete" : ""}><i>02</i> Instructions</span>
          <span className={generated ? "is-complete" : ""}><i>03</i> Appearance</span>
        </div>

        <div className="create-agent-dialog__body">
          <div className="create-agent-dialog__fields">
            <section>
              <div className="create-agent-section-title">
                <Bot size={15} />
                <div><strong>Agent identity</strong><span>How ORION and the team will know this specialist.</span></div>
              </div>
              <div className="create-agent-field-grid">
                <label>
                  <span>Agent name</span>
                  <input
                    value={name}
                    maxLength={64}
                    placeholder="e.g. Vega Navigator"
                    required
                    onChange={(event) => {
                      setName(event.target.value);
                      setGenerated(null);
                    }}
                  />
                </label>
                <label>
                  <span>Role</span>
                  <input
                    value={role}
                    maxLength={100}
                    placeholder="e.g. Research specialist"
                    required
                    onChange={(event) => {
                      setRole(event.target.value);
                      setGenerated(null);
                    }}
                  />
                </label>
              </div>
              <label>
                <span>Default model</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="">Use OpenClaw default</option>
                  {modelChoices?.models.map((choice) => (
                    <option key={choice.id} value={choice.id}>{choice.label}</option>
                  ))}
                </select>
              </label>
            </section>

            <section>
              <div className="create-agent-section-title">
                <BrainCircuit size={15} />
                <div><strong>Operating instructions</strong><span>Saved to the agent workspace and Second Brain.</span></div>
              </div>
              <label>
                <span>Instructions</span>
                <textarea
                  value={instructions}
                  maxLength={20_000}
                  rows={7}
                  placeholder="Describe responsibilities, boundaries, working style, and what success looks like…"
                  required
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </label>
              <div className="create-agent-memory-note">
                <BrainCircuit size={14} />
                <span><strong>Second Brain sync</strong> Agent identity, role, instructions, and appearance references become an agent-instruction memory.</span>
              </div>
            </section>
          </div>

          <section className="create-agent-appearance">
            <div className="create-agent-section-title">
              <Sparkles size={15} />
              <div><strong>GPT-5.4 animation setup</strong><span>Uses your existing ChatGPT OAuth through OpenClaw.</span></div>
            </div>

            <label
              className={`create-agent-dropzone ${files.length ? "has-files" : ""}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
            >
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onFileInput} />
              <UploadCloud size={24} />
              <strong>{files.length ? "Sprite sheet ready" : "Upload your sprite sheet"}</strong>
              <span>Drop one PNG, JPG, or WebP sheet · background removed automatically</span>
            </label>

            {previews.length ? (
              <div className="create-agent-reference-strip">
                {previews.map((url, index) => (
                  <img key={url} src={url} alt={`Uploaded sprite sheet ${index + 1}`} />
                ))}
              </div>
            ) : null}

            <label>
              <span>Animation notes <small>optional</small></span>
              <textarea
                value={appearanceDescription}
                rows={4}
                maxLength={800}
                placeholder="Tell GPT-5.4 which frames represent special actions, if needed…"
                onChange={(event) => {
                  setAppearanceDescription(event.target.value);
                  setGenerated(null);
                }}
              />
            </label>

            <button
              className="create-agent-generate"
              type="button"
              disabled={busy || !files.length}
              onClick={generateAppearance}
            >
              {generating ? <LoaderCircle className="is-spinning" size={16} /> : <ImagePlus size={16} />}
              {generating ? "GPT-5.4 is mapping frames…" : generated ? "Re-analyze sprite sheet" : "Animate sprite with GPT-5.4"}
            </button>

            <div className={`create-agent-preview ${generated ? "is-ready" : ""}`}>
              {generated ? (
                <>
                  <img src={generated.attachment.url} alt={`${name || "Agent"} uploaded sprite sheet`} />
                  <div>
                    <span><CheckCircle2 size={13} /> ANIMATION READY</span>
                    <strong>{generated.model}</strong>
                    <small>ChatGPT OAuth · transparent · {generated.animationSpec.columns} × {generated.animationSpec.rows} frame grid</small>
                  </div>
                </>
              ) : (
                <><Sparkles size={22} /><span>Your animated sprite preview</span></>
              )}
            </div>
          </section>
        </div>

        {error ? <p className="create-agent-error" role="alert">{error}</p> : null}

        <footer className="create-agent-dialog__footer">
          <span><i /> Creates one OpenClaw agent + one Second Brain instruction memory</span>
          <div>
            <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="create-agent-submit" type="submit" disabled={busy || !generated}>
              {creating ? <LoaderCircle className="is-spinning" size={16} /> : <Sparkles size={16} />}
              {creating ? "Creating agent…" : "Create agent"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
