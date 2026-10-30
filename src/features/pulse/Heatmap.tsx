import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
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

// Each day is a 24 px target (WCAG 2.5.8's minimum) drawn as a 20 px square, so squares sit 4 px
// apart. The weekday labels share the scroller's rows (the month row and its 4 px gap, then 7 day
// rows), so Mon / Wed / Fri sit on their rows by construction at every breakpoint.
const LABEL_ROWS = 'grid grid-rows-[16px_repeat(7,24px)]'
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''] as const
/** Width of the fade over a side whose weeks are scrolled out of view. */
const FADE = '16px'
/** Fully shown in the mask (a mask reads only alpha; the colour is never painted). */
const SHOWN = 'rgb(0 0 0 / 1)'
// Fill and edge per level. Forced colours keep them (forced-color-adjust: none) over the system
// Canvas, so an empty day takes the Canvas itself: emptier always reads lighter on a light
// Canvas and darker on a dark one, as the levels do.
const LEVEL_CLASSES = [
  'bg-surface-2 ring-white/[0.04] forced-colors:bg-[color:Canvas] forced-colors:ring-[color:GrayText]',
  'bg-accent/15 ring-accent/20',
  'bg-accent/30 ring-accent/30',
  'bg-accent/55 ring-accent/40',
  'bg-accent ring-accent',
] as const
/**
 * Every day: a 24 px box whose 2 px transparent border is the rest of its target, so the boxes
 * meet without overlapping and a tap between two squares lands on the nearer day. The square is
 * the padding box (its edge an inset ring). Nothing is drawn by a child or a pseudo-element, so
 * every accessibility engine names the day by its title alone. The focus ring sits on the box,
 * 2 px clear of the square and never over a neighbouring one; `scroll-mx-5` keeps a focused day
 * clear of the 16 px edge fades.
 */
const SQUARE =
  'h-6 w-6 shrink-0 scroll-mx-5 rounded-[7px] border-2 border-transparent bg-clip-padding ring-1 ring-inset forced-color-adjust-none focus-visible:outline-offset-0'
/**
 * Today: a centre dot in two tones, the text colour haloed in the card's, so it shows on every
 * level in both themes and never looks like the focus ring. (Forced colours also ring today's
 * border in the selection colour, by the shared [aria-current='date'] rule.)
 */
const TODAY_DOT =
  'bg-[image:radial-gradient(circle,var(--text-primary)_2.5px,var(--surface-1)_3px_4px,transparent_4.5px)]'

/**
 * Grid moves in days: ↑ ↓ one day (into the next or previous week), ← → one week, Page four.
 * Home and End run off either end, and the clamp stops them on the first or last day.
 */
const MOVES: Readonly<Record<string, number>> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
  PageUp: -28,
  PageDown: 28,
  Home: -Infinity,
  End: Infinity,
}

interface Day {
  key: DayKey
  level: number
  total: number
  /** "Sat, October 17: S$12.00" / "Thu, October 15: No spending" */
  label: string
}

const levelOf = (total: number, max: number) => {
  if (total <= 0) return 0
  const r = total / max
  if (r < 0.25) return 1
  if (r < 0.5) return 2
  if (r < 0.75) return 3
  return 4
}

/**
 * Fourteen weeks of daily spending as one grid widget: one Tab stop (a roving tabindex that
 * starts on today), arrows / Page / Home / End move between days, Enter on a day with spending
 * opens it in the ledger. Days without spending are plain cells, not buttons that do nothing.
 */
export function Heatmap({ data, today }: { data: HeatmapData; today: DayKey }) {
  const navigate = useNavigate()
  const fmt = useFormatMoney()
  const scroller = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const summaryId = useId()

  // Everything per cell is derived once per data / currency change, by key slicing. The DOM is
  // row-major (one row per weekday) so a screen reader's table navigation matches the picture.
  const { days, rows, months, summary } = useMemo(() => {
    const max = Math.max(...data.days.map((d) => d.total), 1)
    const lead = data.days[0] ? dayOfWeek(data.days[0].date) : 0
    const weekCount = Math.ceil((lead + data.days.length) / 7)
    const byRow: (Day | null)[][] = Array.from({ length: 7 }, () =>
      Array.from({ length: weekCount }, () => null),
    )
    const monthRow: (string | null)[] = Array.from({ length: weekCount }, () => null)
    const list: Day[] = []
    let lastMonth = ''
    let busiest: Day | null = null
    for (const [i, d] of data.days.entries()) {
      const at = lead + i
      const week = Math.floor(at / 7)
      const month = d.date.slice(0, 7)
      if (month !== lastMonth && (at % 7 === 0 || i === 0)) {
        monthRow[week] = monthShortName(month)
        lastMonth = month
      }
      const day: Day = {
        key: d.date,
        level: levelOf(d.total, max),
        total: d.total,
        label: `${weekdayShort(d.date)}, ${longDate(d.date)}: ${d.total > 0 ? fmt(d.total) : 'No spending'}`,
      }
      const row = byRow[at % 7]
      if (row) row[week] = day
      list.push(day)
      if (d.total > 0 && (!busiest || d.total > busiest.total)) busiest = day
    }
    const spent = list.filter((d) => d.total > 0).length
    const text = busiest
      ? `${String(spent)} of ${String(list.length)} days with spending. Busiest: ${weekdayShort(busiest.key)}, ${shortDate(busiest.key)}, ${fmt(busiest.total)}.`
      : `No spending in these ${String(weekCount)} weeks.`
    return { days: list, rows: byRow, months: monthRow, summary: text }
  }, [data, fmt])

  // The one Tab stop: the day last moved to while this window is shown, else today (when the
  // window holds it), else its last day. Another period starts again from its default.
  const range = `${data.start}/${data.end}`
  const [cursor, setCursor] = useState<{ range: string; day: DayKey } | null>(null)
  if (cursor && cursor.range !== range) setCursor(null) // reset during render, before paint
  const fallback = today >= data.start && today <= data.end ? today : data.end
  const activeDay = cursor?.range === range ? cursor.day : fallback
  const activeIndex = Math.max(
    0,
    days.findIndex((d) => d.key === activeDay),
  )
  const active = days[activeIndex]?.key

  // One handler for every day: with it, an arrow key re-renders the two cells whose Tab stop
  // moved, not all 98.
  const openDay = useCallback(
    (key: DayKey) => {
      void navigate(`/ledger?date=${key}`)
    },
    [navigate],
  )

  const focusDay = (key: DayKey) => {
    const cell = grid.current?.querySelector<HTMLElement>(`[data-day="${key}"]`)
    const target = cell?.querySelector<HTMLElement>('button') ?? cell
    if (!target) return
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const step = MOVES[e.key]
    if (step !== undefined) {
      e.preventDefault()
      const day = days[Math.min(days.length - 1, Math.max(0, activeIndex + step))]
      if (day) focusDay(day.key)
      return
    }
    // A day without spending has nothing to open; Space must not scroll the page either.
    if ((e.key === ' ' || e.key === 'Enter') && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
    }
  }

  // The day with focus, read out under the grid as a hover shows its tooltip (so a keyboard sees
  // the amounts, and a tap on a day without spending gets an answer); null while focus is away.
  const [reading, setReading] = useState<DayKey | null>(null)
  const read = reading === null ? undefined : days.find((d) => d.key === reading)

  // Focus arriving on a day by any route (keys, a click, a screen reader) moves the Tab stop.
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const day = e.target.closest<HTMLElement>('[data-day]')?.dataset.day
    setReading(day ?? null)
    if (day !== undefined && day !== activeDay) setCursor({ range, day })
  }
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setReading(null)
  }

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
        <div className={clsx(LABEL_ROWS, 'mr-1 shrink-0 py-1')} aria-hidden="true">
          <span />
          {WEEKDAY_LABELS.map((label, row) => (
            <span
              key={row}
              className="flex w-6 items-center justify-end pr-1 text-[9px] leading-none text-[var(--text-tertiary)]"
            >
              {label}
            </span>
          ))}
        </div>

        <div
          ref={scroller}
          onScroll={readEdges}
          style={{ maskImage: fade, WebkitMaskImage: fade }}
          // Built to scroll sideways (the e2e reflow audit leaves it alone): 14 weeks of 24 px
          // days do not fit a phone under 390 px, and the fade shows there is more.
          data-scroll-x=""
          className="no-scrollbar min-w-0 flex-1 overflow-x-auto"
        >
          <div className="flex w-max flex-col gap-1 p-1">
            <div className="flex h-3" aria-hidden="true">
              {months.map((month, week) => (
                <span
                  key={week}
                  className="flex w-6 shrink-0 items-end whitespace-nowrap text-[9px] font-medium leading-none text-[var(--text-tertiary)]"
                >
                  {month}
                </span>
              ))}
            </div>

            <div
              ref={grid}
              role="grid"
              aria-label={`Daily spending, ${shortDate(data.start)} – ${shortDateYear(data.end)}`}
              aria-describedby={summaryId}
              // Focusable only as the keyboard handler's host; the Tab stop is a day.
              tabIndex={-1}
              onKeyDown={onKeyDown}
              onFocus={onFocus}
              onBlur={onBlur}
              className="flex flex-col"
            >
              {rows.map((cells, row) => (
                <div key={row} role="row" className="flex">
                  {cells.map((day, week) =>
                    day ? (
                      <DayCell
                        key={day.key}
                        day={day}
                        isToday={day.key === today}
                        tabbable={day.key === active}
                        onOpen={openDay}
                      />
                    ) : (
                      // Days after the window's end keep the grid rectangular.
                      <div
                        key={`pad-${String(week)}`}
                        role="gridcell"
                        className="h-6 w-6 shrink-0"
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <p id={summaryId} className="sr-only">
        {summary}
      </p>

      {/* Footer: the range, or the day with focus. The grid's name and the focused day's say the
          same, so this is for the eyes only. */}
      <div
        className="mt-2.5 flex items-center justify-between gap-2 text-[10px] text-[var(--text-tertiary)]"
        aria-hidden="true"
      >
        {read ? (
          <span className="text-[var(--text-secondary)]">
            {`${shortDate(read.key)} · ${read.total > 0 ? fmt(read.total) : 'No spending'}`}
          </span>
        ) : (
          <span>
            {shortDate(data.start)} – {shortDateYear(data.end)}
          </span>
        )}
        <div className="flex items-center gap-1">
          <span>less</span>
          {LEVEL_CLASSES.map((c) => (
            <span
              key={c}
              className={clsx(
                'h-[10px] w-[10px] rounded-[2px] ring-1 ring-inset forced-color-adjust-none',
                c,
              )}
            />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  )
}

/**
 * One day. With spending it is a cell holding a button that opens the day; without, the cell
 * itself is focusable (so arrows can pass through it) and does nothing. Memoised: the day
 * objects are made once per data change and `onOpen` is one stable handler.
 */
const DayCell = memo(function DayCell({
  day,
  isToday,
  tabbable,
  onOpen,
}: {
  day: Day
  isToday: boolean
  tabbable: boolean
  onOpen: (key: DayKey) => void
}) {
  const square = clsx(SQUARE, LEVEL_CLASSES[day.level] ?? LEVEL_CLASSES[0], isToday && TODAY_DOT)

  if (day.total > 0) {
    return (
      <div role="gridcell" data-day={day.key} className="h-6 w-6 shrink-0">
        <button
          type="button"
          // The title is the name (and the hover tooltip), so it is never read twice.
          title={day.label}
          tabIndex={tabbable ? 0 : -1}
          aria-current={isToday ? 'date' : undefined}
          onClick={() => {
            onOpen(day.key)
          }}
          className={clsx(square, 'block cursor-pointer transition-transform hover:scale-125')}
        />
      </div>
    )
  }
  return (
    <div
      role="gridcell"
      data-day={day.key}
      title={day.label}
      tabIndex={tabbable ? 0 : -1}
      aria-current={isToday ? 'date' : undefined}
      className={square}
    />
  )
})
