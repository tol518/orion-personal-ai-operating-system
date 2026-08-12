import { type FormEvent, useEffect, useRef, useState } from "react";
import { BrainCircuit, KeyRound, LockKeyhole } from "lucide-react";
import { api } from "../lib/api";

export default function MemoryAccessDialog({ open, onClose, onUnlocked }: {
  open: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setError(null);
      setSubmitting(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, submitting]);

  if (!open) return null;

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.unlockMemory(password);
      setPassword("");
      onUnlocked();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access denied");
      inputRef.current?.select();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="hunting-access-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section className="hunting-access-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-access-title" aria-describedby="memory-access-description">
        <div className="hunting-access-dialog__icon" aria-hidden="true"><BrainCircuit size={22} /></div>
        <div className="hunting-access-dialog__heading">
          <span>PRIVATE SECOND BRAIN</span>
          <h2 id="memory-access-title">Identity check required</h2>
          <p id="memory-access-description">Enter the private access password to reveal this section for the current browser session.</p>
        </div>
        <form onSubmit={unlock}>
          <label htmlFor="memory-access-password"><LockKeyhole size={14} /> Access password</label>
          <div className="hunting-access-dialog__field">
            <KeyRound size={16} aria-hidden="true" />
            <input ref={inputRef} id="memory-access-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "memory-access-error" : undefined} disabled={submitting} placeholder="Enter password" />
          </div>
          {error ? <p id="memory-access-error" className="hunting-access-dialog__error" role="alert">{error}</p> : null}
          <div className="hunting-access-dialog__actions">
            <button type="button" className="btn-hud" onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="hunting-access-dialog__unlock" disabled={!password || submitting}>{submitting ? "Verifying..." : "Unlock Second Brain"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}
