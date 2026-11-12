import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString, colorWithAlpha, type CategoryStat } from '../../lib/analytics'
import { ledgerCategoryHref, type LedgerPeriod } from '../ledger/ledgerParams'
import { EmptyState } from '../../ui/EmptyState'
import { PieChart } from 'lucide-react'

export function TopCategories({
  items,
  period,
}: {
  items: readonly CategoryStat[]
  /** The period on screen: a category opens the Ledger over it. */
  period: LedgerPeriod
}) {
  const navigate = useNavigate()
  const fmt = useFormatMoney()

  if (!items.length) {
    return (
      <EmptyState
        icon={PieChart}
        title="No spending yet"
        description="Add your first expense to see a breakdown"
      />
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((it) => {
        const color = colorFromString(it.category)
        return (
          <li key={it.category}>
            <button
              type="button"
              onClick={() => navigate(ledgerCategoryHref(it.category, period))}
              className="group flex min-h-11 w-full flex-col justify-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background: color,
                      boxShadow: `0 0 10px ${colorWithAlpha(it.category, 0.33)}`,
                    }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-[13px] font-medium text-white min-[360px]:max-md:text-[14px]">
                    {it.category}
                  </span>{' '}
                  <span className="text-[11px] text-[var(--text-tertiary)] min-[360px]:max-md:text-[12px]">
                    {Math.round(it.share * 100)}%
                  </span>
                </div>{' '}
                <div className="flex items-center gap-1 font-mono text-[13px] tabular-nums text-white min-[360px]:max-md:text-[14px]">
                  {fmt(it.total)}
                  <ArrowRight
                    size={12}
                    className="opacity-40 transition group-hover:opacity-70 group-focus-visible:opacity-70"
                  />
                </div>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full transition-[width] duration-700"
                  style={{ width: `${Math.max(4, it.share * 100)}%`, background: color }}
                />
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
