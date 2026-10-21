import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { addDays, shortDate, type DayKey } from '../../lib/dates'

const BAR_H = 64 // px

const KEY_STEP: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 7,
  PageDown: -7,
}

/**
 * The day-by-day forecast as one control: tap, hover or drag anywhere over the bars (the gaps
 * included) to read a day, or focus it and use the arrow keys (Home / End for the first and last
 * day). One tab stop and one card-wide target instead of a tiny button per day, which on a phone
 * would be under 18 px wide. Its description lists every day with a charge, so a screen reader
 * gets the data without stepping through the days.
 */
export function ForecastChart({
  forecast,
  today,
  fmt,
}: {
  forecast: readonly number[]
  today: DayKey
  fmt: (n: number) => string
}) {
  const [active, setActive] = useState<number | null>(null)
  const dueListId = useId()
  const days = forecast.length
  const max = Math.max(...forecast, 1)
  const last = days - 1
  const clamp = (i: number) => Math.min(last, Math.max(0, i))
  const describe = (i: number) => {
    const v = forecast[i] ?? 0
    const day = `${i === 0 ? 'Today, ' : ''}${shortDate(addDays(today, i))}`
    return `${day} · ${v > 0 ? fmt(v) : 'nothing due'}`
  }
  const dayAt = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    return clamp(Math.floor(((e.clientX - box.left) / box.width) * days))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP[e.key]
    const target =
      step !== undefined
        ? (active ?? 0) + step
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? last
            : null
    if (target !== null) {
      e.preventDefault()
      setActive(clamp(target))
    } else if (e.key === 'Escape') {
      setActive(null)
    }
  }
  const shown = active ?? 0
  // Every day with a charge, read with the slider: VoiceOver on iOS cannot step a custom slider.
  const due = forecast.flatMap((v, i) => (v > 0 ? [describe(i)] : []))

  return (
    <>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${String(days)}-day forecast by day`}
        aria-describedby={dueListId}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown}
        aria-valuetext={describe(shown)}
        onPointerDown={(e) => {
          setActive(dayAt(e))
        }}
        onPointerMove={(e) => {
          // Hover with a mouse; with a finger or pen only while pressed (a horizontal drag scrubs).
          if (e.pointerType === 'mouse' || e.buttons !== 0) setActive(dayAt(e))
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setActive(null)
        }}
        onFocus={() => {
          setActive((current) => current ?? 0)
        }}
        onBlur={() => {
          setActive(null)
        }}
        onKeyDown={onKeyDown}
        // The top padding holds the day's label, so it never covers the card's heading.
        className="flex cursor-default touch-pan-y select-none items-end gap-1 rounded-md pt-6 outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        {forecast.map((v, i) => {
          const barPx = v > 0 ? Math.max(3, Math.round((v / max) * BAR_H)) : 2
          const isActive = active === i
          return (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className="relative flex w-full flex-col justify-end" style={{ height: BAR_H }}>
                {isActive && (
                  <span
                    className={`pointer-events-none absolute -top-6 z-10 whitespace-nowrap rounded border border-white/10 bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow ${
                      i < 3 ? 'left-0' : i > days - 4 ? 'right-0' : 'left-1/2 -translate-x-1/2'
                    }`}
                  >
                    {describe(i)}
                  </span>
                )}
                <div
                  className={`w-full rounded-t transition-all ${
                    v > 0
                      ? isActive
                        ? 'bg-accent'
                        : 'bg-gradient-to-t from-accent/40 to-accent/80'
                      : isActive
                        ? 'bg-[var(--chart-bar-strong)]'
                        : 'bg-[var(--chart-bar)]'
                  }`}
                  style={{ height: barPx }}
                />
              </div>
              <span
                aria-hidden
                className={`h-1 w-1 rounded-full ${v > 0 ? 'bg-accent' : 'bg-transparent'}`}
              />
            </div>
          )
        })}
      </div>
      <p id={dueListId} className="sr-only">
        {due.length > 0 ? `Charges due: ${due.join('; ')}.` : 'No charges due.'}
      </p>
    </>
  )
}
