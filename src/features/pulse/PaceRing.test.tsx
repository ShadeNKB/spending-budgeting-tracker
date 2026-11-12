import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { BudgetFinal, PaceRing } from './PaceRing'
import type { BudgetSummary } from '../../lib/analytics'

afterEach(cleanup)

const summary = (over: Partial<BudgetSummary> = {}): BudgetSummary => ({
  scope: 'categories',
  cap: 300,
  spent: 90,
  used: 0.3,
  expected: 18 / 31,
  left: 210,
  perDay: 15,
  projected: null,
  status: 'onTrack',
  unbudgeted: 410,
  isFinal: false,
  ...over,
})

describe('PaceRing', () => {
  it('category caps: says the ring covers budgeted categories only', () => {
    render(<PaceRing budget={summary()} daysLeft={14} />)
    const ring = screen.getByRole('img')
    expect(ring).toHaveAccessibleName(/^Budget 30% used: .*90\.00 of .*300\.00\./)
    expect(ring).toHaveAccessibleName(/Budgeted categories only\.$/)
    expect(screen.getByText('Budgeted categories only')).toBeInTheDocument()
  })

  it('a whole-month budget: named as such, with no such caveat', () => {
    render(
      <PaceRing
        budget={summary({
          scope: 'all',
          cap: 1000,
          spent: 500,
          used: 0.5,
          left: 500,
          unbudgeted: 0,
        })}
        daysLeft={14}
      />,
    )
    const ring = screen.getByRole('img')
    expect(ring).toHaveAccessibleName(/^Whole month budget 50% used: .*500\.00 of .*1,000\.00\./)
    expect(ring).not.toHaveAccessibleName(/Budgeted categories only/)
    expect(screen.queryByText('Budgeted categories only')).toBeNull()
    // what is left, and what that is a day
    expect(ring).toHaveAccessibleName(/500\.00 left, .*15\.00 a day, 14 days left\./)
  })

  it('a finished month with a whole-month budget shows the result without the caveat', () => {
    render(
      <BudgetFinal
        budget={summary({
          scope: 'all',
          cap: 450,
          spent: 500,
          used: 500 / 450,
          left: 0,
          perDay: null,
          status: 'over',
          unbudgeted: 0,
          isFinal: true,
        })}
      />,
    )
    expect(screen.getByText(/Over by/)).toBeInTheDocument()
    expect(screen.queryByText('Budgeted categories only')).toBeNull()
  })
})
