import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ForecastChart } from './ForecastChart'

const fmt = (n: number) => `S$${n.toFixed(2)}`
const TODAY = '2026-10-18'
// Fourteen days from today: charges today, in three days and on the last day.
const FORECAST = [9.99, 0, 0, 15.98, 0, 0, 0, 0, 0, 0, 0, 0, 0, 26.22]

function renderChart(forecast: readonly number[] = FORECAST) {
  render(<ForecastChart forecast={forecast} today={TODAY} fmt={fmt} />)
  return screen.getByRole('slider', { name: '14-day forecast by day' })
}

const press = (el: HTMLElement, key: string) => {
  fireEvent.keyDown(el, { key })
}

describe('ForecastChart', () => {
  it('is one slider over the days, described by every day with a charge', () => {
    const slider = renderChart()
    expect(slider).toHaveAttribute('tabindex', '0')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '13')
    expect(slider).toHaveAttribute('aria-valuetext', 'Today, Oct 18 · S$9.99')
    expect(slider).toHaveAccessibleDescription(
      'Charges due: Today, Oct 18 · S$9.99; Oct 21 · S$15.98; Oct 31 · S$26.22.',
    )
  })

  it('steps a day with the arrows, a week with Page Up / Down, to either end with Home / End', () => {
    const slider = renderChart()
    act(() => {
      slider.focus()
    })
    press(slider, 'ArrowRight')
    expect(slider).toHaveAttribute('aria-valuetext', 'Oct 19 · nothing due')
    press(slider, 'PageUp')
    expect(slider).toHaveAttribute('aria-valuetext', 'Oct 26 · nothing due')
    press(slider, 'End')
    expect(slider).toHaveAttribute('aria-valuetext', 'Oct 31 · S$26.22')
    press(slider, 'PageDown')
    expect(slider).toHaveAttribute('aria-valuetext', 'Oct 24 · nothing due')
    press(slider, 'Home')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    expect(slider).toHaveAttribute('aria-valuetext', 'Today, Oct 18 · S$9.99')
  })

  it('says when nothing is due', () => {
    const slider = renderChart(Array.from({ length: 14 }, () => 0))
    expect(slider).toHaveAccessibleDescription('No charges due.')
  })
})
