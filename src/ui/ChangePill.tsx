import { ArrowDown, ArrowUp } from 'lucide-react'
import { Pill } from './Pill'

/**
 * A change between two periods, read the same way on every screen: down is good (positive
 * tone), up is bad (negative tone), and within ±0.5% it is neutral "≈ same as …". Nothing is
 * shown when there is no change to compare (`change === null`).
 */
export function ChangePill({
  change,
  against,
  label,
  digits = 1,
}: {
  change: number | null
  /**
   * What the period is compared with ("Sep 1–18", "previous 7 days"): the neutral wording, and
   * what screen readers hear after the percentage when no `label` is shown.
   */
  against: string
  /** Text after the percentage: "vs Sep 1–18". */
  label?: string
  /** Decimals of the percentage. */
  digits?: number
}) {
  if (change === null) return null
  if (Math.abs(change) < 0.005) return <Pill>≈ same as {against}</Pill>
  const down = change < 0
  // Screen readers hear "Down 32% vs previous 7 days" even when the comparison is not printed.
  return (
    <Pill tone={down ? 'positive' : 'negative'}>
      {down ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
      <span className="sr-only">{down ? 'Down ' : 'Up '}</span>
      {Math.abs(change * 100).toFixed(digits)}%
      {label ? ` ${label}` : <span className="sr-only"> vs {against}</span>}
    </Pill>
  )
}
