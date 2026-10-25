import { colorFromString } from '../../lib/analytics'
import { MAX_AMOUNT, isAmountTooLarge } from '../../utils/amountGuard'

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
