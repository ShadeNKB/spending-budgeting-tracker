import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MonthlyBars } from './MonthlyBars'
import { useUIStore } from '../../stores/useUIStore'
import type { MonthTotal } from '../../lib/analytics'

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Twelve months of `year`, with `current` (0-11) the month in progress, or null for a past year. */
const months = (totals: readonly number[], current: number | null): MonthTotal[] =>
  totals.map((total, month) => ({
    month,
    label: SHORT[month] ?? '',
    total,
    state: current === null || month < current ? 'past' : month === current ? 'current' : 'future',
  }))

// October 2026 in progress; December holds a future-dated row (an annual fee logged ahead).
const THIS_YEAR = months([0, 50, 0, 0, 0, 0, 0, 120.5, 300, 469.8, 0, 500], 9)

function renderBars(data: MonthTotal[], year = 2026) {
  const highest = data.reduce<MonthTotal | null>(
    (best, m) => (m.total > (best?.total ?? 0) ? m : best),
    null,
  )
  const total = data.reduce((sum, m) => sum + m.total, 0)
  render(<MonthlyBars year={year} data={data} total={total} highest={highest} />)
  return screen.getByRole('slider', { name: `Monthly totals, ${String(year)}` })
}

const press = (el: HTMLElement, key: string) => {
  fireEvent.keyDown(el, { key })
}

beforeEach(() => {
  useUIStore.setState({ currency: 'SGD' })
})

describe('MonthlyBars', () => {
  it('is one slider over the twelve months, described by its total and peak', () => {
    const slider = renderBars(THIS_YEAR)
    expect(slider).toHaveAttribute('tabindex', '0')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '11')
    expect(slider).toHaveAccessibleDescription('Total S$1,440.30. Peak S$500.00 in December.')
    // The only tab stop: no bar is a control of its own.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(slider.querySelectorAll('[data-state="current"]')).toHaveLength(1)
    expect(slider.querySelectorAll('[data-state="future"]')).toHaveLength(2)
  })

  it('reads a past month, the month so far, and an upcoming month with any amount already logged', () => {
    const slider = renderBars(THIS_YEAR)
    act(() => {
      slider.focus()
    })
    expect(slider).toHaveAttribute('aria-valuetext', 'January · S$0.00')
    press(slider, 'End')
    expect(slider).toHaveAttribute('aria-valuetext', 'December · S$500.00 · upcoming')
    press(slider, 'ArrowLeft')
    expect(slider).toHaveAttribute('aria-valuetext', 'November · upcoming')
    press(slider, 'ArrowLeft')
    expect(slider).toHaveAttribute('aria-valuetext', 'October · S$469.80 so far')
    press(slider, 'ArrowLeft')
    expect(slider).toHaveAttribute('aria-valuetext', 'September · S$300.00')
  })

  it('reads a past year evenly, every month an amount', () => {
    const slider = renderBars(months([10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 80], null), 2025)
    expect(slider).toHaveAccessibleDescription('Total S$90.00. Peak S$80.00 in December.')
    act(() => {
      slider.focus()
    })
    press(slider, 'End')
    expect(slider).toHaveAttribute('aria-valuetext', 'December · S$80.00')
    expect(slider.querySelectorAll('[data-state="past"]')).toHaveLength(12)
  })

  it('a year without spending never reads a peak', () => {
    const slider = renderBars(
      months(
        Array.from({ length: 12 }, () => 0),
        9,
      ),
    )
    expect(slider).toHaveAccessibleDescription('No spending in this period.')
  })
})
