import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BackupNudge, LATER_KEY } from './BackupNudge'
import { useExpenseStore, type ExpenseView, type StorageFacts } from '../stores/useExpenseStore'
import { useSyncStore, type SyncFailure } from '../stores/useSyncStore'
import { useUIStore } from '../stores/useUIStore'
import { EMPTY_DOC } from '../data/core/doc'
import { encodeBackupFile } from '../data/core/wire'
import type { BackupFileV5 } from '../data/core/types'

// T-050-2: "Time for a backup" (F-050). Days are local calendar days, never 24 h blocks: every time
// below is built in the zone the suite runs in (Asia/Singapore, Pacific/Honolulu,
// Pacific/Kiritimati, and America/New_York for the 1 Nov 2026 DST change), so each case means the
// same calendar days in all of them. Invented data; the store's views and actions are set directly.

// A demo build counts only the owner's own rows (P2-22); the flag is read once as the facade loads.
const build = vi.hoisted(() => ({ demo: false }))
vi.mock('../stores/useExpenseStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('../stores/useExpenseStore')>()
  return {
    ...real,
    isOwnRow: (e: { readonly id: string }) =>
      !build.demo || !e.id.startsWith(real.SAMPLE_ID_PREFIX),
  }
})

/** Local wall-clock time in the zone under test. */
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime()

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const view = (id: string, day: string): ExpenseView => ({
  id,
  itemName: `Item ${id}`,
  amount: 4.5,
  category: 'Food',
  date: `${day}T12:00:00`,
  day,
  createdAt: `${day}T04:00:00.000Z`,
  ext: {},
})

const NO_FACTS: StorageFacts = {
  persisted: null,
  lastBackupAt: null,
  mirror: 'on',
  nearlyFull: false,
}
const CODE = '11111111-1111-4111-8111-111111111111'
const TITLE = 'Time for a backup'
const ONLY_COPY = 'This device holds the only copy of your entries.'
const NAMES_SYNC =
  "Sync keeps your devices alike, but a delete reaches all of them. A backup file doesn't."

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

let downloads: string[]
let markBackedUp: ReturnType<typeof vi.fn<() => void>>
let exportBackup: ReturnType<typeof vi.fn<() => BackupFileV5>>

interface Seed {
  /** The device clock. */
  now: number
  /** Days of the stored rows (own unless their id starts with `demo-`). */
  days?: readonly string[]
  ids?: readonly string[]
  lastBackupAt?: number | null
  sync?: 'off' | 'healthy' | 'failing' | 'stale' | 'never'
  local?: 'saved' | 'error-quota' | 'memory-only'
}

function seed(s: Seed) {
  vi.setSystemTime(s.now)
  const days = s.days ?? [dayOf(at(2026, 1, 5))]
  markBackedUp = vi.fn(() => {
    useExpenseStore.setState({ facts: { ...NO_FACTS, lastBackupAt: Date.now() } })
  })
  exportBackup = vi.fn(() => encodeBackupFile(EMPTY_DOC))
  useExpenseStore.setState({
    hydrated: true,
    local: s.local ?? 'saved',
    expenses: days.map((day, i) => view(s.ids?.[i] ?? `e${String(i)}`, day)),
    facts: { ...NO_FACTS, lastBackupAt: s.lastBackupAt ?? null },
    markBackedUp,
    exportBackup,
  })
  const failing: SyncFailure = { kind: 'network', message: 'offline', since: s.now - 60_000 }
  switch (s.sync ?? 'off') {
    case 'off':
      useSyncStore.setState({ syncId: null, lastError: null, lastSyncAt: null })
      break
    case 'healthy':
      useSyncStore.setState({ syncId: CODE, lastError: null, lastSyncAt: s.now - 3_600_000 })
      break
    case 'failing':
      useSyncStore.setState({ syncId: CODE, lastError: failing, lastSyncAt: s.now - 3_600_000 })
      break
    case 'stale':
      useSyncStore.setState({ syncId: CODE, lastError: null, lastSyncAt: s.now - 8 * 86_400_000 })
      break
    case 'never':
      useSyncStore.setState({ syncId: CODE, lastError: null, lastSyncAt: null })
      break
  }
}

function mount() {
  return render(
    <>
      <main id="main" tabIndex={-1} />
      <BackupNudge />
    </>,
  )
}

const card = () => screen.queryByRole('region', { name: TITLE })
const shown = () => card() !== null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  downloads = []
  localStorage.clear()
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
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  localStorage.clear()
  build.demo = false
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
})

describe('when the nudge is due (local calendar days)', () => {
  it('shows at 30 days since the last backup, not at 29 (sync off)', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 10, 3) })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 10, 2) })
    mount()
    expect(shown()).toBe(true)
    expect(screen.getByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument()
    expect(screen.getByText('Last backup: 30 days ago.')).toBeInTheDocument()
    expect(screen.getByText(ONLY_COPY)).toBeInTheDocument()
  })

  it('never backed up: counts from the oldest own entry, at 30 days and not 29', () => {
    seed({ now: at(2026, 11, 1), days: ['2026-10-20', '2026-10-03'] })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    seed({ now: at(2026, 11, 1), days: ['2026-10-20', '2026-10-02', '2026-10-25'] })
    mount()
    expect(shown()).toBe(true)
    expect(screen.getByText("You haven't downloaded a backup yet.")).toBeInTheDocument()
  })

  it('23:59 to 00:01 is a day: 30 calendar days, though under 30 × 24 h', () => {
    seed({ now: at(2026, 11, 1, 0, 1), lastBackupAt: at(2026, 10, 2, 23, 59) })
    mount()
    expect(shown()).toBe(true)
    expect(screen.getByText('Last backup: 30 days ago.')).toBeInTheDocument()
  })

  it('00:01 to 23:59 of the 29th day is not 30 days, though close to 30 × 24 h', () => {
    seed({ now: at(2026, 11, 1, 23, 59), lastBackupAt: at(2026, 10, 3, 0, 1) })
    mount()
    expect(shown()).toBe(false)
  })

  it('31 Dec to 1 Jan: the year turns over on calendar days too', () => {
    seed({ now: at(2027, 1, 1, 0, 1), lastBackupAt: at(2026, 12, 2, 23, 59) })
    mount()
    expect(screen.getByText('Last backup: 30 days ago.')).toBeInTheDocument()
    cleanup()

    seed({ now: at(2027, 1, 1, 0, 1), lastBackupAt: at(2026, 12, 3, 0, 1) })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    seed({ now: at(2027, 1, 1, 0, 1), days: ['2026-12-02'] })
    mount()
    expect(shown()).toBe(true)
  })

  // America/New_York leaves daylight time at 02:00 on Sun 1 Nov 2026: that day has 25 hours. From
  // 00:30 on 3 Oct to 23:45 on 1 Nov is 29 calendar days but over 30 × 24 h there.
  it('across the 1 Nov 2026 DST change (America/New_York): 29 calendar days stay 29', () => {
    seed({ now: at(2026, 11, 1, 23, 45), lastBackupAt: at(2026, 10, 3, 0, 30) })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    seed({ now: at(2026, 11, 2, 0, 15), lastBackupAt: at(2026, 10, 3, 0, 30) })
    mount()
    expect(shown()).toBe(true)
  })

  it('with healthy sync the line is 60 days, and the copy names sync', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 3), sync: 'healthy' })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 2), sync: 'healthy' })
    mount()
    expect(shown()).toBe(true)
    expect(screen.getByText('Last backup: 60 days ago.')).toBeInTheDocument()
    expect(screen.getByText(NAMES_SYNC)).toBeInTheDocument()
    expect(screen.queryByText(ONLY_COPY)).toBeNull()
  })

  it.each([
    ['failing', 'a sync that keeps failing'],
    ['stale', 'no sync for 8 days'],
    ['never', 'a code that never synced'],
  ] as const)('sync that is not healthy (%s: %s) keeps the 30-day line', (sync, _why) => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 10, 2), sync })
    mount()
    expect(shown()).toBe(true)
    // The device is linked: the risk named is still the one sync carries.
    expect(screen.getByText(NAMES_SYNC)).toBeInTheDocument()
  })

  it('says nothing without own entries, and ignores the sample rows of a demo build', () => {
    seed({ now: at(2026, 11, 1), days: [] })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    build.demo = true
    // Only sample rows, dated months back: nothing of the owner's to back up.
    seed({
      now: at(2026, 11, 1),
      days: ['2026-06-01', '2026-06-02'],
      ids: ['demo-1', 'demo-2'],
    })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    // One own row today beside old sample rows: its age, not theirs, counts.
    seed({
      now: at(2026, 11, 1),
      days: ['2026-06-01', '2026-11-01'],
      ids: ['demo-1', 'own-1'],
    })
    mount()
    expect(shown()).toBe(false)
  })

  it.each(['error-quota', 'memory-only'] as const)(
    'stays away while this device is not saving (%s)',
    (local) => {
      seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 1), local })
      mount()
      expect(shown()).toBe(false)
    },
  )

  it('is a plain region: never a live region, so nothing is announced at boot', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 1) })
    mount()
    const region = card()
    expect(region).not.toBeNull()
    expect(region).not.toHaveAttribute('aria-live')
    expect(region).not.toHaveAttribute('role', 'status')
    expect(region).not.toHaveAttribute('role', 'alert')
  })
})

describe('Download a backup', () => {
  it('downloads, records the backup and hides the card', () => {
    seed({ now: at(2026, 11, 1, 9, 30), lastBackupAt: at(2026, 9, 1) })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Download a backup' }), { detail: 1 })
    expect(downloads).toEqual(['spendtrack-backup-2026-11-01.json'])
    expect(exportBackup).toHaveBeenCalledTimes(1)
    expect(markBackedUp).toHaveBeenCalledTimes(1)
    expect(useExpenseStore.getState().facts.lastBackupAt).toBe(at(2026, 11, 1, 9, 30))
    expect(useUIStore.getState().toasts.map((t) => t.message)).toEqual(['Backup downloaded'])
    expect(shown()).toBe(false)
    // The card went: focus is on the screen, never on <body>.
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('records nothing when the download cannot start, and says so', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 1) })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => {
        throw new Error('blocked')
      },
    })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Download a backup' }), { detail: 1 })
    expect(markBackedUp).not.toHaveBeenCalled()
    expect(useExpenseStore.getState().facts.lastBackupAt).toBe(at(2026, 9, 1))
    expect(useUIStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ['error', "The download couldn't start. Try again."],
    ])
    expect(shown()).toBe(true)
  })

  it('a double click downloads once', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 1) })
    mount()
    const button = screen.getByRole('button', { name: 'Download a backup' })
    fireEvent.click(button, { detail: 1 })
    fireEvent.click(button, { detail: 2 })
    expect(downloads).toHaveLength(1)
    expect(markBackedUp).toHaveBeenCalledTimes(1)
  })
})

describe('Later', () => {
  it('hides it for 7 days, also after a reload (sync off)', () => {
    seed({ now: at(2026, 11, 1, 20, 0), lastBackupAt: at(2026, 9, 1) })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }), { detail: 1 })
    expect(shown()).toBe(false)
    expect(localStorage.getItem(LATER_KEY)).toBe(String(at(2026, 11, 1, 20, 0)))
    expect(document.activeElement).toBe(document.getElementById('main'))
    cleanup()

    // 6 calendar days on, a minute before midnight: still hidden.
    seed({ now: at(2026, 11, 7, 23, 59), lastBackupAt: at(2026, 9, 1) })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    // The 7th day, a minute after midnight: back.
    seed({ now: at(2026, 11, 8, 0, 1), lastBackupAt: at(2026, 9, 1) })
    mount()
    expect(shown()).toBe(true)
  })

  it('hides it for 30 days with healthy sync', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 8, 1), sync: 'healthy' })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }), { detail: 1 })
    cleanup()

    seed({ now: at(2026, 11, 30), lastBackupAt: at(2026, 8, 1), sync: 'healthy' })
    mount()
    expect(shown()).toBe(false)
    cleanup()

    seed({ now: at(2026, 12, 1), lastBackupAt: at(2026, 8, 1), sync: 'healthy' })
    mount()
    expect(shown()).toBe(true)
  })

  it('a damaged or future snooze stamp hides nothing', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 1) })
    localStorage.setItem(LATER_KEY, 'soon')
    mount()
    expect(shown()).toBe(true)
    cleanup()

    // A clock that has since gone back: the snooze cannot run into the future.
    localStorage.setItem(LATER_KEY, String(at(2026, 11, 20)))
    mount()
    expect(shown()).toBe(true)
  })

  it('hides it for this page when storage refuses the write', () => {
    seed({ now: at(2026, 11, 1), lastBackupAt: at(2026, 9, 1) })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Later' }), { detail: 1 })
    expect(shown()).toBe(false)
    expect(localStorage.getItem(LATER_KEY)).toBeNull()
  })
})

describe('a session left open', () => {
  it('shows the card when the 30th day starts, without a reload', () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    seed({ now: at(2026, 10, 31, 23, 58), lastBackupAt: at(2026, 10, 2) })
    mount()
    expect(shown()).toBe(false)
    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(shown()).toBe(true)
  })
})
