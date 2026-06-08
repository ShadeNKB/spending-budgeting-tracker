import { useNavigate } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { formatMoney } from '../../lib/format'
import { colorFromString } from '../../lib/analytics'
import { EmptyState } from '../../ui/EmptyState'
import { PieChart } from 'lucide-react'

export function TopCategories({
  items,
}: {
  items: { category: string; total: number; share: number }[]
}) {
  const navigate = useNavigate()

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
              onClick={() => navigate(`/ledger?category=${encodeURIComponent(it.category)}`)}
              className="group flex w-full flex-col gap-1.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: color, boxShadow: `0 0 10px ${color}55` }}
                  />
                  <span className="truncate text-[13px] font-medium text-white">{it.category}</span>
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    {Math.round(it.share * 100)}%
                  </span>
                </div>
                <div className="flex items-center gap-1 font-mono text-[13px] tabular-nums text-white">
                  {formatMoney(it.total)}
                  <ArrowRight size={12} className="opacity-0 transition group-hover:opacity-60" />
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
