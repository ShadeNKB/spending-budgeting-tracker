import { Check } from 'lucide-react'
import { undoAction, useExpenseStore } from '../../stores/useExpenseStore'
import { useToast } from '../../hooks/useToast'
import { useCurrencySymbol, useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'
import { errorMessage, OTHER } from './panelShared'

const ASIDE_HEADING_ID = 'settings-not-spending'

/**
 * A budget amount: saved as focus leaves it or on Return. An emptied field clears the budget;
 * what cannot be read as a number is refused, never taken for an emptied field (F-114).
 */
function BudgetField({
  name,
  current,
  onSet,
  onClear,
}: {
  /** The field's accessible name. */
  name: string
  current: number | undefined
  /** Throws what the store refuses (0, a negative, too large), with its reason. */
  onSet: (amount: number) => void
  onClear: () => void
}) {
  const toast = useToast()
  const symbol = useCurrencySymbol()
  return (
    <div className="flex items-center gap-1">
      <span className="text-[11px] text-[var(--text-tertiary)]">{symbol}</span>
      <input
        key={String(current ?? 'none')}
        type="number"
        inputMode="decimal"
        defaultValue={current ?? ''}
        aria-label={name}
        placeholder="—"
        // Wider and 44 px tall on touch screens, where the text is floored at 16 px
        // (index.css, against iOS focus zoom): 9 characters (123456.78) still fit.
        className="h-8 w-24 rounded-md border border-white/[0.06] bg-surface-2 px-2 text-right font-mono text-[13px] tabular-nums text-white [color-scheme:dark] [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-28"
        onBlur={(e) => {
          const field = e.target
          // A number field reads "" for what it cannot parse ("12,50" in some browsers): a
          // typo to refuse, never an emptied field that clears the budget (F-114).
          if (field.validity.badInput) {
            field.value = current === undefined ? '' : String(current)
            toast.error('Enter the budget as a number, like 250 or 99.50.')
            return
          }
          const raw = field.value.trim()
          try {
            if (raw === '') {
              // An empty field clears the budget; leaving it empty is no edit.
              if (current !== undefined) onClear()
              return
            }
            const v = Number(raw)
            // Leaving the field unchanged is no edit (and no toast).
            if (v !== current) onSet(v)
          } catch (err) {
            // The store kept the budget it had: so does the field.
            field.value = current === undefined ? '' : String(current)
            toast.error(errorMessage(err))
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </div>
  )
}

const budgetRow =
  'flex items-center gap-3 rounded-lg border border-white/[0.06] bg-surface-1 px-3 py-2 [@media(pointer:coarse)]:py-1'

export function BudgetsPanel() {
  const categories = useExpenseStore((s) => s.categories)
  const budgets = useExpenseStore((s) => s.budgets)
  const monthBudget = useExpenseStore((s) => s.monthBudget)
  const asideCategories = useExpenseStore((s) => s.asideCategories)
  const toast = useToast()
  const fmt = useFormatMoney()
  const aside = new Set(asideCategories)

  // A not-spending category's entries leave every total at once: the toast says what happened
  // and offers the way back.
  const setAside = (category: string, on: boolean) => {
    try {
      useExpenseStore.getState().setCategoryAside(category, on)
    } catch (err) {
      toast.error(errorMessage(err))
      return
    }
    const entry = useExpenseStore.getState().undoStack.at(-1)
    const undoId = entry?.id.startsWith('set-') === true ? entry.id : undefined
    toast.info(
      on ? `${category} no longer counts as spending` : `${category} counts as spending again`,
      { undoId, action: undoId === undefined ? undefined : undoAction(toast, undoId) },
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-[var(--text-tertiary)]">
        One budget for the whole month, caps for single categories, or both.
      </p>
      <div className={budgetRow}>
        <span className="flex-1 text-[13px] font-medium text-white">Whole month</span>
        <BudgetField
          name="Whole month budget"
          current={monthBudget ?? undefined}
          onSet={(v) => {
            useExpenseStore.getState().setMonthBudget(v)
            toast.success(`Whole month: ${fmt(v)} budget set`)
          }}
          onClear={() => {
            useExpenseStore.getState().setMonthBudget(null)
            toast.info('Whole month budget cleared')
          }}
        />
      </div>
      <ul className="flex flex-col gap-1.5">
        {categories.map((c) => {
          // Own keys only: a category named "constructor" has no budget of Object's.
          const current = Object.hasOwn(budgets, c) ? budgets[c] : undefined
          return (
            <li key={c} className={budgetRow}>
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: colorFromString(c) }}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] text-white">{c}</span>
              {aside.has(c) ? (
                // Not spending: a cap would measure nothing. One it already has is kept for the
                // day the category counts again, and the row says so. As tall as a field, so
                // rows line up.
                <span className="flex h-8 shrink-0 items-center text-[12px] text-[var(--text-tertiary)] [@media(pointer:coarse)]:h-11">
                  {current === undefined ? 'Not spending' : `${fmt(current)} cap paused`}
                </span>
              ) : (
                <BudgetField
                  name={`Monthly budget for ${c}`}
                  current={current}
                  onSet={(v) => {
                    useExpenseStore.getState().setBudget(c, v)
                    toast.success(`${c}: ${fmt(v)} budget set`)
                  }}
                  onClear={() => {
                    useExpenseStore.getState().removeBudget(c)
                    toast.info('Budget cleared')
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-2 flex flex-col gap-2">
        <h3 id={ASIDE_HEADING_ID} className="text-[13px] font-semibold text-white">
          Not spending
        </h3>
        <p className="text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          For money you move rather than spend: investments, savings, transfers. Entries in these
          categories stay in the Ledger and are left out of your totals, pace and budgets. Other
          always counts.
        </p>
        {/* 36 px chips 8 px apart: each gets a 44 px hit area on touch, none overlapping. */}
        <div role="group" aria-labelledby={ASIDE_HEADING_ID} className="flex flex-wrap gap-2">
          {categories
            .filter((c) => c !== OTHER)
            .map((c) => {
              const on = aside.has(c)
              return (
                <button
                  type="button"
                  key={c}
                  aria-pressed={on}
                  onClick={() => setAside(c, !on)}
                  className={`tap-target inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition ${
                    on
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-white/[0.08] text-[var(--text-secondary)] hover:border-white/20 hover:text-white'
                  }`}
                >
                  {on && <Check size={12} className="shrink-0" aria-hidden />}
                  <span className="truncate">{c}</span>
                </button>
              )
            })}
        </div>
      </div>
    </div>
  )
}
