import { ArrowRight, Sun } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { formatMoney } from "../../lib/format";
import { colorFromString } from "../../lib/analytics";
import type { Expense } from "../../types";

export function TodayStrip({ entries, total }: { entries: Expense[]; total: number }) {
  const navigate = useNavigate();

  return (
    <div className="rounded-[14px] border border-white/[0.06] bg-surface-1 p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sun size={14} className="text-accent/80" />
          <h3 className="text-[13px] font-semibold text-white">Today</h3>
          <span className="text-[11px] text-[var(--text-tertiary)]">
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[15px] tabular-nums font-semibold text-white">
            {formatMoney(total)}
          </span>
          <button
            onClick={() => navigate("/ledger?range=today")}
            className="inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] hover:text-white transition"
          >
            View <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="py-3 text-center text-[12px] text-[var(--text-tertiary)]">
          Nothing logged today yet
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.04]">
          {entries.slice(0, 5).map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2.5">
              <span
                className="h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold"
                style={{
                  background: `${colorFromString(e.category)}1E`,
                  color: colorFromString(e.category),
                  boxShadow: `0 0 0 1px ${colorFromString(e.category)}28`,
                }}
              >
                {e.itemName.charAt(0).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <div className="truncate text-[13px] text-white">{e.itemName}</div>
                <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                  {e.category}{e.notes ? ` · ${e.notes}` : ""}
                </div>
              </div>
              <span className="font-mono text-[13px] tabular-nums text-white">
                {formatMoney(e.amount)}
              </span>
            </li>
          ))}
          {entries.length > 5 && (
            <li className="pt-2 text-center">
              <button
                onClick={() => navigate("/ledger?range=today")}
                className="text-[11px] text-accent hover:text-accent-hover transition"
              >
                +{entries.length - 5} more
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
