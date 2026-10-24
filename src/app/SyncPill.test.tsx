import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { SyncPill } from './SyncPill'
import { useExpenseStore } from '../stores/useExpenseStore'
import { useUIStore } from '../stores/useUIStore'
import {
  OLD_DEVICE_WAITING,
  clockTime,
  pausedDetail,
  syncMessage,
  useSyncStore,
} from '../stores/useSyncStore'

// A build with sync configured; no request is made here, the stores are set directly.
vi.mock('../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/syncConfig')>()),
  syncEnabled: true,
}))

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000

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

/** The pill as seen. Screen readers skip it and hear the live region instead. */
function pill(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[aria-hidden="true"]')
  if (!element) throw new Error('No visible pill')
  return element
}

const pillText = (): string => pill().textContent

/** What the live region says. */
const announced = (): string => screen.getByRole('status').textContent

const connected = { syncId: 'code', lastSyncAt: NOW - 2 * MINUTE }

describe('SyncPill', () => {
  it('shows the local save state when sync is off', () => {
    useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: NOW - 30_000 })
    render(<SyncPill />)
    expect(pillText()).toBe('Saved · 30s ago')
  })

  it('says Synced only when the last cycle succeeded and nothing is pending', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    expect(pillText()).toBe('Synced · 2m ago')
  })

  it('keeps Synced through a background check with nothing pending (no flicker)', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'syncing', pendingLocal: false })
    render(<SyncPill />)
    expect(pillText()).toBe('Synced · 2m ago')
  })

  it('never says Synced while a local change is pending', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: true })
    render(<SyncPill />)
    expect(pillText()).toBe('Syncing…')
  })

  it('never says Synced after a failed cycle', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: { kind: 'network', message: syncMessage('network'), since: NOW - MINUTE },
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync retrying')
    expect(pill()).toHaveAttribute('title', syncMessage('network'))
    expect(pill()).toHaveClass('text-warning')
  })

  it('keeps showing the failure during the retry cycle', () => {
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'syncing',
      lastError: { kind: 'server', message: syncMessage('server'), since: NOW - MINUTE },
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync retrying')
  })

  it('says since when after 10 minutes of failures, and turns red then', () => {
    const since = NOW - 10 * MINUTE
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: { kind: 'server', message: syncMessage('server'), since },
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
      lastError: { kind: 'network', message: syncMessage('network'), since: NOW - 9 * MINUTE },
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
      lastError: { kind: 'permission', message: syncMessage('permission'), since: NOW },
    })
    render(<SyncPill />)
    // Red means "needs you"; "retrying" would say "wait it out".
    expect(pillText()).toBe('Sync refused')
    expect(pill()).toHaveClass('text-negative')
    expect(pill()).toHaveAttribute('title', syncMessage('permission'))
    expect(announced()).toBe(`Sync refused. ${syncMessage('permission')}`)
  })

  it.each([
    ['too-large', 'text-negative'],
    ['moved', 'text-warning'],
    ['update-required', 'text-warning'],
    ['reload', 'text-warning'],
  ] as const)('shows %s as paused, coloured %s as in Settings › Sync', (kind, colour) => {
    const message = syncMessage(kind, 1200)
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'paused',
      lastError: { kind, message, since: NOW },
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync paused')
    // Said once: the label already says "Sync paused".
    expect(pill()).toHaveAttribute('title', pausedDetail(message))
    expect(pill()).toHaveClass(colour)
    expect(announced()).toBe(`Sync paused. ${pausedDetail(message)}`)
    expect(announced().match(/Sync paused/g)).toHaveLength(1)
  })

  it('shows offline, and whether anything is waiting to sync', () => {
    useExpenseStore.setState({ isOffline: true })
    useSyncStore.setState({ ...connected, cloudStatus: 'offline', pendingLocal: false })
    const { unmount } = render(<SyncPill />)
    expect(pillText()).toBe('Offline')
    unmount()
    useSyncStore.setState({ pendingLocal: true })
    render(<SyncPill />)
    expect(pillText()).toBe('Offline · not synced')
  })

  it('tells the owner when an older device keeps overwriting the relay, in few words', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', waitingForOld: true })
    render(<SyncPill />)
    // Short: the pill shares the top bar with quick add. The tooltip has the whole story.
    expect(pillText()).toBe('Update old device')
    expect(pill()).toHaveAttribute('title', OLD_DEVICE_WAITING)
    expect(announced()).toBe(`Update old device. ${OLD_DEVICE_WAITING}`)
  })

  it('shows the old device, not a spinner, when the held-back change is all that is pending', () => {
    // The last cycle held the push back and nothing changed here since: no push is due.
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'synced',
      pendingLocal: true,
      waitingForOld: true,
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Update old device')
    expect(pill().querySelector('.animate-spin')).toBeNull()
  })

  it.each([
    [
      'warn',
      {
        cloudStatus: 'error' as const,
        lastError: { kind: 'network' as const, message: syncMessage('network'), since: NOW },
      },
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
    useExpenseStore.setState({ syncStatus: 'error' })
    useSyncStore.setState({ ...connected, cloudStatus: 'synced' })
    render(<SyncPill />)
    expect(pillText()).toBe('Save failed')
  })

  it('shows saving before a pending sync', () => {
    useExpenseStore.setState({ syncStatus: 'saving' })
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: true })
    render(<SyncPill />)
    expect(pillText()).toBe('Saving…')
  })

  it('announces nothing while all is well: no saving, no syncing, no clock', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const region = screen.getByRole('status')
    expect(announced()).toBe('')
    act(() => useExpenseStore.setState({ syncStatus: 'saving' }))
    expect(pillText()).toBe('Saving…')
    act(() => useExpenseStore.setState({ syncStatus: 'saved', lastSavedAt: NOW }))
    act(() => useSyncStore.setState({ pendingLocal: true }))
    expect(pillText()).toBe('Syncing…')
    act(() => useSyncStore.setState({ pendingLocal: false, lastSyncAt: NOW }))
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
      useSyncStore.setState({
        cloudStatus: 'error',
        lastError: { kind: 'network', message: syncMessage('network'), since: NOW },
      }),
    )
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent(`Sync retrying. ${syncMessage('network')}`)
    // The retry succeeds with a change still on its way: not yet a recovery to announce.
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null, pendingLocal: true }))
    expect(pillText()).toBe('Syncing…')
    expect(region).toHaveTextContent('Sync retrying')
    act(() => useSyncStore.setState({ pendingLocal: false }))
    expect(screen.getByRole('status')).toBe(region)
    expect(announced()).toBe('Synced')
  })

  it('stays silent while Settings is open on Sync, whose banners and toasts speak for it', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    render(<SyncPill />)
    const network = { kind: 'network' as const, message: syncMessage('network'), since: NOW }
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
    expect(announced()).toBe(`Sync retrying. ${syncMessage('network')}`)
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null }))
    expect(announced()).toBe('Synced')
  })

  it('a failure that began while the panel was open still gets its recovery announced', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    render(<SyncPill />)
    const network = { kind: 'network' as const, message: syncMessage('network'), since: NOW }
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: network }))
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
    const server = { kind: 'server' as const, message: syncMessage('server'), since: NOW }
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: server }))
    expect(pillText()).toBe('Sync retrying')
    expect(announced()).toBe('') // the panel speaks; the region holds nothing untrue
    act(() => useUIStore.setState({ settingsOpen: false }))
    expect(announced()).toBe(`Sync retrying. ${syncMessage('server')}`)
    act(() => {
      vi.advanceTimersByTime(16_000)
    })
    expect(announced()).toBe(`Sync retrying. ${syncMessage('server')}`)
  })

  it('never keeps a problem that recovered while the panel was open', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const server = { kind: 'server' as const, message: syncMessage('server'), since: NOW }
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: server }))
    expect(announced()).toBe(`Sync retrying. ${syncMessage('server')}`)
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
    const server = { kind: 'server' as const, message: syncMessage('server'), since: NOW }
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: server }))
    const region = screen.getByRole('status')
    const changes: string[] = []
    const observer = new MutationObserver(() => changes.push(region.textContent))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    act(() => useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' }))
    act(() => useUIStore.setState({ settingsOpen: false }))
    observer.disconnect()
    expect(changes).toEqual([])
    expect(announced()).toBe(`Sync retrying. ${syncMessage('server')}`)
  })

  // At 1280 px the engine's once-per-session pause toast and the pill said nearly the same
  // sentence one after the other.
  it('leaves a pause to the toast already saying it, and still announces the recovery', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const message = syncMessage('too-large', 1228)
    act(() => {
      useUIStore.getState().pushToast({ kind: 'error', message, duration: 12_000 })
      useSyncStore.setState({
        cloudStatus: 'paused',
        lastError: { kind: 'too-large', message, since: NOW },
      })
    })
    expect(pillText()).toBe('Sync paused')
    expect(announced()).toBe('')
    act(() => useSyncStore.setState({ cloudStatus: 'synced', lastError: null }))
    expect(announced()).toBe('Synced')
  })

  it('announces a pause itself when no toast says it (the once-per-session toast is spent)', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const message = syncMessage('too-large', 1228)
    act(() =>
      useSyncStore.setState({
        cloudStatus: 'paused',
        lastError: { kind: 'too-large', message, since: NOW },
      }),
    )
    expect(announced()).toBe(`Sync paused. ${pausedDetail(message)}`)
  })

  it('speaks while Settings is open on another tab (no sync banner there)', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    useUIStore.setState({ settingsOpen: true, settingsTab: 'categories' })
    render(<SyncPill />)
    act(() =>
      useSyncStore.setState({
        cloudStatus: 'error',
        lastError: { kind: 'network', message: syncMessage('network'), since: NOW },
      }),
    )
    expect(announced()).toBe(`Sync retrying. ${syncMessage('network')}`)
  })
})
