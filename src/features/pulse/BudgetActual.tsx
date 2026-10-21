import { useNavigate } from 'react-router-dom'
import { AlertTriangle, TrendingUp } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'
import type { CategoryBudgetStat } from '../../lib/analytics'

/**
 * Per-category budget rows. Current month: a marker where spending would be at an even pace,
 * amber "Projected" only when the month-end projection (from day 5; a monthly charge already
 * paid is not projected again) would pass the cap, red once over.
 * A finished month (`isFinal`) shows the result only: over by / under.
 */
export function BudgetActual({
  items,
  isFinal,
}: {
  items: readonly CategoryBudgetStat[]
  isFinal: boolean
}) {
  const navigate = useNavigate()
  const fmt = useFormatMoney()
  if (!items.length) return null

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((it) => {
        const over = it.status === 'over'
        const ahead = it.status === 'ahead'
        const pct = Math.min(100, it.used * 100)
        const barColor = over
          ? 'var(--negative)'
          : ahead
            ? 'var(--warning)'
            : colorFromString(it.category)
        const note = over
          ? `Over by ${fmt(it.total - it.budget)}`
          : ahead && it.projected !== null
            ? `Projected ${fmt(it.projected)}`
            : isFinal
              ? `${fmt(it.left)} under`
              : `${String(Math.round(it.used * 100))}% used · ${fmt(it.left)} left`

        return (
          <li key={it.category}>
            <button
              type="button"
              onClick={() => navigate(`/ledger?category=${encodeURIComponent(it.category)}`)}
              className="group w-full rounded-lg px-1.5 py-1 text-left transition hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              aria-label={`${it.category}: ${fmt(it.total)} of ${fmt(it.budget)} budget. ${note}`}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: barColor }}
                  />
                  <span className="truncate text-[13px] text-white">{it.category}</span>
                  {over && <AlertTriangle size={11} className="shrink-0 text-negative" />}
                  {ahead && <TrendingUp size={11} className="shrink-0 text-warning" />}
                </div>
                <div className="flex shrink-0 items-center gap-2 font-mono text-[12px] tabular-nums">
                  <span className={over ? 'text-negative' : ahead ? 'text-warning' : 'text-white'}>
                    {fmt(it.total)}
                  </span>
                  <span className="text-[var(--text-tertiary)]">/ {fmt(it.budget)}</span>
                </div>
              </div>

              <div className="relative h-2 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${String(Math.max(2, pct))}%`, background: barColor }}
                />
                {!isFinal && (
                  <span
                    className="absolute top-0 h-full w-px"
                    style={{
                      left: `${String(Math.min(100, it.expected * 100))}%`,
                      background: 'var(--marker)',
                      boxShadow: '0 0 0 1px var(--marker-edge)',
                    }}
                    aria-hidden
                  />
                )}
              </div>

              <div
                className={`mt-1 text-[10px] ${
                  over ? 'text-negative' : ahead ? 'text-warning' : 'text-[var(--text-tertiary)]'
                }`}
              >
                {note}
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
