import { useEffect, useRef } from 'react'
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

/** "Today", "Tomorrow", else the weekday and date ("Tue, Oct 20"): the card's title says "due". */
function dueLabel(charge: DueCharge): string {
  if (charge.inDays === 0) return 'Today'
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
  const list = useRef<HTMLUListElement>(null)
  // A logged charge leaves the list, and the button that was pressed with it. Focus goes to the
  // Log that took its place, else to the one before, else to the screen: never to <body>.
  const refocus = useRef<number | null>(null)
  useEffect(() => {
    const at = refocus.current
    if (at === null) return
    refocus.current = null
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button')
    const next = buttons?.[Math.min(at, buttons.length - 1)]
    if (next) next.focus({ preventScroll: true })
    else document.getElementById('main')?.focus({ preventScroll: true })
  })
  if (charges.length === 0) return null

  const log = (charge: DueCharge, at: number) => {
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
    if (created === null) return
    // The next charge moves up under the pointer: the rest of a double tap must not log it too.
    shieldGesture()
    refocus.current = at
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
      <ul ref={list} className="divide-y divide-white/[0.04]">
        {charges.map((charge, at) => {
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
                </div>
              </div>
              {/* Under the amount, as a Ledger row has it: at the end of the line above it was
                  the first thing a narrow screen cut off. */}
              <span className="shrink-0 text-right">
                <span className="block font-mono text-[13px] tabular-nums text-white">
                  {amount}
                </span>
                {notSpending.includes(group.category) && (
                  <span className="block text-[11px] text-[var(--text-tertiary)]">
                    not spending
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => log(charge, at)}
                aria-label={`Log ${group.displayName}, ${amount}, for today`}
                className="tap-target inline-flex h-9 shrink-0 items-center rounded-[10px] border border-accent/25 bg-accent/10 px-3 text-[12px] font-semibold text-accent transition hover:bg-accent/15"
              >
                Log
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
        Log adds it for today at its last amount, with an Undo. Nothing is added on its own.
      </p>
    </Card>
  )
}
