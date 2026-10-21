import { useEffect, useRef, useState } from 'react'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Counts up to `value`. With reduced motion it renders the final value from the first paint.
 * A new value mid-animation continues from the number currently shown (no jump back).
 */
export function AnimatedNumber({
  value,
  duration = 650,
  format = (n) => n.toFixed(2),
  className,
}: {
  value: number
  duration?: number
  format?: (n: number) => string
  className?: string
}) {
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0))
  const shown = useRef(display)

  useEffect(() => {
    if (prefersReducedMotion()) {
      shown.current = value
      setDisplay(value)
      return
    }
    const start = performance.now()
    const from = shown.current
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const next = from + (value - from) * (1 - Math.pow(1 - t, 3))
      shown.current = next
      setDisplay(next)
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [value, duration])

  return <span className={className}>{format(display)}</span>
}
