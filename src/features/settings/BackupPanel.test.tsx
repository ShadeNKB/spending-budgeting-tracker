import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BackupPanel } from './BackupPanel'
import {
  useExpenseStore,
  type ExpenseView,
  type ImportOutcome,
  type ImportPreview as Preview,
  type StorageFacts,
} from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'

// Invented data. Render tests: the views and the actions are set on the store directly (P2-14).
const view = (id: string): ExpenseView => ({
  id,
  itemName: `Item ${id}`,
  amount: 4.5,
  category: 'Food',
  date: '2026-10-19T12:00:00',
  day: '2026-10-19',
  createdAt: '2026-10-19T04:00:00.000Z',
  ext: {},
})
const CODE = '11111111-1111-4111-8111-111111111111'
const NO_FACTS: StorageFacts = {
  persisted: null,
  lastBackupAt: null,
  mirror: 'on',
  nearlyFull: false,
}
const preview = (fileName: string): Preview => ({
  fileName,
  counts: {
    inFile: 2,
    added: 2,
    restored: 0,
    updated: 0,
    alreadyHere: 0,
    unreadable: 0,
    deletedInFile: 0,
  },
  replaceDeletes: 0,
})

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

let refreshStorageFacts: ReturnType<typeof vi.fn<() => void>>
let previewImport: ReturnType<typeof vi.fn<(file: Blob) => Promise<Preview>>>
let applyImport: ReturnType<
  typeof vi.fn<(p: Preview, mode: 'restore' | 'replace') => ImportOutcome>
>
let clearSampleData: ReturnType<typeof vi.fn<() => void>>
let downloads: string[]

function seed(
  opts: { count?: number; sync?: boolean; facts?: Partial<StorageFacts>; demo?: boolean } = {},
) {
  refreshStorageFacts = vi.fn()
  previewImport = vi.fn((file: Blob) =>
    Promise.resolve(preview(file instanceof File ? file.name : 'file')),
  )
  applyImport = vi.fn(() => ({
    applied: 2,
    skipped: 0,
    added: 2,
    restored: 0,
    updated: 0,
    removed: 0,
  }))
  clearSampleData = vi.fn(() => {
    useExpenseStore.setState({ demo: 'none' })
  })
  useExpenseStore.setState({
    expenses: Array.from({ length: opts.count ?? 3 }, (_, i) => view(`e${String(i)}`)),
    facts: { ...NO_FACTS, ...opts.facts },
    attention: { quarantined: 0, copies: 0, unseen: 0, full: false },
    demo: opts.demo === true ? 'sample' : 'none',
    undoStack: [],
    refreshStorageFacts,
    previewImport,
    applyImport,
    clearSampleData,
  })
  useSyncStore.setState({ syncId: opts.sync === true ? CODE : null })
  render(<BackupPanel />)
}

function chooseFile(name: string) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  const file = new File(['{}'], name, { type: 'application/json' })
  fireEvent.change(input, { target: { files: [file] } })
}

beforeEach(() => {
  downloads = []
  useUIStore.setState({ toasts: [] })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:x' })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
})

// T-026-1: the copy says where the data really is, per state.
describe('Backup copy per state', () => {
  it('without sync: stored only on this device, one delete action', () => {
    seed()
    expect(
      screen.getByText('Your data is stored only on this device. Download a backup regularly.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Synced through your relay/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete all entries' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /this device only/ })).toBeNull()
    expect(screen.queryByText('Demo mode — sample data loaded.')).toBeNull()
    expect(screen.getByText('3 entries')).toBeInTheDocument()
  })

  it('with sync on: synced through the relay, honest about encryption, two delete actions', () => {
    seed({ sync: true, count: 12 })
    expect(
      screen.getByText(
        "Synced through your relay: every linked device has a full copy. The relay copy isn't encrypted yet, so anyone with this app's public key could read it.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/stored only on this device/)).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Delete all 12 entries everywhere' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    ).toBeInTheDocument()
    // Another device is linked through Sync: the backup hand-over line is not needed.
    expect(screen.queryByText(/Another device:/)).toBeNull()
  })

  it('in a demo with sample rows: the demo line and "Clear sample data"', async () => {
    const user = userEvent.setup()
    seed({ demo: true })
    expect(screen.getByText('Demo mode — sample data loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear sample data' }))
    expect(clearSampleData).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Demo mode — sample data loaded.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Download JSON backup' })).toHaveFocus()
    expect(useUIStore.getState().toasts.at(-1)?.message).toBe('Sample data cleared')
  })

  it('names install steps for iPhone and for Android or a computer', () => {
    seed()
    expect(
      screen.getByText(/open it in Safari, tap Share, then Add to Home Screen/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/use Install app in the browser's menu or address bar/),
    ).toBeInTheDocument()
  })
})

describe('Storage facts', () => {
  it('asks the browser again each time the tab opens', () => {
    seed()
    expect(refreshStorageFacts).toHaveBeenCalledTimes(1)
  })

  it('says whether storage is protected, and is cautious when the browser cannot say', () => {
    seed({ facts: { persisted: true } })
    expect(screen.getByText('Storage: protected from automatic cleanup')).toBeInTheDocument()
    cleanup()
    seed({ facts: { persisted: false } })
    expect(
      screen.getByText('Storage: may be cleared by the browser. Keep sync on or download backups.'),
    ).toBeInTheDocument()
    cleanup()
    seed({ facts: { persisted: null } })
    expect(
      screen.getByText('Storage: may be cleared by the browser. Keep sync on or download backups.'),
    ).toBeInTheDocument()
  })

  it('shows the rollback copy line only when it is off', () => {
    seed()
    expect(screen.queryByText(/Rollback copy/)).toBeNull()
    cleanup()
    seed({ facts: { mirror: 'off' } })
    expect(screen.getByText('Rollback copy: off (storage full)')).toBeInTheDocument()
  })
})

describe('Last backup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [new Date(2026, 9, 31, 0, 5), 'Last backup: today'],
    [new Date(2026, 9, 30, 23, 55), 'Last backup: 1 day ago'],
    [new Date(2026, 9, 19, 12, 0), 'Last backup: 12 days ago'],
    // A clock set back since then: never "in the future".
    [new Date(2026, 10, 2, 12, 0), 'Last backup: today'],
  ])('counts local calendar days (%s)', (at, line) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 31, 9, 0))
    seed({ facts: { lastBackupAt: at.getTime() } })
    expect(screen.getByText(line)).toBeInTheDocument()
  })
})

describe('Import', () => {
  it('a chosen file becomes an inline preview in place of the Import button, Restore focused', async () => {
    seed()
    chooseFile('october.json')
    const region = await screen.findByRole('region', { name: 'Import october.json?' })
    expect(screen.queryByRole('button', { name: 'Import JSON backup' })).toBeNull()
    expect(within(region).getByRole('button', { name: 'Restore' })).toHaveFocus()
    expect(previewImport).toHaveBeenCalledTimes(1)
  })

  it('after Restore the Import button is back, with focus', async () => {
    const user = userEvent.setup()
    seed()
    chooseFile('october.json')
    await user.click(await screen.findByRole('button', { name: 'Restore' }))
    expect(applyImport).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Import JSON backup' })).toHaveFocus()
    expect(screen.queryByRole('region', { name: /^Import/ })).toBeNull()
  })

  it('Cancel brings the Import button back, with focus, and imports nothing', async () => {
    const user = userEvent.setup()
    seed()
    chooseFile('october.json')
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(applyImport).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Import JSON backup' })).toHaveFocus()
  })

  it('a file the store refuses shows its readable message and no preview', async () => {
    seed()
    previewImport.mockRejectedValue(new Error('This backup is from a newer SpendTrack.'))
    chooseFile('future.json')
    await waitFor(() => {
      expect(useUIStore.getState().toasts.at(-1)?.message).toBe(
        'This backup is from a newer SpendTrack.',
      )
    })
    expect(useUIStore.getState().toasts.at(-1)?.kind).toBe('error')
    expect(screen.queryByRole('region', { name: /^Import/ })).toBeNull()
  })

  it('only the latest of two quick choices is previewed', async () => {
    seed()
    let finishFirst: (p: Preview) => void = () => undefined
    previewImport.mockImplementationOnce(
      () =>
        new Promise<Preview>((resolve) => {
          finishFirst = resolve
        }),
    )
    chooseFile('slow.json')
    chooseFile('fast.json')
    await screen.findByRole('region', { name: 'Import fast.json?' })
    finishFirst(preview('slow.json'))
    await Promise.resolve()
    expect(screen.queryByRole('region', { name: 'Import slow.json?' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Import fast.json?' })).toBeInTheDocument()
  })
})

describe('Needs attention in the panel', () => {
  it('shows the card between Import and the danger zone when entries could not be read', () => {
    seed()
    expect(screen.queryByRole('region', { name: 'Needs attention' })).toBeNull()
    act(() => {
      useExpenseStore.setState({ attention: { quarantined: 2, copies: 0, unseen: 0, full: false } })
    })
    const card = screen.getByRole('region', { name: 'Needs attention' })
    const importButton = screen.getByRole('button', { name: 'Import JSON backup' })
    const deleteButton = screen.getByRole('button', { name: 'Delete all entries' })
    expect(
      importButton.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      card.compareDocumentPosition(deleteButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

// Last: the real engine stays loaded for the rest of the file once booted, so it boots after
// every stand-in test has run.
describe('Storage facts, with the engine', () => {
  // F-050: the real engine records the download (P2-14: booted from storage).
  it(
    'says when the last backup was, and a download makes it today',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup()
      localStorage.clear()
      localStorage.setItem('expenses', JSON.stringify([]))
      await act(async () => {
        await useExpenseStore.getState().hydrate()
      })
      render(<BackupPanel />)
      expect(screen.getByText('No backup downloaded yet')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Download JSON backup' }))
      expect(downloads).toEqual([
        expect.stringMatching(/^spendtrack-backup-\d{4}-\d{2}-\d{2}\.json$/),
      ])
      expect(screen.getByText('Last backup: today')).toBeInTheDocument()
      localStorage.clear()
    },
  )
})
