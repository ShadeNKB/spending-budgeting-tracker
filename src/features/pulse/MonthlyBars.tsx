import { useId } from 'react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { seriesSummary, useChartScrub } from '../../hooks/useChartScrub'
import { makeKey, monthKeyOf, monthName } from '../../lib/dates'
import type { MonthTotal } from '../../lib/analytics'

const CHART_H = 88 // bar area height — label lives outside this

/**
 * Twelve monthly bars for the viewed year, read as one slider (`useChartScrub`): hover, press
 * and drag, or focus and use the arrows. Only the current year has a "current" (accent) month
 * and greyed-out future months; a past year is drawn evenly.
 */
export function MonthlyBars({
  data,
  total,
  highest,
  year,
}: {
  data: readonly MonthTotal[]
  total: number
  highest: MonthTotal | null
  year: number
}) {
  const fmt = useFormatMoney()
  const { active, value, props } = useChartScrub({ count: data.length })
  const summaryId = useId()
  const max = Math.max(...data.map((d) => d.total), 1)
  /** "October" */
  const nameOf = (d: MonthTotal) => monthName(monthKeyOf(makeKey(year, d.month + 1, 1)))
  /**
   * "September · S$300.00", "October · S$469.80 so far", "November · upcoming". A month still to
   * come keeps any amount already logged for it (a future-dated fee): "December · S$500.00 ·
   * upcoming".
   */
  const read = (d: MonthTotal | undefined) => {
    if (d === undefined) return ''
    const parts = [nameOf(d)]
    if (d.state !== 'future' || d.total > 0)
      parts.push(`${fmt(d.total)}${d.state === 'current' ? ' so far' : ''}`)
    if (d.state === 'future') parts.push('upcoming')
    return parts.join(' · ')
  }
  const shown = active === null ? undefined : data[active]

  return (
    <div className="flex flex-col gap-2">
      {/* Bar chart area — fixed height, labels sit below */}
      <div
        {...props}
        aria-label={`Monthly totals, ${String(year)}`}
        aria-describedby={summaryId}
        aria-valuetext={read(data[value])}
        data-chart="months"
        className="flex cursor-default touch-pan-y select-none items-end gap-[3px] rounded-md"
        style={{ height: CHART_H }}
      >
        {data.map((d, i) => {
          const pct = d.total / max
          // Cap at 92% of CHART_H so top bar never touches ceiling; min 3px stub
          const barPx = Math.round(d.total > 0 ? Math.max(3, pct * CHART_H * 0.92) : 0)
          const isActive = active === i

          return (
            <div key={d.month} className="relative flex-1" style={{ height: CHART_H }}>
              {/* Tooltip — floats above bar, overflow-visible so it escapes container */}
              {isActive && (
                <div
                  aria-hidden="true"
                  className={`pointer-events-none absolute z-20 whitespace-nowrap rounded-md border border-white/10 bg-surface-3 px-2 py-1 shadow-lg ${
                    i < 2 ? 'left-0' : i > data.length - 3 ? 'right-0' : 'left-1/2 -translate-x-1/2'
                  }`}
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
                data-state={d.state}
                className={`absolute bottom-0 left-0 right-0 rounded-t transition-all duration-300 ${
                  d.state === 'current'
                    ? 'bg-accent shadow-[0_0_12px_-2px_rgba(34,211,238,0.45)]'
                    : isActive
                      ? 'bg-[var(--chart-bar-strong)]'
                      : 'bg-[var(--chart-bar)]'
                }`}
                style={{ height: barPx }}
              />
            </div>
          )
        })}
      </div>
      <p id={summaryId} className="sr-only">
        {seriesSummary(
          data.map((d) => d.total),
          (i) => {
            const d = data[i]
            return d ? nameOf(d) : ''
          },
          fmt,
          'in',
        )}
      </p>

      {/* Labels row — separate from bar area, never compressed; the slider reads the months */}
      <div className="flex gap-[3px]" aria-hidden="true">
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
        {shown && (
          <span className="ml-auto text-[var(--text-secondary)]" aria-hidden="true">
            {shown.label}{' '}
            <span className="font-mono tabular-nums text-white">{fmt(shown.total)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
