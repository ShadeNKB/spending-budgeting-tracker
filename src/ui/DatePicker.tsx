import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react'
import clsx from 'clsx'
import { useToday } from '../hooks/useToday'
import { useModalLayer } from './modalLayer'
import { LayerAnnouncer } from './LayerAnnouncer'
import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInMonth,
  keyDay,
  keyYear,
  longDate,
  makeKey,
  monthKeyOf,
  monthLabel,
  monthRange,
  shortDate,
  shortDateYear,
  sundayOnOrBefore,
  type DayKey,
  type MonthKey,
} from '../lib/dates'

const WEEKDAYS = [
  ['Su', 'Sunday'],
  ['Mo', 'Monday'],
  ['Tu', 'Tuesday'],
  ['We', 'Wednesday'],
  ['Th', 'Thursday'],
  ['Fr', 'Friday'],
  ['Sa', 'Saturday'],
] as const

interface DatePickerProps {
  /** yyyy-MM-dd string */
  value: string
  onChange: (val: string) => void
  /** yyyy-MM-dd max date (inclusive) */
  max?: string
  /** yyyy-MM-dd min date (inclusive) */
  min?: string
  /** Render as a pill chip (for inline preset rows) or as a full input field */
  variant?: 'pill' | 'input'
  placeholder?: string
  /** Extra classes on the trigger */
  className?: string
  /**
   * Highlight this trigger as active (pill variant). An inactive pill reads its placeholder: its
   * day is shown by the control beside it (a pressed preset), and the calendar still opens on
   * that day and marks it.
   */
  active?: boolean
  /** What the date is for ("From"): names the trigger "From, …" and the calendar "Choose From date". */
  label?: string
}

/** Previous / next month: 40 px, with a 44 px hit area on touch screens. */
const MONTH_BUTTON =
  'tap-target flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-secondary)] transition hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-25'

/** 7 days of 44 px, plus the 12 px padding and the 1 px border each side. */
const CALENDAR_WIDTH = 334
const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 6

/** "Saturday, October 3, 2026" */
const dayName = (key: DayKey): string =>
  `${WEEKDAYS[dayOfWeek(key)]?.[1] ?? ''}, ${longDate(key)}, ${String(keyYear(key))}`

/** The same day `n` months on, clamped to that month's length (Jan 31 + 1 → Feb 28). */
function shiftMonths(key: DayKey, n: number): DayKey {
  const month = addMonths(monthKeyOf(key), n)
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return makeKey(y, m, Math.min(keyDay(key), daysInMonth(y, m)))
}

const clampKey = (key: DayKey, min: DayKey | undefined, max: DayKey | undefined): DayKey =>
  min !== undefined && key < min ? min : max !== undefined && key > max ? max : key

/** The month's weeks, Sunday first; days of the neighbouring months are null. */
function weeksOf(month: MonthKey): (DayKey | null)[][] {
  const { start, end } = monthRange(month)
  const weeks: (DayKey | null)[][] = []
  let day = sundayOnOrBefore(start)
  while (day <= end) {
    const week: (DayKey | null)[] = []
    for (let i = 0; i < 7; i++) {
      week.push(monthKeyOf(day) === month ? day : null)
      day = addDays(day, 1)
    }
    weeks.push(week)
  }
  return weeks
}

/**
 * Below the trigger if it fits, else above, else pinned inside the viewport (scrolling inside):
 * never past the screen edges, at any width down to 320 px.
 */
function place(popover: HTMLElement, trigger: HTMLElement, variant: 'pill' | 'input'): void {
  const rect = trigger.getBoundingClientRect()
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth
  const viewportHeight = window.innerHeight
  const preferred = variant === 'input' ? Math.max(rect.width, CALENDAR_WIDTH) : CALENDAR_WIDTH
  const width = Math.min(preferred, viewportWidth - 2 * VIEWPORT_MARGIN)
  popover.style.width = `${String(width)}px`
  popover.style.maxHeight = ''
  const height = popover.offsetHeight

  let top: number
  if (rect.bottom + TRIGGER_GAP + height <= viewportHeight - VIEWPORT_MARGIN) {
    top = rect.bottom + TRIGGER_GAP
  } else if (rect.top - TRIGGER_GAP - height >= VIEWPORT_MARGIN) {
    top = rect.top - TRIGGER_GAP - height
  } else {
    top = Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - height)
    popover.style.maxHeight = `${String(viewportHeight - 2 * VIEWPORT_MARGIN)}px`
  }
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, viewportWidth - VIEWPORT_MARGIN - width),
  )
  popover.style.top = `${String(top)}px`
  popover.style.left = `${String(left)}px`
}

/**
 * A date field with an APG "date picker dialog": the calendar is its own modal layer (Escape
 * closes it and nothing under it; Tab stays inside), opens with focus in the grid, and is fully
 * keyboard operable: arrows ±1 day / ±1 week, Home/End start/end of the week, PageUp/PageDown
 * ±1 month, Shift+PageUp/PageDown ±1 year, Enter/Space pick. Every step is on day keys, so time
 * zones and daylight-saving changes cannot skip or repeat a day.
 */
export function DatePicker({
  value,
  onChange,
  max,
  min,
  variant = 'input',
  placeholder = 'Pick date',
  className = '',
  active,
  label,
}: DatePickerProps) {
  const pickerId = useId()
  const headingId = useId()
  const today = useToday()
  const [open, setOpen] = useState(false)
  const [focusKey, setFocusKey] = useState<DayKey>(today)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  // Set by a key or button that moves the active day: focus follows it after the render.
  const focusDayRef = useRef(false)

  const lo = min === '' ? undefined : min
  const hi = max === '' ? undefined : max
  const enabled = (key: DayKey) =>
    (lo === undefined || key >= lo) && (hi === undefined || key <= hi)
  const activeKey = clampKey(focusKey, lo, hi)
  const month = monthKeyOf(activeKey)
  const previousMonth = addMonths(month, -1)
  const nextMonth = addMonths(month, 1)
  const canGoBack = lo === undefined || monthRange(previousMonth).end >= lo
  const canGoForward = hi === undefined || monthRange(nextMonth).start <= hi

  const dayButton = (key: DayKey) =>
    popoverRef.current?.querySelector<HTMLElement>(`[data-day="${key}"]`) ?? null

  const close = () => {
    setOpen(false)
  }
  const select = (key: DayKey) => {
    if (!enabled(key)) return
    onChange(key)
    setOpen(false)
  }
  const openCalendar = () => {
    const start = value !== '' && enabled(value) ? value : enabled(today) ? today : value || today
    setFocusKey(clampKey(start, lo, hi))
    setOpen(true)
  }

  useModalLayer(open, {
    ref: popoverRef,
    onEscape: close,
    initialFocus: () => dayButton(activeKey),
  })

  // Placed before paint, from the calendar's real size (5 or 6 weeks), then kept beside its
  // trigger on every frame the trigger or the viewport moves: a sheet still sliding in, a scroll,
  // the phone keyboard. The calendar's own scrolling (pinned on a short screen) moves neither, so
  // it is never placed again under the finger.
  useLayoutEffect(() => {
    const popover = popoverRef.current
    const trigger = triggerRef.current
    if (!open || !popover || !trigger) return
    let placedFor = ''
    let frame = 0
    const follow = () => {
      const { left, top } = trigger.getBoundingClientRect()
      const now = [left, top, window.innerWidth, window.innerHeight].join()
      if (now !== placedFor) {
        placedFor = now
        place(popover, trigger, variant)
      }
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [open, variant, month])

  useLayoutEffect(() => {
    if (!focusDayRef.current) return
    focusDayRef.current = false
    dayButton(activeKey)?.focus()
  }, [activeKey])

  // A press outside closes the calendar and leaves the press to whatever it landed on.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  const moveTo = (key: DayKey) => {
    const next = clampKey(key, lo, hi)
    if (next === activeKey) return
    focusDayRef.current = true
    setFocusKey(next)
  }

  const onDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: DayKey) => {
    // Shift picks a year with PageUp/PageDown; other modifiers belong to the browser and the app
    // (Alt+Left goes back, Ctrl+K opens the palette).
    if (event.altKey || event.ctrlKey || event.metaKey) return
    switch (event.key) {
      case 'ArrowLeft':
        moveTo(addDays(key, -1))
        break
      case 'ArrowRight':
        moveTo(addDays(key, 1))
        break
      case 'ArrowUp':
        moveTo(addDays(key, -7))
        break
      case 'ArrowDown':
        moveTo(addDays(key, 7))
        break
      case 'Home':
        moveTo(addDays(key, -dayOfWeek(key)))
        break
      case 'End':
        moveTo(addDays(key, 6 - dayOfWeek(key)))
        break
      case 'PageUp':
        moveTo(shiftMonths(key, event.shiftKey ? -12 : -1))
        break
      case 'PageDown':
        moveTo(shiftMonths(key, event.shiftKey ? 12 : 1))
        break
      case 'Enter':
      case ' ':
        // Handled here, not by the button's own click: a held key must pick once.
        if (!event.repeat) select(key)
        break
      default:
        return
    }
    event.preventDefault()
  }

  const goToMonth = (step: -1 | 1) => {
    const next = clampKey(shiftMonths(activeKey, step), lo, hi)
    const target = monthKeyOf(next)
    // The pressed button turns disabled at the end of the range: carry focus to the day.
    const stillEnabled =
      step === -1
        ? lo === undefined || monthRange(addMonths(target, -1)).end >= lo
        : hi === undefined || monthRange(addMonths(target, 1)).start <= hi
    if (!stillEnabled) focusDayRef.current = true
    setFocusKey(next)
  }

  // The day the trigger shows: none on an inactive pill, whose day a pressed preset shows.
  const shown = variant === 'pill' && active === false ? '' : value
  const displayStr = shown ? shortDateYear(shown) : placeholder
  // The pill keeps to "Oct 17" this year and shows the year for any other ("Dec 31, 2025").
  const pillStr = !shown
    ? placeholder
    : keyYear(shown) === keyYear(today)
      ? shortDate(shown)
      : displayStr
  const pillIsActive = active ?? (variant === 'pill' && !!value)
  const currentName = shown ? `Change date, selected ${displayStr}` : placeholder
  const triggerName = label ? `${label}, ${currentName}` : currentName

  const calendar = open
    ? createPortal(
        <div
          id={pickerId}
          ref={popoverRef}
          role="dialog"
          aria-modal="true"
          aria-label={label ? `Choose ${label} date` : 'Choose date'}
          tabIndex={-1}
          // Position and width are set before paint by place(). The level all layers share:
          // portaled to the end of <body> as it opens, it is drawn over the sheet it belongs to.
          // 8 px of side padding under 360 px keeps the days 40 px wide on a 320 px screen.
          className="fixed left-2 top-2 z-[96] select-none scroll-py-2 overflow-y-auto rounded-2xl border border-white/[0.1] bg-surface-1 px-2 py-3 shadow-[var(--shadow-overlay)] min-[360px]:px-3"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                goToMonth(-1)
              }}
              disabled={!canGoBack}
              aria-label={`Previous month, ${monthLabel(previousMonth)}`}
              className={MONTH_BUTTON}
            >
              <ChevronLeft size={16} aria-hidden />
            </button>
            <h2
              id={headingId}
              aria-live="polite"
              className="text-[14px] font-semibold tracking-tight text-white"
            >
              {monthLabel(month)}
            </h2>
            <button
              type="button"
              onClick={() => {
                goToMonth(1)
              }}
              disabled={!canGoForward}
              aria-label={`Next month, ${monthLabel(nextMonth)}`}
              className={MONTH_BUTTON}
            >
              <ChevronRight size={16} aria-hidden />
            </button>
          </div>

          <table role="grid" aria-labelledby={headingId} className="w-full table-fixed">
            <thead>
              <tr>
                {WEEKDAYS.map(([short, long]) => (
                  <th
                    key={long}
                    scope="col"
                    abbr={long}
                    className="pb-1 text-center text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]"
                  >
                    {short}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeksOf(month).map((week) => (
                <tr key={week.find((d) => d !== null) ?? ''}>
                  {week.map((day, i) =>
                    day === null ? (
                      <td key={`pad-${String(i)}`} />
                    ) : (
                      <td key={day} role="gridcell" aria-selected={day === value} className="p-0">
                        <button
                          type="button"
                          data-day={day}
                          tabIndex={day === activeKey ? 0 : -1}
                          disabled={!enabled(day)}
                          aria-label={dayName(day)}
                          aria-current={day === today ? 'date' : undefined}
                          onClick={() => {
                            select(day)
                          }}
                          onKeyDown={(event) => {
                            onDayKeyDown(event, day)
                          }}
                          className={clsx(
                            'flex h-11 w-full items-center justify-center rounded-lg text-[14px] transition',
                            day === value
                              ? 'bg-accent font-bold text-[#0a0f1a] shadow-[0_0_10px_-2px_rgba(34,211,238,0.6)]'
                              : !enabled(day)
                                ? 'cursor-not-allowed text-white/15'
                                : day === today
                                  ? 'border border-accent/50 font-semibold text-accent hover:bg-accent/10'
                                  : 'font-medium text-white/80 hover:bg-white/[0.08] hover:text-white',
                          )}
                        >
                          {keyDay(day)}
                        </button>
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-2 flex items-center justify-between border-t border-white/[0.05] pt-2">
            <button
              type="button"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className="tap-target h-10 rounded-lg px-3 text-[13px] text-[var(--text-secondary)] transition hover:bg-white/[0.06] hover:text-white"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => {
                select(today)
              }}
              disabled={!enabled(today)}
              className="tap-target h-10 rounded-lg px-3 text-[13px] font-semibold text-accent transition hover:bg-accent/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            >
              Today
            </button>
          </div>
          <LayerAnnouncer />
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) close()
          else openCalendar()
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        aria-label={triggerName}
        className={
          variant === 'pill'
            ? clsx(
                'tap-target inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition',
                pillIsActive
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white',
                className,
              )
            : clsx(
                'tap-target inline-flex h-10 w-full items-center gap-2.5 rounded-[10px] border bg-surface-2 px-3 text-[13px] transition hover:border-accent/40',
                open ? 'border-accent/50' : 'border-white/[0.08]',
                className,
              )
        }
      >
        {variant === 'pill' ? (
          <>
            <CalendarDays size={11} aria-hidden />
            {pillStr}
          </>
        ) : (
          <>
            <CalendarDays size={13} className="shrink-0 text-accent/60" aria-hidden />
            <span className={value ? 'text-white' : 'text-[var(--text-tertiary)]'}>
              {displayStr}
            </span>
          </>
        )}
      </button>

      {calendar}
    </>
  )
}
