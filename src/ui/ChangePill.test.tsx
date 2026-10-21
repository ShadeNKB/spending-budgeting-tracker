import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChangePill } from './ChangePill'

describe('ChangePill', () => {
  it('reads as words with its visible comparison: "Up 41.0% vs Sep 1–18"', () => {
    const { container } = render(
      <ChangePill change={0.41} against="Sep 1–18" label="vs Sep 1–18" />,
    )
    expect(container.textContent).toBe('Up 41.0% vs Sep 1–18')
    expect(container.querySelector('.text-negative')).not.toBeNull()
  })

  it('names the comparison for screen readers when it is not printed', () => {
    const { container } = render(<ChangePill change={-0.32} against="previous 7 days" digits={0} />)
    expect(container.textContent).toBe('Down 32% vs previous 7 days')
    expect(screen.getByText(/vs previous 7 days/)).toHaveClass('sr-only')
    expect(container.querySelector('.text-positive')).not.toBeNull()
  })

  it('is neutral within ±0.5% and absent when there is nothing to compare', () => {
    expect(render(<ChangePill change={0.004} against="Sep 1–18" />).container.textContent).toBe(
      '≈ same as Sep 1–18',
    )
    expect(render(<ChangePill change={null} against="Sep 1–18" />).container.textContent).toBe('')
  })
})
