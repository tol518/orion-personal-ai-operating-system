import type { ReactNode } from "react";

export default function StatTile({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="holo-panel hud-frame flex flex-col justify-between p-4">
      <div className="flex items-center justify-between">
        <span className="hud-label">{label}</span>
        {icon && <span className="text-accent/70">{icon}</span>}
      </div>
      <div className="mt-2 font-mono text-3xl font-semibold text-accent text-glow leading-none">
        {value}
      </div>
      {sub && <div className="mt-1 font-mono text-[0.7rem] text-gray-500">{sub}</div>}
    </div>
  );
}
