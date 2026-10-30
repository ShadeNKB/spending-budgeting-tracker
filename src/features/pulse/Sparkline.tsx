import { useId } from 'react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { seriesSummary, useChartScrub } from '../../hooks/useChartScrub'

const VB_W = 400
const AXIS_LABEL = 'text-[10px] text-[var(--text-tertiary)]'

/**
 * The axis under a sparkline: its first, middle and last labels, the middle picked the same way
 * on every screen, so one window ("Last 30 days") reads the same on Pulse and Insights.
 */
export function SparklineAxis({
  labels,
  lastLabel,
  highlightLast = false,
  className,
}: {
  labels: readonly string[]
  /** Replaces the last label ("Today"). */
  lastLabel?: string
  /** Accent on the last label: the period runs to today. */
  highlightLast?: boolean
  className?: string
}) {
  return (
    <div className={`mt-1.5 flex justify-between ${className ?? ''}`}>
      <span className={AXIS_LABEL}>{labels[0]}</span>
      <span className={AXIS_LABEL}>{labels[Math.floor((labels.length - 1) / 2)]}</span>
      <span className={highlightLast ? 'text-[10px] text-accent' : AXIS_LABEL}>
        {lastLabel ?? labels.at(-1)}
      </span>
    </div>
  )
}

/**
 * A trend line as one slider (`useChartScrub`): hover, press and drag, or focus and use the
 * arrows to read a point. `label` names it ("Daily spending, last 30 days"); its description
 * gives the total and the peak, so a screen reader hears each once.
 */
export function Sparkline({
  data,
  labels,
  label,
  height = 36,
  stroke = 'var(--accent)',
  fill = 'rgba(34,211,238,0.14)',
  className,
  peakAs,
}: {
  data: readonly number[]
  /** One per point ("Oct 3"): what the slider reads and the tooltip shows. */
  labels: readonly string[]
  /** The chart's accessible name. */
  label: string
  height?: number
  stroke?: string
  fill?: string
  className?: string
  /**
   * How the description names the peak when `labels` are too short for a sentence: the year
   * view's months, "Peak S$512.86 in August" (as the monthly bars say it), not "on Aug".
   */
  peakAs?: { readonly labels: readonly string[]; readonly preposition: 'on' | 'in' }
}) {
  const fmt = useFormatMoney()
  const { active, value, props } = useChartScrub({ count: data.length, scale: 'point' })
  const summaryId = useId()

  if (!data.length) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const step = VB_W / Math.max(1, data.length - 1)
  const points = data.map((v, i) => {
    const x = i * step
    const y = height - ((v - min) / range) * (height - 2) - 1
    return [x, y] as const
  })
  const path = points.map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`)).join(' ')
  const area = `${path} L${VB_W},${height} L0,${height} Z`

  const lastPoint = points[points.length - 1]
  const activePoint = active !== null ? points[active] : undefined
  const activeValue = active !== null ? data[active] : undefined
  const activeLabel = active !== null ? labels[active] : undefined
  // Left edge on the first point, right edge on the last, centred between: never off the card.
  const tipPct = activePoint ? (activePoint[0] / VB_W) * 100 : 0

  return (
    <>
      <div
        {...props}
        aria-label={label}
        aria-describedby={summaryId}
        aria-valuetext={`${labels[value] ?? ''} · ${fmt(data[value] ?? 0)}`}
        data-chart="trend"
        className={`relative w-full cursor-crosshair touch-pan-y select-none rounded-md ${className ?? ''}`}
        style={{ height }}
      >
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${VB_W} ${height}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 w-full overflow-visible"
          style={{ height }}
        >
          <path d={area} fill={fill} />
          <path
            d={path}
            fill="none"
            stroke={stroke}
            strokeWidth={1.8}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {lastPoint && <circle cx={lastPoint[0]} cy={lastPoint[1]} r={3} fill={stroke} />}
          {activePoint && (
            <>
              <line
                x1={activePoint[0]}
                y1={0}
                x2={activePoint[0]}
                y2={height}
                stroke="var(--chart-axis)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={activePoint[0]}
                cy={activePoint[1]}
                r={4}
                fill={stroke}
                stroke="var(--chart-axis-strong)"
                strokeWidth={1.5}
              />
            </>
          )}
        </svg>
        {activePoint && activeValue !== undefined && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-full mb-1 whitespace-nowrap rounded-md border border-white/10 bg-surface-3 px-2 py-1 shadow-lg"
            style={{ left: `${String(tipPct)}%`, transform: `translateX(-${String(tipPct)}%)` }}
          >
            {activeLabel && (
              <div className="text-[10px] text-[var(--text-tertiary)]">{activeLabel}</div>
            )}
            <div className="font-mono text-[11px] font-semibold tabular-nums text-white">
              {fmt(activeValue)}
            </div>
          </div>
        )}
      </div>
      <p id={summaryId} className="sr-only">
        {seriesSummary(data, (i) => (peakAs?.labels ?? labels)[i] ?? '', fmt, peakAs?.preposition)}
      </p>
    </>
  )
}
