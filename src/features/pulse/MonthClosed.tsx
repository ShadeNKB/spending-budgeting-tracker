import { useState } from 'react'
import { CalendarCheck, X } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import type { MonthAnalytics } from '../../lib/analytics'
import { safeSet } from '../../services/storage'

/**
 * The month whose close this device has shown (`yyyy-MM`). `spendtrack:*`, so Remove from this
 * device clears it too. Kept per device: each one says it once.
 */
export const RECAP_SEEN_KEY = 'spendtrack:recap-seen'

/** The stored month, or null when there is none or storage refused. */
function readSeen(): string | null {
  try {
    return localStorage.getItem(RECAP_SEEN_KEY)
  } catch {
    return null
  }
}

/** "8.0% less than September", "12.5% more than September", "the same as September". */
function againstBefore(month: MonthAnalytics): string | null {
  const change = month.comparison.changePct
  if (change === null) return null
  if (Math.abs(change) < 0.005) return `the same as ${month.comparison.against}`
  const share = (Math.abs(change) * 100).toFixed(1)
  return `${share}% ${change < 0 ? 'less' : 'more'} than ${month.comparison.against}`
}

/**
 * The first days of a month: last month is closed, and this says how it ended, once. "See it"
 * turns Pulse to that month, where its figures and its review are; the × puts the card away.
 * Either way the month counts as seen on this device.
 */
export function MonthClosed({
  month,
  onSee,
}: {
  /** Last month, final. */
  month: MonthAnalytics
  onSee: () => void
}) {
  const fmt = useFormatMoney()
  const [seen, setSeen] = useState(readSeen)
  if (seen === month.monthKey || month.periodCount === 0) return null

  const markSeen = () => {
    safeSet(RECAP_SEEN_KEY, month.monthKey)
    setSeen(month.monthKey)
  }
  const budget = month.budget
  // Category caps measure their own categories only: the words must not read as the whole month's.
  const measure = budget?.scope === 'all' ? 'budget' : 'its category caps'
  const facts = [
    againstBefore(month),
    budget === null
      ? null
      : budget.spent > budget.cap
        ? `${fmt(budget.spent - budget.cap)} over ${measure}`
        : `${fmt(budget.left)} under ${measure}`,
  ].filter((fact): fact is string => fact !== null)

  return (
    // On a phone the words take the card's width, with the × in its corner and See under them:
    // beside two buttons they were a column three words wide at 320 px. From md, one row.
    <section
      aria-label={`${month.monthName} in review`}
      className="relative rounded-2xl border border-accent/15 bg-accent/[0.035] p-3 md:flex md:items-center md:gap-3 md:p-4"
    >
      <div className="flex min-w-0 items-start gap-3 max-md:pr-9 md:flex-1 md:items-center">
        <span
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
        >
          <CalendarCheck size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-white">
            {month.monthName} closed at{' '}
            <span className="font-mono tabular-nums">{fmt(month.periodTotal)}</span>
          </h2>
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {facts.length > 0
              ? `${facts.join(' · ')}.`
              : `${String(month.periodCount)} ${month.periodCount === 1 ? 'entry' : 'entries'}.`}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          markSeen()
          onSee()
        }}
        className="tap-target inline-flex h-9 shrink-0 items-center rounded-[10px] border border-accent/25 bg-accent/10 px-3 text-[12px] font-semibold text-accent transition hover:bg-accent/15 max-md:ml-11 max-md:mt-2"
      >
        See {month.monthName}
      </button>
      <button
        type="button"
        onClick={markSeen}
        aria-label={`Dismiss ${month.monthName} in review`}
        className="tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white max-md:absolute max-md:right-2 max-md:top-2"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </section>
  )
}
