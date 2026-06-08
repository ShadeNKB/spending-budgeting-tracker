import { useState } from 'react'
import { formatMoney } from '../../lib/format'

const CHART_H = 88 // bar area height — label lives outside this

export function MonthlyBars({ data }: { data: { label: string; total: number; month: number }[] }) {
  const max = Math.max(...data.map((d) => d.total), 1)
  const currentMonth = new Date().getMonth()
  const [hovered, setHovered] = useState<number | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const activeMonth = hovered ?? selected

  const yearTotal = data.reduce((s, d) => s + d.total, 0)
  const activeMos = data.filter((d) => d.total > 0).length

  return (
    <div className="flex flex-col gap-2">
      {/* Bar chart area — fixed height, labels sit below */}
      <div className="flex items-end gap-[3px]" style={{ height: CHART_H }}>
        {data.map((d) => {
          const pct = d.total / max
          // Cap at 92% of CHART_H so top bar never touches ceiling; min 3px stub
          const barPx = Math.round(d.total > 0 ? Math.max(3, pct * CHART_H * 0.92) : 0)
          const isCurrent = d.month === currentMonth
          const isHovered = activeMonth === d.month
          const isFuture = d.month > currentMonth

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
              aria-label={`${d.label}: ${formatMoney(d.total)}`}
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
                    {formatMoney(d.total)}
                  </div>
                </div>
              )}
              {/* Bar — anchored to bottom */}
              <div
                className={`absolute bottom-0 left-0 right-0 rounded-t transition-all duration-300 ${
                  isCurrent
                    ? 'bg-accent shadow-[0_0_12px_-2px_rgba(34,211,238,0.45)]'
                    : isHovered
                      ? 'bg-white/30'
                      : isFuture
                        ? 'bg-white/[0.05]'
                        : 'bg-white/[0.15]'
                }`}
                style={{ height: barPx }}
              />
            </div>
          )
        })}
      </div>

      {/* Labels row — separate from bar area, never compressed */}
      <div className="flex gap-[3px]">
        {data.map((d) => {
          const isCurrent = d.month === currentMonth
          const isFuture = d.month > currentMonth
          return (
            <div key={d.month} className="flex flex-1 justify-center">
              <span
                className={`text-[9px] leading-none ${
                  isCurrent
                    ? 'font-semibold text-accent'
                    : isFuture
                      ? 'text-white/20'
                      : 'text-[var(--text-tertiary)]'
                }`}
              >
                {d.label}
              </span>
            </div>
          )
        })}
      </div>

      {/* Summary row */}
      <div className="flex items-center gap-3 border-t border-white/[0.05] pt-1 text-[11px] text-[var(--text-tertiary)]">
        <span>
          Total <span className="font-mono tabular-nums text-white">{formatMoney(yearTotal)}</span>
        </span>
        <span className="text-white/20">·</span>
        <span>
          Avg/mo{' '}
          <span className="font-mono tabular-nums text-white">
            {formatMoney(yearTotal / Math.max(1, activeMos))}
          </span>
        </span>
        {activeMonth !== null && data[activeMonth] && (
          <>
            <span className="ml-auto text-white/20">·</span>
            <span className="text-white/60">
              {data[activeMonth].label}{' '}
              <span className="font-mono tabular-nums text-white">
                {formatMoney(data[activeMonth].total)}
              </span>
            </span>
          </>
        )}
      </div>
    </div>
  )
}
