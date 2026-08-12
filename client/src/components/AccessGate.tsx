import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { KeyRound, LockKeyhole } from "lucide-react";
import { api } from "../lib/api";

export default function AccessGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    api.authStatus()
      .then((result) => setAuthenticated(result.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    if (authenticated === false) inputRef.current?.focus();
  }, [authenticated]);

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.login(password);
      setAuthenticated(result.authenticated);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access denied");
      inputRef.current?.select();
    } finally {
      setSubmitting(false);
    }
  }

  if (authenticated === true) return children;

  return (
    <main className="hunting-access-backdrop">
      <section
        className="hunting-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="jarvis-access-title"
        aria-describedby="jarvis-access-description"
      >
        <div className="hunting-access-dialog__icon" aria-hidden="true">
          <LockKeyhole size={22} />
        </div>
        <div className="hunting-access-dialog__heading">
          <span>PRIVATE CONTROL SURFACE</span>
          <h2 id="jarvis-access-title">Authentication required</h2>
          <p id="jarvis-access-description">
            Enter the dashboard password configured on this server.
          </p>
        </div>

        {authenticated === null ? (
          <p className="hunting-access-dialog__status">Checking session...</p>
        ) : (
          <form onSubmit={login}>
            <label htmlFor="jarvis-access-password">
              <LockKeyhole size={14} /> Dashboard password
            </label>
            <div className="hunting-access-dialog__field">
              <KeyRound size={16} aria-hidden="true" />
              <input
                ref={inputRef}
                id="jarvis-access-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "jarvis-access-error" : undefined}
                disabled={submitting}
                placeholder="Enter password"
              />
            </div>
            {error ? (
              <p id="jarvis-access-error" className="hunting-access-dialog__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="hunting-access-dialog__actions">
              <button
                type="submit"
                className="hunting-access-dialog__unlock"
                disabled={!password || submitting}
              >
                {submitting ? "Verifying..." : "Sign in"}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
