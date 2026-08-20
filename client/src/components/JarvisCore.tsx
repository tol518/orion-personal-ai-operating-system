import type { CSSProperties } from "react";

type Props = {
  connected: boolean;
  working: number;
  statusLabel: string;
};

const ACCENT = "rgb(var(--hud-accent))";
const ACCENT_HOVER = "rgb(var(--hud-accent-hover))";

const constellation = [
  { x: 104, y: 190, major: true },
  { x: 146, y: 137 },
  { x: 201, y: 168 },
  { x: 255, y: 117, major: true },
  { x: 305, y: 176 },
  { x: 342, y: 229, major: true },
  { x: 286, y: 280 },
  { x: 223, y: 309, major: true },
  { x: 159, y: 270 },
];

export default function JarvisCore({ connected, working, statusLabel }: Props) {
  const speed = 1 + Math.min(working, 8) * 0.5;
  const outerStyle = { "--dur": `${64 / speed}s` } as CSSProperties;
  const innerStyle = { "--dur": `${42 / speed}s` } as CSSProperties;

  return (
    <div
      className="orion-core relative mx-auto"
      style={{ width: "min(26rem, 80vw)", aspectRatio: "1 / 1", opacity: connected ? 1 : 0.44 }}
    >
      <svg viewBox="0 0 440 440" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id="orion-core-wash" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.14" />
            <stop offset="50%" stopColor={ACCENT} stopOpacity="0.035" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
          </radialGradient>
          <filter id="orion-star-glow" x="-300%" y="-300%" width="700%" height="700%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle cx="220" cy="220" r="210" fill="url(#orion-core-wash)" />

        <g className="orion-orbit orion-orbit--outer" style={outerStyle}>
          <ellipse cx="220" cy="220" rx="196" ry="105" transform="rotate(-12 220 220)" />
          <ellipse cx="220" cy="220" rx="184" ry="72" transform="rotate(28 220 220)" />
        </g>
        <g className="orion-orbit orion-orbit--inner" style={innerStyle}>
          <ellipse cx="220" cy="220" rx="151" ry="52" transform="rotate(-54 220 220)" />
          <circle cx="220" cy="220" r="116" />
        </g>

        <path
          className="orion-constellation"
          d={constellation.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ")}
        />
        <path className="orion-constellation orion-constellation--faint" d="M146 137 L159 270 M201 168 L286 280 M255 117 L223 309" />

        {constellation.map((point, index) => (
          <g key={`${point.x}-${point.y}`} className={`orion-star ${point.major ? "orion-star--major" : ""}`}>
            <circle cx={point.x} cy={point.y} r={point.major ? 3.2 : 2} fill={ACCENT_HOVER} />
            {point.major ? (
              <path
                d={`M${point.x} ${point.y - 12} L${point.x + 2.4} ${point.y - 2.4} L${point.x + 12} ${point.y} L${point.x + 2.4} ${point.y + 2.4} L${point.x} ${point.y + 12} L${point.x - 2.4} ${point.y + 2.4} L${point.x - 12} ${point.y} L${point.x - 2.4} ${point.y - 2.4} Z`}
                fill={ACCENT_HOVER}
                filter="url(#orion-star-glow)"
                style={{ animationDelay: `${index * 310}ms` }}
              />
            ) : null}
          </g>
        ))}

        <circle className="orion-core__disc" cx="220" cy="220" r="82" />
        <circle className="orion-core__disc-line" cx="220" cy="220" r="67" />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="hud-label text-[0.6rem]">{connected ? "ONLINE" : "OFFLINE"}</div>
        <div className="orion-core__value font-mono text-6xl font-semibold text-accent text-glow leading-none">
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
