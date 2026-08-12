// Mirror of the OpenClaw-controlled browser so the user can act in it themselves.
//
// The browser is headless inside the gateway container, so a CAPTCHA, sign-in wall, or 2FA
// prompt has nowhere else to be answered. Frames arrive as JPEGs; clicks go back as ratios so
// the same panel works on a phone over private network as on a desktop. Nothing here solves a
// challenge — it relays what the person does.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  CornerDownLeft,
  Loader,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  api,
  type HuntingBrowserFrame,
  type HuntingBrowserInput,
  type HuntingBrowserTab,
} from "../lib/api";

const FRAME_INTERVAL_MS = 1200;
const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};
type QueuedKeyboardInput = { input: HuntingBrowserInput; selectionGeneration: number };

export default function BrowserTakeover({
  targetId,
  url,
  onClose,
  onResume,
  resumeLabel = "Resume with J.A.R.V.I.S.",
}: {
  targetId: string | null;
  url: string | null;
  onClose: () => void;
  onResume?: () => void;
  resumeLabel?: string;
}) {
  const [activeTargetId, setActiveTargetId] = useState<string | null>(targetId);
  const [tabs, setTabs] = useState<HuntingBrowserTab[] | null>(null);
  const [frame, setFrame] = useState<HuntingBrowserFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const imageRef = useRef<HTMLImageElement>(null);
  const activeTargetIdRef = useRef<string | null>(targetId);
  const captureGeneration = useRef(0);
  const selectionGeneration = useRef(0);
  const acting = useRef(false);
  const busyRef = useRef(false);
  const queuedKeyboardInputs = useRef<QueuedKeyboardInput[]>([]);

  const capture = useCallback(async (id: string, start = false, duringInput = false) => {
    if (acting.current && !duringInput) return false;
    const generation = ++captureGeneration.current;
    try {
      const response = start
        ? await api.startHuntingBrowserTakeover(id, url)
        : await api.huntingBrowserFrame(id);
      if (generation !== captureGeneration.current) return false;
      setFrame(response.frame);
      activeTargetIdRef.current = response.frame.targetId;
      setActiveTargetId(response.frame.targetId);
      setError(null);
      return true;
    } catch (caught) {
      if (generation !== captureGeneration.current) return false;
      setError(caught instanceof Error ? caught.message : "Could not read the browser");
      // A tab that disappeared should send the user back to the picker rather than loop.
      if (caught instanceof Error && /not found|closed/i.test(caught.message)) {
        activeTargetIdRef.current = null;
        setActiveTargetId(null);
        setFrame(null);
      }
      return false;
    }
  }, [url]);

  useEffect(() => {
    selectionGeneration.current += 1;
    captureGeneration.current += 1;
    queuedKeyboardInputs.current = [];
    setFrame(null);
    activeTargetIdRef.current = targetId;
    setActiveTargetId(targetId);
  }, [targetId]);

  useEffect(() => {
    if (activeTargetId) return;
    let cancelled = false;
    api
      .huntingBrowserTabs()
      .then((response) => {
        if (!cancelled) setTabs(response.tabs);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not list browser tabs");
      });
    return () => {
      cancelled = true;
    };
  }, [activeTargetId]);

  useEffect(() => {
    if (!activeTargetId) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (needsStart: boolean) => {
      if (cancelled) return;
      const visible = document.visibilityState === "visible";
      const captured = visible ? await capture(activeTargetId, needsStart) : false;
      if (cancelled) return;
      timer = window.setTimeout(
        () => void poll(needsStart && !captured),
        captured || !visible ? FRAME_INTERVAL_MS : 250,
      );
    };
    void poll(true);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      captureGeneration.current += 1;
    };
  }, [activeTargetId, capture]);

  async function send(
    input: HuntingBrowserInput,
    requestedTargetId = activeTargetId,
  ): Promise<boolean> {
    if (!requestedTargetId || busyRef.current) return false;
    const operationGeneration = selectionGeneration.current;
    let nextTargetId = requestedTargetId;
    busyRef.current = true;
    acting.current = true;
    captureGeneration.current += 1;
    setBusy(true);
    try {
      const response = await api.sendHuntingBrowserInput(requestedTargetId, input);
      if (operationGeneration !== selectionGeneration.current) return false;
      nextTargetId = response.targetId;
      if (response.targetId !== requestedTargetId) setFrame(null);
      activeTargetIdRef.current = response.targetId;
      setActiveTargetId(response.targetId);
      setError(null);
      // Show the result immediately instead of waiting for the next tick.
      await capture(response.targetId, false, true);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Input was refused");
      return false;
    } finally {
      busyRef.current = false;
      acting.current = false;
      setBusy(false);
      const next = nextQueuedKeyboardInput(
        queuedKeyboardInputs.current,
        selectionGeneration.current,
      );
      if (next) void send(next, activeTargetIdRef.current ?? nextTargetId);
    }
  }

  function sendKeyboardInput(input: HuntingBrowserInput) {
    if (busyRef.current) {
      queuedKeyboardInputs.current.push({
        input,
        selectionGeneration: selectionGeneration.current,
      });
      return;
    }
    void send(input);
  }

  async function reload(requestedTargetId: string, url: string) {
    if (busyRef.current) return;
    const operationGeneration = selectionGeneration.current;
    let nextTargetId = requestedTargetId;
    busyRef.current = true;
    acting.current = true;
    captureGeneration.current += 1;
    setBusy(true);
    try {
      const response = await api.navigateHuntingBrowser(requestedTargetId, url);
      if (operationGeneration !== selectionGeneration.current) return;
      nextTargetId = response.targetId;
      if (response.targetId !== requestedTargetId) setFrame(null);
      activeTargetIdRef.current = response.targetId;
      setActiveTargetId(response.targetId);
      setError(null);
      await capture(response.targetId, false, true);
    } catch (caught) {
      if (operationGeneration === selectionGeneration.current) {
        setError(caught instanceof Error ? caught.message : "Reload failed");
      }
    } finally {
      busyRef.current = false;
      acting.current = false;
      setBusy(false);
      const next = nextQueuedKeyboardInput(
        queuedKeyboardInputs.current,
        selectionGeneration.current,
      );
      if (next) void send(next, activeTargetIdRef.current ?? nextTargetId);
    }
  }

  function handleFrameClick(event: React.MouseEvent<HTMLImageElement>) {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    void send({
      action: "click",
      xRatio: (event.clientX - rect.left) / rect.width,
      yRatio: (event.clientY - rect.top) / rect.height,
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const special = SPECIAL_KEYS[event.key];
    if (special) {
      event.preventDefault();
      sendKeyboardInput({ action: "press", key: special });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      sendKeyboardInput({ action: "type", text: event.key });
    }
  }

  return (
    <div className="hunting-takeover" role="dialog" aria-label="Browser takeover">
      <div className="hunting-takeover__panel">
        <header className="hunting-takeover__head">
          <span>
            <ShieldCheck size={13} /> Browser takeover
          </span>
          <b>{frame?.url ? shortUrl(frame.url) : activeTargetId ? "connecting…" : "pick a tab"}</b>
          <button onClick={onClose} aria-label="Close takeover">
            <X size={14} />
          </button>
        </header>

        <p className="hunting-takeover__note">
          You are driving the browser J.A.R.V.I.S. uses. Solve the CAPTCHA or sign in yourself —
          J.A.R.V.I.S. never touches a challenge and never enters credentials.
        </p>

        {error ? <div className="hunting-takeover__error">{error}</div> : null}

        {activeTargetId ? (
          <>
            {/* tabIndex makes the frame focusable so a physical keyboard reaches the page. */}
            <div className="hunting-takeover__stage" tabIndex={0} onKeyDown={handleKeyDown}>
              {frame?.targetId === activeTargetId ? (
                <img
                  ref={imageRef}
                  src={frame.image}
                  alt="Live browser frame"
                  onClick={handleFrameClick}
                  draggable={false}
                />
              ) : (
                <div className="hunting-takeover__loading">
                  <Loader className="hunting-spin" size={22} /> waiting for the first frame…
                </div>
              )}
              {busy ? (
                <span className="hunting-takeover__busy">
                  <LoaderCircle className="hunting-spin" size={12} /> sending
                </span>
              ) : null}
            </div>

            <div className="hunting-takeover__keys">
              <input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Type text, then Send"
                maxLength={120}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <button
                onClick={() => {
                  if (!typed) return;
                  const submittedText = typed;
                  void send({ action: "type", text: submittedText }).then((sent) => {
                    if (sent) setTyped((current) => (current === submittedText ? "" : current));
                  });
                }}
                disabled={!typed || busy}
              >
                Send text
              </button>
              <button onClick={() => void send({ action: "press", key: "Enter" })} disabled={busy}>
                <CornerDownLeft size={12} /> Enter
              </button>
              <button onClick={() => void send({ action: "press", key: "Tab" })} disabled={busy}>
                Tab
              </button>
              <button onClick={() => void send({ action: "scroll", deltaY: 1 })} disabled={busy}>
                Page down
              </button>
              <button onClick={() => void send({ action: "scroll", deltaY: -1 })} disabled={busy}>
                Page up
              </button>
              <button
                onClick={() => {
                  if (frame?.url && activeTargetId) {
                    void reload(activeTargetId, frame.url);
                  }
                }}
                disabled={busy || !frame?.url}
              >
                <RefreshCw size={12} /> Reload
              </button>
            </div>

            <footer className="hunting-takeover__foot">
              <button
                onClick={() => {
                  selectionGeneration.current += 1;
                  captureGeneration.current += 1;
                  queuedKeyboardInputs.current = [];
                  setFrame(null);
                  activeTargetIdRef.current = null;
                  setActiveTargetId(null);
                }}
                disabled={busy}
              >
                Switch tab
              </button>
              {frame?.url ? (
                <a href={frame.url} target="_blank" rel="noreferrer">
                  Open in my browser <ArrowUpRight size={12} />
                </a>
              ) : null}
              {onResume ? (
                <button
                  className="hunting-takeover__resume"
                  onClick={() => {
                    onResume();
                    onClose();
                  }}
                >
                  {resumeLabel}
                </button>
              ) : null}
            </footer>
          </>
        ) : (
          <ul className="hunting-takeover__tabs">
            {(tabs ?? []).map((tab) => (
              <li key={tab.targetId}>
                <button
                  onClick={() => {
                    selectionGeneration.current += 1;
                    captureGeneration.current += 1;
                    queuedKeyboardInputs.current = [];
                    setFrame(null);
                    setError(null);
                    activeTargetIdRef.current = tab.targetId;
                    setActiveTargetId(tab.targetId);
                  }}
                >
                  <b>{tab.title || shortUrl(tab.url) || tab.targetId.slice(0, 8)}</b>
                  <small>{shortUrl(tab.url)}</small>
                </button>
              </li>
            ))}
            {tabs && !tabs.length ? <li className="hunting-takeover__empty">No open browser tabs.</li> : null}
            {!tabs ? <li className="hunting-takeover__empty">Loading tabs…</li> : null}
          </ul>
        )}
      </div>
    </div>
  );
}

function shortUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 70);
  } catch {
    return value.slice(0, 70);
  }
}

function nextQueuedKeyboardInput(
  queue: QueuedKeyboardInput[],
  selectionGeneration: number,
): HuntingBrowserInput | null {
  const firstIndex = queue.findIndex((queued) => queued.selectionGeneration === selectionGeneration);
  if (firstIndex < 0) return null;
  const [first] = queue.splice(firstIndex, 1);
  if (!first || first.input.action !== "type") return first?.input ?? null;
  let text = first.input.text ?? "";
  while (
    queue[firstIndex]?.selectionGeneration === selectionGeneration &&
    queue[firstIndex]?.input.action === "type" &&
    text.length < 120
  ) {
    const [next] = queue.splice(firstIndex, 1);
    text += next?.input.text ?? "";
  }
  return { action: "type", text };
}
