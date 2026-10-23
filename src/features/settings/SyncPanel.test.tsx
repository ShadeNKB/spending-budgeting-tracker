import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SyncPanel } from './SyncPanel'
import {
  OLD_DEVICE_WAITING,
  clockTime,
  failingSinceMessage,
  syncMessage,
  useSyncStore,
  type SyncFailure,
  type SyncResult,
} from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'

// A build with sync configured; the store's actions are replaced per test, so no request is made.
vi.mock('../../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/syncConfig')>()),
  syncEnabled: true,
}))

const CODE = '11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const TEN_MINUTES = 10 * 60_000
const OK: SyncResult = { ok: true, pushed: true, changedLocal: false }
const NETWORK: SyncResult = { ok: false, error: 'network', message: syncMessage('network') }
const OFF: SyncResult = { ok: false, error: 'off', message: syncMessage('off') }
const failed = (error: Exclude<SyncFailure['kind'], 'too-large'>): SyncResult => ({
  ok: false,
  error,
  message: syncMessage(error),
})
const failure = (kind: SyncFailure['kind']): SyncFailure => ({
  kind,
  message: syncMessage(kind, 1365),
  since: NOW,
})
/** The status row: the Sync now button is described by it. */
function statusRow(): HTMLElement {
  const button = screen.getByRole('button', { name: 'Sync now' })
  const row = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  if (!row) throw new Error('Sync now is not described by the status row')
  return row
}

const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const toasts = () => useUIStore.getState().toasts.map((t) => [t.kind, t.message])

function connectedPanel(state: Partial<ReturnType<typeof useSyncStore.getState>> = {}) {
  useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW, ...state })
  return render(<SyncPanel />)
}

describe('Sync now', () => {
  it('shows Synced only for an ok result', async () => {
    const triggerSync = vi.fn(() => Promise.resolve(OK))
    connectedPanel({ triggerSync })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(triggerSync).toHaveBeenCalledWith({ resetBackoff: true })
    expect(toasts()).toEqual([['success', 'Synced']])
  })

  it.each([
    [false, []],
    [true, [['info', OLD_DEVICE_WAITING]]],
  ])(
    'does not say Synced when the push was held back for an old device (banner up before: %s)',
    async (before, expected) => {
      connectedPanel({
        waitingForOld: before,
        triggerSync: () => {
          useSyncStore.setState({ waitingForOld: true })
          return Promise.resolve({ ok: true, pushed: false, changedLocal: false })
        },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
        await Promise.resolve()
      })
      // A banner that goes up says it (its region announces it); one already up does not, so
      // then the toast answers the tap. Never both, never Synced.
      expect(screen.getByText(OLD_DEVICE_WAITING)).toBeInTheDocument()
      expect(toasts()).toEqual(expected)
    },
  )

  it('says one failure once: the banner as it appears, a toast only when the banner was up', async () => {
    const network = failure('network')
    const failNow = () => {
      useSyncStore.setState({ cloudStatus: 'error', lastError: network })
      return Promise.resolve(NETWORK)
    }
    connectedPanel({ triggerSync: failNow })
    expect(screen.queryByText(syncMessage('network'))).toBeNull() // no banner yet
    const said: string[] = []
    const watch = new MutationObserver(() => {
      const text = document.querySelector('[role="status"]')?.textContent ?? ''
      if (text !== said.at(-1)) said.push(text)
    })
    const banners = document.querySelector('[role="status"]')
    if (!banners) throw new Error('no banner region')
    watch.observe(banners, { subtree: true, childList: true, characterData: true })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(said).toEqual([syncMessage('network')]) // the banner region, once
    expect(toasts()).toEqual([]) // and no toast saying it again

    // The same failure again: nothing changes on screen, so the toast answers the tap.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    watch.disconnect()
    expect(said).toEqual([syncMessage('network')])
    expect(toasts()).toEqual([['warning', syncMessage('network')]])
  })

  it('shows the failure, never Synced, for ok:false', async () => {
    connectedPanel({ triggerSync: () => Promise.resolve(NETWORK) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([['warning', syncMessage('network')]])
  })

  it('is busy only while its own request runs, keeps focus, and has a 44 px target on phones', async () => {
    let finish: (r: SyncResult) => void = () => undefined
    const pending = new Promise<SyncResult>((resolve) => (finish = resolve))
    const triggerSync = vi.fn(() => pending)
    connectedPanel({ cloudStatus: 'syncing', triggerSync })
    const button = screen.getByRole('button', { name: 'Sync now' })
    expect(button).toHaveAttribute('aria-disabled', 'false') // a background cycle does not block it
    expect(button).toHaveClass('h-11', 'w-11', 'md:h-8', 'md:w-8')
    button.focus()
    fireEvent.click(button)
    // aria-disabled, not disabled: a keyboard user's focus stays on the button.
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toBeEnabled()
    expect(button).toHaveFocus()
    fireEvent.click(button) // a second tap while it runs does nothing
    expect(triggerSync).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(OK)
      await pending
    })
    expect(button).toHaveAttribute('aria-disabled', 'false')
    expect(button).toHaveFocus()
  })

  it('reads Syncing… while its own request runs, even over a fresh Synced', async () => {
    let finish: (r: SyncResult) => void = () => undefined
    const pending = new Promise<SyncResult>((resolve) => (finish = resolve))
    connectedPanel({ lastSyncAt: NOW - 9000, triggerSync: () => pending })
    expect(statusRow()).toHaveTextContent('Synced · 9s ago')
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
    expect(statusRow()).toHaveTextContent('Syncing…')
    await act(async () => {
      finish(OK)
      await pending
    })
  })

  // One severity everywhere: amber while a retried failure is young, red once it has failed
  // for 10 minutes, red for refused access.
  it.each([
    ['offline', 'warning'],
    ['moved', 'warning'],
    ['update-required', 'warning'],
    ['network', 'warning'],
    ['server', 'warning'],
    ['invalid', 'warning'],
    ['permission', 'error'],
  ] as const)('reports a fresh %s failure in its own colour (%s)', async (kind, tone) => {
    connectedPanel({ triggerSync: () => Promise.resolve(failed(kind)) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([[tone, syncMessage(kind)]])
  })

  it('reports a failure that has lasted 10 minutes in red', async () => {
    connectedPanel({
      cloudStatus: 'error',
      lastError: { ...failure('network'), since: NOW - TEN_MINUTES },
      triggerSync: () => Promise.resolve(failed('network')),
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([['error', syncMessage('network')]])
  })

  it('says nothing when sync was switched off while it ran', async () => {
    connectedPanel({ triggerSync: () => Promise.resolve(OFF) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([])
  })
})

describe('Connect and Generate', () => {
  async function connectWith(result: SyncResult) {
    const setupSync = vi.fn(() => Promise.resolve(result))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    const input = screen.getByPlaceholderText('Paste sync code from another device')
    fireEvent.change(input, { target: { value: CODE } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
      await Promise.resolve()
    })
    expect(setupSync).toHaveBeenCalledWith(CODE)
    return input
  }

  it('Connect with ok says connected and clears the input', async () => {
    const input = await connectWith(OK)
    expect(toasts()).toEqual([['success', 'Connected — data synced']])
    expect(input).toHaveValue('')
  })

  it.each(['Connect', 'Generate'] as const)(
    '%s says the old device holds the relay when the first push was held back',
    async (action) => {
      useSyncStore.setState({
        setupSync: () => {
          useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', waitingForOld: true })
          return Promise.resolve({ ok: true, pushed: false, changedLocal: false })
        },
      })
      render(<SyncPanel />)
      if (action === 'Connect') {
        fireEvent.change(screen.getByPlaceholderText('Paste sync code from another device'), {
          target: { value: CODE },
        })
      }
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: action === 'Connect' ? 'Connect' : /Generate/ }),
        )
        await Promise.resolve()
      })
      expect(toasts()).toEqual([['info', OLD_DEVICE_WAITING]])
    },
  )

  it('Connect with ok:false says so, keeps the code and clears the input', async () => {
    const input = await connectWith(NETWORK)
    expect(toasts()).toEqual([
      ['warning', `Connected, but couldn't sync yet: ${syncMessage('network')}`],
    ])
    expect(input).toHaveValue('')
  })

  it.each([
    [
      'too-large' as const,
      'error',
      "Connected. Sync is paused: Your data (1228 KB) is too large for the sync server. It's still saved here — export a backup.",
    ],
    ['moved' as const, 'warning', `Connected. ${syncMessage('moved')}`],
    ['update-required' as const, 'warning', `Connected. ${syncMessage('update-required')}`],
  ])('Connect into a %s pause promises no sync "yet"', async (error, kind, message) => {
    await connectWith({ ok: false, error, message: syncMessage(error, 1228) })
    expect(toasts()).toEqual([[kind, message]])
  })

  it.each([
    ['too-large' as const, 'error', 'Connected. Sync is paused.'],
    ['moved' as const, 'warning', 'Connected. Sync is paused.'],
    ['network' as const, 'warning', "Connected, but couldn't sync yet."],
  ])(
    'Connect into a %s failure the banner explains: the toast leaves the why to it',
    async (kind, tone, message) => {
      const lastError = failure(kind)
      const setupSync = vi.fn(() => {
        useSyncStore.setState({ syncId: CODE, cloudStatus: 'error', lastError })
        return Promise.resolve({ ok: false, error: kind, message: lastError.message } as const)
      })
      useSyncStore.setState({ setupSync })
      render(<SyncPanel />)
      fireEvent.change(screen.getByPlaceholderText('Paste sync code from another device'), {
        target: { value: CODE },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
        await Promise.resolve()
      })
      expect(toasts()).toEqual([[tone, message]])
      const region = document.querySelector('[role="status"]')
      expect(region?.textContent).toContain(
        kind === 'moved'
          ? syncMessage('moved')
          : kind === 'too-large'
            ? 'too large'
            : lastError.message,
      )
    },
  )

  it('Enter in the code field connects once: its activation never presses Sync now too', async () => {
    const setupSync = vi.fn(() => {
      useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW })
      return Promise.resolve(OK)
    })
    const triggerSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync, triggerSync })
    render(<SyncPanel />)
    const input = screen.getByPlaceholderText('Paste sync code from another device')
    fireEvent.change(input, { target: { value: CODE } })
    let notCancelled = true
    await act(async () => {
      notCancelled = fireEvent.keyDown(input, { key: 'Enter' })
      await Promise.resolve()
    })
    // The default action (keypress, which activates whatever has focus by then) is cancelled.
    expect(notCancelled).toBe(false)
    expect(setupSync).toHaveBeenCalledTimes(1)
    expect(triggerSync).not.toHaveBeenCalled()
    expect(toasts()).toEqual([['success', 'Connected — data synced']])
  })

  it('Generate keeps focus while it sets up (aria-disabled, not disabled), and runs once', async () => {
    let finish: (r: SyncResult) => void = () => undefined
    const pending = new Promise<SyncResult>((resolve) => (finish = resolve))
    const setupSync = vi.fn(() => pending)
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    const generate = screen.getByRole('button', { name: /Generate sync code/ })
    generate.focus()
    fireEvent.click(generate)
    const busy = screen.getByRole('button', { name: /Setting up/ })
    expect(busy).toBe(generate)
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toBeEnabled()
    expect(busy).toHaveFocus()
    fireEvent.click(busy) // a second press while it runs does nothing
    const connect = screen.getByRole('button', { name: 'Connect' })
    fireEvent.change(screen.getByPlaceholderText('Paste sync code from another device'), {
      target: { value: CODE },
    })
    expect(connect).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(connect) // nor does Connect
    expect(setupSync).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish(OK)
      await pending
    })
    expect(generate).toHaveAttribute('aria-disabled', 'false')
  })

  it.each([
    [OK, ['success', 'Sync code generated — enter it on your other device']],
    [
      NETWORK,
      ['warning', `Sync code created, but the first sync didn't finish: ${syncMessage('network')}`],
    ],
    [failed('moved'), ['warning', `Sync code created. ${syncMessage('moved')}`]],
    [
      { ok: false, error: 'too-large', message: syncMessage('too-large', 1228) } as const,
      [
        'error',
        "Sync code created. Sync is paused: Your data (1228 KB) is too large for the sync server. It's still saved here — export a backup.",
      ],
    ],
    [OFF, null],
  ])('Generate reports the first sync honestly (%j)', async (result, toast) => {
    useSyncStore.setState({ setupSync: () => Promise.resolve(result) })
    render(<SyncPanel />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Generate sync code/ }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual(toast ? [toast] : [])
  })

  it('Disconnect during a hung first sync frees the buttons and drops the late result', async () => {
    let finish: (r: SyncResult) => void = () => undefined
    const pending = new Promise<SyncResult>((resolve) => (finish = resolve))
    useSyncStore.setState({
      setupSync: () => {
        useSyncStore.setState({ syncId: CODE, cloudStatus: 'syncing' })
        return pending
      },
      disconnectSync: () => {
        useSyncStore.setState({ syncId: null, cloudStatus: 'off' })
      },
    })
    render(<SyncPanel />)
    fireEvent.click(screen.getByRole('button', { name: /Generate sync code/ }))
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    expect(screen.getByRole('button', { name: /Generate sync code/ })).toBeEnabled()
    fireEvent.change(screen.getByPlaceholderText('Paste sync code from another device'), {
      target: { value: CODE },
    })
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    await act(async () => {
      finish(NETWORK) // the stale request ends at its deadline, ~15 s later
      await pending
    })
    expect(toasts()).toEqual([['info', 'Sync disconnected']])
    expect(screen.getByRole('button', { name: /Generate sync code/ })).toBeEnabled()
  })
})

describe('status row', () => {
  it('ages "Synced · just now" while the panel stays open', () => {
    connectedPanel({ lastSyncAt: NOW })
    expect(statusRow()).toHaveTextContent('Synced · just now')
    act(() => {
      vi.advanceTimersByTime(5 * 60_000)
    })
    expect(statusRow()).toHaveTextContent('Synced · 5m ago')
    act(() => {
      vi.advanceTimersByTime(25 * 60_000)
    })
    expect(statusRow()).toHaveTextContent('Synced · 30m ago')
  })

  it.each([
    [{ cloudStatus: 'idle' as const }, 'Ready'],
    [{ cloudStatus: 'synced' as const, pendingLocal: true }, 'Saved here · syncing soon'],
    [{ cloudStatus: 'synced' as const, lastSyncAt: NOW - 120_000 }, 'Synced · 2m ago'],
    [{ cloudStatus: 'syncing' as const, pendingLocal: true }, 'Syncing…'],
    [{ cloudStatus: 'syncing' as const, lastSyncAt: NOW - 120_000 }, 'Synced · 2m ago'],
    [
      { cloudStatus: 'syncing' as const, pendingLocal: true, lastError: failure('offline') },
      'Syncing…',
    ],
    [
      { cloudStatus: 'synced' as const, waitingForOld: true },
      'Saved here · other device needs update',
    ],
    // Held back with nothing new here: no push is due, so not "syncing soon".
    [
      { cloudStatus: 'synced' as const, pendingLocal: true, waitingForOld: true },
      'Saved here · other device needs update',
    ],
    // The row keeps naming what is wrong; the banner under it says since when.
    [
      {
        cloudStatus: 'error' as const,
        lastError: { ...failure('server'), since: NOW - TEN_MINUTES },
      },
      'Sync server error',
    ],
    [{ cloudStatus: 'offline' as const }, "Offline — will sync when you're back"],
    [{ cloudStatus: 'paused' as const }, 'Sync paused'],
    [
      {
        cloudStatus: 'error' as const,
        lastError: { kind: 'permission' as const, message: syncMessage('permission'), since: NOW },
      },
      'Sync server refused access',
    ],
  ])('%j reads "%s"', (state, label) => {
    connectedPanel(state)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it.each([
    ['network', "Can't reach the sync server"],
    ['server', 'Sync server error'],
    ['permission', 'Sync server refused access'],
    ['invalid', "Couldn't read the synced copy"],
    ['too-large', 'Sync paused'],
    ['moved', 'Sync paused'],
  ] as const)(
    'keeps the %s failure, never an older Synced, while a background retry runs',
    (kind, label) => {
      connectedPanel({ cloudStatus: 'syncing', lastSyncAt: NOW - 9000, lastError: failure(kind) })
      expect(statusRow()).toHaveTextContent(label)
      expect(statusRow()).not.toHaveTextContent('Synced')
    },
  )

  it.each([
    [{ cloudStatus: 'paused' as const, lastError: failure('moved') }, 'text-warning'],
    [{ cloudStatus: 'paused' as const, lastError: failure('too-large') }, 'text-negative'],
    [{ cloudStatus: 'error' as const, lastError: failure('server') }, 'text-warning'],
    [
      {
        cloudStatus: 'error' as const,
        lastError: { ...failure('server'), since: NOW - TEN_MINUTES },
      },
      'text-negative',
    ],
    [{ cloudStatus: 'error' as const, lastError: failure('permission') }, 'text-negative'],
    [{ cloudStatus: 'offline' as const }, 'text-warning'],
    [{ cloudStatus: 'synced' as const, waitingForOld: true }, 'text-[var(--text-secondary)]'],
    [{ cloudStatus: 'synced' as const }, 'text-positive'],
  ])('%j is coloured %s', (state, colour) => {
    connectedPanel(state)
    expect(statusRow()).toHaveClass(colour)
  })
})

describe('banners', () => {
  it('shows a held-back push in neutral grey, as the pill does (cyan means a sync in progress)', () => {
    connectedPanel({ waitingForOld: true })
    const dot = statusRow().previousElementSibling
    expect(dot).toHaveClass('bg-[var(--text-tertiary)]')
    const banner = screen.getByText(OLD_DEVICE_WAITING).closest('div')
    expect(banner).toHaveClass('border-white/[0.1]', 'bg-white/[0.03]')
    expect(`${dot?.className ?? ''} ${banner?.className ?? ''}`).not.toMatch(/accent/)
  })

  it.each(['network', 'server', 'permission', 'invalid'] as const)(
    'explains a %s failure in its own words',
    (kind) => {
      connectedPanel({
        cloudStatus: 'error',
        lastError: { kind, message: syncMessage(kind), since: NOW },
      })
      expect(screen.getByText(syncMessage(kind))).toBeInTheDocument()
    },
  )

  it('turns a retried failure red, and says since when, once it has lasted 10 minutes', () => {
    const since = NOW - 9 * 60_000
    connectedPanel({ cloudStatus: 'error', lastError: { ...failure('network'), since } })
    const banner = () => screen.getByText(syncMessage('network')).closest('div')
    expect(banner()).toHaveClass('text-warning')
    expect(statusRow()).toHaveClass('text-warning')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    const failing = screen.getByText(failingSinceMessage(since))
    expect(failing.closest('div')).toHaveClass('text-negative')
    expect(failingSinceMessage(since)).toBe(
      `Sync has been failing since ${clockTime(since)}. Your changes are saved on this device.`,
    )
    expect(statusRow()).toHaveTextContent("Can't reach the sync server")
    expect(statusRow()).toHaveClass('text-negative')
  })

  it('explains too-large with the size under the row, without repeating "Sync paused"', () => {
    const message = syncMessage('too-large', 1365)
    connectedPanel({ cloudStatus: 'paused', lastError: { kind: 'too-large', message, since: NOW } })
    expect(message).toMatch(/^Sync paused: your data \(1365 KB\)/)
    expect(statusRow()).toHaveTextContent('Sync paused')
    const banners = screen.getByRole('status')
    expect(banners).toHaveTextContent(
      "Your data (1365 KB) is too large for the sync server. It's still saved here — export a backup.",
    )
    expect(banners).not.toHaveTextContent('Sync paused')
  })

  it('Export backup opens Backup and asks for its Download button to take focus', () => {
    const message = syncMessage('too-large', 1365)
    connectedPanel({ cloudStatus: 'paused', lastError: { kind: 'too-large', message, since: NOW } })
    const button = screen.getByRole('button', { name: 'Export backup' })
    expect(button).toHaveClass('h-11', 'md:h-8')
    fireEvent.click(button)
    expect(useUIStore.getState()).toMatchObject({
      settingsTab: 'backup',
      settingsFocus: 'backup-download',
    })
  })

  it('sets banner text at 13 px on phones (11 px from md up)', () => {
    connectedPanel({ cloudStatus: 'error', lastError: failure('server') })
    const banner = screen.getByText(syncMessage('server')).closest('div')
    expect(banner).toHaveClass('text-[13px]', 'md:text-[11px]')
  })

  it.each(['moved', 'update-required'] as const)('offers a working Reload when sync %s', (kind) => {
    const reload = vi.fn()
    vi.stubGlobal('location', { reload })
    connectedPanel({
      cloudStatus: 'paused',
      lastError: { kind, message: syncMessage(kind), since: NOW },
    })
    expect(
      screen.getByText('Sync moved to a newer version. Reload SpendTrack to update.'),
    ).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Reload' })
    expect(button).toHaveClass('h-11', 'md:h-8')
    fireEvent.click(button)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows the old-device banner for 24 hours after an old device wrote', () => {
    connectedPanel({ legacyWriterAt: NOW - 60_000 })
    expect(
      screen.getByText(
        'Another device runs an older SpendTrack (0.8.4 or earlier). Open it and reload.',
        { exact: false },
      ),
    ).toBeInTheDocument()
    cleanup()
    connectedPanel({ legacyWriterAt: NOW - 25 * 60 * 60_000 })
    expect(screen.queryByText(/older SpendTrack/)).not.toBeInTheDocument()
  })

  it('says pushes are held back while the old device keeps overwriting', () => {
    connectedPanel({ legacyWriterAt: NOW, waitingForOld: true })
    expect(
      screen.getByText(/keeps overwriting the synced copy until it's updated/),
    ).toBeInTheDocument()
  })

  it('shows nothing when sync is healthy', () => {
    connectedPanel()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('announces a banner that appears while the panel is open (one live region, always there)', () => {
    connectedPanel()
    const region = screen.getByRole('status')
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: failure('server') }))
    // Screen readers announce what is added to a live region, not a region added with it.
    expect(screen.getAllByRole('status')).toEqual([region])
    expect(region).toHaveTextContent(syncMessage('server'))
    act(() => useSyncStore.setState({ legacyWriterAt: NOW, waitingForOld: true }))
    expect(screen.getAllByRole('status')).toEqual([region])
    expect(region).toHaveTextContent(/older SpendTrack/)
  })
})

describe('Disconnect', () => {
  it('states what disconnecting does', () => {
    connectedPanel()
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    expect(
      screen.getByText(
        'This device stops syncing. Your data stays on this device, on your other devices and in the relay.',
      ),
    ).toBeInTheDocument()
  })

  it('puts no fill under the amber confirm text (AA in the light theme, axe-checked)', () => {
    // The confirm card is already amber-tinted; a fill on top dropped amber-700 text to 4.38:1.
    connectedPanel()
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    const confirm = screen.getByRole('button', { name: 'Disconnect' })
    expect(confirm).toHaveClass('!bg-transparent', '!text-warning', 'hover:!bg-warning/5')
  })
})

describe('focus stays in the panel when its view changes', () => {
  it('opening the confirm focuses Cancel, and Cancel returns to Disconnect sync', () => {
    connectedPanel()
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: /Disconnect sync/ })).toHaveFocus()
  })

  it('after Disconnect, focus is on Generate sync code', () => {
    connectedPanel({
      disconnectSync: () => {
        useSyncStore.setState({ syncId: null, cloudStatus: 'off' })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(screen.getByRole('button', { name: /Generate sync code/ })).toHaveFocus()
  })

  it.each(['Connect', 'Generate'] as const)(
    'after %s, focus is on Sync now (the control it pressed is gone)',
    async (action) => {
      useSyncStore.setState({
        setupSync: () => {
          useSyncStore.setState({ syncId: CODE, cloudStatus: 'syncing' })
          return Promise.resolve(OK)
        },
      })
      render(<SyncPanel />)
      if (action === 'Connect') {
        fireEvent.change(screen.getByPlaceholderText('Paste sync code from another device'), {
          target: { value: CODE },
        })
      }
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', {
            name: action === 'Connect' ? 'Connect' : /Generate sync code/,
          }),
        )
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: 'Sync now' })).toHaveFocus()
    },
  )

  it('does not move focus when sync connects without the panel asking', () => {
    render(<SyncPanel />)
    const input = screen.getByPlaceholderText('Paste sync code from another device')
    input.focus()
    act(() => useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW }))
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toHaveFocus()
  })
})

describe('the "Link your phone" steps', () => {
  const steps = () => screen.queryByText('Link your phone in 3 steps')

  it('show after Generate, for the code generated here', async () => {
    useSyncStore.setState({
      setupSync: (code) => {
        useSyncStore.setState({ syncId: code, cloudStatus: 'synced', lastSyncAt: NOW })
        return Promise.resolve(OK)
      },
    })
    render(<SyncPanel />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Generate sync code/ }))
      await Promise.resolve()
    })
    expect(steps()).toBeInTheDocument()
  })

  it('stay hidden on a device linked to a code it did not generate in this session', () => {
    connectedPanel({ lastSyncAt: null })
    expect(steps()).not.toBeInTheDocument()
  })
})

describe('tap targets on phones', () => {
  it('gives Copy and the tap-to-copy code a 44 px target', () => {
    connectedPanel()
    expect(screen.getByRole('button', { name: 'Copy' })).toHaveClass('min-h-11', 'md:min-h-0')
    expect(screen.getByTitle('Tap to copy')).toHaveClass('min-h-11', 'md:min-h-0')
  })
})
