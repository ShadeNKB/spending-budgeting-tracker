import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AddExpenseSheet } from './AddExpenseSheet'
import { EditExpenseSheet } from '../ledger/EditExpenseSheet'
import { LedgerRow } from '../ledger/LedgerRow'
import { TodayStrip } from '../pulse/TodayStrip'
import { TopCategories } from '../pulse/TopCategories'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { kindOf } from '../../lib/kind'
import type { Expense, ExpenseView } from '../../types'

// Refunds (F-058, second slice): money back is added and edited in the sheets an expense is,
// keeps a category, and is listed with a minus and the word.

// The first hydrate loads the engine chunk, the data core with it: once here, with room.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

// Invented data.
const SHOES: Expense = {
  id: 'e-1',
  itemName: 'Shoes',
  amount: 89.9,
  category: 'Shopping',
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
}

/** The rows as 0.9.x stored them (the public v4 keys), then a real boot of the engine. */
async function boot(rows: readonly object[]) {
  await useExpenseStore.getState().hydrate()
  localStorage.clear()
  localStorage.setItem('expenses', JSON.stringify(rows))
  await useExpenseStore.getState().hydrate()
  // After the boot: a device's first currency follows its time zone, and a boot puts it back.
  useUIStore.setState({ toasts: [], currency: 'SGD' })
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
})
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  scrollIntoView.mockClear()
})

const option = (name: 'Expense' | 'Income' | 'Refund') => screen.getByRole('radio', { name })
const categories = () => screen.queryByRole('group', { name: /^Category/ })
const chip = (name: string) => screen.getByRole('button', { name })
/** A refund's chips say what the pick is for, where it is made. */
const comesOff = () => screen.queryByRole('group', { name: /^Category it comes off/ })
const NEEDS = 'Pick the category this refund comes off.'

describe('the Add sheet: a refund', () => {
  beforeEach(async () => {
    await boot([])
  })

  it('Refund names the sheet, keeps the category, and says what the category is for', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    expect(comesOff()).toBeNull()
    // a category picked before the switch stays picked: a refund has one
    await user.click(chip('Shopping'))
    await user.click(option('Refund'))
    expect(option('Refund')).toBeChecked()
    expect(screen.getByRole('dialog', { name: 'Add refund' })).toBeInTheDocument()
    expect(comesOff()).not.toBeNull()
    expect(categories()).not.toBeNull()
    expect(chip('Shopping')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByPlaceholderText(/returned shoes, dinner split/i)).toBeInTheDocument()
    // and the label is an expense's again with the kind
    await user.click(option('Expense'))
    expect(comesOff()).toBeNull()
    expect(categories()).not.toBeNull()
  })

  it('a refund with no category picked and none learned is not added: the chips say why', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddExpenseSheet open onClose={onClose} />)
    await user.click(option('Refund'))
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'Deposit back')
    await user.type(screen.getByPlaceholderText('0.00'), '50')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(useExpenseStore.getState().expenses).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(NEEDS)).toHaveAttribute('role', 'alert')
    expect(comesOff()).toHaveAccessibleDescription(NEEDS)
    // focus is on the first chip, where the answer is
    expect(comesOff()?.querySelector('button')).toHaveFocus()

    await user.click(chip('Shopping'))
    expect(screen.queryByText(NEEDS)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const [added] = useExpenseStore.getState().expenses
    expect(added).toMatchObject({ itemName: 'Deposit back', category: 'Shopping' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('an expense with no category is still added as before (filed under Other)', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'Zzz thing')
    await user.type(screen.getByPlaceholderText('0.00'), '3')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(useExpenseStore.getState().expenses).toHaveLength(1)
    expect(screen.queryByText(NEEDS)).toBeNull()
  })

  it('stores a refund in its category with the amount as typed, and says so', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AddExpenseSheet open onClose={onClose} />)
    await user.click(option('Refund'))
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'Returned shoes')
    await user.type(screen.getByPlaceholderText('0.00'), '89.90')
    await user.click(chip('Shopping'))
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const [added] = useExpenseStore.getState().expenses
    expect(added).toMatchObject({ itemName: 'Returned shoes', amount: 89.9, category: 'Shopping' })
    expect(added && kindOf(added)).toBe('refund')
    // the confirmation names the category it came off
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
      'Added refund "Returned shoes" · S$89.90 · off Shopping',
    )
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('with no category picked files it where its name’s expenses go', async () => {
    // the app learns where a name goes from an add
    useExpenseStore.getState().addExpense({ itemName: 'Shoes', amount: 89.9, category: 'Shopping' })
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    await user.click(option('Refund'))
    await user.type(screen.getByRole('textbox', { name: 'What' }), 'Shoes')
    await user.type(screen.getByPlaceholderText('0.00'), '89.90')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    const added = useExpenseStore.getState().expenses.find((e) => kindOf(e) === 'refund')
    expect(added).toMatchObject({ itemName: 'Shoes', category: 'Shopping' })
    // said in the confirmation: the category was the app's pick, not a tap
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
      'Added refund "Shoes" · S$89.90 · off Shopping',
    )
  })

  it('opens on Refund when what opened it says so (the Fix of an unreadable refund)', () => {
    render(
      <AddExpenseSheet
        open
        onClose={() => {}}
        prefill={{ itemName: 'Returned shoes', amount: 89.9, category: 'Shopping', kind: 'refund' }}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Add refund' })).toBeInTheDocument()
    expect(option('Refund')).toBeChecked()
    expect(chip('Shopping')).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('the Edit sheet: a refund', () => {
  it('a refund opens as one, with its category, and a save says Refund', async () => {
    await boot([{ ...SHOES, itemName: 'Returned shoes', kind: 'refund' }])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Edit refund' })).toBeInTheDocument()
    expect(option('Refund')).toBeChecked()
    expect(comesOff()).not.toBeNull()
    expect(chip('Shopping')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Delete refund' })).toBeInTheDocument()

    await user.click(chip('Food & Dining'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1')).toMatchObject({ amount: 89.9, category: 'Food & Dining' })
    expect(kindOf(view('e-1'))).toBe('refund')
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Refund updated')
  })

  it('an expense becomes a refund in one save, in the same category, and Undo takes it back', async () => {
    await boot([SHOES])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    await user.click(option('Refund'))
    expect(screen.getByRole('dialog', { name: 'Edit refund' })).toBeInTheDocument()
    expect(chip('Shopping')).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(kindOf(view('e-1'))).toBe('refund')
    expect(view('e-1')).toMatchObject({ amount: 89.9, category: 'Shopping' })

    const undo = useExpenseStore.getState().undoStack.at(-1)
    useExpenseStore.getState().consumeUndo(undo?.id ?? '')
    expect(kindOf(view('e-1'))).toBe('expense')
  })

  it('an income made a refund is given a category in the same save', async () => {
    await boot([{ ...SHOES, itemName: 'From Sam', amount: 30, category: 'Other', kind: 'income' }])
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    expect(categories()).toBeNull()
    await user.click(option('Refund'))
    expect(categories()).not.toBeNull()
    await user.click(chip('Food & Dining'))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(kindOf(view('e-1'))).toBe('refund')
    expect(view('e-1').category).toBe('Food & Dining')
  })

  it('a save that did not touch the switch leaves a refund another device made of it', async () => {
    await boot([SHOES])
    const user = userEvent.setup()
    // the sheet holds the entry as it was when it opened: an expense
    render(<EditExpenseSheet expense={view('e-1')} onClose={() => {}} />)
    useExpenseStore.getState().updateExpense('e-1', { kind: 'refund' })

    await user.type(screen.getByRole('textbox', { name: /^Notes/ }), 'wrong size')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(view('e-1').notes).toBe('wrong size')
    expect(kindOf(view('e-1'))).toBe('refund')
  })
})

describe('a Ledger row: a refund', () => {
  const row = (expense: Expense) =>
    render(
      <ul>
        <li>
          <LedgerRow expense={expense} dateLabel="Oct 19" onEdit={vi.fn()} onDelete={vi.fn()} />
        </li>
      </ul>,
    )
  const BACK: Expense = { ...SHOES, itemName: 'Returned shoes', ext: { kind: 'refund' } }

  beforeEach(async () => {
    await boot([])
  })
  afterEach(() => {
    useExpenseStore.setState({ asideCategories: [] })
  })

  it('shows a minus, the word and its category', () => {
    row(BACK)
    const main = screen.getByRole('button', {
      name: 'Edit Returned shoes, -S$89.90 refund, Shopping, Oct 19',
    })
    expect(main).toHaveTextContent('-S$89.90')
    expect(main).toHaveTextContent('Shopping')
    expect(screen.getByText('refund', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('-S$89.90')).toHaveClass('text-income')
    expect(
      screen.getByRole('button', { name: 'Delete Returned shoes, -S$89.90, Oct 19' }),
    ).toBeInTheDocument()
  })

  it('in a not-spending category it says both, in the colour of an entry no total takes', () => {
    useExpenseStore.setState({ asideCategories: ['Shopping'] })
    row(BACK)
    expect(
      screen.getByRole('button', {
        name: 'Edit Returned shoes, -S$89.90 refund, not spending, Shopping, Oct 19',
      }),
    ).toBeInTheDocument()
    // on screen what a screen reader hears: the word is not left to the sign and the colour
    expect(screen.getByText('refund, not spending', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('-S$89.90')).not.toHaveClass('text-income')
  })
})

describe('Today on Pulse: a refund', () => {
  beforeEach(async () => {
    await boot([])
  })

  it('is listed with the day’s spending, signed and named', () => {
    const lunch: Expense = {
      ...SHOES,
      id: 'e-2',
      itemName: 'Lunch',
      amount: 12.5,
      category: 'Food',
    }
    const back: Expense = { ...SHOES, itemName: 'Returned shoes', ext: { kind: 'refund' } }
    render(
      <MemoryRouter>
        <TodayStrip entries={[lunch, back]} total={-77.4} />
      </MemoryRouter>,
    )
    expect(screen.getByText('-S$77.40')).toBeInTheDocument()
    const refund = screen.getByRole('button', {
      name: 'Edit Returned shoes, -S$89.90 refund, Shopping',
    })
    expect(refund).toHaveTextContent('Shopping · refund')
    expect(screen.getByText('-S$89.90')).toHaveClass('text-income')
    expect(screen.getByRole('button', { name: 'Edit Lunch, S$12.50, Food' })).toBeInTheDocument()
    expect(screen.getByText('S$12.50')).toHaveClass('text-white')
  })
})

describe('Top categories: a category refunds took below zero', () => {
  beforeEach(async () => {
    await boot([])
  })

  it('is listed after the ones with spending, with what came back and no share', () => {
    render(
      <MemoryRouter>
        <TopCategories
          period={null}
          items={[
            { category: 'Food', total: 100, share: 1 },
            { category: 'Transport', total: -12, share: 0 },
          ]}
        />
      </MemoryRouter>,
    )
    const rows = screen.getAllByRole('button')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Food')
    expect(rows[0]).toHaveTextContent('100%')
    expect(rows[1]).toHaveTextContent('Transport')
    expect(rows[1]).toHaveTextContent('S$12.00 back')
    expect(rows[1]).not.toHaveTextContent('%')
  })

  it('with nothing to list in a period that has entries, it says refunds cover the spending', () => {
    const { rerender } = render(
      <MemoryRouter>
        <TopCategories period={null} items={[]} hasEntries />
      </MemoryRouter>,
    )
    expect(screen.getByText('Nothing spent, net')).toBeInTheDocument()
    expect(screen.queryByText('No spending yet')).toBeNull()
    rerender(
      <MemoryRouter>
        <TopCategories period={null} items={[]} />
      </MemoryRouter>,
    )
    expect(screen.getByText('No spending yet')).toBeInTheDocument()
  })
})
