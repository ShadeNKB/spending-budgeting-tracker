import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from './AppShell'
import { undoOutcomeMessage, useExpenseStore, whenHydrated } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'
import { useUIStore } from '../stores/useUIStore'
import { QUOTA_TOAST } from './DataNotices'

// The shell itself: its mod+z, and what it shows in place of the screen. Its overlays and bars
// subscribe to stores of their own and are drawn elsewhere; empty stand-ins keep them out.
vi.mock('./TopBar', () => ({ TopBar: () => null }))
vi.mock('./TabBar', () => ({ TabBar: () => null }))
vi.mock('../features/settings/SettingsDrawer', () => ({ SettingsDrawer: () => null }))
vi.mock('../features/entry/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../features/entry/AddExpenseSheet', () => ({ AddExpenseSheet: () => null }))
vi.mock('../ui/ToastHost', () => ({ ToastHost: () => null }))
vi.mock('../ui/HotkeyHints', () => ({ HotkeyHints: () => null }))

// The first-run and backup cards are one lazy chunk (PR-4): count its loads, and let a test make
// it crash, to show the shell fetches it only when a card may be wanted and survives its failure.
const cards = vi.hoisted(() => ({ loads: 0, crash: false }))
vi.mock('./DataCards', async (importOriginal) => {
  cards.loads++
  const real = await importOriginal<typeof import('./DataCards')>()
  const { createElement } = await import('react')
  const DataCards = () => {
    if (cards.crash) throw new Error('a bug in the card')
    return createElement(real.DataCards)
  }
  // The shell loads the module's default export.
  return { DataCards, default: DataCards }
})

// The first hydrate loads the engine chunk, the data core with it. Under a full parallel run on a
// busy machine that load alone ran past the 5 s default, and the timed-out boot then landed in
// the next test. Load it once here, with room: every boot after it is quick.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
}, 60_000)

beforeEach(async () => {
  // P2-14: an empty device, booted for real (whatever the last test left pending first).
  await useExpenseStore.getState().hydrate()
  localStorage.clear()
  await useExpenseStore.getState().hydrate()
  useUIStore.setState({ toasts: [], currency: 'SGD' })
  useSyncStore.setState({ syncId: null })
  cards.crash = false
})

afterEach(() => {
  cleanup()
})

const welcome = () => screen.queryByRole('region', { name: 'Welcome to SpendTrack' })
const nudge = () => screen.queryByRole('region', { name: 'Time for a backup' })

/** The shell with one screen in its outlet, as the router renders it. */
async function mountShellWithScreen() {
  const view = render(
    <MemoryRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<h1>The screen</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  await act(async () => {
    await whenHydrated()
  })
  return view
}

// First in the file: the chunk's module stays loaded once any test has fetched it.
describe('AppShell data cards (first run, backup nudge)', () => {
  it('fetches no card chunk while nothing is due, and fetches it once a card is', async () => {
    act(() => {
      useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
      useExpenseStore.getState().markBackedUp()
    })
    await mountShellWithScreen()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(cards.loads).toBe(0)
    expect(nudge()).toBeNull()

    // The last backup is 31 days old: now the chunk loads, and the nudge shows.
    const facts = useExpenseStore.getState().facts
    act(() => {
      useExpenseStore.setState({
        facts: { ...facts, lastBackupAt: Date.now() - 31 * 86_400_000 },
      })
    })
    expect(await screen.findByRole('region', { name: 'Time for a backup' })).toBeVisible()
    expect(cards.loads).toBe(1)
  })

  it('welcomes a pristine origin first in main, above the screen', async () => {
    await mountShellWithScreen()
    const card = await screen.findByRole('region', { name: 'Welcome to SpendTrack' })
    const main = screen.getByRole('main')
    expect(main).toContainElement(card)
    const screenHeading = screen.getByRole('heading', { level: 1, name: 'The screen' })
    expect(
      card.compareDocumentPosition(screenHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('does not block the screen: it renders while the card is on', async () => {
    await mountShellWithScreen()
    await screen.findByRole('region', { name: 'Welcome to SpendTrack' })
    expect(screen.getByRole('heading', { level: 1, name: 'The screen' })).toBeVisible()
  })

  it.each([
    [
      'a sync code',
      () => useSyncStore.setState({ syncId: '11111111-1111-4111-8111-111111111111' }),
    ],
    ['memory-only', () => useExpenseStore.setState({ local: 'memory-only' })],
    ['a failed save', () => useExpenseStore.setState({ local: 'error-quota' })],
  ])('takes the card away with %s', async (_what, change) => {
    await mountShellWithScreen()
    await screen.findByRole('region', { name: 'Welcome to SpendTrack' })
    act(change)
    expect(welcome()).toBeNull()
    act(() => {
      useExpenseStore.setState({ local: 'saved' })
      useSyncStore.setState({ syncId: null })
    })
  })

  it('shows no card in place of a boot failure', async () => {
    await mountShellWithScreen()
    await screen.findByRole('region', { name: 'Welcome to SpendTrack' })
    act(() => {
      useExpenseStore.setState({ bootError: 'engine-load' })
    })
    expect(welcome()).toBeNull()
    expect(
      screen.getByRole('heading', { level: 1, name: "SpendTrack couldn't start." }),
    ).toBeVisible()
    act(() => {
      useExpenseStore.setState({ bootError: null })
    })
  })

  it('a card that fails leaves the app up: no card, the screen still there', async () => {
    cards.crash = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await mountShellWithScreen()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(welcome()).toBeNull()
    expect(screen.getByRole('heading', { level: 1, name: 'The screen' })).toBeVisible()
    errors.mockRestore()
  })

  it('binds none of the shell’s own listeners again when the card chunk lands', async () => {
    // The chunk's modules first, so the page-wide listener the press shield binds as it loads
    // (once per page, whoever imports it first) is not counted as the shell's.
    await import('./DataCards')
    const add = vi.spyOn(window, 'addEventListener')
    const bound = (type: string) => add.mock.calls.filter(([t]) => t === type).length
    await mountShellWithScreen()
    await screen.findByRole('region', { name: 'Welcome to SpendTrack' })
    for (let i = 0; i < 2; i++) {
      act(() => {
        useUIStore.getState().setHotkeysOpen(i === 0)
      })
    }
    expect(bound('keydown')).toBe(1)
    expect(bound('spendtrack:quota-exceeded')).toBe(1)
    add.mockRestore()
  })
})

async function mountShell() {
  const view = render(
    <MemoryRouter>
      <AppShell />
    </MemoryRouter>,
  )
  await act(async () => {
    await whenHydrated()
  })
  return view
}

const pressUndo = () => {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }),
    )
  })
}

const toasts = () => useUIStore.getState().toasts

describe('AppShell mod+z', () => {
  it('undoes the latest change and says so: the key press has nothing else on screen', async () => {
    await mountShell()
    act(() => {
      useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
    })
    useUIStore.setState({ toasts: [] })
    pressUndo()
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toMatchObject({ kind: 'info', message: 'Undone' })
  })

  it('says how many entries it had to leave when they changed since', async () => {
    await mountShell()
    act(() => {
      const added = useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
      // Changed after the add, as another device's edit would be; that change's own undo is gone.
      useExpenseStore.getState().updateExpense(added.id, { amount: 2 })
      for (const u of useExpenseStore.getState().undoStack)
        if (u.id.startsWith('update-')) useExpenseStore.getState().clearUndo(u.id)
    })
    useUIStore.setState({ toasts: [] })
    pressUndo()
    // Undo never overwrites the later change.
    expect(useExpenseStore.getState().expenses.map((e) => e.amount)).toEqual([2])
    expect(toasts()[0]).toMatchObject({
      kind: 'warning',
      message: undoOutcomeMessage({ applied: 0, skipped: 1 }),
    })
    // nothing was undone at all: the toast says so, not "Undone, except…"
    expect(toasts()[0]?.message).toBe('Nothing to undo: 1 entry changed on another device')
  })

  // The 30 s toast of a delete-all or an import kept its Undo after Ctrl+Z had used the entry up.
  it('takes away the toast whose Undo the key press used up', async () => {
    await mountShell()
    act(() => {
      useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
    })
    const undoId = useExpenseStore.getState().undoStack.at(-1)?.id
    act(() => {
      useUIStore.getState().pushToast({
        kind: 'success',
        message: 'Added "kopi"',
        undoId,
        action: { label: 'Undo', onClick: () => undefined },
      })
      useUIStore.getState().pushToast({ kind: 'info', message: 'Unrelated' })
    })
    pressUndo()
    expect(toasts().map((t) => t.message)).toEqual(['Unrelated', 'Undone'])
  })

  it('says nothing when there is nothing to undo', async () => {
    await mountShell()
    pressUndo()
    expect(toasts()).toEqual([])
  })
})

describe('AppShell data states', () => {
  it('shows the boot-failure card in place of the screen when the engine could not load', async () => {
    await mountShell()
    act(() => {
      useExpenseStore.setState({ bootError: 'engine-load' })
    })
    const main = screen.getByRole('main')
    expect(main).toContainElement(
      screen.getByRole('heading', { level: 1, name: "SpendTrack couldn't start." }),
    )
    expect(screen.queryByText('Loading local spending data')).toBeNull()
    act(() => {
      useExpenseStore.setState({ bootError: null })
    })
  })

  const quotaHit = () => {
    window.dispatchEvent(
      new CustomEvent('spendtrack:quota-exceeded', { detail: { key: 'st5:db' } }),
    )
  }

  it('says storage is full when a save hits the quota', async () => {
    await mountShell()
    await act(async () => {
      quotaHit()
      await whenHydrated()
    })
    expect(toasts().map((t) => t.message)).toEqual([QUOTA_TOAST])
  })

  // walk5: the strip said "Nothing will be overwritten" while a red toast said to clear old data.
  it('leaves the quota advice to the memory-only strip, which says what to do instead', async () => {
    await mountShell()
    act(() => {
      useExpenseStore.setState({ local: 'memory-only' })
    })
    await act(async () => {
      quotaHit()
      await whenHydrated()
    })
    expect(toasts()).toEqual([])
    act(() => {
      useExpenseStore.setState({ local: 'saved' })
    })
  })

  it('draws the data notices above the screen, under the top bar', async () => {
    await mountShell()
    act(() => {
      useExpenseStore.setState({ demo: 'sample' })
    })
    const demo = screen.getByRole('region', { name: 'Demo mode' })
    // Before <main> in reading order, so a screen reader meets it first.
    expect(
      demo.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    act(() => {
      useExpenseStore.setState({ demo: 'none' })
    })
  })
})
