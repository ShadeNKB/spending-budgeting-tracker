import { useState } from 'react'
import { useFormatMoney } from '../../hooks/useFormatMoney'

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

export function Sparkline({
  data,
  labels,
  height = 36,
  stroke = 'var(--accent)',
  fill = 'rgba(34,211,238,0.14)',
  className,
}: {
  data: readonly number[]
  labels?: readonly string[]
  height?: number
  stroke?: string
  fill?: string
  className?: string
}) {
  const [tooltip, setTooltip] = useState<{ i: number; x: number; y: number } | null>(null)
  const fmt = useFormatMoney()

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
  const hoveredPoint = tooltip !== null ? points[tooltip.i] : undefined
  const hoveredVal = tooltip !== null ? data[tooltip.i] : undefined
  const hoveredLabel = tooltip !== null && labels ? labels[tooltip.i] : null
  const total = data.reduce((sum, value) => sum + value, 0)
  // The drawing scales to at least 1; the words use the data itself, so an empty period never
  // reads as having a peak.
  const peak = Math.max(...data)
  const peakLabel = labels?.[data.indexOf(peak)]
  const chartLabel =
    peak > 0
      ? `Trend chart. Total ${fmt(total)}. Peak ${fmt(peak)}${peakLabel ? ` on ${peakLabel}` : ''}.`
      : 'Trend chart. No spending in this period.'

  return (
    <div className={`relative w-full ${className ?? ''}`} style={{ height }}>
      <svg
        role="img"
        aria-label={chartLabel}
        viewBox={`0 0 ${VB_W} ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 w-full overflow-visible"
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
        {/* Hover indicator */}
        {hoveredPoint && (
          <>
            <line
              x1={hoveredPoint[0]}
              y1={0}
              x2={hoveredPoint[0]}
              y2={height}
              stroke="var(--chart-axis)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle
              cx={hoveredPoint[0]}
              cy={hoveredPoint[1]}
              r={4}
              fill={stroke}
              stroke="var(--chart-axis-strong)"
              strokeWidth={1.5}
            />
          </>
        )}
        {/* Invisible hover targets for each data point */}
        {points.map(([x, y], i) => {
          const hitW = step
          const hitX = Math.max(0, x - hitW / 2)
          return (
            <rect
              key={i}
              x={hitX}
              y={0}
              width={hitW}
              height={height}
              fill="transparent"
              onMouseEnter={() => setTooltip({ i, x, y })}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => setTooltip((current) => (current?.i === i ? null : { i, x, y }))}
              style={{ cursor: 'crosshair' }}
            />
          )
        })}
      </svg>
      <span className="sr-only">{chartLabel}</span>
      {/* Tooltip bubble */}
      {tooltip !== null && hoveredVal !== undefined && (
        <div
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-surface-3 px-2 py-1 shadow-lg"
          style={{ left: `${(tooltip.x / VB_W) * 100}%` }}
        >
          {hoveredLabel && (
            <div className="text-[10px] text-[var(--text-tertiary)]">{hoveredLabel}</div>
          )}
          <div className="font-mono text-[11px] font-semibold tabular-nums text-white">
            {fmt(hoveredVal)}
          </div>
        </div>
      )}
    </div>
  )
}
