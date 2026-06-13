import { useNavigate } from 'react-router-dom'
import { AlertTriangle, TrendingUp } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'
import type { CategoryStat } from '../../lib/analytics'

export function BudgetActual({ items, daysLeft }: { items: CategoryStat[]; daysLeft: number }) {
  const navigate = useNavigate()
  const fmt = useFormatMoney()
  if (!items.length) return null

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((it) => {
        const ratio = it.paceRatio ?? 0
        const budget = it.budget ?? 1
        const pct = Math.min(100, (it.total / budget) * 100)
        const expectedPct = Math.min(100, ((it.expected ?? 0) / budget) * 100)
        const projected = it.projected ?? it.total
        const over = ratio >= 1.05
        const warn = ratio >= 0.85 && ratio < 1.05
        const barColor = over
          ? 'var(--negative)'
          : warn
            ? 'var(--warning)'
            : colorFromString(it.category)

        return (
          <li key={it.category}>
            <button
              type="button"
              onClick={() => navigate(`/ledger?category=${encodeURIComponent(it.category)}`)}
              className="group w-full rounded-lg px-1.5 py-1 text-left transition hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              aria-label={`${it.category}: ${fmt(it.total)} used of ${fmt(budget)} budget`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: barColor }}
                  />
                  <span className="truncate text-[13px] text-white">{it.category}</span>
                  {over && <AlertTriangle size={11} className="shrink-0 text-negative" />}
                  {warn && !over && <TrendingUp size={11} className="shrink-0 text-warning" />}
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
                  <span className={over ? 'text-negative' : warn ? 'text-warning' : 'text-white'}>
                    {fmt(it.total)}
                  </span>
                  <span className="text-[var(--text-tertiary)]">/ {fmt(budget)}</span>
                </div>
              </div>

              <div className="relative h-2 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${Math.max(2, pct)}%`, background: barColor }}
                />
                <span
                  className="absolute top-0 h-full w-px bg-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                  style={{ left: `${expectedPct}%` }}
                  aria-hidden
                />
              </div>

              <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
                <span
                  className={
                    over ? 'text-negative' : warn ? 'text-warning' : 'text-[var(--text-tertiary)]'
                  }
                >
                  {over
                    ? it.total > budget
                      ? `Over by ${fmt(it.total - budget)}`
                      : `Projected ${fmt(projected)}`
                    : `${Math.round(pct)}% used`}
                </span>
                <span className="text-[var(--text-tertiary)]">{daysLeft}d left</span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
