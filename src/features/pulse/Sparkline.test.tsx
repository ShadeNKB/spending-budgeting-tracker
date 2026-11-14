import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Sparkline } from './Sparkline'
import { useUIStore } from '../../stores/useUIStore'

const LABELS = ['Sep 28', 'Sep 29', 'Sep 30', 'Oct 1']
const NAME = 'Daily spending, last 30 days'

beforeEach(() => {
  useUIStore.setState({ currency: 'SGD' })
})

describe('Sparkline', () => {
  it('is one slider named by its label and described once, by its total and peak', () => {
    const { container } = render(<Sparkline data={[10, 20, 30, 0]} labels={LABELS} label={NAME} />)
    const slider = screen.getByRole('slider', { name: NAME })
    expect(slider).toHaveAttribute('tabindex', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '3')
    expect(slider).toHaveAccessibleDescription('Total S$60.00. Peak S$30.00 on Sep 30.')
    // The drawing is hidden, and nothing repeats the name or the description.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getAllByText('Total S$60.00. Peak S$30.00 on Sep 30.')).toHaveLength(1)
    expect(screen.queryByText(NAME)).toBeNull()
  })

  it('reads each point by its label and amount; focus shows it, blur hides it', () => {
    render(<Sparkline data={[10, 20, 30, 0]} labels={LABELS} label={NAME} />)
    const slider = screen.getByRole('slider', { name: NAME })
    expect(screen.queryByText('Sep 28')).toBeNull()
    act(() => {
      slider.focus()
    })
    expect(slider).toHaveAttribute('aria-valuetext', 'Sep 28 · S$10.00')
    expect(screen.getByText('Sep 28')).toBeInTheDocument() // the tooltip
    fireEvent.keyDown(slider, { key: 'End' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Oct 1 · S$0.00')
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Sep 30 · S$30.00')
    act(() => {
      slider.blur()
    })
    expect(screen.queryByText('Sep 30')).toBeNull()
  })

  // Pulse's year view plots months under short labels; its description reads like the monthly
  // bars beside it ("in August"), not "on Aug". The points keep their short labels.
  it('names the peak as told when its labels are too short for a sentence', () => {
    render(
      <Sparkline
        data={[100, 512.86, 80]}
        labels={['Jul', 'Aug', 'Sep']}
        label="Monthly spending, 2026"
        peakAs={{ labels: ['July', 'August', 'September'], preposition: 'in' }}
      />,
    )
    const slider = screen.getByRole('slider', { name: 'Monthly spending, 2026' })
    expect(slider).toHaveAccessibleDescription('Total S$692.86. Peak S$512.86 in August.')
    expect(slider).toHaveAttribute('aria-valuetext', 'Jul · S$100.00')
  })

  it('a period without spending reads no peak', () => {
    render(<Sparkline data={[0, 0, 0]} labels={LABELS.slice(0, 3)} label={NAME} />)
    expect(screen.getByRole('slider', { name: NAME })).toHaveAccessibleDescription(
      'No spending in this period.',
    )
  })

  it('draws nothing without data', () => {
    const { container } = render(<Sparkline data={[]} labels={[]} label={NAME} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Sparkline below zero (refunds)', () => {
  const area = (container: HTMLElement) =>
    container.querySelector('svg path')?.getAttribute('d') ?? ''
  const zeroLine = (container: HTMLElement) => container.querySelector('[data-zero-line]')

  it('with nothing below zero the fill closes on the foot of the chart, and no baseline is drawn', () => {
    const { container } = render(
      <Sparkline data={[10, 20, 30, 0]} labels={LABELS} label={NAME} height={40} />,
    )
    expect(area(container)).toMatch(/L400,40 L0,40 Z$/)
    expect(zeroLine(container)).toBeNull()
  })

  it('a day below zero: the fill closes on zero, which a hairline marks, not on the foot', () => {
    // -30 .. 30 over 38 px: zero sits halfway, at y = 40 - 19 - 1 = 20
    const { container } = render(
      <Sparkline data={[0, 30, -30, 0]} labels={LABELS} label={NAME} height={40} />,
    )
    expect(area(container)).toMatch(/L400,20 L0,20 Z$/)
    const line = zeroLine(container)
    expect(line).toHaveAttribute('y1', '20')
    expect(line).toHaveAttribute('y2', '20')
    expect(line).toHaveAttribute('stroke', 'var(--chart-axis)')
  })

  it('reads a point below zero as money back, in the slider and in the tooltip', () => {
    render(<Sparkline data={[0, 30, -30, 0]} labels={LABELS} label={NAME} />)
    const slider = screen.getByRole('slider', { name: NAME })
    act(() => {
      slider.focus()
    })
    fireEvent.keyDown(slider, { key: 'Home' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider).toHaveAttribute('aria-valuetext', 'Sep 30 · S$30.00 back')
    expect(screen.getByText('S$30.00 back')).toBeInTheDocument()
  })
})
