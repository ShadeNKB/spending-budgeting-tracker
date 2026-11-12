import { Link } from 'react-router-dom'
import { Flag } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { busiestDay, type MonthAnalytics } from '../../lib/analytics'
import { shortDate } from '../../lib/dates'
import { Card } from '../../ui/Card'
import { SectionHeader } from '../../ui/SectionHeader'
import { ledgerEntryHref } from '../ledger/ledgerParams'

const label = 'text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]'
const link =
  'tap-target block truncate text-[13px] font-medium text-white underline decoration-[var(--text-tertiary)] underline-offset-2 transition hover:decoration-[var(--text-secondary)]'
const detail = 'block font-mono text-[12px] tabular-nums text-[var(--text-secondary)]'

/**
 * A finished month in review: its largest entry, the day most was spent, and how many entries
 * made it. Each opens the Ledger where it is. The month's total, its comparison, its budget and
 * its categories are the cards around this one.
 */
export function MonthReview({ month }: { month: MonthAnalytics }) {
  const fmt = useFormatMoney()
  const biggest = month.biggest
  if (biggest === null) return null
  const busiest = busiestDay(month.daily)

  return (
    <Card>
      <SectionHeader icon={Flag} meta={month.label}>
        In review
      </SectionHeader>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className={label}>Biggest expense</dt>
          <dd className="mt-0.5">
            <Link to={ledgerEntryHref(biggest)} className={link}>
              {biggest.itemName}
            </Link>
            <span className={detail}>
              {fmt(biggest.amount)} · {shortDate(biggest.day)}
            </span>
          </dd>
        </div>
        {busiest !== null && (
          <div className="min-w-0">
            <dt className={label}>Busiest day</dt>
            <dd className="mt-0.5">
              <Link to={`/ledger?date=${busiest.date}`} className={link}>
                {shortDate(busiest.date)}
              </Link>
              <span className={detail}>{fmt(busiest.total)}</span>
            </dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className={label}>Entries</dt>
          <dd className="mt-0.5">
            <span className="block text-[13px] font-medium text-white">{month.periodCount}</span>
            <span className={detail}>{fmt(month.dailyAverage)} a day</span>
          </dd>
        </div>
      </dl>
    </Card>
  )
}
