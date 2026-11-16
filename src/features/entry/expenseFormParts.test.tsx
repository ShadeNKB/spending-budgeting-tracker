import { createRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CategoryChips, DatePresets, KindSwitch } from './expenseFormParts'
import { chosenChipFill } from './expenseForm'
import { addDays } from '../../lib/dates'
import type { EntryKind } from '../../data/core/types'

const TODAY = '2026-11-16'
const EIGHT = ['Food', 'Transport', 'Shopping', 'Bills', 'Fun', 'Health', 'Gifts', 'Travel']
const TWELVE = [...EIGHT, 'Pets', 'Books', 'Rent', 'Other']

describe('KindSwitch', () => {
  function Harness({ onChange }: { onChange?: (k: EntryKind) => void }) {
    const [kind, setKind] = useState<EntryKind>('expense')
    return (
      <KindSwitch
        value={kind}
        onChange={(k) => {
          setKind(k)
          onChange?.(k)
        }}
      />
    )
  }

  it('is the "Kind of entry" radio group: Expense, Income, Refund', () => {
    render(<Harness />)
    const group = screen.getByRole('radiogroup', { name: 'Kind of entry' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Expense', 'Income', 'Refund'])
    expect(screen.getByRole('radio', { name: 'Expense' })).toHaveAttribute('aria-checked', 'true')
  })

  it('hands each pick to the sheet, by click and by arrow key', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(k: EntryKind) => void>()
    render(<Harness onChange={onChange} />)
    await user.click(screen.getByRole('radio', { name: 'Refund' }))
    await user.keyboard('{ArrowLeft}')
    expect(onChange.mock.calls.map(([k]) => k)).toEqual(['refund', 'income'])
    expect(screen.getByRole('radio', { name: 'Income' })).toHaveFocus()
  })
})

describe('DatePresets', () => {
  const pill = (name: string) => screen.getByRole('button', { name })

  it('is a group named "Date" unless the sheet names it with its own label', () => {
    const { unmount } = render(<DatePresets value={TODAY} today={TODAY} onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'Date' })).not.toHaveAttribute('aria-labelledby')
    unmount()
    render(
      <>
        <span id="when">When</span>
        <DatePresets value={TODAY} today={TODAY} onChange={() => {}} labelledBy="when" />
      </>,
    )
    const group = screen.getByRole('group', { name: 'When' })
    expect(group).not.toHaveAttribute('aria-label')
  })

  it('presses the preset that is the day, and hands a tapped one to the sheet as a calendar day', () => {
    const onChange = vi.fn<(day: string) => void>()
    render(<DatePresets value={addDays(TODAY, -1)} today={TODAY} onChange={onChange} />)
    expect(pill('Yesterday')).toHaveAttribute('aria-pressed', 'true')
    expect(pill('Today')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(pill('3d ago'))
    fireEvent.click(pill('2d ago'))
    fireEvent.click(pill('Today'))
    expect(onChange.mock.calls.map(([d]) => d)).toEqual(['2026-11-13', '2026-11-14', TODAY])
  })

  it('shows the day on the calendar pill only when it is none of the presets', () => {
    const { unmount } = render(<DatePresets value={TODAY} today={TODAY} onChange={() => {}} />)
    expect(pill('Pick date')).toBeInTheDocument()
    unmount()
    render(<DatePresets value="2026-10-01" today={TODAY} onChange={() => {}} />)
    expect(pill('Change date, selected Oct 1, 2026')).toBeInTheDocument()
    for (const name of ['Today', 'Yesterday', '2d ago', '3d ago'])
      expect(pill(name)).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('CategoryChips', () => {
  const chip = (name: string) => screen.getByRole('button', { name })
  const more = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'More categories' })

  it('labels the group "Category", or "Category it comes off" for a refund', () => {
    const { unmount } = render(
      <CategoryChips categories={EIGHT} value="" clearTo="" onChange={() => {}} refund={false} />,
    )
    expect(screen.getByRole('group', { name: 'Category' })).toBeInTheDocument()
    unmount()
    render(<CategoryChips categories={EIGHT} value="" clearTo="" onChange={() => {}} refund />)
    expect(screen.getByRole('group', { name: 'Category it comes off' })).toBeInTheDocument()
  })

  it('shows eight chips and no "More…" for eight categories', () => {
    render(
      <CategoryChips categories={EIGHT} value="" clearTo="" onChange={() => {}} refund={false} />,
    )
    expect(screen.getAllByRole('button')).toHaveLength(8)
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('presses and fills the chosen chip; a tap on it again hands back clearTo', () => {
    const onChange = vi.fn<(c: string) => void>()
    render(
      <CategoryChips
        categories={EIGHT}
        value="Fun"
        clearTo="Other"
        onChange={onChange}
        refund={false}
      />,
    )
    expect(chip('Fun')).toHaveAttribute('aria-pressed', 'true')
    expect(chip('Fun').style.background).not.toBe('')
    expect(chip('Food')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chip('Fun'))
    fireEvent.click(chip('Food'))
    expect(onChange.mock.calls.map(([c]) => c)).toEqual(['Other', 'Food'])
  })

  it('puts the rest behind "More…", naming the one chosen there, and hands every pick on as it is', () => {
    const onChange = vi.fn<(c: string) => void>()
    const { rerender } = render(
      <CategoryChips
        categories={TWELVE}
        value="Food"
        clearTo=""
        onChange={onChange}
        refund={false}
      />,
    )
    expect(screen.getAllByRole('button')).toHaveLength(8)
    expect(more().value).toBe('')
    expect(screen.getByText('More…', { selector: 'span' })).toHaveAttribute('aria-hidden', 'true')
    fireEvent.change(more(), { target: { value: 'Books' } })
    fireEvent.change(more(), { target: { value: '' } })
    expect(onChange.mock.calls.map(([c]) => c)).toEqual(['Books', ''])
    rerender(
      <CategoryChips
        categories={TWELVE}
        value="Rent"
        clearTo=""
        onChange={onChange}
        refund={false}
      />,
    )
    expect(more().value).toBe('Rent')
    expect(screen.getByText('Rent', { selector: 'span' })).toBeInTheDocument()
  })

  it('draws the chevron on "More…" in both sheets (the Edit sheet clears to Other)', () => {
    for (const clearTo of ['', 'Other']) {
      const { container, unmount } = render(
        <CategoryChips
          categories={TWELVE}
          value=""
          clearTo={clearTo}
          onChange={() => {}}
          refund={false}
        />,
      )
      expect(container.querySelector('.lucide-chevron-down')).not.toBeNull()
      unmount()
    }
  })

  it('marks a suggestion in the label and on its chip, dashed in its colour', () => {
    const { rerender } = render(
      <CategoryChips
        categories={TWELVE}
        value=""
        clearTo=""
        onChange={() => {}}
        refund={false}
        suggestion="Fun"
      />,
    )
    expect(
      screen.getByRole('group', { name: /^Category\s*· suggested from your entries$/ }),
    ).toBeInTheDocument()
    expect(chip('Fun, suggested')).toHaveAttribute('aria-pressed', 'false')
    expect(chip('Fun, suggested')).toHaveClass('border-dashed')
    expect(chip('Fun, suggested').style.borderColor).not.toBe('')
    // a suggestion from the rest is what "More…" shows
    rerender(
      <CategoryChips
        categories={TWELVE}
        value=""
        clearTo=""
        onChange={() => {}}
        refund={false}
        suggestion="Rent"
      />,
    )
    expect(screen.getByText('Rent', { selector: 'span' })).toBeInTheDocument()
    expect(more().value).toBe('')
  })

  it('says an error under the chips, describes the group with it, and lends the sheet its group', () => {
    const groupRef = createRef<HTMLDivElement>()
    render(
      <CategoryChips
        categories={EIGHT}
        value=""
        clearTo=""
        onChange={() => {}}
        refund
        error="Pick the category this refund comes off."
        groupRef={groupRef}
      />,
    )
    const group = screen.getByRole('group', { name: 'Category it comes off' })
    expect(groupRef.current).toBe(group)
    expect(screen.getByRole('alert')).toHaveTextContent('Pick the category this refund comes off.')
    expect(group).toHaveAccessibleDescription('Pick the category this refund comes off.')
  })

  it('without an error, describes nothing', () => {
    render(
      <CategoryChips categories={EIGHT} value="" clearTo="" onChange={() => {}} refund={false} />,
    )
    expect(screen.getByRole('group', { name: 'Category' })).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("fills a chosen chip in the category's lighter hue", () => {
    render(
      <CategoryChips
        categories={EIGHT}
        value="Food"
        clearTo=""
        onChange={() => {}}
        refund={false}
      />,
    )
    const probe = document.createElement('div')
    probe.style.background = chosenChipFill('Food')
    expect(chip('Food').style.background).toBe(probe.style.background)
  })
})
