import { useNavigate } from "react-router-dom";
import { AlertTriangle, TrendingUp } from "lucide-react";
import { formatMoney } from "../../lib/format";
import { colorFromString } from "../../lib/analytics";
import type { CategoryStat } from "../../lib/analytics";

export function BudgetActual({ items, daysLeft }: { items: CategoryStat[]; daysLeft: number }) {
  const navigate = useNavigate();
  if (!items.length) return null;

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((it) => {
        const ratio = it.paceRatio ?? 0;
        const pct = Math.min(100, (it.total / (it.budget ?? 1)) * 100);
        const over = ratio >= 1.05;
        const warn = ratio >= 0.85 && ratio < 1.05;
        const barColor = over ? "var(--negative)" : warn ? "var(--warning)" : colorFromString(it.category);

        return (
          <li key={it.category}>
            <button
              onClick={() => navigate(`/ledger?category=${encodeURIComponent(it.category)}`)}
              className="group w-full text-left"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: barColor }} />
                  <span className="text-[13px] text-white truncate">{it.category}</span>
                  {over && <AlertTriangle size={11} className="text-negative shrink-0" />}
                  {warn && !over && <TrendingUp size={11} className="text-warning shrink-0" />}
                </div>
                <div className="flex items-center gap-2 text-[12px] font-mono tabular-nums shrink-0">
                  <span className={over ? "text-negative" : warn ? "text-warning" : "text-white"}>
                    {formatMoney(it.total)}
                  </span>
                  <span className="text-[var(--text-tertiary)]">/ {formatMoney(it.budget!)}</span>
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${Math.max(2, pct)}%`, background: barColor }}
                />
              </div>
              {over && (
                <div className="mt-1 text-[10px] text-negative">
                  {it.total > it.budget!
                    ? `Over by ${formatMoney(it.total - it.budget!)} · ${daysLeft}d left`
                    : `On pace to exceed · ${daysLeft}d left`}
                </div>
              )}
              {warn && !over && (
                <div className="mt-1 text-[10px] text-warning">
                  {Math.round(pct)}% used · {daysLeft}d left
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
