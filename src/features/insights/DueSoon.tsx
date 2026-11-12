import { CalendarClock } from 'lucide-react'
import { colorFromString } from '../../lib/analytics'
import { shortDate, weekdayShort, type DayKey } from '../../lib/dates'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useHaptic } from '../../hooks/useHaptic'
import { useToast } from '../../hooks/useToast'
import { shieldGesture } from '../../ui/pressShield'
import { Card } from '../../ui/Card'
import type { DueCharge } from '../../utils/recurring'
import { addAndConfirm } from '../entry/expenseForm'

/** "Due today", "Tomorrow", else the weekday and date ("Thu, Nov 19"). */
function dueLabel(charge: DueCharge): string {
  if (charge.inDays === 0) return 'Due today'
  if (charge.inDays === 1) return 'Tomorrow'
  return `${weekdayShort(charge.due)}, ${shortDate(charge.due)}`
}

/**
 * Recurring charges expected in the next days, each with a one-tap Log: the entry is added for
 * today at what it cost the last time, with the usual confirmation and its Undo. Nothing is ever
 * added by itself: every synced device would add its own copy, and the copies would both stay.
 * Shown only while something is due.
 */
export function DueSoon({
  charges,
  today,
  notSpending,
}: {
  charges: readonly DueCharge[]
  today: DayKey
  /** Categories that are not spending: their charges are listed, and say so. */
  notSpending: readonly string[]
}) {
  const fmt = useFormatMoney()
  const toast = useToast()
  const vibrate = useHaptic()
  if (charges.length === 0) return null

  const log = (charge: DueCharge) => {
    const created = addAndConfirm(
      toast,
      vibrate,
      {
        itemName: charge.group.displayName,
        amount: charge.lastAmount,
        category: charge.group.category,
        day: today,
      },
      (added) => `Added "${added.itemName}" · ${fmt(added.amount)}`,
    )
    // Logged, the charge leaves the list and the next one moves up under the pointer: the rest
    // of a double tap must not log that one too.
    if (created !== null) shieldGesture()
  }

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CalendarClock size={14} className="shrink-0 text-accent/80" />
          <h2 className="text-[13px] font-semibold text-white">Due soon</h2>
        </div>
        <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">Next 7 days</span>
      </div>
      <ul className="divide-y divide-white/[0.04]">
        {charges.map((charge) => {
          const { group } = charge
          const amount = fmt(charge.lastAmount)
          return (
            <li key={group.key} className="flex items-center gap-3 py-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colorFromString(group.category) }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-white">{group.displayName}</div>
                <div className="truncate text-[11px] text-[var(--text-tertiary)]">
                  {dueLabel(charge)} · {group.category}
                  {notSpending.includes(group.category) ? ' · not spending' : ''}
                </div>
              </div>
              <span className="shrink-0 font-mono text-[13px] tabular-nums text-white">
                {amount}
              </span>
              <button
                type="button"
                onClick={() => log(charge)}
                aria-label={`Log ${group.displayName}, ${amount}, for today`}
                className="tap-target inline-flex h-9 shrink-0 items-center rounded-[10px] border border-accent/25 bg-accent/10 px-3 text-[12px] font-semibold text-accent transition hover:bg-accent/15"
              >
                Log
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
        Log adds it for today at its last amount, with an Undo. Nothing is added by itself.
      </p>
    </Card>
  )
}
