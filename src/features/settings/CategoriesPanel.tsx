import { useState } from 'react'
import { Plus, Trash2, Check, X, Lock } from 'lucide-react'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Pill } from '../../ui/Pill'
import { InlineConfirm } from '../../ui/InlineConfirm'
import { useInlineConfirm } from '../../hooks/useInlineConfirm'
import { shieldKeyGesture } from '../../ui/pressShield'
import { undoAction, useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { colorFromString } from '../../lib/analytics'
import { categoryOf, kindOf } from '../../lib/kind'
import { errorMessage, OTHER } from './panelShared'

const ADD_CATEGORY_ID = 'settings-add-category'

export function CategoriesPanel() {
  const categories = useExpenseStore((s) => s.categories)
  const expenses = useExpenseStore((s) => s.expenses)
  const budgets = useExpenseStore((s) => s.budgets)
  const asideCategories = useExpenseStore((s) => s.asideCategories)
  const toast = useToast()
  const [newCat, setNewCat] = useState('')
  const confirm = useInlineConfirm<string>()
  // A rename onto a name already listed would merge the two: it is asked first (F-076).
  const merge = useInlineConfirm<{ readonly from: string; readonly to: string }>()

  // A name the store refuses (reserved, too long) is said, never dropped in silence; a name it
  // already lists changes nothing, and is said too (the text stays, to be changed).
  const addNew = () => {
    const name = newCat.trim()
    if (!name) return
    const before = useExpenseStore.getState().categories
    try {
      useExpenseStore.getState().addCategory(name)
    } catch (err) {
      toast.error(errorMessage(err))
      return
    }
    if (useExpenseStore.getState().categories === before) {
      toast.info(`"${name}" is already a category`)
      return
    }
    setNewCat('')
    toast.success('Category added')
  }

  /** The toast of a category change, with the Undo of the entry it just put on the stack. */
  const changedToast = (message: string) => {
    const entry = useExpenseStore.getState().undoStack.at(-1)
    const undoId = entry?.id.startsWith('cat-') === true ? entry.id : null
    toast.info(message, {
      undoId: undoId ?? undefined,
      action: undoId === null ? undefined : undoAction(toast, undoId),
    })
  }

  // A rename onto a name that is listed already merges the two (its entries, budget and item
  // picks move). A blur (a tap anywhere else) must not do that by accident: it asks first, in
  // the row, and Keep leaves the name as it was. Either way the toast has an Undo.
  const rename = (from: string, to: string): boolean => {
    const merging = useExpenseStore.getState().categories.includes(to)
    try {
      useExpenseStore.getState().renameCategory(from, to)
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
    changedToast(merging ? `Merged "${from}" into "${to}"` : 'Renamed')
    return true
  }
  /** `byKey`: Return did it, so focus stays on the field, in the row under its new name. */
  const renameTo = (field: HTMLInputElement, from: string, byKey = false) => {
    const to = field.value.trim()
    if (!to || to === from) {
      field.value = from
      return
    }
    if (useExpenseStore.getState().categories.includes(to)) {
      merge.ask({ from, to }, from)
      return
    }
    if (!rename(from, to)) field.value = from
    // The row re-mounts under its new name: nothing is asked, but focus goes on to its field.
    else if (byKey) merge.close(merge.triggerId(to))
  }

  const removeOne = (name: string) => {
    try {
      useExpenseStore.getState().removeCategory(name)
    } catch (err) {
      toast.error(errorMessage(err))
      return false
    }
    changedToast('Category deleted')
    return true
  }

  // A Map: a category may be named "__proto__" or "constructor". Expenses and refunds are
  // in a category: income is stored under one it never shows.
  const counts = new Map(
    categories.map((c) => [c, expenses.filter((e) => categoryOf(e) === c).length]),
  )
  // Categories with a refund in them: their count is of entries, not of expenses alone.
  const mixed = new Set(expenses.filter((e) => kindOf(e) === 'refund').map((e) => e.category))
  // Focus after a delete moves along the rows that can be deleted (Other cannot).
  const deletable = categories.filter((c) => c !== OTHER)

  return (
    <div className="flex flex-col gap-3">
      {/* The field gives way on a narrow screen (a field's own minimum width would push "Add"
          out of the sheet at 320 px); the button keeps its size. */}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={ADD_CATEGORY_ID}
            label="Add category"
            placeholder="e.g. Gifts"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addNew()
            }}
          />
        </div>
        <Button className="shrink-0" onClick={addNew}>
          <Plus size={14} /> Add
        </Button>
      </div>

      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => {
          const count = counts.get(c) ?? 0
          const one = count === 1
          const noun = countNoun(count, mixed.has(c))
          return (
            <li
              key={c}
              className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-1.5"
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colorFromString(c) }}
              />
              {merge.pending?.from === c ? (
                <InlineConfirm
                  layout="row"
                  tone="warning"
                  question={`Merge into ${merge.pending.to}?`}
                  detail={mergeDetail(
                    c,
                    merge.pending.to,
                    count,
                    budgets,
                    asideCategories,
                    mixed.has(c),
                  )}
                  confirmLabel={<Check size={14} aria-hidden />}
                  confirmName={`Merge ${c} into ${merge.pending.to}`}
                  cancelLabel={<X size={14} aria-hidden />}
                  cancelName={`Keep ${c}`}
                  onConfirm={() => {
                    const { to } = merge.pending ?? { to: c }
                    // Focus goes on to the row it merged into (Other has no field: Add, then).
                    merge.close(
                      rename(c, to)
                        ? to === OTHER
                          ? ADD_CATEGORY_ID
                          : merge.triggerId(to)
                        : undefined,
                    )
                  }}
                  onCancel={() => merge.close()}
                />
              ) : confirm.pending === c ? (
                <InlineConfirm
                  layout="row"
                  question={`Delete ${c}?`}
                  detail={
                    // Its expenses are refiled to Other.
                    (Object.hasOwn(budgets, c) ? 'Its budget is deleted · ' : '') +
                    (count === 0
                      ? 'No expenses use it'
                      : `${count.toLocaleString()} ${noun} ${one ? 'moves' : 'move'} to Other`)
                  }
                  confirmLabel={<Check size={14} aria-hidden />}
                  confirmName={`Delete category ${c}`}
                  cancelLabel={<X size={14} aria-hidden />}
                  cancelName={`Keep ${c}`}
                  onConfirm={() => {
                    // Focus moves on to the row that takes this one's place.
                    const at = deletable.indexOf(c)
                    const next = deletable[at + 1] ?? deletable[at - 1]
                    if (!removeOne(c)) {
                      confirm.close()
                      return
                    }
                    confirm.close(next === undefined ? ADD_CATEGORY_ID : confirm.triggerId(next))
                  }}
                  onCancel={() => confirm.close()}
                />
              ) : c === OTHER ? (
                <>
                  {/* As tall as a rename field, so every row lines up. */}
                  <span className="flex h-9 min-w-0 flex-1 items-center text-[13px] text-white [@media(pointer:coarse)]:h-11">
                    {c}
                    <span className="sr-only">: deleted categories' entries go here</span>
                  </span>
                  <Pill tone="default">
                    {count}
                    <span className="sr-only"> {noun}</span>
                  </Pill>
                  <span
                    aria-hidden
                    title="Other holds the entries of deleted categories, so it stays"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--text-tertiary)]"
                  >
                    <Lock size={12} />
                  </span>
                </>
              ) : (
                <>
                  {/* Renames as focus leaves it, or on Return. The dashed rule marks it as a field
                      on a touch screen, where there is no hover to show it. */}
                  <input
                    id={merge.triggerId(c)}
                    aria-label={`Rename category ${c}`}
                    defaultValue={c}
                    enterKeyHint="done"
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.repeat || e.nativeEvent.isComposing) return
                      // Not the browser's own Enter as well: the merge question's Keep takes
                      // focus as it shows, and the same key press would answer it at once. Nor
                      // the second Enter of a double press (pressShield).
                      e.preventDefault()
                      shieldKeyGesture(e.key)
                      renameTo(e.currentTarget, c, true)
                    }}
                    onBlur={(e) => {
                      renameTo(e.target, c)
                    }}
                    className="-mx-1 h-9 min-w-0 flex-1 rounded-none border-b border-dashed border-white/20 bg-transparent px-1 text-[13px] text-white [@media(pointer:coarse)]:h-11"
                  />
                  <Pill tone="default">
                    {count}
                    <span className="sr-only"> {noun}</span>
                  </Pill>
                  <button
                    type="button"
                    id={confirm.triggerId(c)}
                    onClick={() => confirm.ask(c, c)}
                    aria-label={`Delete category ${c}`}
                    title={`Delete category ${c}`}
                    className="tap-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-negative/10 hover:text-negative"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * What a merge of `from` into `to` does, the largest consequence first (a cut-off line still says
 * it). Across the not-spending line the entries take the answer of the category they join, so
 * they leave the totals or come into them: said before anything else. Then the budget: the
 * category merged into keeps its own, else takes the merged one's (budgetView), which measures
 * nothing while that category is not spending.
 */
/** What a category's count is of: expenses, or entries once a refund is among them. */
const countNoun = (count: number, mixed: boolean): string =>
  mixed ? (count === 1 ? 'entry' : 'entries') : count === 1 ? 'expense' : 'expenses'

function mergeDetail(
  from: string,
  to: string,
  count: number,
  budgets: Readonly<Record<string, number>>,
  aside: readonly string[],
  mixed = false,
): string {
  const noun = `${count.toLocaleString()} ${countNoun(count, mixed)}`
  const one = count === 1
  const toAside = aside.includes(to)
  const crosses = count > 0 && toAside !== aside.includes(from)
  const moves =
    count === 0
      ? `${from} has no expenses`
      : crosses
        ? toAside
          ? `${noun} ${one ? 'leaves' : 'leave'} your totals: ${to} is not spending`
          : `${noun} ${one ? 'counts' : 'count'} as spending again in ${to}`
        : `${noun} ${one ? 'moves' : 'move'} to ${to}`
  if (!Object.hasOwn(budgets, from)) return moves
  const budget = toAside
    ? `${from}'s budget is paused`
    : Object.hasOwn(budgets, to)
      ? `${to} keeps its own budget, not ${from}'s`
      : `${to} takes ${from}'s budget`
  return crosses ? `${moves} · ${budget}` : `${budget} · ${moves}`
}
