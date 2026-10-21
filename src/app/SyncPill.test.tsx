import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { SyncPill } from './SyncPill'
import { useExpenseStore } from '../stores/useExpenseStore'
import { OLD_DEVICE_WAITING, clockTime, syncMessage, useSyncStore } from '../stores/useSyncStore'

// A build with sync configured; no request is made here, the stores are set directly.
vi.mock('../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/syncConfig')>()),
  syncEnabled: true,
}))

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
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

  it('says since when after 10 minutes of failures', () => {
    const since = NOW - 10 * MINUTE
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'error',
      lastError: { kind: 'server', message: syncMessage('server'), since },
    })
    render(<SyncPill />)
    expect(pillText()).toBe(`Sync failing since ${clockTime(since)}`)
    expect(clockTime(since)).toMatch(/^\d\d:\d\d$/)
  })

  it.each([
    ['too-large', 'text-negative'],
    ['moved', 'text-warning'],
    ['update-required', 'text-warning'],
  ] as const)('shows %s as paused, coloured %s as in Settings › Sync', (kind, colour) => {
    const message = syncMessage(kind, 1200)
    useSyncStore.setState({
      ...connected,
      cloudStatus: 'paused',
      lastError: { kind, message, since: NOW },
    })
    render(<SyncPill />)
    expect(pillText()).toBe('Sync paused')
    expect(pill()).toHaveAttribute('title', message)
    expect(pill()).toHaveClass(colour)
    expect(announced()).toBe(`Sync paused. ${message}`)
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

  it('keeps the clock out of the live region: an idle minute announces nothing', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const region = screen.getByRole('status')
    expect(announced()).toBe('Synced')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(pillText()).toBe('Synced · 3m ago') // the visible time moves on
    expect(screen.getByRole('status')).toBe(region)
    expect(announced()).toBe('Synced')
  })

  it('keeps one live region across state changes, so each new label is announced', () => {
    useSyncStore.setState({ ...connected, cloudStatus: 'synced', pendingLocal: false })
    render(<SyncPill />)
    const region = screen.getByRole('status')
    act(() => useSyncStore.setState({ pendingLocal: true }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent('Syncing…')
    act(() =>
      useSyncStore.setState({
        cloudStatus: 'error',
        lastError: { kind: 'network', message: syncMessage('network'), since: NOW },
      }),
    )
    expect(screen.getByRole('status')).toBe(region)
    expect(region).toHaveTextContent('Sync retrying')
  })
})
