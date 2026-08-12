import type { ReactNode } from "react";

export default function HoloPanel({
  title,
  right,
  children,
  className = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`holo-panel hud-frame animate-slide-up p-4 ${className}`}>
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between">
          <div className="hud-label">{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
