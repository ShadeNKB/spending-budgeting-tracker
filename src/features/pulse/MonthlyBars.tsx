import { useState } from 'react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import type { MonthTotal } from '../../lib/analytics'

const CHART_H = 88 // bar area height — label lives outside this

/**
 * Twelve monthly bars for the viewed year. Only the current year has a "current" (accent) month
 * and greyed-out future months; a past year is drawn evenly.
 */
export function MonthlyBars({
  data,
  total,
  highest,
}: {
  data: readonly MonthTotal[]
  total: number
  highest: MonthTotal | null
}) {
  const fmt = useFormatMoney()
  const max = Math.max(...data.map((d) => d.total), 1)
  const [hovered, setHovered] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const activeMonth = hovered ?? selected
  const active = activeMonth === null ? undefined : data[activeMonth]

  return (
    <div className="flex flex-col gap-2">
      {/* Bar chart area — fixed height, labels sit below */}
      <div className="flex items-end gap-[3px]" style={{ height: CHART_H }}>
        {data.map((d) => {
          const pct = d.total / max
          // Cap at 92% of CHART_H so top bar never touches ceiling; min 3px stub
          const barPx = Math.round(d.total > 0 ? Math.max(3, pct * CHART_H * 0.92) : 0)
          const isHovered = activeMonth === d.month

          return (
            <div
              key={d.month}
              className="relative flex-1 cursor-default"
              style={{ height: CHART_H }}
              onMouseEnter={() => setHovered(d.month)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => setSelected((current) => (current === d.month ? null : d.month))}
              role="button"
              tabIndex={0}
              aria-label={`${d.label}: ${fmt(d.total)}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelected((current) => (current === d.month ? null : d.month))
                }
              }}
            >
              {/* Tooltip — floats above bar, overflow-visible so it escapes container */}
              {isHovered && (
                <div
                  className="pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-surface-3 px-2 py-1 shadow-lg"
                  style={{ bottom: barPx + 6 }}
                >
                  <div className="text-center text-[9px] text-[var(--text-tertiary)]">
                    {d.label}
                  </div>
                  <div className="font-mono text-[11px] font-semibold tabular-nums text-white">
                    {fmt(d.total)}
                  </div>
                </div>
              )}
              {/* Bar — anchored to bottom */}
              <div
                className={`absolute bottom-0 left-0 right-0 rounded-t transition-all duration-300 ${
                  d.state === 'current'
                    ? 'bg-accent shadow-[0_0_12px_-2px_rgba(34,211,238,0.45)]'
                    : isHovered
                      ? 'bg-[var(--chart-bar-strong)]'
                      : 'bg-[var(--chart-bar)]'
                }`}
                style={{ height: barPx }}
              />
            </div>
          )
        })}
      </div>

      {/* Labels row — separate from bar area, never compressed */}
      <div className="flex gap-[3px]">
        {data.map((d) => (
          <div key={d.month} className="flex flex-1 justify-center">
            <span
              className={`text-[9px] leading-none ${
                d.state === 'current'
                  ? 'font-semibold text-accent'
                  : d.state === 'future'
                    ? 'text-[var(--text-muted)]'
                    : 'text-[var(--text-tertiary)]'
              }`}
            >
              {d.label}
            </span>
          </div>
        ))}
      </div>

      {/* Summary row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[0.05] pt-1 text-[11px] text-[var(--text-tertiary)]">
        <span>
          Total <span className="font-mono tabular-nums text-white">{fmt(total)}</span>
        </span>
        {/* No separator dot: the row gap separates the facts, and it never dangles on a wrap. */}
        {highest && (
          <span>
            Highest: {highest.label}{' '}
            <span className="font-mono tabular-nums text-white">{fmt(highest.total)}</span>
          </span>
        )}
        {active && (
          <span className="ml-auto text-[var(--text-secondary)]">
            {active.label}{' '}
            <span className="font-mono tabular-nums text-white">{fmt(active.total)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
