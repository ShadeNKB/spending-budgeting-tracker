import { motion, useMotionValue, useTransform, animate, PanInfo } from 'framer-motion'
import { useRef, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'
import type { Expense } from '../../types'

export function LedgerRow({
  expense,
  onEdit,
  onDelete,
}: {
  expense: Expense
  onEdit: (e: Expense) => void
  onDelete: (id: string) => void
}) {
  const fmt = useFormatMoney()
  const x = useMotionValue(0)
  const bg = useTransform(
    x,
    [-120, -40, 0],
    ['rgba(239,68,68,0.14)', 'rgba(239,68,68,0.04)', 'rgba(255,255,255,0)'],
  )
  const [revealed, setRevealed] = useState(false)
  const dragStarted = useRef(false)

  const onDragEnd = (_: unknown, info: PanInfo) => {
    dragStarted.current = true
    if (info.offset.x < -76 || info.velocity.x < -650) {
      setRevealed(true)
      animate(x, -96, { type: 'spring', stiffness: 420, damping: 40 })
    } else {
      setRevealed(false)
      animate(x, 0, { type: 'spring', stiffness: 420, damping: 40 })
    }
    setTimeout(() => {
      dragStarted.current = false
    }, 50)
  }

  const handleRowClick = () => {
    if (dragStarted.current) return
    if (revealed) {
      setRevealed(false)
      animate(x, 0, { type: 'spring', stiffness: 420, damping: 40 })
      return
    }
    onEdit(expense)
  }

  return (
    <motion.div
      style={{ background: bg }}
      className="group relative touch-pan-y"
      onPointerDown={() => {
        dragStarted.current = false
      }}
      onPointerCancel={() => {
        dragStarted.current = false
      }}
    >
      <motion.button
        type="button"
        onClick={() => onDelete(expense.id)}
        className="absolute inset-y-0 right-0 flex w-24 items-center justify-center gap-1.5 text-negative transition hover:bg-negative/10"
        style={{ opacity: useTransform(x, [-120, -20, 0], [1, 0.6, 0]) }}
        aria-label={`Delete ${expense.itemName}`}
      >
        <Trash2 size={13} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">Delete</span>
      </motion.button>
      <motion.div
        drag="x"
        dragConstraints={{ left: -120, right: 0 }}
        dragElastic={{ left: 0.12, right: 0 }}
        onDragStart={() => {
          dragStarted.current = true
        }}
        onDragEnd={onDragEnd}
        style={{ x }}
        onClick={handleRowClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleRowClick()
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={`Edit ${expense.itemName}, ${fmt(expense.amount)}, ${expense.category}`}
        className="relative flex cursor-pointer items-center gap-3 bg-surface-1 px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 md:cursor-default md:px-4 active:md:cursor-default"
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
          style={{
            background: `${colorFromString(expense.category)}1E`,
            color: colorFromString(expense.category),
            boxShadow: `0 0 0 1px ${colorFromString(expense.category)}30`,
          }}
          aria-hidden
        >
          {expense.itemName.charAt(0).toUpperCase()}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] text-white">{expense.itemName}</div>
          <div className="truncate text-[11px] text-[var(--text-tertiary)]">
            {expense.category} · {format(parseISO(expense.date), 'MMM d')}
            {expense.notes && <span className="ml-1 opacity-60">· {expense.notes}</span>}
          </div>
        </div>

        <span className="shrink-0 font-mono text-[14px] tabular-nums text-white">
          {fmt(expense.amount)}
        </span>

        {/* Desktop: hover-revealed buttons */}
        <div className="hidden shrink-0 items-center gap-0.5 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 md:flex">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(expense)
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white"
            aria-label="Edit"
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(expense.id)
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-negative/10 hover:text-negative"
            aria-label="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
        {/* Mobile: always-visible delete button (edit via row tap) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(expense.id)
          }}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition active:bg-negative/10 active:text-negative md:hidden"
          aria-label="Delete"
        >
          <Trash2 size={15} />
        </button>
      </motion.div>
    </motion.div>
  )
}
