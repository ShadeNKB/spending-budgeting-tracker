import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { CommandPalette } from './CommandPalette'
import { useUIStore } from '../../stores/useUIStore'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { CONFIRM_DELAY_MS } from '../../utils/amountGuard'
import { Sheet } from '../../ui/Sheet'
import { installFakeAnimations, type FakeAnimations } from '../../__tests__/fakeAnimations'
import type { Expense } from '../../types'

function Where() {
  const { pathname } = useLocation()
  return <p data-testid="path">{pathname}</p>
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 18, 10, 0))
  useUIStore.setState({
    paletteOpen: false,
    addSheetOpen: false,
    settingsOpen: false,
    toasts: [],
    currency: 'SGD',
  })
  useExpenseStore.setState({ expenses: [] })
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

const expense = (id: string, itemName: string, amount: number): Expense => ({
  id,
  itemName,
  amount,
  category: 'Food & Dining',
  date: '2026-10-17T12:00:00',
  createdAt: '2026-10-17T12:00:00',
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
