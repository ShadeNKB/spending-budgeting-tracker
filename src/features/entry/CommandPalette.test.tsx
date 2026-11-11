import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { CommandPalette } from './CommandPalette'
import { useUIStore } from '../../stores/useUIStore'
import { undoOutcomeMessage, useExpenseStore } from '../../stores/useExpenseStore'
import { CONFIRM_DELAY_MS } from '../../utils/amountGuard'
import { Sheet } from '../../ui/Sheet'
import { installFakeAnimations, type FakeAnimations } from '../../__tests__/fakeAnimations'
import type { ExpenseView } from '../../types'

// The first hydrate loads the engine chunk, the data core with it. Under a full parallel run on a
// busy machine that load alone ran past the 5 s default, and the timed-out boot then landed in
// the next test. Load it once here, with room: every boot after it is quick.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

function Where() {
  const { pathname, search } = useLocation()
  return (
    <>
      <p data-testid="path">{pathname}</p>
      <p data-testid="search">{search}</p>
    </>
  )
}

function App() {
  return (
    <MemoryRouter initialEntries={['/pulse']}>
      <button type="button" onClick={() => useUIStore.getState().setPaletteOpen(true)}>
        Search
      </button>
      <CommandPalette />
      <Where />
    </MemoryRouter>
  )
}

/** Focus is handed back in a task after the one that closed the palette. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

function openPalette() {
  const trigger = screen.getByRole('button', { name: 'Search' })
  act(() => {
    trigger.focus()
  })
  fireEvent.click(trigger)
  return trigger
}

const input = () =>
  screen.getByRole('combobox', { name: 'Search actions and expenses, or quick add' })

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } })
}

function activeOption(): HTMLElement | null {
  const id = input().getAttribute('aria-activedescendant')
  return id ? document.getElementById(id) : null
}

/** P2-14: an empty device, booted for real (whatever the last test left pending settles first). */
async function bootEmpty() {
  await useExpenseStore.getState().hydrate()
  localStorage.clear()
  await useExpenseStore.getState().hydrate()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 18, 10, 0))
  await bootEmpty()
  useUIStore.setState({
    paletteOpen: false,
    addSheetOpen: false,
    settingsOpen: false,
    toasts: [],
    currency: 'SGD',
  })
})
// jsdom has no Web Animations API, so the palette leaves at once here. Tests of its exit
// install fake animations: the exit then lasts until they finish.
let fake: FakeAnimations | null = null
function holdExits(): FakeAnimations {
  fake = installFakeAnimations()
  return fake
}
const finishExits = (animations: FakeAnimations) =>
  act(async () => {
    animations.finishAll()
    await Promise.resolve()
    await Promise.resolve()
  })

afterEach(() => {
  fake?.restore()
  fake = null
  vi.useRealTimers()
})

describe('CommandPalette combobox', () => {
  it('opens with focus in a named combobox that controls a listbox of grouped options', () => {
    render(<App />)
    openPalette()
    const box = input()
    expect(box).toHaveFocus()
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveAttribute('aria-autocomplete', 'list')
    const listbox = document.getElementById(box.getAttribute('aria-controls') ?? '')
    expect(listbox).toHaveAttribute('role', 'listbox')
    expect(screen.getByRole('group', { name: 'Actions' })).toBeInTheDocument()
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options[0]).toHaveTextContent('Add expense')
    for (const option of options) expect(option).toHaveAttribute('tabindex', '-1')
  })

  it('arrow keys move the announced option, and Enter runs exactly that one', async () => {
    render(<App />)
    const trigger = openPalette()
    expect(activeOption()).toHaveTextContent('Add expense')
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    const active = activeOption()
    expect(active).toHaveTextContent('Go to Ledger')
    expect(active).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('option').filter((o) => o.hasAttribute('aria-selected'))).toEqual([
      active,
    ])

    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByTestId('path')).toHaveTextContent('/ledger')
    expect(useUIStore.getState().paletteOpen).toBe(false)
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('clamps at both ends of the list', () => {
    render(<App />)
    openPalette()
    fireEvent.keyDown(input(), { key: 'ArrowUp' })
    expect(activeOption()).toHaveTextContent('Add expense')
    for (let i = 0; i < 20; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(activeOption()).toHaveTextContent('Export backup (JSON)')
  })

  it('keeps the active option valid as the results shrink', () => {
    render(<App />)
    openPalette()
    for (let i = 0; i < 5; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    type('ledger')
    expect(activeOption()).toHaveTextContent('Go to Ledger')
    type('zzzz')
    expect(input()).not.toHaveAttribute('aria-activedescendant')
    expect(input()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('status')).toHaveTextContent('No matches')
  })

  it('runs nothing on Enter pressed anywhere but the input', () => {
    render(<App />)
    openPalette()
    type('led')
    const clear = screen.getByRole('button', { name: 'Clear command search' })
    act(() => {
      clear.focus()
    })
    fireEvent.keyDown(clear, { key: 'Enter' })
    expect(screen.getByTestId('path')).toHaveTextContent('/pulse')
    expect(useUIStore.getState().paletteOpen).toBe(true)
  })

  it('keeps focus in the input when an option is pressed, and runs it on click', () => {
    render(<App />)
    openPalette()
    const option = screen.getByRole('option', { name: /Go to Insights/ })
    fireEvent.mouseMove(option)
    expect(activeOption()).toBe(option)
    // fireEvent returns false when the default (moving focus) was prevented.
    expect(fireEvent.mouseDown(option)).toBe(false)
    expect(input()).toHaveFocus()
    fireEvent.click(option)
    expect(screen.getByTestId('path')).toHaveTextContent('/insights')
  })

  it('Escape closes it and returns focus to the trigger', async () => {
    render(<App />)
    const trigger = openPalette()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(useUIStore.getState().paletteOpen).toBe(false)
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('opens empty each time', () => {
    render(<App />)
    openPalette()
    type('ledger')
    fireEvent.keyDown(input(), { key: 'Escape' })
    openPalette()
    expect(input()).toHaveValue('')
    expect(activeOption()).toHaveTextContent('Add expense')
  })
})

/** Every text the palette's live region was given, in order (including while it was batched). */
function recordStatus(region: HTMLElement) {
  const said: string[] = []
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const node of r.addedNodes) said.push(node.textContent ?? '')
  })
  observer.observe(region, { childList: true, subtree: true, characterData: true })
  return () => {
    for (const r of observer.takeRecords())
      for (const node of r.addedNodes) said.push(node.textContent ?? '')
    observer.disconnect()
    return said
  }
}

/** A view as the store hands it out (render-only tests may set them, P2-14). */
const expense = (id: string, itemName: string, amount: number): ExpenseView => ({
  id,
  itemName,
  amount,
  category: 'Food & Dining',
  date: '2026-10-17T12:00:00',
  day: '2026-10-17',
  createdAt: '2026-10-17T12:00:00',
  ext: {},
})

describe('CommandPalette actions found by typing (F-055)', () => {
  const options = () => screen.getAllByRole('option').map((o) => o.textContent)

  it('opens on the six everyday actions, not on every one it knows', () => {
    render(<App />)
    openPalette()
    expect(screen.getAllByRole('option')).toHaveLength(6)
    expect(screen.queryByRole('option', { name: /Budgets/ })).toBeNull()
  })

  it('finds a place in Settings by its name or by another word for it, and opens it there', () => {
    render(<App />)
    openPalette()
    type('budg')
    expect(options()).toEqual([expect.stringContaining('Budgets')])
    type('limit')
    fireEvent.click(screen.getByRole('option', { name: /Budgets/ }))
    expect(useUIStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'budgets' })
    expect(useUIStore.getState().paletteOpen).toBe(false)
  })

  it('finds a Ledger view, and opens the Ledger on it', () => {
    render(<App />)
    openPalette()
    type('uncat')
    fireEvent.click(screen.getByRole('option', { name: /Entries without a category/ }))
    expect(screen.getByTestId('path')).toHaveTextContent('/ledger')
    expect(screen.getByTestId('search')).toHaveTextContent('?range=all&category=Other')
  })

  it('finds every Ledger range under "ledger", after Go to Ledger', () => {
    render(<App />)
    openPalette()
    type('ledger')
    expect(options()).toEqual([
      expect.stringContaining('Go to Ledger'),
      expect.stringContaining('Ledger: today'),
      expect.stringContaining('Ledger: last 7 days'),
      expect.stringContaining('Ledger: this year'),
      expect.stringContaining('Ledger: all time'),
      expect.stringContaining('Entries without a category'),
    ])
  })

  it('switches the theme, named for where it goes', () => {
    useUIStore.setState({ theme: 'dark' })
    render(<App />)
    openPalette()
    type('theme')
    fireEvent.click(screen.getByRole('option', { name: /Switch to light theme/ }))
    expect(useUIStore.getState().theme).toBe('light')
    openPalette()
    type('dark')
    expect(screen.getByRole('option', { name: /Switch to dark theme/ })).toBeInTheDocument()
  })

  it('opens the keyboard shortcuts', () => {
    render(<App />)
    openPalette()
    type('keys')
    fireEvent.click(screen.getByRole('option', { name: /Keyboard shortcuts/ }))
    expect(useUIStore.getState().hotkeysOpen).toBe(true)
  })

  it('a quick add keeps the list to the add and the everyday six', () => {
    render(<App />)
    openPalette()
    type('theme park 45')
    expect(screen.getAllByRole('option')).toHaveLength(7)
    expect(screen.queryByRole('option', { name: /Switch to/ })).toBeNull()
  })
})

describe('CommandPalette status', () => {
  // The expense search runs a render behind the typing. "No matches" was said at "ko", before
  // the hits arrived, and stayed in the region beside the two kopi options.
  it('never says "No matches" while results are on their way, typed one key at a time', () => {
    useExpenseStore.setState({
      expenses: [expense('a', 'kopi siew dai', 1.2), expense('b', 'kopi o', 1.8)],
    })
    render(<App />)
    openPalette()
    const region = screen.getByRole('status')
    const said = recordStatus(region)
    for (const text of ['k', 'ko', 'kop', 'kopi']) type(text)
    expect(said()).not.toContain('No matches')
    expect(screen.getAllByRole('option', { name: /kopi/ }).length).toBeGreaterThan(0)
    expect(region).toBeEmptyDOMElement()
    expect(screen.queryByText(/^No matches - try/)).toBeNull()
  })

  it('says "No matches" when there are none, and takes it back once there are', () => {
    useExpenseStore.setState({ expenses: [expense('a', 'kopi o', 1.8)] })
    render(<App />)
    openPalette()
    const region = screen.getByRole('status')
    type('zzzz')
    expect(region).toHaveTextContent('No matches')
    expect(screen.getByText(/^No matches - try/)).not.toHaveClass('invisible')
    type('kopi')
    expect(screen.getByRole('option', { name: /kopi o/ })).toBeInTheDocument()
    expect(region).toBeEmptyDOMElement()
  })

  it('takes the large-amount question back once the query changes', () => {
    render(<App />)
    openPalette()
    const region = screen.getByRole('status')
    type('laptop 20000')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(region).toHaveTextContent('Choose it again to add it.')
    type('laptop 2000')
    expect(region).not.toHaveTextContent('Choose it again')
  })
})

// The list can shrink with no key pressed: a sync pull removes the rows behind the hits, the
// deferred search catches up. The input must go on pointing at an option that is on screen,
// the one Enter would run.
describe('CommandPalette results that shrink by themselves', () => {
  it('moves the active option to the last one left, never to one that is gone', () => {
    useExpenseStore.setState({
      expenses: [
        expense('a', 'kopi siew dai', 1.2),
        expense('b', 'kopi o', 1.8),
        expense('c', 'kopi c kosong', 1.6),
      ],
    })
    render(<App />)
    openPalette()
    type('kopi')
    const hits = screen.getAllByRole('option', { name: /kopi/ })
    expect(hits).toHaveLength(3)
    for (let i = 0; i < 10; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(activeOption()).toBe(screen.getAllByRole('option').at(-1))

    act(() => {
      useExpenseStore.setState({ expenses: [expense('a', 'kopi siew dai', 1.2)] })
    })
    const left = screen.getAllByRole('option')
    expect(left).toHaveLength(1)
    expect(activeOption()).toBe(left[0])
    expect(left[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByTestId('path')).toHaveTextContent('/ledger')
  })
})

describe('CommandPalette motion', () => {
  // The motion itself is CSS (index.css, src/__tests__/motion-css.test.ts) keyed on the layer
  // box's data-state; e2e/motion.spec.ts watches it in a browser.
  it('drops in over a fading backdrop, and stays, inert, while it leaves', async () => {
    const animations = holdExits()
    render(<App />)
    openPalette()
    const dialog = screen.getByRole('dialog', { name: 'Command palette' })
    const box = dialog.parentElement
    expect(dialog).toHaveClass('palette-panel')
    expect(box).toHaveAttribute('data-state', 'open')
    expect(box?.querySelector(':scope > .palette-backdrop')).not.toBeNull()

    fireEvent.keyDown(input(), { key: 'Escape' })
    await settle()
    expect(dialog).toBeInTheDocument()
    expect(box).toHaveAttribute('data-state', 'closed')
    expect(dialog).toHaveAttribute('inert')
    // The page stays locked while it leaves: WebKit ends a running transition at once when the
    // body's overflow changes.
    expect(document.body.style.overflow).toBe('hidden')
    await finishExits(animations)
    expect(dialog).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')
  })

  it('never moves under Reduce Motion turned on while it shows', () => {
    render(<App />)
    openPalette()
    // In the page's CSS: no transform at all while the system asks for reduced motion.
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveClass(
      'motion-reduce:!transform-none',
    )
  })
})

describe('CommandPalette over a sheet', () => {
  const zIndexOf = (el: Element) => [...el.classList].filter((c) => /^z-/.test(c))

  it('is drawn over a sheet opened before it: last in the page, at the sheets’ level', () => {
    render(
      <MemoryRouter>
        <Sheet open onClose={() => {}} title="Add expense" side="bottom">
          <input aria-label="What" />
        </Sheet>
        <CommandPalette />
      </MemoryRouter>,
    )
    act(() => {
      useUIStore.getState().setPaletteOpen(true)
    })
    // Each layer is drawn in one box (backdrop and panel) at the level all layers share.
    const sheet = screen.getByRole('dialog', { name: 'Add expense' }).parentElement
    const palette = screen.getByRole('dialog', { name: 'Command palette' }).parentElement
    if (!sheet || !palette) throw new Error('no layer box')
    expect(palette.parentElement).toBe(document.body)
    expect(sheet.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(zIndexOf(palette)).toEqual(zIndexOf(sheet))
    expect(zIndexOf(palette)).not.toEqual([])
    expect(input()).toHaveFocus()
  })
})

describe('CommandPalette quick add', () => {
  it('adds the typed expense on Enter, once', async () => {
    // The second Enter reaches the palette while it is still leaving.
    const animations = holdExits()
    render(<App />)
    openPalette()
    type('kopi 2.40')
    expect(activeOption()).toHaveTextContent('Add "kopi" · S$2.40')
    fireEvent.keyDown(input(), { key: 'Enter' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    const added = useExpenseStore.getState().expenses
    expect(added).toHaveLength(1)
    expect(added[0]?.itemName).toBe('kopi')
    expect(useUIStore.getState().paletteOpen).toBe(false)
    await finishExits(animations)
  })

  it('keeps showing the entry and its option while it leaves after a quick add', async () => {
    const animations = holdExits()
    render(<App />)
    openPalette()
    type('kopi 2.40')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses).toHaveLength(1)
    // Closed, the query cleared and the row added: the leaving palette still shows them as
    // they were, not an empty search over the action list.
    expect(input()).toHaveValue('kopi 2.40')
    expect(screen.getByRole('option', { name: /Add "kopi" · S\$2\.40/ })).toBeInTheDocument()
    await finishExits(animations)
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull()

    openPalette()
    expect(input()).toHaveValue('')
  })

  it('asks again for a large amount, and ignores the tail of a double Enter', () => {
    render(<App />)
    openPalette()
    type('laptop 20000')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses).toHaveLength(0)
    expect(activeOption()).toHaveTextContent('Confirm large amount: add "laptop"')
    expect(screen.getByRole('status')).toHaveTextContent('Choose it again to add it.')

    vi.setSystemTime(Date.now() + CONFIRM_DELAY_MS / 2)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses).toHaveLength(0)

    vi.setSystemTime(Date.now() + CONFIRM_DELAY_MS)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses).toHaveLength(1)
  })

  it('says why a too-large amount cannot be added', () => {
    render(<App />)
    openPalette()
    type('house 99999999')
    expect(screen.getByRole('status')).toHaveTextContent(/Amount too large/)
  })
})

// P2-2: the quick add writes a day (today when the text has none), and the hits read each
// entry's day. Run in Asia/Singapore, Pacific/Honolulu and Pacific/Kiritimati (PowerShell $env:TZ).
describe('CommandPalette days', () => {
  /** Quick adds `text` and returns the entry stored for `item`. */
  const quickAdd = (text: string, item = 'kopi') => {
    render(<App />)
    openPalette()
    type(text)
    fireEvent.keyDown(input(), { key: 'Enter' })
    return useExpenseStore.getState().expenses.find((e) => e.itemName === item)
  }

  it("stores an undated quick add on today's local day, at local noon with no zone", () => {
    expect(quickAdd('kopi 2.40')).toMatchObject({ day: '2026-10-18', date: '2026-10-18T12:00:00' })
  })

  it('stores a dated quick add on the day it names', () => {
    expect(quickAdd('kopi 2.40 yesterday')).toMatchObject({
      day: '2026-10-17',
      date: '2026-10-17T12:00:00',
    })
  })

  it('keeps 00:30 on 1 Jan on the new day, and 23:59 on 31 Dec on the old one', () => {
    vi.setSystemTime(new Date(2026, 0, 1, 0, 30))
    expect(quickAdd('kopi 2.40')).toMatchObject({ day: '2026-01-01' })
    cleanup()
    vi.setSystemTime(new Date(2025, 11, 31, 23, 59))
    expect(quickAdd('teh 1.80', 'teh')).toMatchObject({ day: '2025-12-31' })
  })

  it('shows each hit on its day and opens the Ledger on that day', () => {
    // A view whose stored date reads as another day here: the day it carries wins.
    useExpenseStore.setState({
      expenses: [
        { ...expense('a', 'kopi o', 1.8), day: '2026-10-15', date: '2026-10-16T01:00:00' },
      ],
    })
    render(<App />)
    openPalette()
    type('kopi o')
    const hit = screen.getByRole('option', { name: /kopi o/ })
    expect(hit).toHaveTextContent('Food & Dining / Oct 15')
    fireEvent.mouseMove(hit)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(screen.getByTestId('path')).toHaveTextContent('/ledger')
    expect(screen.getByTestId('search')).toHaveTextContent('?date=2026-10-15&q=kopi%20o')
  })
})

// P2-13 and P2-12: what the store refuses is said, and Undo reports a part it could not undo.
describe('CommandPalette quick add outcomes', () => {
  it('shows the reason for a refused add and keeps the query open to fix', () => {
    render(<App />)
    openPalette()
    type(`${'k'.repeat(201)} 2`)
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(useExpenseStore.getState().expenses).toHaveLength(0)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'error',
      message: 'Item name must be 1 to 200 characters.',
    })
    expect(useUIStore.getState().paletteOpen).toBe(true)
    expect(input()).toHaveValue(`${'k'.repeat(201)} 2`)
  })

  it('offers Undo, which takes the entry back out', () => {
    render(<App />)
    openPalette()
    type('kopi 2.40')
    fireEvent.keyDown(input(), { key: 'Enter' })
    const toast = useUIStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Added "kopi" · S$2.40')
    expect(toast?.action?.label).toBe('Undo')
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(useUIStore.getState().toasts.filter((t) => t.kind === 'warning')).toEqual([])
  })

  it('says how many entries changed since when Undo has to leave them', () => {
    render(<App />)
    openPalette()
    type('kopi 2.40')
    fireEvent.keyDown(input(), { key: 'Enter' })
    const added = useExpenseStore.getState().expenses[0]
    if (!added) throw new Error('nothing added')
    const toast = useUIStore.getState().toasts.at(-1)
    // Changed again after the add, as another device's edit would be: Undo must not take it.
    act(() => {
      useExpenseStore.getState().updateExpense(added.id, { amount: 3 })
    })
    act(() => {
      toast?.action?.onClick()
    })
    expect(useExpenseStore.getState().expenses.map((e) => e.amount)).toEqual([3])
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({
      kind: 'warning',
      message: undoOutcomeMessage({ applied: 0, skipped: 1 }),
    })
  })
})
