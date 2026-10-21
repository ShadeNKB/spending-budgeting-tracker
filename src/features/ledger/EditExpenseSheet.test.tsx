import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditExpenseSheet } from './EditExpenseSheet'
import type { Expense } from '../../types'

// Invented data.
const KOPI: Expense = {
  id: 'e-1',
  itemName: 'Kopi O',
  amount: 1.8,
  category: 'Food',
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
}

// Touch screens floor a select's own text at 16 px (index.css, against iOS focus zoom). Drawn
// by the select itself, this chip would grow past its 12 px neighbours.
describe('EditExpenseSheet "More…" category chip', () => {
  // jsdom has no matchMedia; the sheet only listens to it for the phone layout.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (media: string) =>
      Object.assign(new EventTarget(), { media, matches: false }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('draws its label at chip size, with the native select invisible on top', async () => {
    const user = userEvent.setup()
    render(<EditExpenseSheet expense={KOPI} onClose={() => {}} />)
    const more = screen.getByRole('combobox', { name: 'More categories' })
    const chip = more.parentElement
    const label = () => chip?.querySelector('span[aria-hidden="true"]')
    expect(label()).toHaveTextContent('More…')
    expect(chip).toHaveClass('text-[12px]', 'h-[30px]')
    expect(more).toHaveClass('opacity-0', 'absolute', 'inset-0')

    await user.selectOptions(more, 'Investment')
    expect(more).toHaveValue('Investment')
    expect(label()).toHaveTextContent('Investment')
  })
})
