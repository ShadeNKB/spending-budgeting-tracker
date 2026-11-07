import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FirstRunCard, WELCOME_KEY } from './FirstRunCard'
import {
  useExpenseStore,
  type ExpenseView,
  type ImportOutcome,
  type ImportPreview as Preview,
} from '../stores/useExpenseStore'
import { useUIStore } from '../stores/useUIStore'

// T-050-3, the card itself: what it offers, where each button goes. Whether it shows at all is
// DataCards' question (DataCards.test.tsx, on a real boot). Invented data; the store's actions
// are stand-ins here.

const build = vi.hoisted(() => ({ syncEnabled: true }))
vi.mock('../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/syncConfig')>()),
  get syncEnabled() {
    return build.syncEnabled
  },
}))

const TITLE = 'Welcome to SpendTrack'
const BODY =
  'Your spending is saved on this device. New here? Start fresh. Moving phones, or did the browser clear its data? Bring your entries back.'
const SYNC_HINT = 'Join with the code from Settings › Sync on your other device.'
const TIP =
  'Tip: add SpendTrack to your Home Screen (Safari: Share › Add to Home Screen) so the browser keeps your data.'

const preview = (fileName: string): Preview => ({
  fileName,
  counts: {
    inFile: 3,
    added: 3,
    restored: 0,
    updated: 0,
    alreadyHere: 0,
    unreadable: 0,
    deletedInFile: 0,
  },
  replaceDeletes: 0,
})

const IMPORTED: ExpenseView = {
  id: 'e1',
  itemName: 'kopi',
  amount: 1.8,
  category: 'Food & Dining',
  date: '2026-10-19T12:00:00',
  day: '2026-10-19',
  createdAt: '2026-10-19T04:00:00.000Z',
  ext: {},
}

const initialExpense = useExpenseStore.getState()
const initialUI = useUIStore.getState()

let onStartFresh: ReturnType<typeof vi.fn<() => void>>
let previewImport: ReturnType<typeof vi.fn<(file: Blob) => Promise<Preview>>>
let applyImport: ReturnType<
  typeof vi.fn<(p: Preview, mode: 'restore' | 'replace') => ImportOutcome>
>

function mount() {
  onStartFresh = vi.fn()
  return render(
    <>
      <main id="main" tabIndex={-1} />
      <FirstRunCard onStartFresh={onStartFresh} />
    </>,
  )
}

const card = () => screen.getByRole('region', { name: TITLE })
const button = (name: string) => within(card()).getByRole('button', { name })

function chooseFile(name: string, text = '{}') {
  const input = card().querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  fireEvent.change(input, {
    target: { files: [new File([text], name, { type: 'application/json' })] },
  })
}

function stubStandalone(standalone: { media?: boolean; ios?: boolean }) {
  vi.stubGlobal(
    'matchMedia',
    (query: string): Pick<MediaQueryList, 'matches' | 'media'> => ({
      media: query,
      matches: query === '(display-mode: standalone)' && standalone.media === true,
    }),
  )
  if (standalone.ios !== undefined) {
    Object.defineProperty(navigator, 'standalone', {
      configurable: true,
      value: standalone.ios,
    })
  }
}

beforeEach(() => {
  localStorage.clear()
  useUIStore.setState({ toasts: [], settingsOpen: false, settingsTab: 'categories' })
  previewImport = vi.fn((file: Blob) =>
    Promise.resolve(preview(file instanceof File ? file.name : 'file')),
  )
  applyImport = vi.fn(() => {
    useExpenseStore.setState({ undoStack: [] })
    return { applied: 3, skipped: 0, added: 3, restored: 0, updated: 0, removed: 0 }
  })
  useExpenseStore.setState({ previewImport, applyImport, undoStack: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'standalone')
  localStorage.clear()
  build.syncEnabled = true
  useExpenseStore.setState(initialExpense, true)
  useUIStore.setState(initialUI, true)
})

describe('the welcome card', () => {
  it('is a labelled region with its heading, body and three ways in (relay build)', () => {
    mount()
    expect(within(card()).getByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument()
    expect(within(card()).getByText(BODY)).toBeInTheDocument()
    const names = within(card())
      .getAllByRole('button')
      .map((b) => b.textContent.trim())
    expect(names).toEqual(['Start fresh', 'Restore from sync', 'Import a backup file'])
    // Not a live region: nothing is announced while the app boots.
    expect(card()).not.toHaveAttribute('aria-live')
  })

  it('offers Restore from sync only on a build with a relay', () => {
    build.syncEnabled = false
    mount()
    expect(within(card()).queryByRole('button', { name: 'Restore from sync' })).toBeNull()
    expect(within(card()).queryByText(SYNC_HINT)).toBeNull()
    expect(button('Start fresh')).toBeInTheDocument()
    expect(button('Import a backup file')).toBeInTheDocument()
  })

  it('Restore from sync opens Settings on Sync, and says what it needs', () => {
    mount()
    const restore = button('Restore from sync')
    expect(restore).toHaveAccessibleDescription(SYNC_HINT)
    fireEvent.click(restore, { detail: 1 })
    const ui = useUIStore.getState()
    expect(ui.settingsOpen).toBe(true)
    expect(ui.settingsTab).toBe('sync')
    // Nothing is written: joining is Settings' step.
    expect(localStorage.getItem(WELCOME_KEY)).toBeNull()
    expect(onStartFresh).not.toHaveBeenCalled()
  })
})

describe('Start fresh', () => {
  it('remembers the answer, hands back, and puts focus on the screen', () => {
    mount()
    fireEvent.click(button('Start fresh'), { detail: 1 })
    expect(localStorage.getItem(WELCOME_KEY)).toBe('1')
    expect(onStartFresh).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('still hands back when storage refuses the write (hidden for this session only)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    mount()
    fireEvent.click(button('Start fresh'), { detail: 1 })
    expect(onStartFresh).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(WELCOME_KEY)).toBeNull()
  })

  it('ignores the second click of a double click', () => {
    mount()
    const start = button('Start fresh')
    fireEvent.click(start, { detail: 2 })
    expect(onStartFresh).not.toHaveBeenCalled()
  })
})

describe('Import a backup file', () => {
  it('opens its own file picker from the tap', () => {
    const picked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    mount()
    fireEvent.click(button('Import a backup file'), { detail: 1 })
    expect(picked).toHaveBeenCalledTimes(1)
    const input = picked.mock.contexts[0]
    expect(input).toBeInstanceOf(HTMLInputElement)
    expect(card()).toContainElement(input instanceof HTMLElement ? input : null)
  })

  it('previews the file in the card; Cancel goes back with focus on Import', async () => {
    mount()
    chooseFile('old-phone.json')
    const question = await within(card()).findByRole('region', {
      name: 'Import old-phone.json?',
    })
    expect(previewImport).toHaveBeenCalledTimes(1)
    expect(within(question).getByText('in the file')).toBeInTheDocument()
    // The safe choice is under the next key.
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Restore' }))
    // The three ways in step aside while the question is open.
    expect(within(card()).queryByRole('button', { name: 'Start fresh' })).toBeNull()

    fireEvent.click(within(question).getByRole('button', { name: 'Cancel' }), { detail: 1 })
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Import a backup file'))
    })
    expect(applyImport).not.toHaveBeenCalled()
  })

  it('Restore imports through the store and moves focus to the screen', async () => {
    mount()
    chooseFile('old-phone.json')
    const question = await within(card()).findByRole('region', {
      name: 'Import old-phone.json?',
    })
    // The import adds entries: the store now has data, so the card is about to go.
    applyImport.mockImplementation(() => {
      useExpenseStore.setState({ expenses: [IMPORTED], undoStack: [] })
      return { applied: 3, skipped: 0, added: 3, restored: 0, updated: 0, removed: 0 }
    })
    fireEvent.click(within(question).getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(applyImport).toHaveBeenCalledWith(preview('old-phone.json'), 'restore')
    expect(useUIStore.getState().toasts.map((t) => t.message)).toEqual(['Imported · 3 added'])
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('a file with nothing new keeps the card, with focus back on Import', async () => {
    mount()
    chooseFile('empty.json')
    const question = await within(card()).findByRole('region', { name: 'Import empty.json?' })
    applyImport.mockImplementation(() => ({
      applied: 0,
      skipped: 0,
      added: 0,
      restored: 0,
      updated: 0,
      removed: 0,
    }))
    fireEvent.click(within(question).getByRole('button', { name: 'Restore' }), { detail: 1 })
    await waitFor(() => {
      expect(document.activeElement).toBe(button('Import a backup file'))
    })
    expect(useUIStore.getState().toasts.map((t) => t.message)).toEqual([
      'Nothing to import: everything in the file is already here',
    ])
  })

  it("says why a file can't be read, in the store's words, and keeps the card", async () => {
    previewImport.mockRejectedValue(new Error('This file is from a newer SpendTrack.'))
    mount()
    chooseFile('newer.json')
    await waitFor(() => {
      expect(useUIStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
        ['error', 'This file is from a newer SpendTrack.'],
      ])
    })
    expect(button('Import a backup file')).toBeInTheDocument()
  })

  it('a slower read of an earlier file never replaces the latest one', async () => {
    let first: (p: Preview) => void = () => undefined
    previewImport
      .mockImplementationOnce(
        () =>
          new Promise<Preview>((resolve) => {
            first = resolve
          }),
      )
      .mockImplementationOnce((file: Blob) =>
        Promise.resolve(preview(file instanceof File ? file.name : 'file')),
      )
    mount()
    chooseFile('first.json')
    chooseFile('second.json')
    await within(card()).findByRole('region', { name: 'Import second.json?' })
    first(preview('first.json'))
    await Promise.resolve()
    expect(within(card()).queryByRole('region', { name: 'Import first.json?' })).toBeNull()
    expect(within(card()).getByRole('region', { name: 'Import second.json?' })).toBeVisible()
  })
})

describe('the Home Screen tip', () => {
  it('shows in a browser tab', () => {
    stubStandalone({ media: false })
    mount()
    expect(within(card()).getByText(TIP)).toBeInTheDocument()
  })

  it('is gone in the installed app (display-mode: standalone)', () => {
    stubStandalone({ media: true })
    mount()
    expect(within(card()).queryByText(TIP)).toBeNull()
  })

  it('is gone in an iPhone Home Screen app (navigator.standalone)', () => {
    stubStandalone({ media: false, ios: true })
    mount()
    expect(within(card()).queryByText(TIP)).toBeNull()
  })
})
