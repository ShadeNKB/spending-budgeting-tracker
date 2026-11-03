import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SyncPill } from './SyncPill'
import { useExpenseStore, type LocalStatus } from '../stores/useExpenseStore'
import { useUIStore } from '../stores/useUIStore'
import {
  OLD_DEVICE_WAITING,
  clockTime,
  useSyncStore,
  type SyncFailure,
} from '../stores/useSyncStore'

// A build with sync configured; no request is made here, the stores are set directly.
vi.mock('../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/syncConfig')>()),
  syncEnabled: true,
}))

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000

// The engine's words (syncEngine.ts owns them); the pill shows whatever lastError says.
const NETWORK = "Couldn't reach the sync server. Your changes are saved on this device."
const SERVER = 'The sync server had a problem. Your changes are saved on this device.'
const REFUSED = 'The sync server refused access. Your data is safe on this device.'
const TOO_LARGE =
  "Sync paused: your data (1228 KB) is too large for the sync server. It's still saved here — export a backup."
const NOT_FOUND = 'No synced data found for this code. Check it on your other device.'
const DENIED = 'Sync paused: the sync server refused access. Your data is safe on this device.'
const MOVED = 'Sync moved to a newer version. Reload SpendTrack to update.'
const BUSY = 'Your devices kept syncing at the same moment. Your changes are saved on this device.'

const failure = (kind: SyncFailure['kind'], message: string, extra: Partial<SyncFailure> = {}) => ({
  kind,
  message,
  since: NOW,
  ...extra,
})

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
  vi.useRealTimers()
})

/** The pill as seen from 1280 px (display: none below, so never a focus stop on a phone). */
function pill(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.xl\\:inline-flex')
  if (!element) throw new Error('No visible pill')
  return element
}

const pillText = (): string => pill().textContent

/** What the live region says. */
const announced = (): string => screen.getByRole('status').textContent

const connected = { syncId: 'code', lastSyncAt: NOW - 2 * MINUTE }

describe('SyncPill labels (track spec §3.11)', () => {
  it('shows the local save state when sync is off', () => {
    useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: NOW - 30_000 })
    render(<SyncPill />)
    expect(pillText()).toBe('Saved · 30s ago')
  })

  it('says Synced only when the last cycle succeeded and nothing is pending', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false, pending: 0 })
    render(<SyncPill />)
    expect(pillText()).toBe('Synced · 2m ago')
  })

  it('keeps Synced through a background check with nothing pending (no flicker)', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'syncing', pendingLocal: false, pending: 0 })
    render(<SyncPill />)
    expect(pillText()).toBe('Synced · 2m ago')
  })

  it('counts what is waiting to sync while no cycle runs: "3 to sync", never Synced', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: true, pending: 3 })
    render(<SyncPill />)
    expect(pillText()).toBe('3 to sync')
    expect(pill()).toHaveClass('text-accent')
    expect(pill().querySelector('.animate-spin')).toBeNull()
  })

  it('says Syncing… while a cycle carries the waiting changes', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'syncing', pendingLocal: true, pending: 3 })
    render(<SyncPill />)
    expect(pillText()).toBe('Syncing…')
  })

  it('says Syncing… before the first cycle, when nothing is known to be on the relay', () => {
    useSyncStore.setState({ syncId: 'code', cloudStatus: 'idle', pendingLocal: true, pending: 0 })
    render(<SyncPill />)
    expect(pillText()).toBe('Syncing…')
  })

  it('never says Synced after a failed cycle', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('network', NETWORK),
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync retrying')
    expect(pill()).toHaveAttribute('title', NETWORK)
    expect(pill()).toHaveClass('text-warning')
  })

  it('counts down to the next retry in 5 s steps, rounded up, on the pill only', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('server', SERVER, { since: NOW - MINUTE, retryAt: NOW + 27_000 }),
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync retrying · 30 s')
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(pillText()).toBe('Sync retrying · 25 s')
    // The live region never ticks.
    expect(announced()).toBe(`Sync retrying. ${SERVER}`)
    act(() => {
      vi.advanceTimersByTime(25_000)
    })
    expect(pillText()).toBe('Sync retrying')
  })

  it('treats busy (6 crossing attempts) like any retry', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('busy', BUSY, { retryAt: NOW + 8_000 }),
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync retrying · 10 s')
    expect(pill()).toHaveClass('text-warning')
  })

  it('keeps showing the failure during the retry cycle', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'syncing',
      lastError: failure('server', SERVER, { since: NOW - MINUTE }),
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync retrying')
  })

  it('says since when after 10 minutes of failures, and turns red then', () => {
    const since = NOW - 10 * MINUTE
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('server', SERVER, { since }),
    })
    render(<SyncPill />)
    expect(pillText()).toBe(`Sync failing since ${clockTime(since)}`)
    expect(clockTime(since)).toMatch(/^\d\d:\d\d$/)
    expect(pill()).toHaveClass('text-negative')
  })

  it('turns from amber to red on its own when the retries reach 10 minutes', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('network', NETWORK, { since: NOW - 9 * MINUTE }),
    })
    render(<SyncPill />)
    expect(pill()).toHaveClass('text-warning')
    act(() => {
      vi.advanceTimersByTime(MINUTE)
    })
    expect(pill()).toHaveClass('text-negative')
    expect(pillText()).toMatch(/^Sync failing since /)
  })

  it('shows refused access in red from the first failure, in words that ask for action', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('permission', REFUSED),
    })
    render(<SyncPill />)
    // Red means "needs you"; "retrying" would say "wait it out".
    expect(pillText()).toBe('Sync refused')
    expect(pill()).toHaveClass('text-negative')
    expect(pill()).toHaveAttribute('title', REFUSED)
    expect(announced()).toBe(`Sync refused. ${REFUSED}`)
  })

  it.each([
    ['too-large', 'Sync paused · too large', TOO_LARGE, 'text-negative'],
    ['denied', 'Sync paused · refused', DENIED, 'text-negative'],
    ['not-found', 'Sync paused · code not found', NOT_FOUND, 'text-negative'],
    ['moved', 'Sync paused · reload to update', MOVED, 'text-warning'],
    ['update-required', 'Sync paused · reload to update', MOVED, 'text-warning'],
    [
      'reload',
      'Sync paused · reload to update',
      'Sync couldn’t start on this page.',
      'text-warning',
    ],
  ] as const)('shows the %s pause as "%s"', (kind, label, message, colour) => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'paused',
      lastError: failure(kind, message),
    })
    render(<SyncPill />)
    expect(pillText()).toBe(label)
    expect(pill()).toHaveClass(colour)
    // Said once: the label already says "Sync paused", so the detail drops its own prefix.
    const detail = message.replace(/^Sync paused: (.)/, (_m, c: string) => c.toUpperCase())
    expect(pill()).toHaveAttribute('title', detail)
    expect(announced()).toBe(`${label}. ${detail}`)
    expect(announced().match(/Sync paused/g)).toHaveLength(1)
  })

  it('shows the pause of a sync set up by a newer SpendTrack, which has no code here', () => {
    useSyncStore.setState({
      syncId: null,
      cloudStatus: 'paused',
      lastError: failure(
        'update-required',
        'Sync on this device was set up by a newer SpendTrack.',
      ),
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync paused · reload to update')
  })

  it('shows offline, and how much waits to sync', () => {
    useExpenseStore.setState({ isOffline: true })
    useSyncStore.setState({ ...connected, cloudStatus: 'offline', pendingLocal: false, pending: 0 })
    const { unmount } = render(<SyncPill />)
    expect(pillText()).toBe('Offline')
    unmount()
    useSyncStore.setState({ pendingLocal: true, pending: 3 })
    render(<SyncPill />)
    expect(pillText()).toBe('Offline · 3 to sync')
    expect(announced()).toBe('Offline')
  })

  it('never counts sync changes offline when sync is off', () => {
    useExpenseStore.setState({ isOffline: true })
    useSyncStore.setState({ syncId: null, cloudStatus: 'off', pending: 2 })
    render(<SyncPill />)
    expect(pillText()).toBe('Offline')
  })

  it('tells the owner how many changes wait for an older device, in few words', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', waitingForOld: 3 })
    render(<SyncPill />)
    // Short: the pill shares the top bar with quick add. The tooltip has the whole story.
    expect(pillText()).toBe('Update other device')
    expect(pill()).toHaveAttribute(
      'title',
      '3 changes wait for your other device to update. Everything is saved here.',
    )
    expect(announced()).toBe(`Update other device. ${OLD_DEVICE_WAITING}`)
  })

  it('speaks of one waiting change in the singular', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', waitingForOld: 1 })
    render(<SyncPill />)
    expect(pill()).toHaveAttribute(
      'title',
      '1 change waits for your other device to update. Everything is saved here.',
    )
  })

  it('shows the other device, not a spinner, when the held-back change is all that is pending', () => {
    // The last cycle held the push back and nothing changed here since: no push is due.
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'synced',
      pendingLocal: true,
      pending: 1,
      waitingForOld: 1,
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Update other device')
    expect(pill().querySelector('.animate-spin')).toBeNull()
  })

  it.each([
    [
      'warn',
      { cloudStatus: 'error' as const, lastError: failure('network', NETWORK) },
      '[[data-theme=light]_&]:text-[#92400e]',
    ],
    ['saved', { cloudStatus: 'synced' as const }, '[[data-theme=light]_&]:text-[#166534]'],
  ])('darkens the %s text in the light theme to AA contrast', (_tone, state, light) => {
    // amber-700 and green-700 on the tinted pill measured under 4.5:1; the 800s clear it.
    useSyncStore.setState({ ...connected, ...state })
    render(<SyncPill />)
    expect(pill()).toHaveClass(light)
  })

  it('caps its width, so a long label cannot squeeze quick add', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced' })
    render(<SyncPill />)
    expect(pill()).toHaveClass('max-w-52')
    expect(pill().querySelector('span')).toHaveClass('truncate')
  })

  it('puts a failed local save above everything', () => {
    useExpenseStore.setState({ syncStatus: 'error', local: 'error-quota' })
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'paused',
      lastError: failure('moved', MOVED),
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Not saved')
    expect(pill()).toHaveAttribute('title', 'Storage on this device is full.')
  })

  // walk4: the boot-failure card on screen, and "✓ Saved" beside it in the top bar.
  it('never says Saved when the data engine could not load', () => {
    useExpenseStore.setState({ bootError: 'engine-load', syncStatus: 'idle' })
    useSyncStore.setState({ ...connected, cloudStatus: 'synced' })
    render(<SyncPill />)
    expect(pillText()).toBe('Not loaded')
    expect(pill()).toHaveAttribute(
      'title',
      "SpendTrack couldn't start. Your data is still saved on this device.",
    )
    // the card in place of the screen says it already: the pill is not a second voice
    expect(announced()).toBe('')
  })

  it('says why nothing is saved for each local failure', () => {
    const reasons: readonly (readonly [LocalStatus, string])[] = [
      ['error-quota', 'Storage on this device is full.'],
      ['error-storage', 'This browser is blocking storage.'],
      ['memory-only', "Saved data couldn't be read, so nothing is written over it."],
    ]
    for (const [local, reason] of reasons) {
      useExpenseStore.setState({ syncStatus: 'error', local })
      render(<SyncPill />)
      expect(pillText()).toBe('Not saved')
      expect(pill()).toHaveAttribute('title', reason)
      cleanup()
    }
  })

  it('shows saving before a pending sync', () => {
    useExpenseStore.setState({ syncStatus: 'saving' })
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: true, pending: 1 })
    render(<SyncPill />)
    expect(pillText()).toBe('Saving…')
  })
})

describe('SyncPill as a button (AC-U1)', () => {
  const problems = [
    ['retrying', { cloudStatus: 'error' as const, lastError: failure('network', NETWORK) }],
    ['refused', { cloudStatus: 'error' as const, lastError: failure('permission', REFUSED) }],
    [
      'failing',
      { cloudStatus: 'error' as const, lastError: failure('server', SERVER, { since: 0 }) },
    ],
    ['paused', { cloudStatus: 'paused' as const, lastError: failure('not-found', NOT_FOUND) }],
    ['waiting for an old device', { cloudStatus: 'synced' as const, waitingForOld: 2 }],
  ] as const

  it.each(problems)('is a button that opens Settings › Sync when %s', (_what, state) => {
    useSyncStore.setState({ ...connected, ...state })
    render(<SyncPill />)
    const button = screen.getByRole('button')
    expect(button).toBe(pill())
    expect(button.getAttribute('aria-label')).toMatch(/\. Opens Settings, Sync\.$/)
    expect(button.getAttribute('aria-label')).toContain(
      pillText()
        .replace(/ · \d+ s$/, '')
        .trim(),
    )
    fireEvent.click(button)
    // Sync now takes focus as the panel mounts (one Tab from the problem, not five)
    expect(useUIStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsTab: 'sync',
      settingsFocus: 'sync-now',
    })
  })

  it('opens the view of a sync a newer SpendTrack set up as it is (it has no Sync now)', () => {
    useSyncStore.setState({
      syncId: null,
      cloudStatus: 'paused',
      lastError: failure(
        'update-required',
        'Sync on this device was set up by a newer SpendTrack.',
      ),
    })
    render(<SyncPill />)
    fireEvent.click(screen.getByRole('button'))
    expect(useUIStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsTab: 'sync',
      settingsFocus: null,
    })
  })

  it.each([
    ['synced', { cloudStatus: 'synced' as const }],
    ['syncing', { cloudStatus: 'syncing' as const, pendingLocal: true, pending: 1 }],
    ['to sync', { cloudStatus: 'synced' as const, pendingLocal: true, pending: 2 }],
    ['offline', { cloudStatus: 'offline' as const, lastError: failure('offline', 'Offline.') }],
  ] as const)('is not interactive while %s (no target, aria-hidden)', (_what, state) => {
    useSyncStore.setState({ ...connected, ...state })
    render(<SyncPill />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(pill()).toHaveAttribute('aria-hidden', 'true')
  })

  it('never puts a focus stop below 1280 px: the pill is display:none there, the region stays', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: failure('network', NETWORK),
    })
    render(<SyncPill />)
    // Tailwind: `hidden` below xl, `inline-flex` from 1280 px. The live region holds text only.
    expect(pill()).toHaveClass('hidden', 'xl:inline-flex')
    const region = screen.getByRole('status')
    expect(region).toHaveClass('sr-only')
    expect(region.querySelector('button, a, [tabindex]')).toBeNull()
    expect(document.querySelectorAll('button')).toHaveLength(1)
  })

  it('keys each pause by its reason, so a new reason replays the entrance and is said', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'paused',
      lastError: failure('moved', MOVED),
    })
    render(<SyncPill />)
    const first = pill()
    act(() => useSyncStore.setState({ lastError: failure('too-large', TOO_LARGE) }))
    expect(pill()).not.toBe(first)
    expect(announced()).toMatch(/^Sync paused · too large\. /)
  })
})

describe('SyncPill announcements', () => {
  it('leaves a failed save to its strip (one voice), then says the save that ends it', () => {
    useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: NOW, local: 'saved' })
    render(<SyncPill />)
    act(() => useExpenseStore.setState({ syncStatus: 'error', local: 'error-quota' }))
    expect(pillText()).toBe('Not saved')
    expect(announced()).toBe('')
    act(() => useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: NOW, local: 'saved' }))
    expect(announced()).toBe('Saved')
  })

  it('announces nothing while all is well: no saving, no counts, no syncing, no clock', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false, pending: 0 })
    render(<SyncPill />)
    const region = screen.getByRole('status')
    expect(announced()).toBe('')
    act(() => useExpenseStore.setState({ syncStatus: 'saving' }))
    expect(pillText()).toBe('Saving…')
    act(() => useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: NOW }))
    act(() => useSyncStore.setState({ pendingLocal: true, pending: 1 }))
    expect(pillText()).toBe('1 to sync')
    act(() => useSyncStore.setState({ cloudStatus: 'syncing' }))
    expect(pillText()).toBe('Syncing…')
    act(() => useSyncStore.setState({ cloudStatus: 'synced', pendingLocal: false, pending: 0 }))
    act(() => useSyncStore.setState({ lastSyncAt: NOW }))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(pillText()).toBe('Synced · 1m ago') // the visible time moves on
    expect(screen.getByRole('status')).toBe(region)
    expect(announced()).toBe('')
  })

  it('announces a failure, then the recovery once settled, through one live region', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const region = screen.getByRole('status')
    act(() =>
      useSyncStore.setState({ cloudStatus: 'error', lastError: failure('network', NETWORK) }),
    )
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent(`Sync retrying. ${NETWORK}`)
    // The retry succeeds with a change still on its way: not yet a recovery to announce.
    act(() =>
      useSyncStore.setState({
        cloudStatus: 'synced',
        lastError: null,
        pendingLocal: true,
        pending: 1,
      }),
    )
    expect(pillText()).toBe('1 to sync')
    expect(region).toHaveTextContent('Sync retrying')
    act(() => useSyncStore.setState({ pendingLocal: false, pending: 0 }))
    expect(screen.getByRole('status')).toBe(region)
    expect(announced()).toBe('Synced')
  })

  it('says offline once, however the count changes', async () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const region = screen.getByRole('status')
    const changes: string[] = []
    const observer = new MutationObserver(() => changes.push(region.textContent))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    // Each step lets the observer report before the next one.
    await act(async () => {
      useExpenseStore.setState({ isOffline: true })
      await Promise.resolve()
    })
    await act(async () => {
      useSyncStore.setState({ pendingLocal: true, pending: 1 })
      await Promise.resolve()
    })
    await act(async () => {
      useSyncStore.setState({ pending: 2 })
      await Promise.resolve()
    })
    observer.disconnect()
    expect(pillText()).toBe('Offline · 2 to sync')
    expect(changes).toEqual(['Offline'])
  })

  it('stays silent while Settings is open on Sync, whose banners and toasts speak for it', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    render(<SyncPill />)
    const network = failure('network', NETWORK)
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: network }))
    expect(pillText()).toBe('Sync retrying') // still shown, not announced
    expect(announced()).toBe('')
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null }))
    expect(announced()).toBe('')

    // Closed again: nothing it followed is announced late; the next problem is, and so is its
    // recovery.
    act(() => useUIStore.setState({ settingsOpen: false }))
    expect(announced()).toBe('')
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: network }))
    expect(announced()).toBe(`Sync retrying. ${NETWORK}`)
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null }))
    expect(announced()).toBe('Synced')
  })

  it('a failure that began while the panel was open still gets its recovery announced', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    render(<SyncPill />)
    act(() =>
      useSyncStore.setState({ cloudStatus: 'error', lastError: failure('network', NETWORK) }),
    )
    act(() => useUIStore.setState({ settingsOpen: false }))
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null }))
    expect(announced()).toBe('Synced')
  })

  // Measured at 1280 px: the region said "Synced" while the pill read "Sync retrying", for good.
  it('never keeps a claim made before the panel opened: a failure meanwhile is said on close', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    act(() => useExpenseStore.setState({ isOffline: true }))
    expect(announced()).toBe('Offline')
    act(() => useExpenseStore.setState({ isOffline: false }))
    expect(announced()).toBe('Synced')

    act(() => useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' }))
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: failure('server', SERVER) }))
    expect(pillText()).toBe('Sync retrying')
    expect(announced()).toBe('') // the panel speaks; the region holds nothing untrue
    act(() => useUIStore.setState({ settingsOpen: false }))
    expect(announced()).toBe(`Sync retrying. ${SERVER}`)
    act(() => {
      vi.advanceTimersByTime(16_000)
    })
    expect(announced()).toBe(`Sync retrying. ${SERVER}`)
  })

  it('never keeps a problem that recovered while the panel was open', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: failure('server', SERVER) }))
    expect(announced()).toBe(`Sync retrying. ${SERVER}`)
    act(() => useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' }))
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null, lastSyncAt: NOW }))
    expect(pillText()).toBe('Synced · just now')
    expect(announced()).toBe('')
    act(() => useUIStore.setState({ settingsOpen: false }))
    expect(announced()).toBe('')
  })

  it('opening and closing the panel with nothing changed says nothing again', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: failure('server', SERVER) }))
    const region = screen.getByRole('status')
    const changes: string[] = []
    const observer = new MutationObserver(() => changes.push(region.textContent))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    act(() => useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' }))
    act(() => useUIStore.setState({ settingsOpen: false }))
    observer.disconnect()
    expect(changes).toEqual([])
    expect(announced()).toBe(`Sync retrying. ${SERVER}`)
  })

  // At 1280 px the engine's once-per-session pause toast and the pill said nearly the same
  // sentence one after the other.
  it('leaves a pause to the toast already saying it, and still announces the recovery', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    act(() => {
      useUIStore.getState().pushToast({ kind: 'error', message: TOO_LARGE, duration: 12_000 })
      useSyncStore.setState({ cloudStatus: 'paused', lastError: failure('too-large', TOO_LARGE) })
    })
    expect(pillText()).toBe('Sync paused · too large')
    expect(announced()).toBe('')
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null }))
    expect(announced()).toBe('Synced')
  })

  it('announces a pause itself when no toast says it (the once-per-session toast is spent)', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    act(() =>
      useSyncStore.setState({ cloudStatus: 'paused', lastError: failure('too-large', TOO_LARGE) }),
    )
    expect(announced()).toBe(
      "Sync paused · too large. Your data (1228 KB) is too large for the sync server. It's still saved here — export a backup.",
    )
  })

  it('speaks while Settings is open on another tab (no sync banner there)', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    useUIStore.setState({ settingsOpen: true, settingsTab: 'categories' })
    render(<SyncPill />)
    act(() =>
      useSyncStore.setState({ cloudStatus: 'error', lastError: failure('network', NETWORK) }),
    )
    expect(announced()).toBe(`Sync retrying. ${NETWORK}`)
  })
})
