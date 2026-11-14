import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddExpenseSheet } from './AddExpenseSheet'
import { EditExpenseSheet } from '../ledger/EditExpenseSheet'
import { LedgerRow } from '../ledger/LedgerRow'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { kindOf } from '../../lib/kind'
import type { Expense, ExpenseView } from '../../types'

// T8c, money in: an income is added and edited in the sheets an expense is, and listed in the
// Ledger with its sign and the word.

// The first hydrate loads the engine chunk, the data core with it: once here, with room.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

// Invented data.
const KOPI: Expense = {
  id: 'e-1',
  itemName: 'Kopi O',
  amount: 1.8,
  category: 'Food & Dining',
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
}

/** P2-14: the rows as 0.9.x stored them (the public v4 keys), then a real boot of the engine. */
async function boot(rows: readonly object[]) {
  await useExpenseStore.getState().hydrate()
  localStorage.clear()
  localStorage.setItem('expenses', JSON.stringify(rows))
  await useExpenseStore.getState().hydrate()
}

function view(id: string): ExpenseView {
  const found = useExpenseStore.getState().expenses.find((e) => e.id === id)
  if (!found) throw new Error(`no entry ${id}`)
  return found
}

const scrollIntoView = vi.fn()
beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), { media, matches: false }),
  )
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: scrollIntoView,
    configurable: true,
  })
  useUIStore.setState({ toasts: [], currency: 'SGD' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  scrollIntoView.mockClear()
})

const kindSwitch = () => screen.getByRole('radiogroup', { name: 'Kind of entry' })
const option = (name: 'Expense' | 'Income') => screen.getByRole('radio', { name })
const categories = () => screen.queryByRole('group', { name: /^Category/ })

describe('the Add sheet: money in', () => {
  beforeEach(async () => {
    await boot([])
  })

  it('opens as an expense; Income takes the category away and names the sheet', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Add expense' })).toBeInTheDocument()
    expect(kindSwitch()).toBeInTheDocument()
    expect(option('Expense')).toBeChecked()
    expect(categories()).not.toBeNull()

    await user.click(option('Income'))
    expect(option('Income')).toBeChecked()
    expect(screen.getByRole('dialog', { name: 'Add income' })).toBeInTheDocument()
    expect(categories()).toBeNull()
    expect(screen.getByPlaceholderText(/allowance, pay, sold bike/i)).toBeInTheDocument()
  })

  it('stores an income as one, under no category, and says so', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddExpenseSheet open onClose={onClose} />)
    // a category picked before the switch is not carried into the income
    await user.click(screen.getByRole('button', { name: 'Shopping' }))
    await user.click(option('Income'))
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'Allowance')
    await user.type(screen.getByPlaceholderText('0.00'), '790')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const [added] = useExpenseStore.getState().expenses
    expect(added).toMatchObject({ itemName: 'Allowance', amount: 790, category: 'Other' })
    expect(added && kindOf(added)).toBe('income')
    expect(useExpenseStore.getState().categoryMappings).toEqual({})
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Added income "Allowance" · S$790.00')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('is an expense again the next time it opens', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<AddExpenseSheet open onClose={() => {}} />)
    await user.click(option('Income'))
    rerender(<AddExpenseSheet open={false} onClose={() => {}} />)
    rerender(<AddExpenseSheet open onClose={() => {}} />)
    expect(option('Expense')).toBeChecked()
    expect(categories()).not.toBeNull()
  })

  it('an expense added from it carries no kind at all', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'Kopi')
    await user.type(screen.getByPlaceholderText('0.00'), '1.80')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(useExpenseStore.getState().expenses[0]?.ext).toEqual({})
  })
})

describe('the Edit sheet: money in', () => {
  it('an income opens as one: no category, its own name, and the save says Income', async () => {
    await boot([{ ...KOPI, itemName: 'Allowance', amount: 790, kind: 'income' }])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Edit income' })).toBeInTheDocument()
    expect(option('Income')).toBeChecked()
    expect(categories()).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete income' })).toBeInTheDocument()

    const amount = screen.getByRole('spinbutton', { name: 'Amount' })
    await user.clear(amount)
    await user.type(amount, '800')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1')).toMatchObject({ amount: 800, category: 'Food & Dining' })
    expect(kindOf(view('e-1'))).toBe('income')
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Income updated')
  })

  it('an expense becomes an income in one save, keeps its category, and Undo takes it back', async () => {
    await boot([KOPI])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Edit expense' })).toBeInTheDocument()
    await user.click(option('Income'))
    expect(categories()).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(kindOf(view('e-1'))).toBe('income')
    expect(view('e-1').category).toBe('Food & Dining')

    const undo = useExpenseStore.getState().undoStack.at(-1)
    expect(undo?.id.startsWith('update-e-1-')).toBe(true)
    useExpenseStore.getState().consumeUndo(undo?.id ?? '')
    expect(kindOf(view('e-1'))).toBe('expense')
  })

  it('an income turned back into an expense shows the category it was stored with', async () => {
    await boot([{ ...KOPI, kind: 'income' }])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.click(option('Expense'))
    expect(screen.getByRole('button', { name: 'Food & Dining' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(kindOf(view('e-1'))).toBe('expense')
    expect(view('e-1').ext).toEqual({})
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Expense updated')
  })

  it('a kind a newer SpendTrack wrote is said, offered no switch, and left exactly as it is', async () => {
    await boot([{ ...KOPI, itemName: 'Shopee', kind: 'refund' }])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Edit entry' })).toBeInTheDocument()
    expect(
      screen.getByText(/This entry came from a newer version of SpendTrack/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Kind of entry' })).toBeNull()
    expect(categories()).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete entry' })).toBeInTheDocument()

    const amount = screen.getByRole('spinbutton', { name: 'Amount' })
    await user.clear(amount)
    await user.type(amount, '26')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1')).toMatchObject({ amount: 26, ext: { kind: 'refund' } })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Entry updated')
  })
})

describe('a Ledger row: money in', () => {
  const row = (expense: Expense) =>
    render(
      <ul>
        <li>
          <LedgerRow expense={expense} dateLabel="Oct 19" onEdit={vi.fn()} onDelete={vi.fn()} />
        </li>
      </ul>,
    )

  beforeEach(async () => {
    await boot([])
  })

  it('an income shows its sign and the word, and "Income" where a category would be', () => {
    row({ ...KOPI, itemName: 'Allowance', amount: 790, ext: { kind: 'income' } })
    const main = screen.getByRole('button', { name: 'Edit Allowance, +S$790.00 income, Oct 19' })
    expect(main).toHaveTextContent('+S$790.00')
    expect(main).toHaveTextContent('Income')
    expect(main).not.toHaveTextContent('Food & Dining')
    expect(screen.getByText('+S$790.00')).toHaveClass('text-income')
    expect(
      screen.getByRole('button', { name: 'Delete Allowance, +S$790.00, Oct 19' }),
    ).toBeInTheDocument()
  })

  it('an expense reads as it always did', () => {
    row(KOPI)
    expect(
      screen.getByRole('button', { name: 'Edit Kopi O, S$1.80, Food & Dining, Oct 19' }),
    ).toBeInTheDocument()
  })

  it('a kind this version does not know is listed plainly as not counted', () => {
    row({ ...KOPI, itemName: 'Shopee', amount: 25, ext: { kind: 'refund' } })
    const main = screen.getByRole('button', { name: 'Edit Shopee, S$25.00 not counted, Oct 19' })
    expect(main).toHaveTextContent('Newer kind')
    expect(main).toHaveTextContent('not counted')
  })
})

describe('the sheets and a kind that changes underneath them (T8c review)', () => {
  it('a save that did not touch the switch leaves a kind another device set meanwhile', async () => {
    await boot([KOPI])
    const user = userEvent.setup()
    // the sheet holds the entry as it was when it opened: an expense
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    expect(option('Expense')).toBeChecked()
    // the other device makes it an income, and the sync lands
    useExpenseStore.getState().updateExpense('e-1', { kind: 'income' })
    expect(kindOf(view('e-1'))).toBe('income')

    await user.type(screen.getByRole('textbox', { name: /^Notes/ }), 'with kaya toast')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1').notes).toBe('with kaya toast')
    expect(kindOf(view('e-1'))).toBe('income')
  })

  it('a category picked before the switch to Income is not saved with it', async () => {
    await boot([KOPI])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Shopping' }))
    await user.click(option('Income'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(kindOf(view('e-1'))).toBe('income')
    expect(view('e-1').category).toBe('Food & Dining')
    expect(useExpenseStore.getState().categoryMappings).toEqual({})
  })

  it('a kind set on a row from before kinds is still there after the app is opened again', async () => {
    // a 0.9.x row: no per-field stamps, no seal
    await boot([KOPI])
    useExpenseStore.getState().updateExpense('e-1', { kind: 'income' })
    expect(useExpenseStore.getState().saveNow()).toBe('saved')
    await useExpenseStore.getState().hydrate()
    expect(kindOf(view('e-1'))).toBe('income')
    expect(view('e-1')).toMatchObject({
      itemName: 'Kopi O',
      amount: 1.8,
      category: 'Food & Dining',
    })
  })

  it('the Add sheet opens on Income when what opened it says so (the Fix of an unreadable income)', () => {
    render(
      <AddExpenseSheet
        open
        onClose={() => {}}
        prefill={{ itemName: 'Allowance', amount: 790, kind: 'income' }}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Add income' })).toBeInTheDocument()
    expect(option('Income')).toBeChecked()
    expect(categories()).toBeNull()
  })
})
