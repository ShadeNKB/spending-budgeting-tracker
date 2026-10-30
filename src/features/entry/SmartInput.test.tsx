import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SmartInput } from './SmartInput'

const quickAdd = () => screen.getByRole('textbox', { name: 'Quick add expense' })
/** The bar's frame (input row + preview), two levels up as the e2e suite reads it. */
const frame = () => quickAdd().parentElement?.parentElement ?? null
const preview = () => frame()?.querySelector<HTMLElement>('[data-quick-add-preview]') ?? null

describe('SmartInput focus and targets', () => {
  it('has one focus indicator: the frame rings while the input is focused', () => {
    render(<SmartInput />)
    const input = quickAdd()
    expect(input).toHaveClass('field-control')
    expect(input).not.toHaveClass('outline-none')
    expect(frame()).toHaveClass('field-focus')
    expect(frame()?.className ?? '').not.toMatch(/focus-within:(shadow|border|ring)/)
  })

  it('takes a tap on its sparkle into the input: the icon is drawn over the input’s own padding', () => {
    render(<SmartInput />)
    const input = quickAdd()
    const sparkle = input.parentElement?.querySelector(':scope > svg')
    // Decoration only: hidden from screen readers and from the pointer, so a tap on it falls
    // through to the input under it.
    expect(sparkle).toHaveAttribute('aria-hidden', 'true')
    expect(sparkle).toHaveClass('pointer-events-none', 'absolute')
    // The input reaches the frame's left edge: the frame has no left padding, the input does.
    expect(frame()?.className ?? '').not.toMatch(/(^|\s)p[xl]-/)
    expect(input.className).toMatch(/(^|\s)pl-/)
  })

  it('gives clear, full entry and Add a 44 px coarse-pointer hit area, spaced apart', async () => {
    const user = userEvent.setup()
    render(<SmartInput />)
    await user.type(quickAdd(), 'coffee 4.50')
    const clear = screen.getByRole('button', { name: 'Clear quick entry' })
    const pen = screen.getByRole('button', { name: 'Full entry form' })
    const add = screen.getByRole('button', { name: 'Add' })
    for (const button of [clear, pen, add]) expect(button).toHaveClass('tap-target')
    // 32 px boxes: 12 px apart keeps their 44 px hit areas from overlapping.
    expect(clear).toHaveClass('h-8', 'w-8')
    expect(pen).toHaveClass('h-8', 'w-8', 'ml-1')

    await user.click(clear)
    expect(quickAdd()).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Clear quick entry' })).toBeNull()
  })
})

describe('SmartInput parse preview', () => {
  it('in the header (dense) floats under the bar, so typing never grows the header', async () => {
    const user = userEvent.setup()
    render(<SmartInput dense />)
    expect(preview()).toBeNull()
    await user.type(quickAdd(), 'coffee 4.50')
    const panel = preview()
    expect(panel).not.toBeNull()
    expect(panel).toHaveClass('absolute', 'top-full', 'inset-x-0')
    expect(panel).toHaveTextContent('coffee')
    expect(panel).toHaveTextContent('4.50')
    // Shown only while the bar has focus: it never covers the page after the user moves on.
    expect(panel).toHaveClass('hidden', 'group-focus-within:flex')
    expect(frame()).toHaveClass('group', 'relative')
  })

  it('on a screen (not dense) stays in the flow under the input', async () => {
    const user = userEvent.setup()
    render(<SmartInput />)
    await user.type(quickAdd(), 'grab 12')
    const panel = preview()
    expect(panel).not.toBeNull()
    expect(panel).not.toHaveClass('absolute')
    expect(panel).not.toHaveClass('hidden')
    expect(panel).toHaveTextContent('grab')
    // Chips start under the typed text, like the floating panel's.
    expect(panel).toHaveClass('pl-9')
  })
})
