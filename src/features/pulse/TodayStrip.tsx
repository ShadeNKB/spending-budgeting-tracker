import { ArrowRight, Sun } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { categoryAvatarStyle } from '../../lib/analytics'
import { useToday } from '../../hooks/useToday'
import { initialOf } from '../../lib/format'
import type { Expense } from '../../types'
import { ledgerEntryHref } from '../ledger/ledgerParams'

export function TodayStrip({ entries, total }: { entries: readonly Expense[]; total: number }) {
  const navigate = useNavigate()
  const fmt = useFormatMoney()
  const today = useToday()

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface-1 p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sun size={14} className="text-accent/80" />
          <h2 className="text-[13px] font-semibold text-white">Today</h2>
          <span className="text-[11px] text-[var(--text-tertiary)]">
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[15px] font-semibold tabular-nums text-white">
            {fmt(total)}
          </span>
          <button
            type="button"
            onClick={() => navigate('/ledger?range=today')}
            aria-label="View today's entries"
            className="tap-target inline-flex items-center gap-1 text-[12px] text-[var(--text-secondary)] transition hover:text-white"
          >
            View <ArrowRight size={12} />
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="py-3 text-center text-[12px] text-[var(--text-tertiary)]">
          Nothing logged today yet
        </p>
      ) : (
        <ul className="divide-y divide-white/[0.04]">
          {entries.slice(0, 5).map((e) => (
            <li key={e.id}>
              {/* Opens the entry in the Ledger, its Edit sheet open, as a ledger row does (F-116). */}
              <button
                type="button"
                onClick={() => navigate(ledgerEntryHref({ ...e, day: e.day ?? today }))}
                aria-label={`Edit ${e.itemName}, ${fmt(e.amount)}, ${e.category}`}
                className="focus-inset flex w-full items-center gap-3 py-2.5 text-left transition md:hover:bg-surface-2"
              >
                <span
                  className="cat-avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-[var(--cat)]"
                  style={categoryAvatarStyle(e.category, 0.16)}
                  aria-hidden
                >
                  {initialOf(e.itemName)}
                </span>
                <span className="block min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-white min-[360px]:max-md:text-[14px]">
                    {e.itemName}
                  </span>
                  <span className="block truncate text-[11px] text-[var(--text-tertiary)] min-[360px]:max-md:text-[12px]">
                    {e.category}
                    {e.notes ? ` · ${e.notes}` : ''}
                  </span>
                </span>
                <span className="font-mono text-[13px] tabular-nums text-white min-[360px]:max-md:text-[14px]">
                  {fmt(e.amount)}
                </span>
              </button>
            </li>
          ))}
          {entries.length > 5 && (
            <li className="pt-2 text-center">
              <button
                type="button"
                onClick={() => navigate('/ledger?range=today')}
                className="tap-target text-[11px] text-accent transition hover:text-accent-hover"
              >
                +{entries.length - 5} more
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
