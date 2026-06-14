import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { LedgerRow } from './LedgerRow'
import { flattenLedgerGroups, ledgerHeaderLabel, type LedgerGroup } from './ledgerFlatten'
import type { Expense } from '../../types'

/**
 * Windowed ledger list for large result sets (>150 rows). Renders day-header
 * groups as a single flattened stream virtualized against the window scroll,
 * so the page keeps its natural one-hand scroll behaviour while only the
 * visible rows are mounted. Headers scroll inline (not sticky) in this mode —
 * an intentional trade for the rare huge-list case; the grouped sticky view is
 * used for normal-sized lists.
 */
export function VirtualLedgerList({
  groups,
  onEdit,
  onDelete,
}: {
  groups: LedgerGroup[]
  onEdit: (e: Expense) => void
  onDelete: (id: string) => void
}) {
  const fmt = useFormatMoney()
  const parentRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)

  const flat = useMemo(() => flattenLedgerGroups(groups), [groups])

  useLayoutEffect(() => {
    if (parentRef.current) setScrollMargin(parentRef.current.offsetTop)
  }, [])

  const virtualizer = useWindowVirtualizer({
    count: flat.length,
    estimateSize: (i) => (flat[i].kind === 'header' ? 41 : 62),
    overscan: 8,
    scrollMargin,
  })

  return (
    <div
      ref={parentRef}
      className="elevated overflow-hidden rounded-2xl border border-white/[0.06] bg-surface-1"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const item = flat[vi.index]
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start - scrollMargin}px)`,
              }}
            >
              {item.kind === 'header' ? (
                <div className="flex items-center justify-between gap-2 border-b border-white/[0.05] bg-surface-2/85 px-4 py-2.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                    {ledgerHeaderLabel(item.date)}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
                    {fmt(item.total)}
                  </span>
                </div>
              ) : (
                <div className="border-b border-white/[0.04]">
                  <LedgerRow expense={item.expense} onEdit={onEdit} onDelete={onDelete} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
