import { Link } from 'react-router-dom'
import { Flag } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { busiestDay, type MonthAnalytics } from '../../lib/analytics'
import { shortDate } from '../../lib/dates'
import { Card } from '../../ui/Card'
import { SectionHeader } from '../../ui/SectionHeader'
import { ledgerEntryHref } from '../ledger/ledgerParams'

const label = 'text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]'
// One step up on a phone, as the rows of the cards around it (F-108).
const value = 'text-[13px] font-medium text-white min-[360px]:max-md:text-[14px]'
// The name is cut in a span of its own: `truncate` on the link would clip its 44 px touch area
// (.tap-target::after) down to the height of the text.
const link = `tap-target block underline decoration-[var(--text-tertiary)] underline-offset-2 transition hover:decoration-current ${value}`
const detail = 'block font-mono text-[12px] tabular-nums text-[var(--text-secondary)]'

/**
 * A finished month in review: its largest entry, the day most was spent, and how many entries
 * made it on how many days. The first two open the Ledger where they are. The month's total, its
 * comparison, its budget and its categories are the cards around this one.
 */
export function MonthReview({ month }: { month: MonthAnalytics }) {
  const fmt = useFormatMoney()
  const biggest = month.biggest
  if (biggest === null) return null
  const biggestDay = busiestDay(month.daily)
  const daysWithSpending = month.daily.filter((d) => d.total > 0).length

  return (
    <Card>
      <SectionHeader icon={Flag} meta={month.label}>
        Month in review
      </SectionHeader>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className={label}>Biggest expense</dt>
          <dd className="mt-0.5">
            <Link to={ledgerEntryHref(biggest)} className={link}>
              <span className="block truncate">{biggest.itemName}</span>
            </Link>
            <span className={detail}>
              {fmt(biggest.amount)} · {shortDate(biggest.day)}
            </span>
          </dd>
        </div>
        {biggestDay !== null && (
          <div className="min-w-0">
            <dt className={label}>Biggest day</dt>
            <dd className="mt-0.5">
              <Link to={`/ledger?date=${biggestDay.date}`} className={link}>
                <span className="block truncate">{shortDate(biggestDay.date)}</span>
              </Link>
              <span className={detail}>{fmt(biggestDay.total)}</span>
            </dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className={label}>Entries</dt>
          <dd className="mt-0.5">
            <span className={`block ${value}`}>{month.periodCount}</span>
            <span className={detail}>
              on {daysWithSpending} of {month.daysInPeriod} days
            </span>
          </dd>
        </div>
      </dl>
    </Card>
  )
}
