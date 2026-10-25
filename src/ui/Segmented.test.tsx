import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Segmented } from './Segmented'

type Period = 'week' | 'month' | 'year'

const OPTIONS = [
  { value: 'week' as const, label: 'Week' },
  { value: 'month' as const, label: 'Month' },
  { value: 'year' as const, label: 'Year' },
]

function Harness({ onChange }: { onChange?: (v: Period) => void }) {
  const [value, setValue] = useState<Period>('month')
  return (
    <>
      <button type="button">before</button>
      <Segmented<Period>
        label="Period"
        value={value}
        onChange={(v) => {
          setValue(v)
          onChange?.(v)
        }}
        options={OPTIONS}
      />
      <button type="button">after</button>
    </>
  )
}

const radio = (name: string) => screen.getByRole('radio', { name })

describe('Segmented (radio group pattern)', () => {
  it('is a radiogroup named by its label', () => {
    render(<Harness />)
    expect(screen.getByRole('radiogroup', { name: 'Period' })).toBeInTheDocument()
    expect(radio('Month')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Week')).toHaveAttribute('aria-checked', 'false')
  })

  it('is one tab stop: only the checked radio is tabbable', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(radio('Month')).toHaveAttribute('tabindex', '0')
    expect(radio('Week')).toHaveAttribute('tabindex', '-1')
    expect(radio('Year')).toHaveAttribute('tabindex', '-1')

    await user.click(screen.getByRole('button', { name: 'before' }))
    await user.tab()
    expect(radio('Month')).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(radio('Month')).toHaveFocus()
  })

  it('moves and selects with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: Period) => void>()
    render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'before' }))
    await user.tab()

    await user.keyboard('{ArrowRight}')
    expect(radio('Year')).toHaveFocus()
    expect(radio('Year')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Year')).toHaveAttribute('tabindex', '0')
    expect(radio('Month')).toHaveAttribute('tabindex', '-1')

    await user.keyboard('{ArrowDown}')
    expect(radio('Week')).toHaveFocus()
    expect(radio('Week')).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowLeft}')
    expect(radio('Year')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(radio('Month')).toHaveFocus()
    expect(radio('Month')).toHaveAttribute('aria-checked', 'true')

    expect(onChange.mock.calls.map(([v]) => v)).toEqual(['year', 'week', 'year', 'month'])
  })

  it('tells the browser an arrow-key move is keyboard focus, so the ring shows even after a click', async () => {
    // WebKit decides whether script focus shows the ring from how focus last arrived: after a
    // click on a radio, a plain focus() from the arrow key left the next radio with no ring.
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(radio('Month'))
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      await user.keyboard('{ArrowRight}')
      expect(radio('Year')).toHaveFocus()
      expect(focus).toHaveBeenCalledTimes(1)
      expect(focus.mock.contexts[0]).toBe(radio('Year'))
      expect(focus.mock.calls[0]).toEqual([{ focusVisible: true }])
    } finally {
      focus.mockRestore()
    }
  })

  it('leaves other keys and modified arrows alone', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: Period) => void>()
    render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'before' }))
    await user.tab()
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}{Control>}{ArrowLeft}{/Control}a')
    expect(radio('Month')).toHaveFocus()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects on click', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(v: Period) => void>()
    render(<Harness onChange={onChange} />)
    await user.click(radio('Week'))
    expect(onChange).toHaveBeenCalledWith('week')
    expect(radio('Week')).toHaveAttribute('aria-checked', 'true')
    expect(radio('Week')).toHaveAttribute('tabindex', '0')
  })

  it('keeps one tab stop when the value matches no option', () => {
    render(
      <Segmented<string>
        label="Theme"
        value="none"
        onChange={() => undefined}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]}
      />,
    )
    expect(radio('Dark')).toHaveAttribute('tabindex', '0')
    expect(radio('Light')).toHaveAttribute('tabindex', '-1')
  })
})
