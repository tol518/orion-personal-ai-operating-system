// The signature arc-reactor core: stacked SVG rings (CSS-animated) whose spin
// speed rises with active-agent load, plus a glass center readout. Faithful to
// the reference's JarvisCore technique (SVG rings + speed driven by workload),
// minus the optional Three.js nucleus (added later).
type Props = {
  connected: boolean;
  working: number;
  statusLabel: string;
};

const ACCENT = "rgb(var(--hud-accent))";

function ticks(radius: number, count: number, len: number) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x1 = 220 + Math.cos(a) * radius;
    const y1 = 220 + Math.sin(a) * radius;
    const x2 = 220 + Math.cos(a) * (radius - len);
    const y2 = 220 + Math.sin(a) * (radius - len);
    items.push(
      <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={ACCENT} strokeWidth={1.5} />,
    );
  }
  return items;
}

export default function JarvisCore({ connected, working, statusLabel }: Props) {
  // More active agents -> faster spin (mirrors reference: 1 + working*0.5).
  const speed = 1 + Math.min(working, 8) * 0.5;
  const outerDur = `${56 / speed}s`;
  const midDur = `${34 / speed}s`;
  const innerDur = `${18 / speed}s`;

  return (
    <div
      className="relative mx-auto"
      style={{ width: "min(26rem, 80vw)", aspectRatio: "1 / 1", opacity: connected ? 1 : 0.4 }}
    >
      <svg viewBox="0 0 440 440" className="absolute inset-0 h-full w-full text-accent">
        {/* outer counter-rotating ring */}
        <g className="ring-spin-rev" style={{ ["--dur" as any]: outerDur }}>
          <circle
            cx="220"
            cy="220"
            r="200"
            fill="none"
            stroke={ACCENT}
            strokeOpacity="0.5"
            strokeWidth="1"
            strokeDasharray="2 10"
          />
          {ticks(196, 60, 10)}
        </g>
        {/* mid ring */}
        <g className="ring-spin" style={{ ["--dur" as any]: midDur }}>
          <circle
            cx="220"
            cy="220"
            r="160"
            fill="none"
            stroke={ACCENT}
            strokeOpacity="0.7"
            strokeWidth="1.5"
            strokeDasharray="40 16"
          />
        </g>
        {/* inner ring */}
        <g className="ring-spin-rev" style={{ ["--dur" as any]: innerDur }}>
          <circle
            cx="220"
            cy="220"
            r="120"
            fill="none"
            stroke={ACCENT}
            strokeOpacity="0.9"
            strokeWidth="1"
            strokeDasharray="4 8"
          />
          {ticks(120, 24, 14)}
        </g>
        {/* core disc */}
        <circle
          cx="220"
          cy="220"
          r="86"
          fill="rgb(var(--hud-accent) / 0.06)"
          stroke={ACCENT}
          strokeOpacity="0.6"
          strokeWidth="1.5"
          className="animate-core-pulse"
          style={{ transformOrigin: "center", filter: "drop-shadow(0 0 18px rgb(var(--hud-accent)/0.6))" }}
        />
      </svg>

      {/* glass center readout */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="hud-label text-[0.6rem]">{connected ? "ONLINE" : "OFFLINE"}</div>
        <div className="font-mono text-6xl font-semibold text-accent text-glow leading-none">
          {working}
        </div>
        <div className="hud-label mt-1 text-[0.6rem] opacity-80">ACTIVE</div>
        <div className="mt-3 max-w-[10rem] truncate font-mono text-[0.7rem] text-gray-400">
          {statusLabel}
        </div>
      </div>
    </div>
  );
}
