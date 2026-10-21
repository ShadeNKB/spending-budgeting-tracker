import type { ReactNode } from 'react'
import clsx from 'clsx'
import { TrendingUp } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { Ring } from '../../ui/Ring'
import type { BudgetStatus, BudgetSummary } from '../../lib/analytics'

const STATUS_COLOR: Record<BudgetStatus, string> = {
  onTrack: 'var(--accent)',
  ahead: 'var(--warning)',
  over: 'var(--negative)',
}

const STATUS_TEXT: Record<BudgetStatus, string> = {
  onTrack: 'On track',
  ahead: 'Ahead of pace',
  over: 'Over budget',
}

const percent = (share: number) => `${String(Math.min(999, Math.round(share * 100)))}%`

/**
 * Facts on one line, dot-separated, wrapping without a dangling dot: each fact carries its dot in
 * front, and the row is pulled left by the dot's width inside a clipping box, so the dot of a fact
 * that starts a line falls outside and is cut off. md+: one fact per line, no dots.
 */
function Facts({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('overflow-hidden', className)}>
      <div className="-ml-3 flex flex-wrap md:ml-0 md:flex-col md:items-center">{children}</div>
    </div>
  )
}

const fact =
  "relative whitespace-nowrap pl-3 before:absolute before:left-0 before:w-3 before:text-center before:text-[var(--text-tertiary)] before:content-['·'] md:pl-0 md:before:hidden"

/**
 * This month's budget: the share of the cap used (budgeted categories only), a tick where
 * spending would be if it were spread evenly, what is left and what that allows per day.
 * Ahead of pace and over budget are spelled out, never shown by colour alone.
 * Mobile: a compact one-row strip. md+: a 74 px ring beside the hero total, one fact per line.
 */
export function PaceRing({ budget, daysLeft }: { budget: BudgetSummary; daysLeft: number }) {
  const fmt = useFormatMoney()
  const over = budget.spent - budget.cap
  const lastDay = daysLeft === 1
  const daysText = lastDay ? 'Last day' : `${String(daysLeft)} days left`
  const perDay = budget.perDay ?? 0
  const projected = budget.status === 'ahead' ? budget.projected : null
  const label = [
    `Budget ${percent(budget.used)} used: ${fmt(budget.spent)} of ${fmt(budget.cap)}.`,
    projected === null
      ? `${STATUS_TEXT[budget.status]}.`
      : `${STATUS_TEXT.ahead}: projected ${fmt(projected)}.`,
    over > 0
      ? `Over by ${fmt(over)}.`
      : lastDay
        ? `${fmt(budget.left)} left today, the last day.`
        : `${fmt(budget.left)} left, ${fmt(perDay)} a day, ${daysText.toLowerCase()}.`,
    `The tick marks an even pace: ${percent(budget.expected)} of the budget by today.`,
    budget.unbudgeted > 0 ? 'Budgeted categories only.' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      role="img"
      aria-label={label}
      className="flex items-center gap-3 md:w-[150px] md:flex-col md:gap-2 md:text-center"
    >
      <Ring
        value={budget.used}
        marker={budget.expected}
        color={STATUS_COLOR[budget.status]}
        size={74}
        stroke={6}
        className="h-11 w-11 md:h-[74px] md:w-[74px]"
        label={<span className="text-[10px] md:text-[13px]">{percent(budget.used)}</span>}
      />
      <div className="min-w-0 text-[12px] leading-snug">
        {over > 0 ? (
          <div className="font-medium text-negative">
            Over by <span className="font-mono tabular-nums">{fmt(over)}</span>
          </div>
        ) : lastDay ? (
          // One day left: "left" and "per day" would be the same figure twice.
          <div className="text-white">
            <span className="font-mono tabular-nums">{fmt(budget.left)}</span> left today
          </div>
        ) : (
          <Facts className="text-white">
            <span className={fact}>
              <span className="font-mono tabular-nums">{fmt(budget.left)}</span> left
            </span>
            <span className={fact}>
              <span className="font-mono tabular-nums">{fmt(perDay)}</span>
              <span className="text-[var(--text-secondary)]">/day</span>
            </span>
          </Facts>
        )}
        {projected !== null && (
          <Facts className="text-[11px] font-medium text-warning">
            <span className={fact}>
              <TrendingUp size={11} className="mr-1 inline-block align-[-1px]" aria-hidden />
              Ahead of pace
            </span>
            <span className={fact}>
              projected <span className="font-mono tabular-nums">{fmt(projected)}</span>
            </span>
          </Facts>
        )}
        <Facts className="text-[11px] text-[var(--text-tertiary)]">
          <span className={fact}>
            of <span className="font-mono tabular-nums">{fmt(budget.cap)}</span>
          </span>
          <span className={fact}>{daysText}</span>
        </Facts>
        {budget.unbudgeted > 0 && (
          <div className="text-[10px] text-[var(--text-tertiary)]">Budgeted categories only</div>
        )}
      </div>
    </div>
  )
}

/** A finished month's budget result: no ring, no pace, just spent vs cap. */
export function BudgetFinal({ budget }: { budget: BudgetSummary }) {
  const fmt = useFormatMoney()
  const over = budget.spent - budget.cap
  return (
    <div className="rounded-xl border border-white/[0.06] bg-surface-2/55 p-3 md:w-[190px]">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
        Budget · Final
      </div>
      <div className="mt-1 text-[13px] text-white">
        <span className="font-mono tabular-nums">{fmt(budget.spent)}</span>
        <span className="text-[var(--text-secondary)]"> of </span>
        <span className="font-mono tabular-nums">{fmt(budget.cap)}</span>
      </div>
      <div
        className={clsx(
          'mt-0.5 text-[12px]',
          over > 0 ? 'font-medium text-negative' : 'text-[var(--text-secondary)]',
        )}
      >
        {over > 0 ? (
          <>
            Over by <span className="font-mono tabular-nums">{fmt(over)}</span>
          </>
        ) : (
          <>
            <span className="font-mono tabular-nums">{fmt(budget.left)}</span> under
          </>
        )}
      </div>
      {budget.unbudgeted > 0 && (
        <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
          Budgeted categories only
        </div>
      )}
    </div>
  )
}
