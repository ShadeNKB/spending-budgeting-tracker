import { colorFromString } from '../../lib/analytics'
import { MAX_AMOUNT, isAmountTooLarge } from '../../utils/amountGuard'
import type { useToast } from '../../hooks/useToast'
import { useExpenseStore, type LocalStatus } from '../../stores/useExpenseStore'

/** The two fields both expense sheets check before saving, as typed. */
export interface ExpenseFormValues {
  itemName: string
  amount: string
}

export type ExpenseFormField = keyof ExpenseFormValues

/** One message per invalid field; empty when the form can be saved. */
export type ExpenseFormErrors = Partial<Record<ExpenseFormField, string>>

/** Form order: the field focused first when several are invalid. */
const FIELD_ORDER: readonly ExpenseFormField[] = ['itemName', 'amount']

/**
 * The Add and Edit sheets' shared check. `fmt` formats the limit in the selected currency.
 * The store re-checks amounts at its boundary; this only decides what the form says.
 */
export function validateExpenseForm(
  { itemName, amount }: ExpenseFormValues,
  fmt: (n: number) => string,
): ExpenseFormErrors {
  const errors: ExpenseFormErrors = {}
  if (!itemName.trim()) errors.itemName = 'Required'
  const value = parseFloat(amount)
  if (!Number.isFinite(value) || value <= 0) {
    errors.amount = 'Enter a valid amount'
  } else if (isAmountTooLarge(value)) {
    errors.amount = `Amount too large — the limit is ${fmt(MAX_AMOUNT)}`
  }
  return errors
}

/**
 * What to tell the owner when a store action refuses its input (P2-13). Its message is written
 * for them ("Notes are at most 500 characters."); anything without one gets a plain retry line.
 */
export function actionErrorMessage(err: unknown): string {
  return err instanceof Error && err.message.trim() !== ''
    ? err.message
    : "That couldn't be saved. Try again."
}

/** What an add's confirmation adds while this device is not keeping it; null while it is. */
export function unsavedNote(local: LocalStatus): string | null {
  switch (local) {
    case 'saved':
      return null
    case 'memory-only':
      return 'Kept only until you close SpendTrack'
    case 'error-quota':
    case 'error-storage':
      return 'Not saved on this device yet'
  }
}

type ToastApi = ReturnType<typeof useToast>

/**
 * An add's confirmation, honest about storage (§6.5): while this device cannot keep the entry
 * (memory only, or a save that failed) it is a warning that says so, never a tick. The add's
 * write is made first (it would run on the next microtask), so the tone is that of its own save,
 * also for the first entry storage refuses.
 */
export function confirmAdded(
  toast: ToastApi,
  message: string,
  opts: NonNullable<Parameters<ToastApi['success']>[1]>,
): void {
  const note = unsavedNote(useExpenseStore.getState().saveNow())
  if (note === null) toast.success(message, opts)
  else toast.warning(`${message} · ${note}`, opts)
}

/**
 * The undo of the latest delete of `id` on the store's stack, which names it `del-<id>-<n>`
 * (P2-12). Matched exactly, so the Undo for "ab" never brings back "ab-1" instead.
 */
export function deleteUndoId(
  stack: readonly { readonly id: string }[],
  id: string,
): string | undefined {
  const prefix = `del-${id}-`
  for (let i = stack.length - 1; i >= 0; i--) {
    const undo = stack[i]?.id
    if (undo?.startsWith(prefix) && /^\d+$/.test(undo.slice(prefix.length))) return undo
  }
  return undefined
}

/** The field to focus after a failed save, in form order; null when every field is valid. */
export function firstInvalidField(errors: ExpenseFormErrors): ExpenseFormField | null {
  return FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null
}

/**
 * Lightness of a chosen category chip's fill. Its label is dark 12 px text (`text-surface-0`),
 * which reads at 4.5:1 or more on the category's hue at this lightness for every hue, in both
 * themes (worst: 5.1:1 at blue-violet, hue 240). The dot colour (colorFromString, 62 %) gave
 * Shopping 3.9:1.
 */
export const CHOSEN_CHIP_LIGHTNESS = 68

/** A chosen category chip's fill: the hue of the category's dot (`hsl(h, 65%, 62%)`), lighter. */
export const chosenChipFill = (category: string): string =>
  colorFromString(category).replace(/62%\)$/, `${String(CHOSEN_CHIP_LIGHTNESS)}%)`)
