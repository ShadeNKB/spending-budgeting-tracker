import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SmartInput } from './SmartInput'
import { NOT_STARTED, undoOutcomeMessage, useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'

// The first hydrate loads the engine chunk, the data core with it. Under a full parallel run on a
// busy machine that load alone ran past the 5 s default, and the timed-out boot then landed in
// the next test. Load it once here, with room: every boot after it is quick.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

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

// P2-2: a quick add stores a day, today when the text names none, read off the device clock at
// the moment of the add. P2-13: what the store refuses is said. Run in Asia/Singapore,
// Pacific/Honolulu and Pacific/Kiritimati (PowerShell $env:TZ).
describe('SmartInput adds', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 18, 10, 0))
    // P2-14: an empty device, booted for real (whatever the last test left pending first).
    await useExpenseStore.getState().hydrate()
    localStorage.clear()
    await useExpenseStore.getState().hydrate()
    useUIStore.setState({ toasts: [], currency: 'SGD' })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Types `text` into a fresh quick add and presses Enter; the entry stored for `item`. */
  const add = (text: string, item = 'kopi') => {
    render(<SmartInput />)
    fireEvent.change(quickAdd(), { target: { value: text } })
    fireEvent.keyDown(quickAdd(), { key: 'Enter' })
    return useExpenseStore.getState().expenses.find((e) => e.itemName === item)
  }

  // One matcher for every way in (F-044): the bar shows, and files under, what the add itself
  // and the Add sheet would pick (useLearnedCategory, over the engine's smartCategory).
  it("suggests the app's own pick from past entries, through a typo too, and files it there", () => {
    act(() => {
      useExpenseStore
        .getState()
        .addExpense({ itemName: 'Grab home', amount: 12, category: 'Transportation' })
    })
    render(<SmartInput />)
    fireEvent.change(quickAdd(), { target: { value: 'grab hme 9.50' } })
    expect(screen.getByText('Transportation')).toBeInTheDocument()
    expect(useExpenseStore.getState().getSmartCategory('grab hme')).toBe('Transportation')
    fireEvent.keyDown(quickAdd(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses.find((e) => e.amount === 9.5)).toMatchObject({
      itemName: 'grab hme',
      category: 'Transportation',
    })
  })

  it('a category typed after the amount wins over the pick', () => {
    act(() => {
      useExpenseStore
        .getState()
        .addExpense({ itemName: 'Grab home', amount: 12, category: 'Transportation' })
    })
    render(<SmartInput />)
    fireEvent.change(quickAdd(), { target: { value: 'grab home 30 shopping' } })
    expect(screen.getByText('Shopping')).toBeInTheDocument()
    expect(screen.queryByText('Transportation')).toBeNull()
    fireEvent.keyDown(quickAdd(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses.find((e) => e.amount === 30)?.category).toBe(
      'Shopping',
    )
  })

  it('follows what the app learns while the text is in the bar', () => {
    render(<SmartInput />)
    fireEvent.change(quickAdd(), { target: { value: 'grab home 9.50' } })
    expect(screen.queryByText('Transportation')).toBeNull()
    act(() => {
      useExpenseStore
        .getState()
        .addExpense({ itemName: 'Grab home', amount: 12, category: 'Transportation' })
    })
    expect(screen.getByText('Transportation')).toBeInTheDocument()
  })

  it("stores an undated entry on today's local day, at local noon with no zone", () => {
    expect(add('kopi 1.80')).toMatchObject({
      amount: 1.8,
      day: '2026-10-18',
      date: '2026-10-18T12:00:00',
    })
    expect(quickAdd()).toHaveValue('')
  })

  it('stores a back-dated entry on the day it names', () => {
    expect(add('kopi 1.80 yesterday')).toMatchObject({
      day: '2026-10-17',
      date: '2026-10-17T12:00:00',
    })
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Added "kopi" · S$1.80 · Oct 17')
  })

  it('keeps 00:30 on 1 Jan on the new day, and 23:59 on 31 Dec on the old one', () => {
    vi.setSystemTime(new Date(2026, 0, 1, 0, 30))
    expect(add('kopi 1.80')).toMatchObject({ day: '2026-01-01' })
    cleanup()
    vi.setSystemTime(new Date(2025, 11, 31, 23, 59))
    expect(add('teh 1.20', 'teh')).toMatchObject({ day: '2025-12-31' })
  })

  // 0.9.4 hydrated at once; 0.10.0 loads its data engine after the shell, so the bar takes text
  // a moment before the data is there. That Enter is kept, not refused.
  it('an add made before the data has loaded lands once it has, once', async () => {
    act(() => {
      useExpenseStore.setState({ hydrated: false })
    })
    render(<SmartInput />)
    fireEvent.change(quickAdd(), { target: { value: 'kopi 1.80' } })
    fireEvent.keyDown(quickAdd(), { key: 'Enter' })
    fireEvent.keyDown(quickAdd(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(useUIStore.getState().toasts).toEqual([])
    act(() => {
      useExpenseStore.setState({ hydrated: true })
    })
    await vi.waitFor(() => {
      expect(useExpenseStore.getState().expenses.map((e) => e.itemName)).toEqual(['kopi'])
    })
    expect(useUIStore.getState().toasts.map((t) => t.message)).toEqual(['Added "kopi" · S$1.80'])
    expect(quickAdd()).toHaveValue('')
  })

  it('an add made while the data engine fails to load says so, and keeps the text', async () => {
    act(() => {
      useExpenseStore.setState({ hydrated: false })
    })
    render(<SmartInput />)
    fireEvent.change(quickAdd(), { target: { value: 'kopi 1.80' } })
    fireEvent.keyDown(quickAdd(), { key: 'Enter' })
    act(() => {
      useExpenseStore.setState({ bootError: 'engine-load' })
    })
    await vi.waitFor(() => {
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        kind: 'error',
        message: NOT_STARTED,
      })
    })
    expect(quickAdd()).toHaveValue('kopi 1.80')
    act(() => {
      useExpenseStore.setState({ bootError: null, hydrated: true })
    })
  })

  // walk5: in memory only, each add still said "Added … · Undo" with a tick, and was gone after
  // the next reload.
  // The tone is that of the add's own save, made before the toast is chosen: the very first add
  // storage refuses is a warning, never a tick (the save would otherwise run a microtask later).
  it('says the first add storage refuses is not saved, never with a tick', () => {
    const real = Storage.prototype.setItem.bind(localStorage)
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      if (key === 'st5:db') throw new DOMException('full', 'QuotaExceededError')
      real(key, value)
    })
    try {
      add('teh 1.20', 'teh')
      expect(useUIStore.getState().toasts.map((t) => t.message)).not.toContain(
        'Added "teh" · S$1.20',
      )
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        kind: 'warning',
        message: 'Added "teh" · S$1.20 · Not saved on this device yet',
        action: { label: 'Undo' },
      })
    } finally {
      refuse.mockRestore()
    }
  })

  it('says an add is kept only until SpendTrack closes while nothing can be saved', async () => {
    // storage refused at boot: the engine runs in memory only
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      await act(async () => {
        await useExpenseStore.getState().hydrate()
      })
      expect(useExpenseStore.getState().local).toBe('memory-only')
      // the boot read no device currency (storage refused): the zone's default; this test is in S$
      useUIStore.setState({ currency: 'SGD' })
      add('kopi 1.80')
      expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
        kind: 'warning',
        message: 'Added "kopi" · S$1.80 · Kept only until you close SpendTrack',
        action: { label: 'Undo' },
      })
    } finally {
      vi.unstubAllGlobals()
      await act(async () => {
        await useExpenseStore.getState().hydrate()
      })
    }
  })

  it('shows why the store refused it, and keeps the text to fix', () => {
    const long = `${'k'.repeat(201)} 2`
    expect(add(long)).toBeUndefined()
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'Item name must be 1 to 200 characters.',
    })
    expect(quickAdd()).toHaveValue(long)
  })

  it('Undo takes it back out, and says what it had to leave', () => {
    const added = add('kopi 1.80')
    if (!added) throw new Error('nothing added')
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.action?.label).toBe('Undo')
    // Changed again after the add, as another device's edit would be: Undo must not take it.
    act(() => {
      useExpenseStore.getState().updateExpense(added.id, { amount: 2 })
    })
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().expenses.map((e) => e.amount)).toEqual([2])
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'warning',
      message: undoOutcomeMessage({ applied: 0, skipped: 1 }),
    })
  })
})
