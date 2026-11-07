import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RecoveryCentre } from './RecoveryCentre'
import {
  useExpenseStore,
  type AttentionItem,
  type ChangeItem,
  type ImportPreview,
  type RecordSummary,
  type RecoveryApi,
  type RestoreResult,
  type SnapshotInfo,
} from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore, type Toast } from '../../stores/useUIStore'
import { downloadJSON } from '../../lib/download'
import { downloadRescueFile } from '../../lib/rescue'
import { EMPTY_DOC } from '../../data/core/doc'
import { encodeBackupFile } from '../../data/core/wire'
import type { UndoOutcome } from '../../data/local/types'
import type { BackupFileV5 } from '../../data/core/types'

// Settings › Backup › Recovery (PR-4 track spec §3.2): the view over a stand-in Recovery API
// (the engine side has its own suites: recovery.test.ts, sync.recovery.test.ts). Invented data.

// The browser download is the edge of this test: what is handed to it is checked instead.
vi.mock('../../lib/download', () => ({ downloadJSON: vi.fn(), downloadCSV: vi.fn() }))
vi.mock('../../lib/rescue', () => ({
  downloadRescueFile: vi.fn(() => ({ kind: 'downloaded', filename: 'raw.json' })),
}))

const NOW = new Date(2026, 9, 19, 14, 2).getTime()
const HOUR = 3_600_000
const CODE = '11111111-1111-4111-8111-111111111111'

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

const summary = (over: Partial<RecordSummary> = {}): RecordSummary => ({
  itemName: 'Lunch',
  amount: 4.5,
  day: '2026-10-19',
  category: 'Meals',
  notes: null,
  ...over,
})

const change = (over: Partial<ChangeItem> & Pick<ChangeItem, 'id' | 'kind'>): ChangeItem => ({
  at: NOW - HOUR,
  seen: false,
  pinned: false,
  before: summary(),
  after: null,
  count: 1,
  ...over,
})

const attentionItem = (
  over: Partial<AttentionItem> & Pick<AttentionItem, 'id'>,
): AttentionItem => ({
  at: NOW - 2 * HOUR,
  origin: 'local-v4',
  reason: 'bad-amount',
  kind: 'entry',
  salvage: { itemName: 'Chicken rice', day: '2026-10-18' },
  ...over,
})

const snapshot = (id: string, over: Partial<SnapshotInfo> = {}): SnapshotInfo => ({
  id,
  at: NOW - HOUR,
  reason: 'daily',
  rows: 641,
  ...over,
})

/** An empty backup file, as a snapshot's Download and the held entries' download hand over. */
const FILE = encodeBackupFile(EMPTY_DOC)

const PREVIEW: ImportPreview = {
  fileName: 'snapshot-s1',
  counts: {
    inFile: 12,
    added: 0,
    restored: 12,
    updated: 0,
    alreadyHere: 0,
    unreadable: 0,
    deletedInFile: 0,
  },
  replaceDeletes: 0,
}

interface Lists {
  attention: AttentionItem[]
  changes: ChangeItem[]
  snapshots: SnapshotInfo[]
  canWrite: boolean
}

/** The API's actions, as spies the tests read and steer. */
function spiesOf(lists: Lists) {
  const restored: RestoreResult = { applied: 1, skipped: 0, undoId: 'rec-1', why: null }
  return {
    previewSnapshot: vi.fn((_id: string) => Promise.resolve(PREVIEW)),
    snapshotFile: vi.fn((_id: string) => Promise.resolve<BackupFileV5 | null>(FILE)),
    restoreChange: vi.fn((_id: string) => Promise.resolve(restored)),
    markAllSeen: vi.fn(() => {
      lists.changes = lists.changes.map((c) => ({ ...c, seen: true }))
    }),
    attentionFile: vi.fn((id: string): unknown => ({ kind: 'needs-attention', id })),
    markFixed: vi.fn((id: string) => {
      lists.attention = lists.attention.filter((a) => a.id !== id)
    }),
    discard: vi.fn((id: string) => {
      lists.attention = lists.attention.filter((a) => a.id !== id)
    }),
  }
}

interface Fake extends Lists {
  readonly api: RecoveryApi
  readonly spy: ReturnType<typeof spiesOf>
}

/** A stand-in Recovery API over plain lists; its actions are spies the tests read. */
function fakeApi(init: Partial<Lists> = {}): Fake {
  const lists: Lists = {
    attention: init.attention ?? [],
    changes: init.changes ?? [],
    snapshots: init.snapshots ?? [],
    canWrite: init.canWrite ?? true,
  }
  const spy = spiesOf(lists)
  const api: RecoveryApi = {
    summary: () => ({
      snapshots: lists.snapshots.length,
      newChanges: lists.changes.filter((c) => c.pinned && !c.seen).length,
      canWrite: lists.canWrite,
    }),
    snapshots: () => lists.snapshots,
    previewSnapshot: (id) => spy.previewSnapshot(id),
    snapshotFile: (id) => spy.snapshotFile(id),
    changes: () => lists.changes,
    restoreChange: (id) => spy.restoreChange(id),
    markAllSeen: () => {
      spy.markAllSeen()
    },
    attention: () => lists.attention,
    attentionFile: (id) => spy.attentionFile(id),
    markFixed: (id) => {
      spy.markFixed(id)
    },
    discard: (id) => {
      spy.discard(id)
    },
  }
  return Object.assign(lists, { api, spy })
}

let onBack: ReturnType<typeof vi.fn<() => void>>
let onDownloadBackup: ReturnType<typeof vi.fn<() => void>>

async function open(
  fake: Fake,
  opts: {
    synced?: boolean
    memoryOnly?: boolean
    consumeUndo?: (id: string) => UndoOutcome | null
  } = {},
) {
  onBack = vi.fn()
  onDownloadBackup = vi.fn()
  act(() => {
    useExpenseStore.setState({
      hydrated: true,
      local: opts.memoryOnly === true ? 'memory-only' : 'saved',
      recovery: () => Promise.resolve(fake.api),
      exportBackup: () => FILE,
      ...(opts.consumeUndo === undefined ? {} : { consumeUndo: opts.consumeUndo }),
    })
    useSyncStore.setState({ syncId: opts.synced === false ? null : CODE })
  })
  const view = render(<RecoveryCentre onBack={onBack} onDownloadBackup={onDownloadBackup} />)
  await screen.findByRole('heading', { name: 'Snapshots' })
  return view
}

/** The `i`th of `list` (a missing one fails the test). */
function nth(list: readonly HTMLElement[], i: number): HTMLElement {
  const el = list[i]
  if (el === undefined) throw new Error(`no item ${String(i)}`)
  return el
}

const toasts = (): Toast[] => useUIStore.getState().toasts
const lastToast = (): Toast | undefined => toasts().at(-1)
const section = (name: string | RegExp) => {
  const heading = screen.getByRole('heading', { name })
  const region = heading.closest('section')
  if (region === null) throw new Error(`no section for ${String(name)}`)
  return region
}

beforeEach(() => {
  // jsdom does not lay out: a sheet scrolls a focused field into view.
  Element.prototype.scrollIntoView = vi.fn()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  useUIStore.setState({ toasts: [] })
  vi.mocked(downloadJSON).mockClear()
  vi.mocked(downloadRescueFile).mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
})

describe('the Recovery view', () => {
  it('takes focus on its heading; Back to Backup goes back', async () => {
    const user = userEvent.setup()
    await open(fakeApi())
    expect(screen.getByRole('heading', { name: 'Recovery', level: 3 })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Back to Backup' }))
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('with nothing kept yet: each section says so, and Needs attention is not there', async () => {
    await open(fakeApi())
    expect(screen.queryByRole('heading', { name: /Needs attention/ })).toBeNull()
    expect(section('Changes from your other device')).toHaveTextContent(
      'Nothing has changed here from your other device.',
    )
    expect(section('Snapshots')).toHaveTextContent(
      'No snapshots yet. SpendTrack keeps one each day you add something, and one before every big change.',
    )
    expect(section('Raw data')).toHaveTextContent(
      "Everything SpendTrack saved in this browser, exactly as stored. Your sync code isn't included.",
    )
    expect(screen.queryByRole('region', { name: 'Not saving' })).toBeNull()
  })

  it('without a sync code, the changes section says when it fills', async () => {
    await open(fakeApi(), { synced: false })
    expect(section('Changes from your other device')).toHaveTextContent(
      'Changes from your other device show here once sync is on.',
    )
  })

  it('lists the sections in order: needs attention, changes, snapshots, raw data', async () => {
    await open(
      fakeApi({
        attention: [attentionItem({ id: 'a1' })],
        changes: [change({ id: 'c1', kind: 'removed' })],
        snapshots: [snapshot('s1')],
      }),
    )
    const order = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)
    expect(order).toEqual([
      'Needs attention (1)',
      'Changes from your other device',
      'Snapshots',
      'Raw data',
    ])
  })

  it('Download raw data saves the rescue file', async () => {
    const user = userEvent.setup()
    await open(fakeApi())
    await user.click(within(section('Raw data')).getByRole('button', { name: 'Download raw data' }))
    expect(downloadRescueFile).toHaveBeenCalledOnce()
    expect(lastToast()?.message).toBe('Raw data downloaded')
  })

  it('"Review" lands on the section it asked for, once', async () => {
    useUIStore.setState({ settingsFocus: 'recovery-changes' })
    await open(fakeApi({ changes: [change({ id: 'c1', kind: 'removed' })] }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Changes from your other device' })).toHaveFocus()
    })
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })

  it('"Review" of what needs attention lands on that list', async () => {
    useUIStore.setState({ settingsFocus: 'recovery-attention' })
    await open(fakeApi({ attention: [attentionItem({ id: 'a1' })] }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Needs attention (1)' })).toHaveFocus()
    })
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })

  it('a Recovery that does not load says why', async () => {
    act(() => {
      useExpenseStore.setState({
        recovery: () => Promise.reject(new Error('SpendTrack is still loading your data.')),
      })
    })
    render(<RecoveryCentre onBack={vi.fn()} onDownloadBackup={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'SpendTrack is still loading your data.',
    )
  })
})

describe('memory only (acceptance 14)', () => {
  it('says the device is not saving, offers both downloads, and offers no action that writes', async () => {
    const user = userEvent.setup()
    await open(
      fakeApi({
        canWrite: false,
        attention: [attentionItem({ id: 'a1' })],
        changes: [change({ id: 'c1', kind: 'removed', pinned: true })],
        snapshots: [snapshot('s1')],
      }),
      { memoryOnly: true },
    )
    const notice = screen.getByRole('region', { name: 'Not saving' })
    expect(notice).toHaveTextContent(
      "This device isn't saving. Your saved data couldn't be read and there's no room for a safety copy, so nothing is written. Download your entries before you close SpendTrack.",
    )
    await user.click(within(notice).getByRole('button', { name: 'Download a backup' }))
    expect(downloadJSON).toHaveBeenCalledWith(
      expect.stringMatching(/^spendtrack-backup-\d{4}-\d{2}-\d{2}\.json$/),
      FILE,
    )
    // the held entries' file: no "Last backup" (Backup's own download records one)
    expect(onDownloadBackup).not.toHaveBeenCalled()
    await user.click(within(notice).getByRole('button', { name: 'Download raw data' }))
    expect(downloadRescueFile).toHaveBeenCalledOnce()
    // read-only: no Fix, Discard, Restore or Mark all seen; downloads stay
    for (const name of [/^Fix /, /^Discard /, /^Restore/, /Mark all seen/]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.getByRole('button', { name: /^Download Chicken rice/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Download Daily copy/ })).toBeInTheDocument()
  })
})

describe('Needs attention (acceptance 10–12)', () => {
  const items = [
    attentionItem({ id: 'a1' }),
    attentionItem({
      id: 'a2',
      origin: 'remote',
      reason: 'bad-name',
      salvage: { amount: 7.25 },
    }),
    attentionItem({ id: 'a3', reason: 'not-object', salvage: null }),
    attentionItem({
      id: 'st5:q:st5:db:1',
      origin: 'local-envelope',
      reason: 'copy',
      kind: 'copy',
      salvage: null,
    }),
  ]

  it('lists each item with its reason, origin and date; Fix only where something reads', async () => {
    await open(fakeApi({ attention: items }))
    const list = screen.getByRole('list', { name: 'Needs attention' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('Chicken rice')
    expect(rows[0]).toHaveTextContent("The amount isn't a number above 0")
    expect(rows[0]).toHaveTextContent('Found on this device · Today, 12:02')
    expect(rows[1]).toHaveTextContent('Unnamed entry')
    expect(rows[1]).toHaveTextContent('It has no name')
    expect(rows[1]).toHaveTextContent('From the synced copy')
    expect(rows[2]).toHaveTextContent("It isn't an entry")
    expect(rows[3]).toHaveTextContent('A damaged copy of your saved data')
    expect(rows[3]).toHaveTextContent('Kept exactly as it was found')
    expect(screen.getByRole('button', { name: 'Fix Chicken rice' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fix Unnamed entry' })).toBeInTheDocument()
    // no salvage, or a whole copy: no Fix
    expect(within(nth(rows, 2)).queryByRole('button', { name: /^Fix/ })).toBeNull()
    expect(within(nth(rows, 3)).queryByRole('button', { name: /^Fix/ })).toBeNull()
  })

  it('Download saves that one item', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ attention: items })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Download Chicken rice' }))
    expect(fake.spy.attentionFile).toHaveBeenCalledWith('a1')
    expect(downloadJSON).toHaveBeenCalledWith(
      expect.stringMatching(/^spendtrack-needs-attention-\d{4}-\d{2}-\d{2}\.json$/),
      { kind: 'needs-attention', id: 'a1' },
    )
    expect(fake.spy.discard).not.toHaveBeenCalled()
  })

  it('Discard asks first, downloads it first (ticked), then removes exactly that item', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ attention: items })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Discard Chicken rice' }))
    const ask = screen.getByRole('group', { name: 'Discard this for good?' })
    expect(ask).toHaveTextContent("It's removed from this device. Nothing else changes.")
    const first = within(ask).getByRole('checkbox', { name: 'Download it first' })
    expect(first).toBeChecked()
    expect(fake.spy.discard).not.toHaveBeenCalled()
    await user.click(within(ask).getByRole('button', { name: 'Discard' }))
    expect(downloadJSON).toHaveBeenCalledOnce()
    expect(fake.spy.discard).toHaveBeenCalledExactlyOnceWith('a1')
    expect(lastToast()?.message).toBe('Downloaded, then discarded')
    expect(screen.queryByRole('button', { name: 'Discard Chicken rice' })).toBeNull()
    // the row is gone: focus is on the section, never on <body>
    expect(screen.getByRole('heading', { name: 'Needs attention (3)' })).toHaveFocus()
  })

  it('Discard without the download: nothing is downloaded', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ attention: items })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Discard Chicken rice' }))
    const ask = screen.getByRole('group', { name: 'Discard this for good?' })
    await user.click(within(ask).getByRole('checkbox', { name: 'Download it first' }))
    await user.click(within(ask).getByRole('button', { name: 'Discard' }))
    expect(downloadJSON).not.toHaveBeenCalled()
    expect(fake.spy.discard).toHaveBeenCalledExactlyOnceWith('a1')
    expect(lastToast()?.message).toBe('Discarded')
  })

  it('a download that fails discards nothing', async () => {
    const user = userEvent.setup()
    vi.mocked(downloadJSON).mockImplementationOnce(() => {
      throw new Error('blocked')
    })
    const fake = fakeApi({ attention: items })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Discard Chicken rice' }))
    await user.click(
      within(screen.getByRole('group', { name: 'Discard this for good?' })).getByRole('button', {
        name: 'Discard',
      }),
    )
    expect(fake.spy.discard).not.toHaveBeenCalled()
    expect(lastToast()?.message).toBe(
      "The download couldn't start, so nothing was discarded. Try again.",
    )
    expect(screen.getByRole('button', { name: 'Discard Chicken rice' })).toHaveFocus()
  })

  it('Cancel takes the question back and changes nothing', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ attention: items })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Discard Chicken rice' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group', { name: 'Discard this for good?' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Discard Chicken rice' })).toHaveFocus()
    expect(fake.spy.discard).not.toHaveBeenCalled()
  })

  it('the second press of a double click does not ask again', async () => {
    const fake = fakeApi({ attention: items })
    await open(fake)
    const trigger = screen.getByRole('button', { name: 'Fix Chicken rice' })
    fireEvent.click(trigger, { detail: 2 })
    expect(screen.queryByRole('dialog', { name: 'Add expense' })).toBeNull()
  })

  it('Discard of the last row hands focus to the Recovery heading', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ attention: [attentionItem({ id: 'a1' })] })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Discard Chicken rice' }))
    await user.click(
      within(screen.getByRole('group', { name: 'Discard this for good?' })).getByRole('button', {
        name: 'Discard',
      }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /Needs attention/ })).toBeNull()
    })
    expect(screen.getByRole('heading', { name: 'Recovery', level: 3 })).toHaveFocus()
  })

  it('Fix opens the Add sheet prefilled; once added, the row is marked fixed and leaves', async () => {
    const user = userEvent.setup()
    const addExpense = vi.fn(
      (input: { itemName: string; amount: number; category?: string; day?: string }) => ({
        id: 'new-1',
        itemName: input.itemName,
        amount: input.amount,
        category: input.category ?? 'Other',
        date: `${input.day ?? '2026-10-19'}T12:00:00`,
        day: input.day ?? '2026-10-19',
        createdAt: '2026-10-19T06:02:00.000Z',
        ext: {},
      }),
    )
    const fake = fakeApi({
      attention: [
        attentionItem({
          id: 'a1',
          salvage: { itemName: 'Chicken rice', day: '2026-10-18', notes: 'extra egg' },
        }),
        attentionItem({
          id: 'a2',
          reason: 'bad-date',
          salvage: { itemName: 'Taxi', amount: 18.4 },
        }),
      ],
    })
    await open(fake)
    act(() => {
      useExpenseStore.setState({
        addExpense,
        saveNow: () => 'saved',
        categories: ['Food & Dining', 'Other'],
      })
    })
    await user.click(screen.getByRole('button', { name: 'Fix Chicken rice' }))
    const sheet = await screen.findByRole('dialog', { name: 'Add expense' })
    expect(within(sheet).getByRole('textbox', { name: 'Notes (optional)' })).toHaveValue(
      'extra egg',
    )
    expect(within(sheet).getByDisplayValue('Chicken rice')).toBeInTheDocument()
    await user.type(within(sheet).getByRole('spinbutton', { name: /Amount/ }), '5.5')
    await user.click(screen.getByRole('button', { name: /^Add for / }))
    expect(addExpense).toHaveBeenCalledWith(
      expect.objectContaining({
        itemName: 'Chicken rice',
        amount: 5.5,
        day: '2026-10-18',
        notes: 'extra egg',
      }),
    )
    expect(fake.spy.markFixed).toHaveBeenCalledExactlyOnceWith('a1')
    expect(lastToast()?.message).toMatch(
      /^Added "Chicken rice" · .*\. The unreadable original stays in your raw data download\.$/,
    )
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Fix Chicken rice' })).toBeNull()
    })
    expect(screen.getByRole('heading', { name: 'Needs attention (1)' })).toBeInTheDocument()
  })
})

describe('Changes from your other device (acceptance 7–8)', () => {
  it('names each kind, shows what moved, marks the new ones, and Mark all seen clears them', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({
      changes: [
        change({
          id: 'c1',
          kind: 'conflict',
          pinned: true,
          after: summary({ amount: 45 }),
        }),
        change({ id: 'c2', kind: 'removed', seen: true, before: summary({ itemName: 'Taxi' }) }),
        change({ id: 'c3', kind: 'mass', pinned: true, count: 3, before: null }),
      ],
    })
    await open(fake)
    const changes = section('Changes from your other device')
    const rows = within(changes).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Changed on your other device while you were editing it here')
    expect(rows[0]).toHaveTextContent(/Amount: S?\$4\.50 → S?\$45\.00/)
    expect(within(nth(rows, 0)).getByText('New')).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Deleted on your other device')
    expect(within(nth(rows, 1)).queryByText('New')).toBeNull()
    expect(rows[2]).toHaveTextContent('Your other device removed 3 entries')
    expect(within(changes).getByText('2 new')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore Lunch' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore all 3' })).toBeInTheDocument()

    await user.click(within(changes).getByRole('button', { name: 'Mark all seen' }))
    expect(fake.spy.markAllSeen).toHaveBeenCalledOnce()
    expect(within(changes).queryByText('2 new')).toBeNull()
    expect(within(changes).queryByText('New')).toBeNull()
  })

  it('Restore says it is back, with a 30 s Undo that takes it away again', async () => {
    const user = userEvent.setup()
    const consumeUndo = vi.fn((_id: string): UndoOutcome | null => ({ applied: 1, skipped: 0 }))
    const fake = fakeApi({ changes: [change({ id: 'c1', kind: 'removed' })] })
    await open(fake, { consumeUndo })
    await user.click(screen.getByRole('button', { name: 'Restore Lunch' }))
    expect(fake.spy.restoreChange).toHaveBeenCalledExactlyOnceWith('c1')
    const done = lastToast()
    expect(done).toMatchObject({ kind: 'success', message: 'Restored', duration: 30_000 })
    expect(done?.action?.label).toBe('Undo')
    act(() => {
      done?.action?.onClick()
    })
    expect(consumeUndo).toHaveBeenCalledWith('rec-1')
    expect(lastToast()?.message).toBe('Undone')
  })

  it.each([
    ['already', "It's already back."],
    ['changed-since', 'It has changed again since, so nothing was restored.'],
    ['deleted-since', 'It was deleted since, so nothing was restored.'],
    ['gone', "This change can't be restored any more."],
  ] as const)('a refused restore (%s) says why, with no Undo', async (why, message) => {
    const user = userEvent.setup()
    const fake = fakeApi({ changes: [change({ id: 'c1', kind: 'removed' })] })
    fake.spy.restoreChange.mockResolvedValueOnce({
      applied: 0,
      skipped: 1,
      undoId: null,
      why,
    })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Restore Lunch' }))
    expect(lastToast()).toMatchObject({ message })
    expect(lastToast()?.action).toBeUndefined()
  })

  it('a mass removal restores all of them at once', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ changes: [change({ id: 'c3', kind: 'mass', count: 3, before: null })] })
    fake.spy.restoreChange.mockResolvedValueOnce({
      applied: 3,
      skipped: 0,
      undoId: 'rec-9',
      why: null,
    })
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Restore all 3' }))
    expect(lastToast()?.message).toBe('Restored 3 entries')
    fake.spy.restoreChange.mockResolvedValueOnce({
      applied: 0,
      skipped: 3,
      undoId: null,
      why: 'already',
    })
    await user.click(screen.getByRole('button', { name: 'Restore all 3' }))
    expect(lastToast()?.message).toBe('Those entries are already back.')
  })

  it('a press while a restore is running restores nothing more', async () => {
    const fake = fakeApi({ changes: [change({ id: 'c1', kind: 'removed' })] })
    let finish: (r: RestoreResult) => void = () => undefined
    fake.spy.restoreChange.mockImplementationOnce(
      () =>
        new Promise<RestoreResult>((resolve) => {
          finish = resolve
        }),
    )
    await open(fake)
    const button = screen.getByRole('button', { name: 'Restore Lunch' })
    fireEvent.click(button, { detail: 1 })
    fireEvent.click(button, { detail: 1 })
    fireEvent.click(button, { detail: 2 })
    await act(async () => {
      finish({ applied: 1, skipped: 0, undoId: 'rec-1', why: null })
      await Promise.resolve()
    })
    expect(fake.spy.restoreChange).toHaveBeenCalledOnce()
  })

  it('a refusal that throws (this device is not saving) says so', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ changes: [change({ id: 'c1', kind: 'removed' })] })
    fake.spy.restoreChange.mockRejectedValueOnce(
      new Error("This device isn't saving, so nothing can be restored here."),
    )
    await open(fake)
    await user.click(screen.getByRole('button', { name: 'Restore Lunch' }))
    expect(lastToast()).toMatchObject({
      kind: 'error',
      message: "This device isn't saving, so nothing can be restored here.",
    })
  })
})

describe('Snapshots (acceptance 3, 5, 6)', () => {
  it('lists each copy by what it was kept for, when, and how many entries', async () => {
    await open(
      fakeApi({
        snapshots: [
          snapshot('s1', { reason: 'delete-all', rows: 12 }),
          snapshot('s2', { reason: 'mass', at: NOW - 30 * HOUR, rows: 1 }),
          snapshot('s3', { reason: 'pre-v5', at: new Date(2025, 9, 19, 9, 5).getTime() }),
        ],
      }),
    )
    const rows = within(section('Snapshots')).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Before Delete all')
    expect(rows[0]).toHaveTextContent('Today, 13:02 · 12 entries')
    expect(rows[1]).toHaveTextContent('Before your other device removed entries')
    expect(rows[1]).toHaveTextContent('Yesterday, 08:02 · 1 entry')
    expect(rows[2]).toHaveTextContent('Before the 0.10.0 upgrade')
    expect(rows[2]).toHaveTextContent('19 Oct 2025, 09:05 · 641 entries')
    expect(
      screen.getByRole('button', { name: 'Restore Before Delete all, Today, 13:02' }),
    ).toBeInTheDocument()
  })

  it('Restore previews in the row: what the copy brings back, and Restore only', async () => {
    const user = userEvent.setup()
    const applyImport = vi.fn(() => ({
      applied: 12,
      skipped: 0,
      added: 0,
      restored: 12,
      updated: 0,
      removed: 0,
    }))
    const fake = fakeApi({ snapshots: [snapshot('s1', { reason: 'delete-all', rows: 12 })] })
    await open(fake)
    act(() => {
      useExpenseStore.setState({ applyImport, undoStack: [] })
    })
    await user.click(screen.getByRole('button', { name: /^Restore Before Delete all/ }))
    const preview = await screen.findByRole('region', { name: 'Restore from this copy?' })
    expect(fake.spy.previewSnapshot).toHaveBeenCalledExactlyOnceWith('s1')
    expect(preview).toHaveTextContent('12 in the copy')
    expect(preview).toHaveTextContent('12 restored (they were deleted)')
    expect(preview).toHaveTextContent('Nothing here is removed or changed.')
    expect(within(preview).queryByRole('button', { name: /Replace/ })).toBeNull()
    await user.click(within(preview).getByRole('button', { name: 'Restore' }))
    expect(applyImport).toHaveBeenCalledWith(PREVIEW, 'restore')
    expect(lastToast()?.message).toBe('Restored 12 entries')
    expect(screen.queryByRole('region', { name: 'Restore from this copy?' })).toBeNull()
  })

  it('a copy that no longer reads says so and opens no preview', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({ snapshots: [snapshot('s1')] })
    fake.spy.previewSnapshot.mockRejectedValueOnce(new Error("This copy can't be read any more."))
    await open(fake)
    await user.click(screen.getByRole('button', { name: /^Restore Daily copy/ }))
    await waitFor(() => {
      expect(lastToast()?.message).toBe("This copy can't be read any more.")
    })
    expect(screen.queryByRole('region', { name: 'Restore from this copy?' })).toBeNull()
    expect(screen.queryByText('Checking…')).toBeNull()
  })

  it('Download saves the copy as a dated backup file and records no backup', async () => {
    const user = userEvent.setup()
    const fake = fakeApi({
      snapshots: [snapshot('s1', { at: new Date(2026, 9, 19, 9, 7).getTime() })],
    })
    await open(fake)
    await user.click(screen.getByRole('button', { name: /^Download Daily copy/ }))
    await waitFor(() => {
      expect(downloadJSON).toHaveBeenCalledWith('spendtrack-snapshot-2026-10-19-0907.json', FILE)
    })
    expect(onDownloadBackup).not.toHaveBeenCalled()
    expect(lastToast()?.message).toBe('Snapshot downloaded')
  })

  it('shows 20 at a time; Show more adds the rest and focus goes to the first one added', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 25 }, (_, i) =>
      snapshot(`s${String(i)}`, { at: NOW - (i + 1) * HOUR }),
    )
    await open(fakeApi({ snapshots: many }))
    const list = () => within(section('Snapshots')).getAllByRole('listitem')
    expect(list()).toHaveLength(20)
    await user.click(screen.getByRole('button', { name: 'Show 5 more' }))
    expect(list()).toHaveLength(25)
    expect(list()[20]).toHaveFocus()
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull()
  })
})
