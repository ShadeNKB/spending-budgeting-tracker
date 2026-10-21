import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import {
  dayOfWeek,
  longDate,
  monthShortName,
  shortDate,
  shortDateYear,
  weekdayShort,
  type DayKey,
} from '../../lib/dates'
import type { HeatmapData } from '../../lib/analytics'

// Labels and cells share one row template (month row + 7 day rows, 3 px gaps), so the
// Mon / Wed / Fri labels sit on their rows by construction at every breakpoint.
const ROWS = 'grid grid-rows-[14px_repeat(7,17px)] gap-[3px] sm:grid-rows-[14px_repeat(7,19px)]'
const LABELED_ROWS = new Map([
  [1, 'Mon'],
  [3, 'Wed'],
  [5, 'Fri'],
])
/** Width of the fade over a side whose weeks are scrolled out of view. */
const FADE = '16px'
/** Fully shown in the mask (a mask reads only alpha; the colour is never painted). */
const SHOWN = 'rgb(0 0 0 / 1)'
const LEVEL_CLASSES = [
  'bg-surface-2 border-white/[0.04]',
  'bg-accent/15 border-accent/20',
  'bg-accent/30 border-accent/30',
  'bg-accent/55 border-accent/40',
  'bg-accent border-accent',
] as const

interface Cell {
  key: DayKey
  row: number
  level: number
  total: number
  label: string
  title: string
}

const levelOf = (total: number, max: number) => {
  if (total <= 0) return 0
  const r = total / max
  if (r < 0.25) return 1
  if (r < 0.5) return 2
  if (r < 0.75) return 3
  return 4
}

export function Heatmap({ data, today }: { data: HeatmapData; today: DayKey }) {
  const navigate = useNavigate()
  const fmt = useFormatMoney()
  const scroller = useRef<HTMLDivElement>(null)

  // Everything per cell is derived once per data / currency change, by key slicing.
  const weeks = useMemo(() => {
    const max = Math.max(...data.days.map((d) => d.total), 1)
    const out: { month: string | null; cells: Cell[] }[] = []
    let lastMonth = ''
    for (const d of data.days) {
      const row = dayOfWeek(d.date)
      if (row === 0 || out.length === 0) {
        const month = d.date.slice(0, 7)
        out.push({ month: month === lastMonth ? null : monthShortName(month), cells: [] })
        lastMonth = month
      }
      const amount = d.total > 0 ? fmt(d.total) : 'No spending'
      out[out.length - 1]?.cells.push({
        key: d.date,
        row,
        level: levelOf(d.total, max),
        total: d.total,
        label: `${weekdayShort(d.date)}, ${longDate(d.date)}: ${amount}`,
        title: `${weekdayShort(d.date)}, ${shortDate(d.date)} · ${amount}`,
      })
    }
    return out
  }, [data, fmt])

  // Which sides have weeks scrolled out of view. A cut-off column under a soft fade reads as
  // "more this way" rather than as a broken edge (below 390 px 14 weeks do not quite fit).
  const [hidden, setHidden] = useState({ before: false, after: false })
  const readEdges = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const before = el.scrollLeft > 1
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setHidden((h) => (h.before === before && h.after === after ? h : { before, after }))
  }, [])

  // Open on the latest weeks: on a narrow phone the grid scrolls inside its card. The scroll
  // waits for the frame's own layout (rAF runs before it, still ahead of the first paint), so
  // mounting Pulse never forces an extra synchronous layout; and it runs only when the period
  // changes, so an add does not undo the reader's scroll.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const frame = requestAnimationFrame(() => {
      el.scrollLeft = el.scrollWidth
      readEdges()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [data.start, data.end, readEdges])

  // A rotated phone or a resized window changes what fits.
  useEffect(() => {
    window.addEventListener('resize', readEdges)
    return () => {
      window.removeEventListener('resize', readEdges)
    }
  }, [readEdges])

  const fade =
    hidden.before || hidden.after
      ? `linear-gradient(to right, ${hidden.before ? 'transparent' : SHOWN}, ${SHOWN} ${FADE}, ${SHOWN} calc(100% - ${FADE}), ${hidden.after ? 'transparent' : SHOWN})`
      : undefined

  return (
    <div>
      <div className="flex">
        <div className={clsx(ROWS, 'mr-1 shrink-0 py-1')} aria-hidden>
          <span />
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <span
              key={row}
              className="flex w-6 items-center justify-end pr-1 text-[9px] leading-none text-[var(--text-tertiary)]"
            >
              {LABELED_ROWS.get(row)}
            </span>
          ))}
        </div>

        <div
          ref={scroller}
          onScroll={readEdges}
          style={{ maskImage: fade, WebkitMaskImage: fade }}
          className="no-scrollbar min-w-0 flex-1 overflow-x-auto"
        >
          <div className="flex w-max gap-[3px] p-1">
            {weeks.map((week) => (
              <div key={week.cells[0]?.key} className={clsx(ROWS, 'shrink-0')}>
                <span className="flex items-end whitespace-nowrap text-[9px] font-medium leading-none text-[var(--text-tertiary)]">
                  {week.month}
                </span>
                {week.cells.map((cell) => (
                  <button
                    key={cell.key}
                    type="button"
                    aria-label={cell.label}
                    title={cell.title}
                    onClick={() => cell.total > 0 && navigate(`/ledger?date=${cell.key}`)}
                    style={{ gridRowStart: cell.row + 2 }}
                    className={clsx(
                      'h-[17px] w-[17px] rounded-[5px] border transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-[19px] sm:w-[19px]',
                      LEVEL_CLASSES[cell.level],
                      cell.key === today &&
                        'shadow-[0_0_8px_-2px_rgba(34,211,238,0.55)] ring-2 ring-accent ring-offset-2 ring-offset-surface-1',
                      cell.total > 0 ? 'cursor-pointer' : 'cursor-default',
                    )}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-2.5 flex items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]">
        <span>
          {shortDate(data.start)} – {shortDateYear(data.end)}
        </span>
        <div className="flex items-center gap-1">
          <span>less</span>
          {LEVEL_CLASSES.map((c) => (
            <span key={c} className={clsx('h-[10px] w-[10px] rounded-[2px] border', c)} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  )
}
