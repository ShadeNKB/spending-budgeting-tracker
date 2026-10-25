import {
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  animateSingleValue,
  PanInfo,
} from 'framer-motion'
import { memo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Trash2 } from 'lucide-react'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'
import { toastJustLeft } from '../../ui/pressShield'
import type { Expense } from '../../types'

const SNAP = { type: 'spring', stiffness: 420, damping: 40 } as const
const INSTANT = { duration: 0 } as const

/**
 * One ledger row: tap (or Enter) to edit; swipe left, the trash button or the Delete key to
 * delete. Memoised — with stable `onEdit` / `onDelete` from the screen, typing in the search box
 * or deleting another row does not re-render it.
 *
 * Keyboard and screen readers get one tab stop per row (the row button) and one named
 * "Delete {item}, {amount}, {day}" button beside it (out of the tab order: the Delete key does
 * it). Both names carry the amount and the day, so a daily "kopi" is not several identical
 * buttons. The swipe action is for touch only, hidden from both: it used to be an invisible
 * tab stop that a second Enter could fire on the next row.
 */
export const LedgerRow = memo(function LedgerRow({
  expense,
  dateLabel,
  onEdit,
  onDelete,
}: {
  expense: Expense
  /** Pre-formatted day ("Oct 5", or "Oct 5, 2025" in another year). */
  dateLabel: string
  onEdit: (e: Expense) => void
  /** `at`: when the press or the key that asks for it was made (its event's timeStamp). */
  onDelete: (id: string, at: number) => void
}) {
  const fmt = useFormatMoney()
  const reduceMotion = useReducedMotion() === true
  const x = useMotionValue(0)
  const bg = useTransform(
    x,
    [-120, -40, 0],
    ['rgba(239,68,68,0.14)', 'rgba(239,68,68,0.04)', 'rgba(255,255,255,0)'],
  )
  const swipeOpacity = useTransform(x, [-120, -20, 0], [1, 0.6, 0])
  const [revealed, setRevealed] = useState(false)
  const dragStarted = useRef(false)

  // What `animate(x, …)` runs for a single motion value, imported directly: `animate` also
  // brings framer's sequence and DOM-target machinery (about 6.5 KB) that nothing here uses.
  const snapTo = (target: number) => {
    void animateSingleValue(x, target, reduceMotion ? INSTANT : SNAP)
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    dragStarted.current = true
    const reveal = info.offset.x < -76 || info.velocity.x < -650
    setRevealed(reveal)
    snapTo(reveal ? -96 : 0)
    setTimeout(() => {
      dragStarted.current = false
    }, 50)
  }

  const handleRowClick = () => {
    if (dragStarted.current) return
    if (revealed) {
      setRevealed(false)
      snapTo(0)
      return
    }
    onEdit(expense)
  }

  // The trash moves with the row, so a mouse or trackpad swipe that starts on it ends on it,
  // and the browser follows with a click: that swipe only reveals the action, like any other.
  // A press where a toast has just gone (its × over this trash on a phone) was meant for the
  // toast, not for deleting this row.
  const handleTrashClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (dragStarted.current || (e.detail > 0 && toastJustLeft(e.nativeEvent))) return
    onDelete(expense.id, e.nativeEvent.timeStamp)
  }

  // Delete removes the row; the screen offers Undo. Backspace never does, on any keyboard: it is
  // the key a reflex corrects typing with, and focus lands on the row after every Edit sheet
  // closes. (A Mac keyboard sends Delete for fn + delete.) A held key deletes one row: its
  // auto-repeat lands on the next row, which focus moves to.
  const onRowKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'Delete') return
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    e.preventDefault()
    onDelete(expense.id, e.nativeEvent.timeStamp)
  }

  const amount = fmt(expense.amount)
  const deleteName = `Delete ${expense.itemName}, ${amount}, ${dateLabel}`

  return (
    <motion.div
      data-ledger-row={expense.id}
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
        data-swipe-delete
        aria-hidden="true"
        tabIndex={-1}
        onClick={(e) => {
          if (e.detail > 0 && toastJustLeft(e.nativeEvent)) return
          onDelete(expense.id, e.nativeEvent.timeStamp)
        }}
        className="absolute inset-y-0 right-0 flex w-24 items-center justify-center gap-1.5 text-negative transition hover:bg-negative/10"
        style={{ opacity: swipeOpacity }}
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
        className="relative flex items-center bg-surface-1 transition-colors md:hover:bg-surface-2"
      >
        <button
          type="button"
          data-row-main
          onClick={handleRowClick}
          onKeyDown={onRowKeyDown}
          aria-keyshortcuts="Delete"
          aria-label={`Edit ${expense.itemName}, ${amount}, ${expense.category}, ${dateLabel}`}
          className="focus-inset flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 pr-2 text-left md:pl-4"
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

          <span className="block min-w-0 flex-1">
            <span className="block truncate text-[14px] text-white">{expense.itemName}</span>
            {/* On a narrow row the notes give way first (they only take the space left over),
                then the category; the date never does, so "Aug 19, 2025" is never cut to "Aug 1…". */}
            <span className="flex min-w-0 text-[11px] text-[var(--text-tertiary)]">
              <span className="truncate">{expense.category}</span>
              <span className="shrink-0 whitespace-nowrap">&nbsp;· {dateLabel}</span>
              {expense.notes && (
                <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
                  &nbsp;· {expense.notes}
                </span>
              )}
            </span>
          </span>

          <span className="shrink-0 font-mono text-[14px] tabular-nums text-white">{amount}</span>
        </button>

        {/* Always shown on touch screens; with a mouse it appears on hover and while the row
            is focused. 44 px square everywhere, so its hit area never overlaps the row's, and
            flush with the row's end: it then starts right of the centre of the swipe action
            (96 px wide), so a second tap where Delete was revealed lands on the next row's
            button, never on its trash. */}
        <button
          type="button"
          tabIndex={-1}
          onClick={handleTrashClick}
          aria-label={deleteName}
          title={deleteName}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-negative/10 hover:text-negative active:bg-negative/10 active:text-negative group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0"
        >
          <Trash2 size={15} aria-hidden />
        </button>
      </motion.div>
    </motion.div>
  )
})
