import { useId } from 'react'
import { useChartScrub } from '../../hooks/useChartScrub'
import { addDays, shortDate, type DayKey } from '../../lib/dates'

const BAR_H = 64 // px

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
  const days = forecast.length
  const { active, value, props } = useChartScrub({ count: days })
  const dueListId = useId()
  const max = Math.max(...forecast, 1)
  const describe = (i: number) => {
    const v = forecast[i] ?? 0
    const day = `${i === 0 ? 'Today, ' : ''}${shortDate(addDays(today, i))}`
    return `${day} · ${v > 0 ? fmt(v) : 'nothing due'}`
  }
  // Every day with a charge, read with the slider: VoiceOver on iOS cannot step a custom slider.
  const due = forecast.flatMap((v, i) => (v > 0 ? [describe(i)] : []))

  return (
    <>
      <div
        {...props}
        aria-label={`${String(days)}-day forecast by day`}
        aria-describedby={dueListId}
        aria-valuetext={describe(value)}
        data-chart="forecast"
        // The top padding holds the day's label, so it never covers the card's heading.
        className="flex cursor-default touch-pan-y select-none items-end gap-1 rounded-md pt-6"
      >
        {forecast.map((v, i) => {
          const barPx = v > 0 ? Math.max(3, Math.round((v / max) * BAR_H)) : 2
          const isActive = active === i
          return (
            <div key={i} className="flex flex-1 flex-col items-center gap-1">
              <div className="relative flex w-full flex-col justify-end" style={{ height: BAR_H }}>
                {isActive && (
                  <span
                    aria-hidden="true"
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
