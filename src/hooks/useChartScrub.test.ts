import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { pointAt, seriesSummary, useChartScrub, type ScrubScale } from './useChartScrub'

const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon 2', 'Tue 2', 'Wed 2']

/** A chart of `count` points read as "{label}", 400 px wide from x = 100. */
function Chart({ count, scale }: { count: number; scale?: ScrubScale }) {
  const scrub = useChartScrub({ count, scale })
  return createElement(
    'div',
    {
      ...scrub.props,
      'aria-label': 'Test chart',
      'aria-valuetext': LABELS[scrub.value] ?? '',
      'data-active': scrub.active === null ? 'none' : String(scrub.active),
    },
    'chart',
  )
}

function renderChart(count = 10, scale?: ScrubScale) {
  const view = render(createElement(Chart, { count, scale }))
  const slider = screen.getByRole('slider', { name: 'Test chart' })
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, width: 400 }),
  )
  return { ...view, slider }
}

const activeOf = (el: HTMLElement) => el.dataset.active

const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
  fireEvent.keyDown(el, { key, ...init })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pointAt', () => {
  it('maps x to equal bands for bar charts (gaps included)', () => {
    expect(pointAt(0, 400, 10)).toBe(0)
    expect(pointAt(39.9, 400, 10)).toBe(0)
    expect(pointAt(40, 400, 10)).toBe(1)
    expect(pointAt(399, 400, 10)).toBe(9)
  })

  it('maps x to the nearest point for line charts (first and last points on the edges)', () => {
    // 10 points at 0, 44.4, 88.9 … 400
    expect(pointAt(0, 400, 10, 'point')).toBe(0)
    expect(pointAt(22, 400, 10, 'point')).toBe(0)
    expect(pointAt(23, 400, 10, 'point')).toBe(1)
    expect(pointAt(380, 400, 10, 'point')).toBe(9)
    expect(pointAt(400, 400, 10, 'point')).toBe(9)
  })

  it('clamps outside the chart and survives degenerate boxes', () => {
    expect(pointAt(-30, 400, 10)).toBe(0)
    expect(pointAt(900, 400, 10)).toBe(9)
    expect(pointAt(900, 400, 10, 'point')).toBe(9)
    expect(pointAt(50, 0, 10)).toBe(0)
    expect(pointAt(50, 400, 1, 'point')).toBe(0)
  })
})

describe('seriesSummary', () => {
  const fmt = (n: number) => `S$${n.toFixed(2)}`
  const days = ['Sep 28', 'Sep 29', 'Sep 30', 'Oct 1']

  it('states the total and the first highest point', () => {
    expect(seriesSummary([10, 20, 30, 0], (i) => days[i] ?? '', fmt)).toBe(
      'Total S$60.00. Peak S$30.00 on Sep 30.',
    )
    expect(seriesSummary([5, 9, 9, 1], (i) => days[i] ?? '', fmt)).toBe(
      'Total S$24.00. Peak S$9.00 on Sep 29.',
    )
  })

  it('takes another preposition for months, and drops a missing label', () => {
    expect(seriesSummary([1, 4], (i) => ['September', 'October'][i] ?? '', fmt, 'in')).toBe(
      'Total S$5.00. Peak S$4.00 in October.',
    )
    expect(seriesSummary([1, 4], () => '', fmt)).toBe('Total S$5.00. Peak S$4.00.')
  })

  it('never reads a peak in a period without spending', () => {
    expect(seriesSummary([0, 0, 0], (i) => days[i] ?? '', fmt)).toBe('No spending in this period.')
    expect(seriesSummary([], (i) => days[i] ?? '', fmt)).toBe('No spending in this period.')
  })
})

describe('useChartScrub', () => {
  it('is one focusable slider spanning every point, reading the first point at rest', () => {
    const { slider } = renderChart(10)
    expect(slider).toHaveAttribute('tabindex', '0')
    expect(slider).toHaveAttribute('aria-valuemin', '0')
    expect(slider).toHaveAttribute('aria-valuemax', '9')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    expect(slider).toHaveAttribute('aria-valuetext', 'Mon')
    expect(activeOf(slider)).toBe('none')
  })

  it('focus shows the first point, blur hides it again', () => {
    const { slider } = renderChart(10)
    act(() => {
      slider.focus()
    })
    expect(activeOf(slider)).toBe('0')
    act(() => {
      slider.blur()
    })
    expect(activeOf(slider)).toBe('none')
  })

  it('focus keeps a point already picked by the pointer', () => {
    const { slider } = renderChart(10)
    fireEvent.pointerDown(slider, { clientX: 100 + 250, pointerType: 'touch' })
    act(() => {
      slider.focus()
    })
    expect(activeOf(slider)).toBe('6')
  })

  it('steps with the arrows: right/up +1, left/down −1, clamped at both ends', () => {
    const { slider } = renderChart(10)
    act(() => {
      slider.focus()
    })
    press(slider, 'ArrowRight')
    press(slider, 'ArrowUp')
    expect(slider).toHaveAttribute('aria-valuenow', '2')
    expect(slider).toHaveAttribute('aria-valuetext', 'Wed')
    press(slider, 'ArrowLeft')
    expect(slider).toHaveAttribute('aria-valuenow', '1')
    press(slider, 'ArrowDown')
    press(slider, 'ArrowDown')
    press(slider, 'ArrowLeft')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    press(slider, 'End')
    press(slider, 'ArrowRight')
    expect(slider).toHaveAttribute('aria-valuenow', '9')
  })

  it('pages by seven (PageUp later, PageDown earlier) and jumps with Home / End, clamped', () => {
    const { slider } = renderChart(10)
    act(() => {
      slider.focus()
    })
    press(slider, 'PageUp')
    expect(slider).toHaveAttribute('aria-valuenow', '7')
    press(slider, 'PageUp')
    expect(slider).toHaveAttribute('aria-valuenow', '9')
    press(slider, 'PageDown')
    expect(slider).toHaveAttribute('aria-valuenow', '2')
    press(slider, 'PageDown')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
    press(slider, 'End')
    expect(slider).toHaveAttribute('aria-valuenow', '9')
    press(slider, 'Home')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
  })

  it('handled keys do not scroll the page; other keys and shortcuts pass through', () => {
    const { slider } = renderChart(10)
    act(() => {
      slider.focus()
    })
    expect(fireEvent.keyDown(slider, { key: 'ArrowRight' })).toBe(false) // default prevented
    expect(fireEvent.keyDown(slider, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(slider, { key: 'a' })).toBe(true)
    // Alt+← is the browser's Back; Ctrl/⌘ + arrows belong to the system.
    expect(fireEvent.keyDown(slider, { key: 'ArrowLeft', altKey: true })).toBe(true)
    expect(fireEvent.keyDown(slider, { key: 'ArrowRight', metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(slider, { key: 'Home', ctrlKey: true })).toBe(true)
    expect(slider).toHaveAttribute('aria-valuenow', '1')
    expect(fireEvent.keyDown(slider, { key: 'PageDown' })).toBe(false)
    expect(fireEvent.keyDown(slider, { key: 'End' })).toBe(false)
    expect(slider).toHaveAttribute('aria-valuenow', '9')
  })

  it('Escape clears the point being read', () => {
    const { slider } = renderChart(10)
    act(() => {
      slider.focus()
    })
    press(slider, 'End')
    expect(activeOf(slider)).toBe('9')
    press(slider, 'Escape')
    expect(activeOf(slider)).toBe('none')
    expect(slider).toHaveAttribute('aria-valuenow', '0')
  })

  it('a mouse scrubs on hover and lets go when it leaves', () => {
    const { slider } = renderChart(10)
    fireEvent.pointerMove(slider, { clientX: 100 + 130, pointerType: 'mouse', buttons: 0 })
    expect(activeOf(slider)).toBe('3')
    fireEvent.pointerMove(slider, { clientX: 100 + 399, pointerType: 'mouse', buttons: 0 })
    expect(activeOf(slider)).toBe('9')
    fireEvent.pointerLeave(slider, { pointerType: 'mouse' })
    expect(activeOf(slider)).toBe('none')
  })

  it('a finger reads the point it presses and scrubs only while pressed; lifting keeps it', () => {
    const { slider } = renderChart(10)
    fireEvent.pointerMove(slider, { clientX: 100 + 130, pointerType: 'touch', buttons: 0 })
    expect(activeOf(slider)).toBe('none')
    fireEvent.pointerDown(slider, { clientX: 100 + 10, pointerType: 'touch', buttons: 1 })
    expect(activeOf(slider)).toBe('0')
    fireEvent.pointerMove(slider, { clientX: 100 + 210, pointerType: 'touch', buttons: 1 })
    expect(activeOf(slider)).toBe('5')
    fireEvent.pointerLeave(slider, { pointerType: 'touch' })
    expect(activeOf(slider)).toBe('5')
  })

  it("maps the pointer to the nearest point on a line chart's scale", () => {
    const { slider } = renderChart(10, 'point')
    fireEvent.pointerDown(slider, { clientX: 100 + 23, pointerType: 'mouse', buttons: 1 })
    expect(activeOf(slider)).toBe('1')
    fireEvent.pointerDown(slider, { clientX: 100 + 400, pointerType: 'mouse', buttons: 1 })
    expect(activeOf(slider)).toBe('9')
  })

  it('keeps the point in range when the series gets shorter', () => {
    const { slider, rerender } = renderChart(10)
    act(() => {
      slider.focus()
    })
    press(slider, 'End')
    rerender(createElement(Chart, { count: 4 }))
    expect(slider).toHaveAttribute('aria-valuemax', '3')
    expect(slider).toHaveAttribute('aria-valuenow', '3')
    expect(activeOf(slider)).toBe('3')
    press(slider, 'ArrowLeft')
    expect(slider).toHaveAttribute('aria-valuenow', '2')
  })
})
