import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Select } from './Select'

const CATEGORIES = ['Food', 'Social & Leisure', 'Transportation']

function CategoryFilter() {
  const [category, setCategory] = useState('all')
  return (
    <Select
      label="Filter by category"
      value={category}
      onChange={(e) => {
        setCategory(e.target.value)
      }}
      className="max-w-[42vw]"
    >
      <option value="all">All</option>
      {CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </Select>
  )
}

/** The design-size label drawn over the select (hidden from assistive tech). */
function drawnLabel(select: HTMLElement): HTMLElement | null {
  return select.parentElement?.querySelector<HTMLElement>('span[aria-hidden="true"]') ?? null
}

describe('Select', () => {
  it('draws the chosen option at the design size, truncating with an ellipsis', () => {
    render(<CategoryFilter />)
    const select = screen.getByRole('combobox', { name: 'Filter by category' })
    const label = drawnLabel(select)
    expect(label).toHaveTextContent('All')
    expect(label).toHaveClass('text-[13px]')
    expect(label?.querySelector('.truncate')).not.toBeNull()
    // The select's own (16 px on touch screens) text is hidden; its options stay readable.
    expect(select).toHaveClass('text-transparent')
    expect(select).not.toHaveClass('text-white')
  })

  it('follows the selection and keeps the select itself accessible', async () => {
    const user = userEvent.setup()
    render(<CategoryFilter />)
    const select = screen.getByRole('combobox', { name: 'Filter by category' })
    await user.selectOptions(select, 'Social & Leisure')
    expect(select).toHaveValue('Social & Leisure')
    expect(drawnLabel(select)).toHaveTextContent('Social & Leisure')
  })

  it('leaves an uncontrolled select to draw its own text', () => {
    render(
      <Select label="Size" defaultValue="m">
        <option value="s">Small</option>
        <option value="m">Medium</option>
      </Select>,
    )
    const select = screen.getByRole('combobox', { name: 'Size' })
    expect(drawnLabel(select)).toBeNull()
    expect(select).toHaveClass('text-white')
  })

  it('matches an option without a value attribute by its text', () => {
    render(
      <Select label="Mode" value="Weekly" onChange={() => undefined}>
        <option>Daily</option>
        <option>Weekly</option>
      </Select>,
    )
    expect(drawnLabel(screen.getByRole('combobox', { name: 'Mode' }))).toHaveTextContent('Weekly')
  })
})
