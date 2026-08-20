import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Apple,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Hand,
  Monitor,
  MonitorOff,
  MousePointer2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Terminal,
  WifiOff,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api } from "../lib/api";

type ScreenNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  connected?: boolean;
  paired?: boolean;
  approvalState?: string;
  commands?: string[];
  lastSeenAtMs?: number;
  screenBridgeConfigured?: boolean;
  screenBridgeOnline?: boolean;
  permissions?: { accessibility?: boolean; appleScript?: boolean };
};

type ScreenFrame = {
  dataUrl: string;
  width?: number;
  height?: number;
  displayWidth?: number;
  displayHeight?: number;
  capturedAtMs: number;
  screenIndex: number;
  screenCount: number;
};

type PanPosition = { x: number; y: number };

type FeedStatus = "connecting" | "live" | "paused" | "error";

const SNAPSHOT_DELAY_MS = 850;
const RETRY_DELAY_MS = 2_500;

export default function ScreensPage({ nodes }: { nodes: ScreenNode[] }) {
  const pageVisible = usePageVisible();
  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (node) =>
          node.connected ||
          node.approvalState === "approved" ||
          node.commands?.includes("screen.snapshot"),
      ),
    [nodes],
  );
  const readyNodes = visibleNodes.filter(
    (node) => node.connected && node.commands?.includes("screen.snapshot"),
  ).length;

  return (
    <section className="screens-page" aria-labelledby="screens-title">
      <header className="screens-header">
        <div>
          <h1 id="screens-title">Screens</h1>
          <p>On-demand screen mirrors · active only while this page is open</p>
        </div>
        <div className="screens-header__status" aria-label={`${visibleNodes.length} screen devices`}>
          <Monitor size={17} />
          <span>{visibleNodes.length} {visibleNodes.length === 1 ? "device" : "devices"}</span>
          <b>{readyNodes}/{visibleNodes.length || 0} ready</b>
        </div>
      </header>

      {visibleNodes.length ? (
        <div className="screen-feed-grid" data-count={visibleNodes.length}>
          {visibleNodes.map((node) => (
            <ScreenFeed key={node.nodeId} node={node} pageVisible={pageVisible} />
          ))}
        </div>
      ) : (
        <div className="screens-empty-state">
          <MonitorOff size={42} />
          <h2>No approved computer nodes</h2>
          <p>Pair a macOS or Windows node with OpenClaw to make it available here.</p>
        </div>
      )}

      <footer className="screens-privacy-strip">
        <ShieldCheck size={17} />
        <span>Capture stops when you leave Screens</span>
        <small>{pageVisible ? "Page visible" : "Capture paused while tab is hidden"}</small>
      </footer>
    </section>
  );
}

function ScreenFeed({ node, pageVisible }: { node: ScreenNode; pageVisible: boolean }) {
  const supportsSnapshot = node.commands?.includes("screen.snapshot") ?? false;
  const supportsControl = node.commands?.includes("screen.input") ?? false;
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [screenIndex, setScreenIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PanPosition>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [inputPulse, setInputPulse] = useState(false);
  const wheelLockRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlTokenRef = useRef<string | null>(null);
  const inputQueueRef = useRef(Promise.resolve());
  const dragStartRef = useRef<
    | { pointerId: number; x: number; y: number; pan: PanPosition }
    | null
  >(null);
  const shouldCapture = Boolean(node.connected && supportsSnapshot && pageVisible && !paused);

  useEffect(
    () => () => {
      if (wheelLockRef.current) clearTimeout(wheelLockRef.current);
      const token = controlTokenRef.current;
      controlTokenRef.current = null;
      if (token) void api.stopScreenControl(node.nodeId, token).catch(() => undefined);
    },
    [node.nodeId],
  );

  const stopControl = useCallback(() => {
    const token = controlTokenRef.current;
    controlTokenRef.current = null;
    setControlling(false);
    setInputPulse(false);
    if (token) void api.stopScreenControl(node.nodeId, token).catch(() => undefined);
  }, [node.nodeId]);

  useEffect(() => {
    if ((!pageVisible || paused || !node.connected) && controlTokenRef.current) stopControl();
  }, [node.connected, pageVisible, paused, stopControl]);

  useEffect(() => {
    if (!shouldCapture) {
      if (paused || !pageVisible) setStatus("paused");
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const capture = async () => {
      controller = new AbortController();
      setStatus((current) => (current === "live" ? current : "connecting"));
      try {
        const response = await api.screenSnapshot(node.nodeId, screenIndex, controller.signal);
        const nextFrame = parseSnapshot(response.payload);
        if (disposed) return;
        setFrame(nextFrame);
        setError(null);
        setStatus("live");
        timer = setTimeout(capture, SNAPSHOT_DELAY_MS);
      } catch (captureError) {
        if (disposed || isAbortError(captureError)) return;
        setStatus("error");
        setError(captureError instanceof Error ? captureError.message : "Screen capture failed");
        timer = setTimeout(capture, RETRY_DELAY_MS);
      }
    };

    void capture();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [node.nodeId, pageVisible, paused, retryVersion, screenIndex, shouldCapture]);

  const name = node.displayName || `Node ${node.nodeId.slice(0, 8)}`;
  const state = feedState(node, supportsSnapshot, status, pageVisible);
  const screenCount = frame?.screenCount ?? 1;
  const hasMultipleScreens = screenCount > 1;

  const changeScreen = (nextIndex: number) => {
    const boundedIndex = Math.max(0, Math.min(screenCount - 1, nextIndex));
    if (boundedIndex === screenIndex) return;
    stopControl();
    setScreenIndex(boundedIndex);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setFrame(null);
    setError(null);
    setStatus("connecting");
  };

  const handleMonitorWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (controlling && frame) {
      event.preventDefault();
      const point = framePoint(event.currentTarget, event.clientX, event.clientY, frame);
      if (point && Math.abs(event.deltaY) >= 1) {
        queueInput({ action: "scroll", ...point, screenIndex, delta: event.deltaY });
      }
      return;
    }
    if (!hasMultipleScreens || Math.abs(event.deltaX) < 24 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (wheelLockRef.current) return;
    changeScreen(screenIndex + (event.deltaX > 0 ? 1 : -1));
    wheelLockRef.current = setTimeout(() => {
      wheelLockRef.current = null;
    }, 450);
  };

  const handleMonitorKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasMultipleScreens || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    changeScreen(screenIndex + (event.key === "ArrowRight" ? 1 : -1));
  };

  const setZoomLevel = (nextZoom: number) => {
    const boundedZoom = Math.max(0.6, Math.min(4, nextZoom));
    setZoom(boundedZoom);
    if (boundedZoom <= 1) setPan({ x: 0, y: 0 });
  };

  const clampPan = (nextPan: PanPosition, viewport: HTMLDivElement): PanPosition => {
    if (!frame || zoom <= 1) return { x: 0, y: 0 };
    const { width: viewportWidth, height: viewportHeight } = viewport.getBoundingClientRect();
    const aspectRatio = (frame.width ?? viewportWidth) / (frame.height ?? viewportHeight);
    const fittedWidth = Math.min(viewportWidth, viewportHeight * aspectRatio);
    const fittedHeight = Math.min(viewportHeight, viewportWidth / aspectRatio);
    const maxX = Math.max(0, (fittedWidth * zoom - fittedWidth) / 2);
    const maxY = Math.max(0, (fittedHeight * zoom - fittedHeight) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, nextPan.x)),
      y: Math.max(-maxY, Math.min(maxY, nextPan.y)),
    };
  };

  const handlePanStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (controlling || zoom <= 1 || (event.target instanceof Element && event.target.closest("button"))) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan };
    setDragging(true);
  };

  const handlePanMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPan(
      clampPan(
        { x: start.pan.x + event.clientX - start.x, y: start.pan.y + event.clientY - start.y },
        event.currentTarget,
      ),
    );
  };

  const handlePanEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current?.pointerId !== event.pointerId) return;
    dragStartRef.current = null;
    setDragging(false);
  };

  async function startControl() {
    if (!supportsControl || controlling) return;
    const accepted = window.confirm(
      "Enable manual screen control? Your clicks and scrolls will be sent to this device until you stop control or leave Screens.",
    );
    if (!accepted) return;
    setControlError(null);
    try {
      const response = await api.startScreenControl(node.nodeId);
      controlTokenRef.current = response.control.token;
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setControlling(true);
    } catch (controlStartError) {
      setControlError(controlStartError instanceof Error ? controlStartError.message : "Unable to enable manual control");
    }
  }

  function queueInput(input: {
    action: "click" | "scroll";
    xRatio: number;
    yRatio: number;
    screenIndex: number;
    delta?: number;
  }) {
    const token = controlTokenRef.current;
    if (!token) return;
    setInputPulse(true);
    window.setTimeout(() => setInputPulse(false), 180);
    inputQueueRef.current = inputQueueRef.current
      .then(() => api.sendScreenInput(node.nodeId, token, input))
      .then(() => undefined)
      .catch((inputError) => {
        setControlError(inputError instanceof Error ? inputError.message : "Manual input failed");
        stopControl();
      });
  }

  function handleControlClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!controlling || !frame) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    const point = framePoint(event.currentTarget, event.clientX, event.clientY, frame);
    if (point) queueInput({ action: "click", ...point, screenIndex });
  }

  function scrollControl(delta: number) {
    if (!controlling) return;
    queueInput({ action: "scroll", xRatio: 0.5, yRatio: 0.5, screenIndex, delta });
  }

  return (
    <article className="screen-feed-card">
      <header className="screen-feed-card__header">
        <div className="screen-feed-card__identity">
          <span className="screen-feed-card__platform">{platformIcon(node)}</span>
          <div>
            <h2>{name}</h2>
            <span>{node.deviceFamily || node.platform || "OpenClaw node"}</span>
          </div>
        </div>
        <div className={`screen-feed-state screen-feed-state--${state.tone}`}>
          <i />
          {state.label}
        </div>
        <div className="screen-feed-card__meta">
          <span>Last frame</span>
          <strong>{frame ? formatTime(frame.capturedAtMs) : "—"}</strong>
        </div>
        {node.connected && supportsSnapshot ? (
          <div className="screen-feed-card__actions">
            {supportsControl ? (
              <button
                className={controlling ? "screen-feed-toggle screen-feed-toggle--active" : "screen-feed-toggle"}
                type="button"
                onClick={() => controlling ? stopControl() : void startControl()}
              >
                {controlling ? <Hand size={14} /> : <MousePointer2 size={14} />}
                {controlling ? "Stop control" : "Control"}
              </button>
            ) : null}
            <button
              className="screen-feed-toggle"
              type="button"
              onClick={() => {
                if (!paused) stopControl();
                setPaused((current) => !current);
              }}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "Resume" : "Pause"}
            </button>
          </div>
        ) : null}
      </header>

      <div
        className={`screen-feed-viewport${zoom > 1 && !controlling ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}${controlling ? " is-controlling" : ""}${inputPulse ? " has-input-pulse" : ""}`}
        onWheel={handleMonitorWheel}
        onKeyDown={handleMonitorKey}
        onPointerDown={handlePanStart}
        onPointerMove={handlePanMove}
        onPointerUp={handlePanEnd}
        onPointerCancel={handlePanEnd}
        onClick={handleControlClick}
        tabIndex={hasMultipleScreens || controlling ? 0 : undefined}
        aria-label={controlling ? `${name}, manual screen control` : hasMultipleScreens ? `${name}, monitor ${screenIndex + 1} of ${screenCount}` : undefined}
      >
        {frame ? (
          <img
            src={frame.dataUrl}
            alt={`Live screen mirror from ${name}`}
            style={{
              transform: `translate(${Math.round(pan.x)}px, ${Math.round(pan.y)}px) scale(${zoom})`,
            }}
          />
        ) : null}
        {controlling ? (
          <div className="screen-feed-control-strip" aria-label="Manual screen control">
            <span><MousePointer2 size={13} /> Manual input only</span>
            <button type="button" aria-label="Scroll remote screen up" onClick={() => scrollControl(-420)}><ChevronUp size={14} /></button>
            <button type="button" aria-label="Scroll remote screen down" onClick={() => scrollControl(420)}><ChevronDown size={14} /></button>
            <button type="button" onClick={stopControl}>Stop</button>
          </div>
        ) : null}
        {controlError ? (
          <div className="screen-feed-control-error" role="alert">
            {controlError}
            <button type="button" onClick={() => setControlError(null)}>Dismiss</button>
          </div>
        ) : null}
        <div className="screen-feed-scanlines" aria-hidden="true" />
        {!node.connected ? (
          <FeedMessage
            icon={<WifiOff size={38} />}
            title="Device offline"
            body={lastSeenText(node.lastSeenAtMs)}
          />
        ) : !supportsSnapshot ? (
          <FeedMessage
            icon={<MonitorOff size={38} />}
            title="Screen capture unavailable"
            body={unsupportedMessage(node)}
          />
        ) : status === "connecting" && !frame ? (
          <FeedMessage
            icon={<ScanLine className="screen-feed-searching" size={38} />}
            title="Searching for frames…"
            body="Starting on-demand screen capture"
          />
        ) : status === "paused" ? (
          <FeedMessage
            icon={<Pause size={38} />}
            title={pageVisible ? "Mirror paused" : "Capture paused"}
            body={pageVisible ? "Resume when you want fresh frames." : "This browser tab is not visible."}
          />
        ) : status === "error" ? (
          <FeedMessage
            icon={<MonitorOff size={38} />}
            title="Unable to capture screen"
            body={error || "OpenClaw rejected the screen snapshot request."}
            action={
              <button type="button" onClick={() => setRetryVersion((version) => version + 1)}>
                <RefreshCw size={14} /> Retry now
              </button>
            }
          />
        ) : null}
        {frame ? (
          <div className="screen-feed-resolution">
            <Radio size={12} /> {formatResolution(frame)}
          </div>
        ) : null}
        {frame ? (
          <div className="screen-feed-zoom-controls" aria-label="Screen zoom controls">
            <button
              type="button"
              aria-label="Zoom out"
              disabled={zoom <= 0.6}
              onClick={() => setZoomLevel(zoom - 0.2)}
            >
              <ZoomOut size={13} />
            </button>
            <button type="button" className="screen-feed-zoom-level" onClick={() => setZoomLevel(1)}>
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              disabled={zoom >= 4}
              onClick={() => setZoomLevel(zoom + 0.2)}
            >
              <ZoomIn size={13} />
            </button>
          </div>
        ) : null}
        {hasMultipleScreens ? (
          <div className="screen-feed-monitor-controls" aria-label="Monitor navigation">
            <button
              type="button"
              aria-label="Previous monitor"
              disabled={screenIndex === 0}
              onClick={() => changeScreen(screenIndex - 1)}
            >
              <ChevronLeft size={13} />
            </button>
            <span>MONITOR {screenIndex + 1} / {screenCount}</span>
            <button
              type="button"
              aria-label="Next monitor"
              disabled={screenIndex >= screenCount - 1}
              onClick={() => changeScreen(screenIndex + 1)}
            >
              <ChevronRight size={13} />
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function FeedMessage({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="screen-feed-message">
      {icon}
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function usePageVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function parseSnapshot(payload: unknown): ScreenFrame {
  if (!payload || typeof payload !== "object") throw new Error("Invalid screen snapshot response");
  const data = payload as Record<string, unknown>;
  const format = typeof data.format === "string" ? data.format.toLowerCase() : "";
  const base64 = typeof data.base64 === "string" ? data.base64 : "";
  if (!base64 || !["jpg", "jpeg", "png"].includes(format)) {
    throw new Error("OpenClaw returned an unsupported screen frame");
  }
  return {
    dataUrl: `data:image/${format === "png" ? "png" : "jpeg"};base64,${base64}`,
    width: typeof data.width === "number" ? data.width : undefined,
    height: typeof data.height === "number" ? data.height : undefined,
    displayWidth: typeof data.displayWidth === "number" ? data.displayWidth : undefined,
    displayHeight: typeof data.displayHeight === "number" ? data.displayHeight : undefined,
    capturedAtMs: typeof data.capturedAtMs === "number" ? data.capturedAtMs : Date.now(),
    screenIndex: typeof data.screenIndex === "number" ? data.screenIndex : 0,
    screenCount: typeof data.screenCount === "number" ? Math.max(1, data.screenCount) : 1,
  };
}

export function framePoint(
  viewport: Pick<HTMLElement, "getBoundingClientRect">,
  clientX: number,
  clientY: number,
  frame: Pick<ScreenFrame, "width" | "height">,
) {
  const bounds = viewport.getBoundingClientRect();
  const frameWidth = frame.width ?? bounds.width;
  const frameHeight = frame.height ?? bounds.height;
  const frameRatio = frameWidth / frameHeight;
  const viewportRatio = bounds.width / bounds.height;
  const renderedWidth = viewportRatio > frameRatio ? bounds.height * frameRatio : bounds.width;
  const renderedHeight = viewportRatio > frameRatio ? bounds.height : bounds.width / frameRatio;
  const left = bounds.left + (bounds.width - renderedWidth) / 2;
  const top = bounds.top + (bounds.height - renderedHeight) / 2;
  if (clientX < left || clientX > left + renderedWidth || clientY < top || clientY > top + renderedHeight) {
    return null;
  }
  return {
    xRatio: Math.max(0, Math.min(1, (clientX - left) / renderedWidth)),
    yRatio: Math.max(0, Math.min(1, (clientY - top) / renderedHeight)),
  };
}

function formatResolution(frame: ScreenFrame) {
  const width = frame.displayWidth ?? frame.width;
  const height = frame.displayHeight ?? frame.height;
  return width && height ? `${width} × ${height}` : "LIVE FRAME";
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function platformIcon(node: ScreenNode) {
  const platform = `${node.platform ?? ""} ${node.deviceFamily ?? ""} ${node.displayName ?? ""}`.toLowerCase();
  if (platform.includes("mac") || platform.includes("darwin")) return <Apple size={24} />;
  if (platform.includes("win")) return <Monitor size={24} />;
  return <Terminal size={24} />;
}

function feedState(
  node: ScreenNode,
  supportsSnapshot: boolean,
  status: FeedStatus,
  pageVisible: boolean,
) {
  if (!node.connected) return { label: "OFFLINE", tone: "offline" };
  if (!supportsSnapshot) return { label: "UNAVAILABLE", tone: "offline" };
  if (!pageVisible || status === "paused") return { label: "PAUSED", tone: "paused" };
  if (status === "error") return { label: "RETRYING", tone: "error" };
  if (status === "live") return { label: "LIVE", tone: "live" };
  return { label: "CONNECTING", tone: "connecting" };
}

function unsupportedMessage(node: ScreenNode) {
  if (node.screenBridgeConfigured && !node.screenBridgeOnline) {
    return "The Windows screen bridge is offline. Sign in to Windows and start the ORION Screen Bridge task.";
  }
  const platform = `${node.platform ?? ""} ${node.deviceFamily ?? ""} ${node.displayName ?? ""}`.toLowerCase();
  if (platform.includes("win") && platform.includes("linux")) {
    return "This Windows connection is the WSL node. Enable Windows Hub node mode so it advertises screen.snapshot.";
  }
  if (platform.includes("mac") || platform.includes("darwin")) {
    return "Enable Node Mode and Screen Recording permission in the OpenClaw macOS app.";
  }
  return "This node does not advertise OpenClaw’s screen.snapshot capability.";
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function lastSeenText(value?: number) {
  if (!value) return "Waiting for this device to reconnect.";
  const minutes = Math.max(1, Math.round((Date.now() - value) / 60_000));
  if (minutes < 60) return `Last seen ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `Last seen ${hours}h ago`;
}
