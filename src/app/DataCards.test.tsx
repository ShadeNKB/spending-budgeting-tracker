import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { DataCards } from './DataCards'
import { WELCOME_KEY } from './FirstRunCard'
import { useExpenseStore, whenHydrated } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'
import { useUIStore } from '../stores/useUIStore'

// T-050-3 on a real engine booted from real (jsdom) storage: the welcome card shows on a pristine
// origin only. A pristine boot writes nothing until its first commit, so "no envelope and no
// welcome answer" is the test; a migration, a recovery and the demo seed all write the envelope
// while booting. Every other exclusion is a state the store publishes. Invented data.

const build = vi.hoisted(() => ({ demo: false }))
vi.mock('../stores/useExpenseStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../stores/useExpenseStore')>()
  return {
    ...real,
    get IS_DEMO() {
      return build.demo
    },
  }
})

const TITLE = 'Welcome to SpendTrack'
const CODE = '11111111-1111-4111-8111-111111111111'

const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

/** A page load on what is stored now (P2-14: hydrate is re-runnable). */
async function boot(keys: Record<string, string> = {}): Promise<void> {
  await useExpenseStore.getState().hydrate()
  localStorage.clear()
  for (const [key, value] of Object.entries(keys)) localStorage.setItem(key, value)
  await act(async () => {
    await useExpenseStore.getState().hydrate()
  })
}

function mount() {
  return render(
    <>
      <main id="main" tabIndex={-1} />
      <DataCards />
    </>,
  )
}

const welcome = () => screen.queryByRole('region', { name: TITLE })

// The first hydrate loads the engine chunk (the data core with it): give it room once.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
  await whenHydrated()
}, 60_000)

beforeEach(async () => {
  await boot()
  useUIStore.setState({ toasts: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  build.demo = false
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
})

describe('first run: only on a pristine origin', () => {
  it('welcomes a fresh origin: no SpendTrack data stored at all', () => {
    expect(localStorage.getItem('st5:db')).toBeNull()
    mount()
    expect(welcome()).not.toBeNull()
  })

  it('the theme and currency preferences alone are still a fresh origin', async () => {
    await boot({ 'spendtrack:theme': 'light', 'spendtrack:currency': 'SGD' })
    mount()
    expect(welcome()).not.toBeNull()
  })

  it('never shows with an envelope, even an empty one', async () => {
    // Add and delete: the envelope is written, no entries are left.
    act(() => {
      const e = useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
      useExpenseStore.getState().deleteExpense(e.id)
    })
    useExpenseStore.getState().saveNow()
    const envelope = localStorage.getItem('st5:db')
    expect(envelope).not.toBeNull()
    await boot({ 'st5:db': envelope ?? '' })
    expect(useExpenseStore.getState().expenses).toEqual([])
    mount()
    expect(welcome()).toBeNull()
  })

  it.each([
    ['expenses', '[]'],
    ['categories', JSON.stringify(['Food', 'Other'])],
    ['deletedExpenseIds', JSON.stringify(['gone-1'])],
    ['categoryBudgets', JSON.stringify({ Food: 300 })],
  ])('never shows with a v4 key (%s): the migration writes the envelope', async (key, value) => {
    await boot({ [key]: value })
    expect(useExpenseStore.getState().expenses).toEqual([])
    mount()
    expect(welcome()).toBeNull()
  })

  it('never shows with a sync code', () => {
    useSyncStore.setState({ syncId: CODE })
    mount()
    expect(welcome()).toBeNull()
  })

  it('never shows on a demo build', () => {
    build.demo = true
    mount()
    expect(welcome()).toBeNull()
  })

  it.each(['memory-only', 'error-quota', 'error-storage'] as const)(
    'never shows while this device is not saving (%s)',
    (local) => {
      useExpenseStore.setState({ local })
      mount()
      expect(welcome()).toBeNull()
      act(() => {
        useExpenseStore.setState({ local: 'saved' })
      })
    },
  )

  it('never shows after a boot error', () => {
    useExpenseStore.setState({ bootError: 'engine-load' })
    mount()
    expect(welcome()).toBeNull()
    act(() => {
      useExpenseStore.setState({ bootError: null })
    })
  })

  it('never shows once Start fresh was answered on this origin', async () => {
    await boot({ [WELCOME_KEY]: '1' })
    mount()
    expect(welcome()).toBeNull()
  })

  it('never shows when storage refuses to be read (a throw means not a first run)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    mount()
    expect(welcome()).toBeNull()
  })
})

describe('first run: going away', () => {
  it('Start fresh hides it, also after a reload with zero entries', async () => {
    mount()
    const card = welcome()
    if (card === null) throw new Error('no welcome card')
    fireEvent.click(within(card).getByRole('button', { name: 'Start fresh' }), { detail: 1 })
    expect(welcome()).toBeNull()
    cleanup()

    await boot({ [WELCOME_KEY]: '1' })
    expect(useExpenseStore.getState().expenses).toEqual([])
    mount()
    expect(welcome()).toBeNull()
  })

  it('a refused Start fresh hides it for this page; a reload asks again', async () => {
    mount()
    const card = welcome()
    if (card === null) throw new Error('no welcome card')
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Start fresh' }), { detail: 1 })
    expect(welcome()).toBeNull()
    write.mockRestore()
    cleanup()

    await boot()
    mount()
    expect(welcome()).not.toBeNull()
  })

  it('the first entry hides it for good, even once that entry is deleted', () => {
    mount()
    expect(welcome()).not.toBeNull()
    let id = ''
    act(() => {
      id = useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 }).id
    })
    expect(welcome()).toBeNull()
    act(() => {
      useExpenseStore.getState().deleteExpense(id)
      useExpenseStore.getState().saveNow()
    })
    expect(useExpenseStore.getState().expenses).toEqual([])
    expect(welcome()).toBeNull()
  })

  it('any saved change (a category) ends the first run: the envelope now exists', () => {
    mount()
    act(() => {
      useExpenseStore.getState().addCategory('Pets')
      useExpenseStore.getState().saveNow()
    })
    expect(localStorage.getItem('st5:db')).not.toBeNull()
    expect(welcome()).toBeNull()
  })

  it('a sync code from Restore from sync hides it', () => {
    mount()
    act(() => {
      useSyncStore.setState({ syncId: CODE })
    })
    expect(welcome()).toBeNull()
  })
})

// F-004 on the first-run path: the card's Import is the Backup tab's restore, same semantics.
describe('first run: Import a backup file restores with the existing restore', () => {
  it('previews the file, Restore brings the entries back, and the card goes', async () => {
    // A backup made on another (invented) device.
    act(() => {
      useExpenseStore
        .getState()
        .addExpense({ itemName: 'chicken rice', amount: 5.5, day: '2026-10-12' })
      useExpenseStore.getState().addExpense({ itemName: 'grab home', amount: 15 })
    })
    const file = new File(
      [JSON.stringify(useExpenseStore.getState().exportBackup())],
      'spendtrack-backup-2026-10-19.json',
      { type: 'application/json' },
    )
    const before = useExpenseStore
      .getState()
      .expenses.map((e) => [e.itemName, e.amount, e.category, e.day])
    await boot()

    mount()
    const card = welcome()
    if (card === null) throw new Error('no welcome card')
    const input = card.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('no file input')
    fireEvent.change(input, { target: { files: [file] } })
    const question = await within(card).findByRole('region', {
      name: 'Import spendtrack-backup-2026-10-19.json?',
    })
    expect(within(question).getByText('new').closest('li')).toHaveTextContent('2 new')

    fireEvent.click(within(question).getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(
      useExpenseStore.getState().expenses.map((e) => [e.itemName, e.amount, e.category, e.day]),
    ).toEqual(before)
    expect(useUIStore.getState().toasts[0]?.message).toBe('Imported · 2 added')
    expect(welcome()).toBeNull()
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('a file that is not a backup says why, and the card stays', async () => {
    mount()
    const card = welcome()
    if (card === null) throw new Error('no welcome card')
    const input = card.querySelector<HTMLInputElement>('input[type="file"]')
    if (input === null) throw new Error('no file input')
    fireEvent.change(input, {
      target: { files: [new File(['not json at all'], 'notes.txt', { type: 'text/plain' })] },
    })
    await vi.waitFor(() => {
      expect(useUIStore.getState().toasts.map((t) => t.kind)).toEqual(['error'])
    })
    expect(useUIStore.getState().toasts[0]?.message).not.toBe('')
    expect(welcome()).not.toBeNull()
    expect(useExpenseStore.getState().expenses).toEqual([])
  })
})

describe('one slot, never both cards', () => {
  it('shows the nudge, not the welcome, when there are own entries due a backup', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 1, 12, 0))
      act(() => {
        useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8, day: '2026-09-15' })
      })
      mount()
      expect(welcome()).toBeNull()
      expect(screen.getByRole('region', { name: 'Time for a backup' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})
