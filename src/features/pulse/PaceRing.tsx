import { Ring } from "../../ui/Ring";

export function PaceRing({ ratio, daysLeft }: { ratio: number; daysLeft: number }) {
  const pct = Math.min(999, Math.round(ratio * 100));
  const label = ratio > 0 ? `${pct}%` : "—";
  return (
    <div className="flex flex-col items-center gap-1">
      <Ring value={ratio} size={74} stroke={6} label={<span className="text-[12px]">{label}</span>} />
      <span className="text-[10px] text-[var(--text-tertiary)]">
        {daysLeft}d left
      </span>
    </div>
  );
}
