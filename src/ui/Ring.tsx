import clsx from 'clsx'

/**
 * Progress ring. `value` is the filled share (clamped to 0-1.2; the stroke tops out at a full
 * circle), `marker` an optional tick at a share of the circle (e.g. the expected pace).
 * Size the ring with `size` (px) or responsively with `className` (`size` then only sets the
 * drawing scale).
 */
export function Ring({
  value,
  size = 56,
  stroke = 5,
  track = 'var(--surface-3)',
  color,
  marker,
  label,
  className,
}: {
  value: number
  size?: number
  stroke?: number
  track?: string
  color?: string
  marker?: number
  label?: React.ReactNode
  className?: string
}) {
  const clamped = Math.max(0, Math.min(1.2, value))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = Math.min(1, clamped) * c
  const center = size / 2

  const autoColor =
    color ??
    (clamped >= 1.1 ? 'var(--negative)' : clamped >= 0.85 ? 'var(--warning)' : 'var(--accent)')

  // The SVG is rotated -90°, so angle 0 (pointing right) lands at 12 o'clock.
  const tick =
    marker === undefined
      ? null
      : (() => {
          const angle = Math.max(0, Math.min(1, marker)) * 2 * Math.PI
          const inner = r - stroke / 2 - 1.5
          const outer = r + stroke / 2 + 1.5
          return {
            x1: center + inner * Math.cos(angle),
            y1: center + inner * Math.sin(angle),
            x2: center + outer * Math.cos(angle),
            y2: center + outer * Math.sin(angle),
          }
        })()

  return (
    <div
      className={clsx('relative inline-flex shrink-0 items-center justify-center', className)}
      style={className ? undefined : { width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        className="h-full w-full -rotate-90 overflow-visible"
        aria-hidden
      >
        <circle cx={center} cy={center} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {/* At 0% a round cap would still paint a dot at 12 o'clock: draw no arc at all. */}
        {dash > 0 && (
          <circle
            cx={center}
            cy={center}
            r={r}
            stroke={autoColor}
            strokeWidth={stroke}
            fill="none"
            strokeDasharray={`${String(dash)} ${String(c)}`}
            strokeLinecap="round"
            className="transition-[stroke-dasharray,stroke] duration-700 ease-out"
          />
        )}
        {tick && (
          <>
            <line {...tick} stroke="var(--marker-edge)" strokeWidth={3.5} strokeLinecap="round" />
            <line {...tick} stroke="var(--marker)" strokeWidth={1.75} strokeLinecap="round" />
          </>
        )}
      </svg>
      {label && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums text-white">
          {label}
        </div>
      )}
    </div>
  )
}
