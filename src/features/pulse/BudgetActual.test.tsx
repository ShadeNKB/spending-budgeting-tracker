import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { BudgetActual } from './BudgetActual'
import { useUIStore } from '../../stores/useUIStore'
import type { CategoryBudgetStat } from '../../lib/analytics'

const stat = (s: Partial<CategoryBudgetStat> & Pick<CategoryBudgetStat, 'category'>) => {
  const total = s.total ?? 50
  const budget = s.budget ?? 200
  return {
    total,
    budget,
    used: total / budget,
    expected: 0.6,
    left: Math.max(0, budget - total),
    status: 'onTrack' as const,
    projected: null,
    ...s,
  }
}

const ITEMS: CategoryBudgetStat[] = [
  stat({ category: 'Shopping', total: 300, status: 'over' }),
  stat({ category: 'Food & Dining', total: 150, status: 'ahead', projected: 260 }),
  stat({ category: 'Transportation', total: 40 }),
]

function LedgerProbe() {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{pathname + search}</output>
}

const row = (category: string) => screen.getByRole('button', { name: new RegExp(`^${category}`) })

beforeEach(() => {
  useUIStore.setState({ currency: 'SGD' })
})

function renderRows(items: CategoryBudgetStat[], isFinal = false) {
  return render(
    <MemoryRouter>
      <BudgetActual items={items} isFinal={isFinal} />
    </MemoryRouter>,
  )
}

describe('BudgetActual names', () => {
  it('reads category, spent, cap and the status in words (current month)', () => {
    renderRows(ITEMS)
    const over = row('Shopping')
    expect(over).toHaveAccessibleName(/Shopping.*Over budget.*S\$300\.00 of S\$200\.00/)
    expect(over).toHaveAccessibleName(/Over by S\$100\.00$/)

    const ahead = row('Food & Dining')
    expect(ahead).toHaveAccessibleName(
      /Food & Dining.*On pace to go over budget.*S\$150\.00 of S\$200\.00/,
    )
    expect(ahead).toHaveAccessibleName(/Projected S\$260\.00$/)

    const fine = row('Transportation')
    expect(fine).toHaveAccessibleName(/Transportation.*On track.*S\$40\.00 of S\$200\.00/)
    expect(fine).toHaveAccessibleName(/20% used · S\$160\.00 left$/)
  })

  it('a finished month reads under or over budget, never a pace', () => {
    renderRows(
      [
        stat({ category: 'Shopping', total: 300, status: 'over' }),
        stat({ category: 'Transportation', total: 40 }),
      ],
      true,
    )
    expect(row('Shopping')).toHaveAccessibleName(/Shopping.*Over budget.*S\$300\.00 of S\$200\.00/)
    expect(row('Transportation')).toHaveAccessibleName(
      /Transportation.*Under budget.*S\$40\.00 of S\$200\.00.*S\$160\.00 under$/,
    )
    expect(screen.queryByText(/On track|On pace/)).toBeNull()
  })

  it('is named by its visible text: no aria-label, icons and the slash hidden', () => {
    const { container } = renderRows(ITEMS)
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-label')
      expect(button).not.toHaveAccessibleName(/\//)
    }
    const icons = container.querySelectorAll('svg')
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) expect(icon).toHaveAttribute('aria-hidden', 'true')
    // The status word is for screen readers only: the colour, icon and note show it on screen.
    expect(within(row('Shopping')).getByText(/Over budget/)).toHaveClass('sr-only')
  })

  it('opens the category in the ledger', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/pulse']}>
        <Routes>
          <Route path="/pulse" element={<BudgetActual items={ITEMS} isFinal={false} />} />
          <Route path="/ledger" element={<LedgerProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    await user.click(row('Food & Dining'))
    expect(screen.getByTestId('location')).toHaveTextContent('/ledger?category=Food%20%26%20Dining')
  })
})
