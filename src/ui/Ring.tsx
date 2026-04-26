import clsx from "clsx";

export function Ring({
  value,
  size = 56,
  stroke = 5,
  track = "var(--surface-3)",
  color,
  label,
}: {
  value: number;
  size?: number;
  stroke?: number;
  track?: string;
  color?: string;
  label?: React.ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1.2, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = Math.min(1, clamped) * c;

  const autoColor =
    color ?? (clamped >= 1.1 ? "var(--negative)" : clamped >= 0.85 ? "var(--warning)" : "var(--accent)");

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={autoColor}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          className="transition-[stroke-dasharray,stroke] duration-700 ease-out"
        />
      </svg>
      {label && (
        <div className={clsx("absolute inset-0 flex items-center justify-center text-[11px] font-semibold text-white tabular-nums")}>
          {label}
        </div>
      )}
    </div>
  );
}
