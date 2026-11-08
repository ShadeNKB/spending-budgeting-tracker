import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { format } from 'date-fns'
import { SyncPanel } from './SyncPanel'
import { PREV_KEY, keepPrevious } from './previousCode'
import { storage } from '../../services/storage'
import { getUpdateController } from '../../app/swUpdate'
import {
  OLD_DEVICE_WAITING,
  SYNC_OFF_MESSAGE,
  SYNC_RELOAD_MESSAGE,
  clockTime,
  failingSinceMessage,
  useSyncStore,
  type DeviceRow,
  type SyncFailure,
  type SyncResult,
  type SyncView,
} from '../../stores/useSyncStore'
import { previewJoin, type JoinPreview } from '../../stores/syncEngine'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'

// A build with sync configured; the store's actions are replaced per test, so no request is made.
// A test of a build without relay settings turns `relayBuild.on` off (reset after each test).
const relayBuild = vi.hoisted(() => ({ on: true }))
vi.mock('../../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/syncConfig')>()),
  get syncEnabled() {
    return relayBuild.on
  },
}))
// The engine is stubbed: the panel reaches it only through loadSyncEngine() (Join's preview).
vi.mock('../../stores/syncEngine', () => ({ previewJoin: vi.fn() }))
vi.mock('../../stores/useSyncStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/useSyncStore')>()),
  loadSyncEngine: vi.fn(() => import('../../stores/syncEngine')),
}))

const CODE = '11111111-1111-4111-8111-11111111a1b2'
const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const DAY = 24 * 60 * 60_000
const TEN_MINUTES = 10 * 60_000

/** The engine's words (syncEngine.ts owns them): the panel shows lastError.message as it is. */
const MSG: Record<SyncFailure['kind'], string> = {
  offline:
    "You're offline. Changes are saved on this device and will sync when you're back online.",
  network: "Couldn't reach the sync server. Your changes are saved on this device.",
  server: 'The sync server had a problem. Your changes are saved on this device.',
  permission: 'The sync server refused access. Your data is safe on this device.',
  invalid:
    "The synced copy couldn't be read, so nothing was merged. Your data is safe on this device.",
  busy: 'Your devices kept syncing at the same moment. Your changes are saved on this device.',
  'too-large':
    "Sync paused: your data (1365 KB) is too large for the sync server. It's still saved here — export a backup.",
  moved: 'Sync moved to a newer version. Reload SpendTrack to update.',
  'update-required': 'Sync moved to a newer version. Reload SpendTrack to update.',
  reload: SYNC_RELOAD_MESSAGE,
  'not-found': 'No synced data found for this code. Check it on your other device.',
  denied: 'Sync paused: the sync server refused access. Your data is safe on this device.',
}
const NEWER_CONFIG =
  'Sync on this device was set up by a newer SpendTrack. Reload SpendTrack to update. Your data is safe here.'

const OK: SyncResult = { ok: true, pushed: true, changedLocal: false }
const OFF: SyncResult = { ok: false, error: 'off', message: SYNC_OFF_MESSAGE }
const failed = (error: SyncFailure['kind']): SyncResult => ({
  ok: false,
  error,
  message: MSG[error],
})
const NETWORK = failed('network')
const failure = (kind: SyncFailure['kind'], extra: Partial<SyncFailure> = {}): SyncFailure => ({
  kind,
  message: MSG[kind],
  since: NOW,
  ...extra,
})
const FOUND: JoinPreview = {
  kind: 'found',
  here: 2,
  synced: 5,
  after: 7,
  removed: 0,
  unreadable: 0,
}

const device = (over: Partial<DeviceRow>): DeviceRow => ({
  id: 'me',
  name: 'Windows · Chrome',
  app: __APP_VERSION__,
  mode: 'table',
  me: true,
  seen: NOW,
  rpcSince: 0,
  stale: false,
  older: false,
  legacy: false,
  ...over,
})
const view = (over: Partial<SyncView> = {}): SyncView => ({
  codeMasked: '••••-…-a1b2',
  transport: 'table',
  live: 'on',
  devices: [
    device({}),
    device({ id: 'phone', name: 'iPhone · Safari', me: false, seen: NOW - 5 * 60_000 }),
  ],
  legacy: { v084At: null, v085At: null, v5preAt: null },
  sizePct: 12,
  allCurrent: true,
  lockdown: null,
  ...over,
})

/**
 * The banner box the eye sees showing `text`. Its words are hidden from screen readers, which
 * hear them from the panel's one live region instead.
 */
function shownBanner(text: string | RegExp): HTMLElement {
  const shown = screen
    .getAllByText(text, { exact: typeof text !== 'string' || undefined })
    .filter((el) => el.getAttribute('aria-hidden') === 'true')
  const box = shown.length === 1 ? shown[0]?.closest('div') : null
  if (!box) throw new Error(`expected one banner showing ${String(text)}, found ${shown.length}`)
  return box
}

/** The status row: the Sync now button is described by it. */
function statusRow(): HTMLElement {
  const button = screen.getByRole('button', { name: 'Sync now' })
  const row = document.getElementById(button.getAttribute('aria-describedby') ?? '')
  if (!row) throw new Error('Sync now is not described by the status row')
  return row
}

/** The banners' live region (the first status region of the linked view). */
function bannerRegion(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[role="status"]')
  if (!region) throw new Error('no banner region')
  return region
}

const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()
const initialExpenses = useExpenseStore.getState()

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  localStorage.clear()
  vi.mocked(previewJoin).mockImplementation(() => Promise.resolve(FOUND))
})

afterEach(() => {
  cleanup()
  relayBuild.on = true
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
  useExpenseStore.setState(initialExpenses, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(previewJoin).mockReset()
  vi.unstubAllGlobals()
})

const toasts = () => useUIStore.getState().toasts.map((t) => [t.kind, t.message])

function connectedPanel(state: Partial<ReturnType<typeof useSyncStore.getState>> = {}) {
  useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW, ...state })
  return render(<SyncPanel />)
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/** Types `code` into Join, previews it, and confirms the preview. */
async function joinWith(code = CODE) {
  fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: 'Join' }))
  await settle()
  const question = screen.getByRole('group', { name: 'Join this sync?' })
  fireEvent.click(within(question).getByRole('button', { name: 'Join' }))
  await settle()
}

const generate = () => screen.getByRole('button', { name: /Generate sync code/ })

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
    [0, []],
    [2, [['info', OLD_DEVICE_WAITING]]],
  ])(
    'does not say Synced when the push was held back for an old device (waiting before: %i)',
    async (before, expected) => {
      connectedPanel({
        waitingForOld: before,
        triggerSync: () => {
          useSyncStore.setState({ waitingForOld: 2 })
          return Promise.resolve({ ok: true, pushed: false, changedLocal: false })
        },
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
        await Promise.resolve()
      })
      // A banner that goes up says it (its region announces it); one already up does not, so
      // then the toast answers the tap. Never both, never Synced.
      expect(shownBanner(OLD_DEVICE_WAITING)).toBeInTheDocument()
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
    expect(screen.queryByText(MSG.network)).toBeNull() // no banner yet
    const said: string[] = []
    const region = bannerRegion()
    const watch = new MutationObserver(() => {
      if (region.textContent !== said.at(-1)) said.push(region.textContent)
    })
    watch.observe(region, { subtree: true, childList: true, characterData: true })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(said).toEqual([MSG.network]) // the banner region, once
    expect(toasts()).toEqual([]) // and no toast saying it again

    // The same failure again: nothing changes on screen, so the toast answers the tap.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    watch.disconnect()
    expect(said).toEqual([MSG.network])
    expect(toasts()).toEqual([['warning', MSG.network]])
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
  // for 10 minutes, red for what needs the owner.
  it.each([
    ['offline', 'warning'],
    ['moved', 'warning'],
    ['update-required', 'warning'],
    ['reload', 'warning'],
    ['network', 'warning'],
    ['server', 'warning'],
    ['invalid', 'warning'],
    ['busy', 'warning'],
    ['permission', 'error'],
    ['not-found', 'error'],
    ['denied', 'error'],
  ] as const)('reports a fresh %s failure in its own colour (%s)', async (kind, tone) => {
    connectedPanel({ triggerSync: () => Promise.resolve(failed(kind)) })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([[tone, MSG[kind]]])
  })

  it('reports a failure that has lasted 10 minutes in red', async () => {
    connectedPanel({
      cloudStatus: 'error',
      lastError: failure('network', { since: NOW - TEN_MINUTES }),
      triggerSync: () => Promise.resolve(NETWORK),
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([['error', MSG.network]])
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

describe('Generate', () => {
  it.each([
    [OK, ['success', 'Sync code created. Join it on your other device.']],
    [NETWORK, ['warning', `Sync code created, but the first sync didn't finish: ${MSG.network}`]],
    [failed('moved'), ['warning', `Sync code created. ${MSG.moved}`]],
    [
      failed('too-large'),
      [
        'error',
        "Sync code created. Sync is paused: Your data (1365 KB) is too large for the sync server. It's still saved here — export a backup.",
      ],
    ],
    [failed('permission'), ['error', 'Sync code created, but the sync server refused access.']],
    [OFF, null],
  ])('reports the first sync honestly (%j)', async (result, toast) => {
    const setupSync = vi.fn(() => Promise.resolve(result))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    await act(async () => {
      fireEvent.click(generate())
      await Promise.resolve()
    })
    // A new random code, set up as established (it may create the relay copy).
    expect(setupSync).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/))
    expect(toasts()).toEqual(toast ? [toast] : [])
  })

  it('says the old device holds the relay when the first push was held back', async () => {
    useSyncStore.setState({
      setupSync: () => {
        useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', waitingForOld: 1 })
        return Promise.resolve({ ok: true, pushed: false, changedLocal: false })
      },
    })
    render(<SyncPanel />)
    await act(async () => {
      fireEvent.click(generate())
      await Promise.resolve()
    })
    expect(toasts()).toEqual([['info', OLD_DEVICE_WAITING]])
  })

  it('keeps focus while it sets up (aria-disabled, not disabled), and runs once', async () => {
    let finish: (r: SyncResult) => void = () => undefined
    const pending = new Promise<SyncResult>((resolve) => (finish = resolve))
    const setupSync = vi.fn(() => pending)
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    const button = generate()
    button.focus()
    fireEvent.click(button)
    const busy = screen.getByRole('button', { name: /Setting up/ })
    expect(busy).toBe(button)
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toBeEnabled()
    expect(busy).toHaveFocus()
    fireEvent.click(busy) // a second press while it runs does nothing
    fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
    const join = screen.getByRole('button', { name: 'Join' })
    expect(join).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(join) // nor does Join
    await settle()
    expect(setupSync).toHaveBeenCalledTimes(1)
    expect(previewJoin).not.toHaveBeenCalled()
    await act(async () => {
      finish(OK)
      await pending
    })
    expect(button).toHaveAttribute('aria-disabled', 'false')
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
    fireEvent.click(generate())
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))

    expect(generate()).toHaveAttribute('aria-disabled', 'false')
    fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
    expect(screen.getByRole('button', { name: 'Join' })).toHaveAttribute('aria-disabled', 'false')
    await act(async () => {
      finish(NETWORK) // the stale request ends at its deadline, ~15 s later
      await pending
    })
    expect(toasts()).toEqual([['info', 'Sync disconnected']])
  })

  it('AC-U6: asks "Start a separate sync?" while this device remembers a code', async () => {
    keepPrevious(CODE, NOW - DAY)
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    fireEvent.click(generate())
    const question = screen.getByRole('group', { name: 'Start a separate sync?' })
    expect(question).toHaveAccessibleDescription(
      'Your other devices stay on the old code. Reconnect instead to keep one sync.',
    )
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(setupSync).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(question).getByRole('button', { name: 'Make a new code' }))
      await Promise.resolve()
    })
    expect(setupSync).toHaveBeenCalledTimes(1)
    expect(setupSync).not.toHaveBeenCalledWith(CODE)
  })

  it('Cancel on "Start a separate sync?" makes nothing and gives focus back to Generate', () => {
    keepPrevious(CODE, NOW - DAY)
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    fireEvent.click(generate())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(setupSync).not.toHaveBeenCalled()
    expect(generate()).toHaveFocus()
  })

  it('asks nothing extra with no remembered code', async () => {
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    await act(async () => {
      fireEvent.click(generate())
      await Promise.resolve()
    })
    expect(screen.queryByRole('group', { name: 'Start a separate sync?' })).toBeNull()
    expect(setupSync).toHaveBeenCalledTimes(1)
  })
})

describe('Join (never creates, AC-U3)', () => {
  it('previews, then joins with the code as a joiner: "Joined. This device is synced."', async () => {
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    await joinWith()
    expect(previewJoin).toHaveBeenCalledWith(CODE)
    expect(setupSync).toHaveBeenCalledTimes(1)
    expect(setupSync).toHaveBeenCalledWith(CODE, { join: true })
    expect(toasts()).toEqual([['success', 'Joined. This device is synced.']])
  })

  it('a code with no synced copy saves nothing and sets nothing up', async () => {
    vi.mocked(previewJoin).mockImplementation(() => Promise.resolve({ kind: 'not-found' }))
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await settle()
    expect(screen.getByText(MSG['not-found'])).toBeInTheDocument()
    expect(setupSync).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('says the old device holds the relay when the first push was held back', async () => {
    useSyncStore.setState({
      setupSync: () => {
        useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', waitingForOld: 1 })
        return Promise.resolve({ ok: true, pushed: false, changedLocal: false })
      },
    })
    render(<SyncPanel />)
    await joinWith()
    expect(toasts()).toEqual([['info', OLD_DEVICE_WAITING]])
  })

  it.each([
    [NETWORK, 'warning', `Code saved, but couldn't sync yet: ${MSG.network}`],
    [failed('permission'), 'error', 'Code saved, but the sync server refused access.'],
    [
      failed('not-found'),
      'error',
      'Code saved. Sync is paused: No synced data found for this code. Check it on your other device.',
    ],
    [
      failed('too-large'),
      'error',
      "Code saved. Sync is paused: Your data (1365 KB) is too large for the sync server. It's still saved here — export a backup.",
    ],
    [failed('moved'), 'warning', `Code saved. ${MSG.moved}`],
  ] as const)('a join whose first sync fails says so honestly (%j)', async (result, tone, text) => {
    useSyncStore.setState({ setupSync: () => Promise.resolve(result) })
    render(<SyncPanel />)
    await joinWith()
    expect(toasts()).toEqual([[tone, text]])
  })

  it.each([
    ['too-large', 'error', 'Code saved. Sync is paused.'],
    ['not-found', 'error', 'Code saved. Sync is paused.'],
    ['moved', 'warning', 'Code saved. Sync is paused.'],
    ['network', 'warning', "Code saved, but couldn't sync yet."],
  ] as const)(
    'a join into a %s failure the banner explains: the toast leaves the why to it',
    async (kind, tone, message) => {
      const lastError = failure(kind)
      useSyncStore.setState({
        setupSync: () => {
          useSyncStore.setState({ syncId: CODE, cloudStatus: 'error', lastError })
          return Promise.resolve(failed(kind))
        },
      })
      render(<SyncPanel />)
      await joinWith()
      expect(toasts()).toEqual([[tone, message]])
      expect(bannerRegion().textContent).toContain(
        lastError.message.replace(/^Sync paused: y/, 'Y'),
      )
    },
  )

  it('Enter in the code field previews once: its activation never presses Sync now too', async () => {
    const setupSync = vi.fn(() => {
      useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW })
      return Promise.resolve(OK)
    })
    const triggerSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync, triggerSync })
    render(<SyncPanel />)
    const input = screen.getByLabelText('Sync code')
    fireEvent.change(input, { target: { value: CODE } })
    let notCancelled = true
    await act(async () => {
      notCancelled = fireEvent.keyDown(input, { key: 'Enter' })
      await Promise.resolve()
    })
    await settle()
    // The default action (keypress, which activates whatever has focus by then) is cancelled.
    expect(notCancelled).toBe(false)
    expect(previewJoin).toHaveBeenCalledTimes(1)
    expect(setupSync).not.toHaveBeenCalled() // the preview asks first
    expect(triggerSync).not.toHaveBeenCalled()
  })
})

describe('one question at a time (F-050)', () => {
  const groups = () => screen.queryAllByRole('group')
  const reconnect = () => screen.getByRole('button', { name: /^Reconnect to/ })

  it.each([false, true])(
    "Generate and Reconnect wait while Join's preview asks (a code remembered: %s)",
    async (remembered) => {
      if (remembered) keepPrevious(CODE, NOW - DAY)
      const setupSync = vi.fn(() => Promise.resolve(OK))
      useSyncStore.setState({ setupSync })
      render(<SyncPanel />)
      fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
      fireEvent.click(screen.getByRole('button', { name: 'Join' }))
      await settle()
      expect(screen.getByRole('group', { name: 'Join this sync?' })).toBeInTheDocument()
      expect(generate()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.click(generate())
      if (remembered) {
        expect(reconnect()).toHaveAttribute('aria-disabled', 'true')
        fireEvent.click(reconnect())
      }
      await settle()
      expect(groups()).toHaveLength(1)
      expect(setupSync).not.toHaveBeenCalled()
      // Cancel: the field is back, and so are the other setups
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(generate()).toHaveAttribute('aria-disabled', 'false')
    },
  )

  it('Generate and Reconnect wait while Join checks a code', async () => {
    keepPrevious(CODE, NOW - DAY)
    vi.mocked(previewJoin).mockImplementation(() => new Promise<JoinPreview>(() => undefined))
    render(<SyncPanel />)
    fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeInTheDocument()
    expect(generate()).toHaveAttribute('aria-disabled', 'true')
    expect(reconnect()).toHaveAttribute('aria-disabled', 'true')
  })

  it('Join waits while "Start a separate sync?" asks', async () => {
    keepPrevious(CODE, NOW - DAY)
    render(<SyncPanel />)
    fireEvent.click(generate())
    expect(screen.getByRole('group', { name: 'Start a separate sync?' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
    const join = screen.getByRole('button', { name: 'Join' })
    expect(join).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(join)
    await settle()
    expect(previewJoin).not.toHaveBeenCalled()
    expect(groups()).toHaveLength(1)
  })

  it('Reconnect answers "Start a separate sync?": the question goes', () => {
    useExpenseStore.setState({ demo: 'sample', clearSampleData: vi.fn() })
    keepPrevious(CODE, NOW - DAY)
    render(<SyncPanel />)
    fireEvent.click(generate())
    fireEvent.click(reconnect())
    // the sample-data question asks in Reconnect's place, alone
    expect(screen.getByRole('group', { name: 'Remove the sample data first?' })).toBeInTheDocument()
    expect(groups()).toHaveLength(1)
    expect(generate()).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('Reconnect (P3-18)', () => {
  const reconnect = () => screen.queryByRole('button', { name: /^Reconnect to/ })

  it('AC-U6: offers Reconnect for 30 days after a Disconnect, named without the full code', () => {
    keepPrevious(CODE, NOW - 29 * DAY)
    render(<SyncPanel />)
    const button = reconnect()
    expect(button).toHaveAccessibleName('Reconnect to the code ending in a 1 b 2')
    expect(button).toHaveTextContent('Reconnect to ••••-…-a1b2')
    // The local date (d MMM), however far the time zone is from UTC.
    expect(button).toHaveAccessibleDescription(
      `This device remembers the code until ${format(NOW + DAY, 'd MMM')}.`,
    )
    expect(document.body.textContent).not.toContain('11111111')
    // Reconnect is the main action now: Generate steps back.
    expect(generate()).not.toHaveClass('bg-accent')
  })

  it('offers nothing once the 30 days are over', () => {
    keepPrevious(CODE, NOW - 30 * DAY)
    render(<SyncPanel />)
    expect(reconnect()).toBeNull()
    expect(generate()).toHaveClass('bg-accent')
  })

  it.each([
    [true, false],
    [false, true],
  ])(
    'reconnects with the remembered code (established: %s, so join: %s), forgets the slot, focuses Sync now',
    async (established, join) => {
      // the setup the device had when it disconnected: generated or found (established), or a
      // join whose relay copy was never found, which must never create one on a Reconnect (P3-5)
      storage.saveSyncId(CODE, established)
      keepPrevious(CODE, NOW - DAY)
      storage.saveSyncId(null)
      const setupSync = vi.fn((code: string, _opts?: { join?: boolean }) => {
        useSyncStore.setState({ syncId: code, cloudStatus: 'synced', lastSyncAt: NOW })
        return Promise.resolve(OK)
      })
      useSyncStore.setState({ setupSync })
      render(<SyncPanel />)
      await act(async () => {
        fireEvent.click(reconnect() ?? document.body)
        await Promise.resolve()
      })
      expect(setupSync).toHaveBeenCalledWith(CODE, { join })
      expect(localStorage.getItem(PREV_KEY)).toBeNull()
      expect(toasts()).toEqual([['success', 'Reconnected. This device is synced.']])
      expect(screen.getByRole('button', { name: 'Sync now' })).toHaveFocus()
    },
  )
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

  it('asks with the shared confirmation: a group named by its question, Cancel focused', () => {
    connectedPanel()
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    const question = screen.getByRole('group', { name: 'Disconnect sync on this device?' })
    expect(within(question).getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('Escape takes back the question, not Settings, and focus returns to Disconnect sync', () => {
    const disconnectSync = vi.fn()
    connectedPanel({ disconnectSync })
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    // A handled Escape (default prevented) is one the layer stack leaves: Settings stays open.
    const notHandled = fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    })
    expect(notHandled).toBe(false)
    expect(screen.queryByRole('group', { name: /Disconnect sync on this device/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Disconnect sync/ })).toHaveFocus()
    expect(disconnectSync).not.toHaveBeenCalled()
  })

  it('AC-U6: keeps the code for 30 days, offers Reconnect and focuses it', () => {
    connectedPanel({
      disconnectSync: () => {
        useSyncStore.setState({ syncId: null, cloudStatus: 'off' })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(JSON.parse(localStorage.getItem(PREV_KEY) ?? 'null')).toEqual({
      code: CODE,
      until: NOW + 30 * DAY,
      established: false, // this test saved no setup: never assumed established
    })
    expect(screen.getByRole('button', { name: /^Reconnect to/ })).toHaveFocus()
    expect(toasts()).toEqual([['info', 'Sync disconnected']])
  })

  it('focuses Generate when storage refused to remember the code', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    connectedPanel({
      disconnectSync: () => {
        useSyncStore.setState({ syncId: null, cloudStatus: 'off' })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(generate()).toHaveFocus()
  })

  it.each([
    ['the linked view', () => connectedPanel()],
    [
      'the view of a sync a newer SpendTrack set up',
      () => {
        useSyncStore.setState({
          syncId: null,
          cloudStatus: 'paused',
          lastError: { kind: 'update-required', message: NEWER_CONFIG, since: NOW },
        })
        render(<SyncPanel />)
      },
    ],
  ])('in %s, Disconnect sync is 44 px tall under a finger (40 px with a mouse)', (_view, show) => {
    show()
    const button = screen.getByRole('button', { name: /Disconnect sync/ })
    expect(button).toHaveClass('h-10', '[@media(pointer:coarse)]:h-11')
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
  })

  it.each([
    // Linked, before the first cycle (the engine may still be loading).
    [{ cloudStatus: 'idle' as const }, 'Starting sync…'],
    [{ cloudStatus: 'synced' as const, pendingLocal: true }, 'Saved here · syncing soon'],
    [{ cloudStatus: 'synced' as const, pendingLocal: true, pending: 3 }, 'Saved here · 3 to sync'],
    [{ cloudStatus: 'synced' as const, lastSyncAt: NOW - 120_000 }, 'Synced · 2m ago'],
    [{ cloudStatus: 'syncing' as const, pendingLocal: true, pending: 1 }, 'Syncing…'],
    [{ cloudStatus: 'syncing' as const, lastSyncAt: NOW - 120_000 }, 'Synced · 2m ago'],
    [
      { cloudStatus: 'synced' as const, waitingForOld: 2 },
      'Saved here · other device needs update',
    ],
    // Held back with nothing new here: no push is due, so not "syncing soon".
    [
      { cloudStatus: 'synced' as const, pendingLocal: true, pending: 1, waitingForOld: 1 },
      'Saved here · other device needs update',
    ],
    // The row keeps naming what is wrong; the banner under it says since when.
    [
      { cloudStatus: 'error' as const, lastError: failure('server', { since: NOW - TEN_MINUTES }) },
      'Sync server error',
    ],
    [
      { cloudStatus: 'error' as const, lastError: failure('network', { retryAt: NOW + 27_000 }) },
      "Can't reach the sync server · retry in 30 s",
    ],
    [
      { cloudStatus: 'error' as const, lastError: failure('busy') },
      'Devices synced at the same moment',
    ],
    [{ cloudStatus: 'offline' as const }, "Offline — will sync when you're back"],
    [
      { cloudStatus: 'offline' as const, pending: 3 },
      "Offline — will sync when you're back · 3 to sync",
    ],
    // The engine's code failed to load here: nothing promises it loads once back online.
    [{ cloudStatus: 'offline' as const, engineFailed: true }, 'Offline · not synced'],
    // Refused access outlasts an outage: the row keeps saying it.
    [
      { cloudStatus: 'error' as const, lastError: failure('permission') },
      'Sync server refused access',
    ],
    [{ cloudStatus: 'paused' as const }, 'Sync paused'],
    [{ cloudStatus: 'paused' as const, lastError: failure('not-found') }, 'Sync paused'],
  ])('%j reads "%s"', (state, label) => {
    connectedPanel(state)
    expect(statusRow()).toHaveTextContent(label)
  })

  it('counts the retry down while the panel stays open', () => {
    connectedPanel({
      cloudStatus: 'error',
      lastError: failure('server', { retryAt: NOW + 27_000 }),
    })
    expect(statusRow()).toHaveTextContent('Sync server error · retry in 30 s')
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(statusRow()).toHaveTextContent('Sync server error · retry in 20 s')
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
    [{ cloudStatus: 'paused' as const, lastError: failure('not-found') }, 'text-negative'],
    [{ cloudStatus: 'paused' as const, lastError: failure('denied') }, 'text-negative'],
    [{ cloudStatus: 'error' as const, lastError: failure('server') }, 'text-warning'],
    [
      { cloudStatus: 'error' as const, lastError: failure('server', { since: NOW - TEN_MINUTES }) },
      'text-negative',
    ],
    [{ cloudStatus: 'error' as const, lastError: failure('permission') }, 'text-negative'],
    [{ cloudStatus: 'offline' as const }, 'text-warning'],
    [{ cloudStatus: 'synced' as const, waitingForOld: 1 }, 'text-[var(--text-secondary)]'],
    [{ cloudStatus: 'synced' as const }, 'text-positive'],
  ])('%j is coloured %s', (state, colour) => {
    connectedPanel(state)
    expect(statusRow()).toHaveClass(colour)
  })
})

describe('banners', () => {
  it('shows a held-back push in neutral grey, as the pill does (cyan means a sync in progress)', () => {
    connectedPanel({ waitingForOld: 1 })
    const dot = statusRow().previousElementSibling
    expect(dot).toHaveClass('bg-[var(--text-tertiary)]')
    const banner = shownBanner(OLD_DEVICE_WAITING)
    expect(banner).toHaveClass('border-white/[0.1]', 'bg-white/[0.03]')
    expect(`${dot?.className ?? ''} ${banner.className}`).not.toMatch(/accent/)
  })

  it.each(['network', 'server', 'permission', 'invalid', 'busy'] as const)(
    'explains a %s failure in the engine’s own words',
    (kind) => {
      connectedPanel({ cloudStatus: 'error', lastError: failure(kind) })
      expect(shownBanner(MSG[kind])).toBeInTheDocument()
      expect(bannerRegion()).toHaveTextContent(MSG[kind])
    },
  )

  // A button inside the live region would be read as part of the sentence ("…to update.
  // Reload"): the region holds the sentence only, and the button is described by it.
  it.each([
    ['moved', 'Reload', MSG.moved],
    ['reload', 'Reload', SYNC_RELOAD_MESSAGE],
    [
      'too-large',
      'Export backup',
      "Your data (1365 KB) is too large for the sync server. It's still saved here — export a backup.",
    ],
  ] as const)(
    'announces a %s banner without its button, which the sentence describes',
    (kind, name, sentence) => {
      connectedPanel({ cloudStatus: 'paused', lastError: failure(kind) })
      const region = bannerRegion()
      const button = screen.getByRole('button', { name })
      expect(region).not.toContainElement(button)
      expect(region.textContent).toBe(sentence)
      expect(button).toHaveAccessibleDescription(sentence)
    },
  )

  it.each([
    ['not-found', 'No synced data found for this code. Check it on your other device.'],
    ['denied', 'The sync server refused access. Your data is safe on this device.'],
  ] as const)('explains the %s pause in red, without repeating "Sync paused"', (kind, sentence) => {
    connectedPanel({ cloudStatus: 'paused', lastError: failure(kind) })
    expect(shownBanner(sentence)).toHaveClass('text-negative')
    expect(bannerRegion().textContent).toBe(sentence)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('turns a retried failure red, and says since when, once it has lasted 10 minutes', () => {
    const since = NOW - 9 * 60_000
    connectedPanel({ cloudStatus: 'error', lastError: failure('network', { since }) })
    expect(shownBanner(MSG.network)).toHaveClass('text-warning')
    expect(statusRow()).toHaveClass('text-warning')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(shownBanner(failingSinceMessage(since))).toHaveClass('text-negative')
    expect(failingSinceMessage(since)).toBe(
      `Sync has been failing since ${clockTime(since)}. Your changes are saved on this device.`,
    )
    expect(statusRow()).toHaveTextContent("Can't reach the sync server")
    expect(statusRow()).toHaveClass('text-negative')
  })

  it('Export backup opens Backup and asks for its Download button to take focus', () => {
    connectedPanel({ cloudStatus: 'paused', lastError: failure('too-large') })
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
    expect(shownBanner(MSG.server)).toHaveClass('text-[13px]', 'md:text-[11px]')
  })

  // The service worker is prompt-style: a plain reload is served by the old worker, so the new
  // build that is installed and waiting would never run, and the same pause would come back.
  it.each(['moved', 'update-required', 'reload'] as const)(
    'offers a Reload that runs the waiting build when sync is paused (%s)',
    (kind) => {
      const reloadToLatest = vi
        .spyOn(getUpdateController(), 'reloadToLatest')
        .mockImplementation(() => {})
      const reload = vi.fn()
      vi.stubGlobal('location', { reload })
      connectedPanel({ cloudStatus: 'paused', lastError: failure(kind) })
      expect(shownBanner(MSG[kind])).toBeInTheDocument()
      const button = screen.getByRole('button', { name: 'Reload' })
      expect(button).toHaveClass('h-11', 'md:h-8')
      fireEvent.click(button)
      expect(reloadToLatest).toHaveBeenCalledTimes(1)
      expect(reload).not.toHaveBeenCalled()
    },
  )

  it('AC-U5: names a 0.8.4 writer for 24 hours, from either signal', () => {
    connectedPanel({ legacyWriterAt: NOW - 60_000 })
    const OLD =
      "A device still runs an old SpendTrack (0.8.4 or earlier). Open it and reload. Until then, don't rename categories, restore backups or delete everything on it."
    expect(shownBanner(OLD)).toBeInTheDocument()
    cleanup()
    connectedPanel({
      view: view({ legacy: { v084At: NOW - DAY + 1000, v085At: null, v5preAt: null } }),
    })
    expect(shownBanner(OLD)).toBeInTheDocument()
    cleanup()
    connectedPanel({ legacyWriterAt: NOW - 25 * 60 * 60_000, view: null })
    expect(screen.queryByText(/old SpendTrack/)).not.toBeInTheDocument()
  })

  it.each([
    ['0.9.2', 'Your other device runs SpendTrack 0.9.2. Open it and reload to update.'],
    ['0.10.0', 'Your other device runs SpendTrack 0.10.0. Open it and reload to update.'],
  ] as const)('AC-U5: names a %s writer seen within 24 hours', (version, sentence) => {
    const seenAt = (at: number): SyncView['legacy'] =>
      version === '0.9.2'
        ? { v084At: null, v085At: at, v5preAt: null }
        : { v084At: null, v085At: null, v5preAt: at }
    connectedPanel({ view: view({ legacy: seenAt(NOW - 60_000) }) })
    expect(shownBanner(sentence)).toBeInTheDocument()
    cleanup()
    connectedPanel({ view: view({ legacy: seenAt(NOW - DAY) }) })
    expect(screen.queryByText(sentence)).toBeNull()
  })

  it('says one old-device sentence, the oldest writer first', () => {
    connectedPanel({
      view: view({ legacy: { v084At: NOW, v085At: NOW, v5preAt: NOW } }),
    })
    expect(bannerRegion().textContent).toMatch(/^A device still runs an old SpendTrack \(0\.8\.4/)
    expect(bannerRegion().textContent).not.toMatch(/0\.9\.2|0\.10\.0/)
  })

  it('says pushes are held back while the old device keeps overwriting, in one sentence when both apply', () => {
    connectedPanel({ waitingForOld: 1 })
    expect(shownBanner(OLD_DEVICE_WAITING)).toBeInTheDocument()
    cleanup()
    connectedPanel({ legacyWriterAt: NOW, waitingForOld: 3 })
    const both =
      "An older SpendTrack (0.8.4 or earlier) on your other device keeps overwriting the synced copy. Open it and reload; everything is saved here. Until then, don't rename categories, restore backups or delete everything on it."
    expect(shownBanner(both)).toBeInTheDocument()
    expect(bannerRegion()).toHaveTextContent(both)
    expect(screen.queryByText(OLD_DEVICE_WAITING)).not.toBeInTheDocument()
  })

  it.each([
    [69, null],
    [70, 'info'],
    [89, 'info'],
    [90, 'warning'],
    [104, 'warning'],
  ] as const)('AC-U5: a size of %i %% shows the meter as %s', (pct, tone) => {
    connectedPanel({ view: view({ sizePct: pct }) })
    const sentence = `Sync uses ${String(pct)} % of the relay limit. At 100 % sync pauses; your data stays on this device.`
    if (tone === null) {
      expect(screen.queryByText(sentence)).toBeNull()
      return
    }
    const banner = shownBanner(sentence)
    expect(banner).toHaveClass(tone === 'info' ? 'text-[var(--text-secondary)]' : 'text-warning')
    // the icon turns with the colour: ⓘ to inform, the alert sign to warn (as every warning banner)
    expect(banner.querySelector('svg')).toHaveClass(
      tone === 'info' ? 'lucide-info' : 'lucide-circle-alert',
    )
  })

  it('leaves the size to the too-large pause once it is over the limit', () => {
    connectedPanel({
      cloudStatus: 'paused',
      lastError: failure('too-large'),
      view: view({ sizePct: 120 }),
    })
    expect(screen.queryByText(/of the relay limit/)).toBeNull()
  })

  it('shows nothing when sync is healthy', () => {
    connectedPanel({ view: view() })
    expect(bannerRegion()).toBeEmptyDOMElement()
  })

  it('announces a banner that appears while the panel is open (one live region, always there)', () => {
    connectedPanel()
    const region = bannerRegion()
    act(() => useSyncStore.setState({ cloudStatus: 'error', lastError: failure('server') }))
    // Screen readers announce what is added to a live region, not a region added with it.
    expect(screen.getAllByRole('status')).toEqual([region])
    expect(region).toHaveTextContent(MSG.server)
    act(() => useSyncStore.setState({ legacyWriterAt: NOW, waitingForOld: 1 }))
    expect(screen.getAllByRole('status')).toEqual([region])
    expect(region).toHaveTextContent(/older SpendTrack/)
    expect(within(region).queryByRole('button')).toBeNull()
  })
})

describe('the linked view (F-104, AC-U4)', () => {
  it('shows the code masked, with Show, Copy and the code-safety line', () => {
    connectedPanel({ view: view() })
    expect(screen.getByText('••••-…-a1b2')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('11111111-1111')
    expect(screen.getByRole('button', { name: 'Show code' })).toHaveTextContent('Show')
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Share the code only with your own devices: anyone with it can change your synced data.',
      ),
    ).toBeInTheDocument()
  })

  it('lists the devices the engine knows', () => {
    connectedPanel({ view: view() })
    const list = screen.getByRole('list', { name: 'Devices' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(
      screen.getByText(`All your devices run SpendTrack ${__APP_VERSION__}.`),
    ).toBeInTheDocument()
  })

  it('no longer carries the "Link your phone in 3 steps" card', () => {
    connectedPanel()
    expect(screen.queryByText(/Link your phone/)).toBeNull()
  })
})

describe('a sync set up by a newer SpendTrack (P3-19, AC-E9)', () => {
  function newerPanel(state: Partial<ReturnType<typeof useSyncStore.getState>> = {}) {
    useSyncStore.setState({
      syncId: null,
      cloudStatus: 'paused',
      lastError: { kind: 'update-required', message: NEWER_CONFIG, since: NOW },
      ...state,
    })
    return render(<SyncPanel />)
  }

  it('offers Reload and Disconnect, never Generate or Join (which would overwrite it)', () => {
    newerPanel()
    expect(shownBanner(NEWER_CONFIG)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Disconnect sync/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Generate/ })).toBeNull()
    expect(screen.queryByLabelText('Sync code')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull()
  })

  it('Disconnect asks first, then removes it explicitly and keeps no Reconnect slot', () => {
    const disconnectSync = vi.fn(() => {
      useSyncStore.setState({ cloudStatus: 'off', lastError: null })
    })
    newerPanel({ disconnectSync })
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    const question = screen.getByRole('group', { name: 'Disconnect sync on this device?' })
    expect(question).toHaveAccessibleDescription(
      'This device forgets the sync a newer SpendTrack set up here. Your data stays on this device and on your other devices.',
    )
    expect(disconnectSync).not.toHaveBeenCalled()
    fireEvent.click(within(question).getByRole('button', { name: 'Disconnect' }))
    expect(disconnectSync).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(PREV_KEY)).toBeNull()
    expect(generate()).toHaveFocus()
  })
})

describe('T-026-1: copy keyed to state (F-026)', () => {
  const FORBIDDEN = /no cloud|local only|local-only|shared secret|no sharing/i
  const copy = () => document.body.textContent
  /** Readable with the public key only until 005 (PR-4 §3.5): the lockdown then asks for the code. */
  const INTRO =
    "Generate a sync code here, then join it on your other device. There's no account: the code links them. The synced copy isn't encrypted yet: until the database lockdown (update 005), anyone with this app's public key could read it."

  const pausedStates = (
    ['too-large', 'moved', 'update-required', 'reload', 'not-found', 'denied'] as const
  ).map((kind): [string, () => void] => [
    `paused ${kind}`,
    () => connectedPanel({ cloudStatus: 'paused', lastError: failure(kind) }),
  ])
  const states: [string, () => void][] = [
    ['unlinked', () => render(<SyncPanel />)],
    [
      'unlinked with Reconnect',
      () => {
        keepPrevious(CODE, NOW - DAY)
        render(<SyncPanel />)
      },
    ],
    ['linked plain', () => connectedPanel({ view: view() })],
    [
      'legacy 0.8.4 peer',
      () => connectedPanel({ legacyWriterAt: NOW, view: view({ allCurrent: false }) }),
    ],
    [
      'legacy 0.9.2 peer',
      () =>
        connectedPanel({
          view: view({ allCurrent: false, legacy: { v084At: null, v085At: NOW, v5preAt: null } }),
        }),
    ],
    [
      'legacy 0.10.0 peer',
      () =>
        connectedPanel({
          view: view({ allCurrent: false, legacy: { v084At: null, v085At: null, v5preAt: NOW } }),
        }),
    ],
    ['offline with sync', () => connectedPanel({ cloudStatus: 'offline', pending: 2 })],
    ...pausedStates,
    [
      'newer config',
      () => {
        useSyncStore.setState({
          syncId: null,
          cloudStatus: 'paused',
          lastError: { kind: 'update-required', message: NEWER_CONFIG, since: NOW },
        })
        render(<SyncPanel />)
      },
    ],
    ['size meter', () => connectedPanel({ view: view({ sizePct: 82 }) })],
    [
      'a build with no relay',
      () => {
        relayBuild.on = false
        render(<SyncPanel />)
      },
    ],
  ]

  it.each(states)('%s: claims nothing untrue about where the data lives', (_state, show) => {
    show()
    expect(copy()).not.toMatch(FORBIDDEN)
  })

  it('the unlinked intro says the synced copy is readable with the public key until 005', () => {
    render(<SyncPanel />)
    expect(screen.getByRole('heading', { name: 'Link your devices' })).toBeInTheDocument()
    expect(screen.getByText(INTRO)).toBeInTheDocument()
    expect(
      screen.getByText(
        'Share the code only with your own devices: anyone with it can change your synced data.',
      ),
    ).toBeInTheDocument()
    // The two instructional cards are gone (bundle offset): the intro replaces them.
    expect(screen.queryByText('On this device')).toBeNull()
    expect(screen.queryByText('On other devices')).toBeNull()
  })

  it('the unlinked view, word for word', () => {
    keepPrevious(CODE, NOW - DAY)
    render(<SyncPanel />)
    expect(copy()).toBe(
      [
        'Link your devices',
        INTRO,
        'Reconnect to ••••-…-a1b2',
        `This device remembers the code until ${format(NOW + 29 * DAY, 'd MMM')}.`,
        'Generate sync code for this device',
        'or join an existing one',
        'Sync code',
        'Join',
        'Share the code only with your own devices: anyone with it can change your synced data.',
        `This device runs SpendTrack ${__APP_VERSION__}`,
      ].join(''),
    )
  })
})

describe('a build with no relay settings: the setup steps (F-026, PR-4 §3.5)', () => {
  const STEPS = [
    'Create a free project at supabase.com',
    'Run migrations 001 to 004 from supabase/migrations, in order, by hand in the Supabase SQL editor (never supabase db push). See docs/brain/sync-runbook.md.',
    'Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to Vercel and your local .env.local',
    'Redeploy — sync activates automatically',
  ]
  const steps = () => within(screen.getByRole('list')).getAllByRole('listitem')

  beforeEach(() => {
    relayBuild.on = false
    render(<SyncPanel />)
  })

  it('names migrations 001 to 004, run by hand and in order (never db push), and the runbook', () => {
    expect(screen.getByText('Cloud sync not configured')).toBeInTheDocument()
    expect(steps().map((li) => [...li.children].map((part) => part.textContent))).toEqual(
      STEPS.map((step, i) => [`${String(i + 1)}.`, step]),
    )
    // Nothing to link in this build: no code to generate or join.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('each step is one run of text that wraps anywhere, so no name pushes it sideways at 320 px', () => {
    for (const li of steps()) {
      expect(li.lastElementChild).toHaveClass('min-w-0', '[overflow-wrap:anywhere]')
    }
    expect([...document.querySelectorAll('ol code')].map((name) => name.textContent)).toEqual([
      'supabase.com',
      'supabase/migrations',
      'supabase db push',
      'docs/brain/sync-runbook.md',
      'VITE_SUPABASE_URL',
      'VITE_SUPABASE_ANON_KEY',
      '.env.local',
    ])
  })
})

describe('the panel names its parts', () => {
  it('labels the sync code field (the placeholder disappears as you paste)', () => {
    render(<SyncPanel />)
    expect(screen.getByLabelText('Sync code')).toBe(
      screen.getByPlaceholderText('Paste your sync code'),
    )
  })

  it.each(['without', 'with'] as const)(
    'shows which SpendTrack this device runs, %s a sync code',
    (linked) => {
      if (linked === 'with') connectedPanel()
      else render(<SyncPanel />)
      expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+$/)
      expect(screen.getByText(`This device runs SpendTrack ${__APP_VERSION__}`)).toBeInTheDocument()
    },
  )
})

describe('focus stays in the panel when its view changes', () => {
  it('Sync now takes the focus the problem pill asked for, once', () => {
    useUIStore.getState().focusSettings('sync', 'sync-now')
    const { unmount } = connectedPanel({ cloudStatus: 'paused', lastError: failure('not-found') })
    expect(screen.getByRole('button', { name: 'Sync now' })).toHaveFocus()
    expect(useUIStore.getState().settingsFocus).toBeNull()
    unmount()
    connectedPanel()
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toHaveFocus()
  })

  it('opening the confirm focuses Cancel, and Cancel returns to Disconnect sync', () => {
    connectedPanel()
    fireEvent.click(screen.getByRole('button', { name: /Disconnect sync/ }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: /Disconnect sync/ })).toHaveFocus()
  })

  it.each(['Join', 'Generate'] as const)(
    'after %s, focus is on Sync now (the control it pressed is gone)',
    async (action) => {
      useSyncStore.setState({
        setupSync: () => {
          useSyncStore.setState({ syncId: CODE, cloudStatus: 'syncing' })
          return Promise.resolve(OK)
        },
      })
      render(<SyncPanel />)
      if (action === 'Join') await joinWith()
      else {
        await act(async () => {
          fireEvent.click(generate())
          await Promise.resolve()
        })
      }
      expect(screen.getByRole('button', { name: 'Sync now' })).toHaveFocus()
    },
  )

  it('does not move focus when sync connects without the panel asking', () => {
    render(<SyncPanel />)
    screen.getByLabelText('Sync code').focus()
    act(() => useSyncStore.setState({ syncId: CODE, cloudStatus: 'synced', lastSyncAt: NOW }))
    expect(screen.getByRole('button', { name: 'Sync now' })).not.toHaveFocus()
  })
})

describe("the demo's sample data (P2-22, F-027)", () => {
  const QUESTION = 'Remove the sample data first?'
  const question = () => screen.queryByRole('group', { name: QUESTION })

  /** A demo build with its sample rows here; Clear sample data ends the sample state. */
  function withSample(clear: () => void = () => undefined) {
    const clearSampleData = vi.fn(() => {
      clear()
      useExpenseStore.setState({ demo: 'none' })
    })
    useExpenseStore.setState({ demo: 'sample', clearSampleData })
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    return { clearSampleData, setupSync }
  }

  it('Generate asks first, in place of the button, with the safe answer focused', () => {
    const { setupSync, clearSampleData } = withSample()
    fireEvent.click(generate())
    const group = question()
    expect(group).toBeInTheDocument()
    expect(group).toHaveAccessibleDescription(
      'Sample entries stay on this device and never sync. Remove them to start with your own.',
    )
    expect(screen.queryByRole('button', { name: /Generate sync code/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep it on this device' })).toHaveFocus()
    expect(setupSync).not.toHaveBeenCalled()
    expect(clearSampleData).not.toHaveBeenCalled()
  })

  it('Remove and connect removes the sample rows, then sets up', async () => {
    const order: string[] = []
    const { setupSync, clearSampleData } = withSample(() => order.push('clear'))
    setupSync.mockImplementation(() => {
      order.push('setup')
      return Promise.resolve(OK)
    })
    fireEvent.click(generate())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove and connect' }))
      await Promise.resolve()
    })
    expect(clearSampleData).toHaveBeenCalledTimes(1)
    expect(setupSync).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['clear', 'setup'])
    expect(question()).not.toBeInTheDocument()
  })

  it('Join asks first too, before any preview, and Keep goes on with the sample rows kept', async () => {
    const { setupSync, clearSampleData } = withSample()
    fireEvent.change(screen.getByLabelText('Sync code'), { target: { value: CODE } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(question()).toBeInTheDocument()
    expect(previewJoin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on this device' }))
    await settle()
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Join this sync?' })).getByRole('button', {
        name: 'Join',
      }),
    )
    await settle()
    expect(setupSync).toHaveBeenCalledWith(CODE, { join: true })
    expect(clearSampleData).not.toHaveBeenCalled()
  })

  it('Reconnect asks first too', () => {
    keepPrevious(CODE, NOW - DAY)
    const { setupSync } = withSample()
    fireEvent.click(screen.getByRole('button', { name: /^Reconnect to/ }))
    expect(question()).toBeInTheDocument()
    expect(setupSync).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep it on this device' }), {
      key: 'Escape',
    })
    expect(screen.getByRole('button', { name: /^Reconnect to/ })).toHaveFocus()
  })

  it('Escape after Generate backs out: nothing removed, nothing set up, focus back on it', () => {
    const { setupSync, clearSampleData } = withSample()
    fireEvent.click(generate())
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep it on this device' }), {
      key: 'Escape',
    })
    expect(question()).not.toBeInTheDocument()
    expect(setupSync).not.toHaveBeenCalled()
    expect(clearSampleData).not.toHaveBeenCalled()
    expect(generate()).toHaveFocus()
  })

  it("a double click's second press does not answer the question it raised", () => {
    const { setupSync, clearSampleData } = withSample()
    fireEvent.click(generate(), { detail: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Remove and connect' }), { detail: 2 })
    expect(question()).toBeInTheDocument()
    expect(clearSampleData).not.toHaveBeenCalled()
    expect(setupSync).not.toHaveBeenCalled()
  })

  it('a removal that fails says so and sets nothing up', async () => {
    const clearSampleData = vi.fn(() => {
      throw new Error('SpendTrack is still loading your data.')
    })
    useExpenseStore.setState({ demo: 'sample', clearSampleData })
    const setupSync = vi.fn(() => Promise.resolve(OK))
    useSyncStore.setState({ setupSync })
    render(<SyncPanel />)
    fireEvent.click(generate())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove and connect' }))
      await Promise.resolve()
    })
    expect(setupSync).not.toHaveBeenCalled()
    expect(toasts()).toEqual([['error', 'SpendTrack is still loading your data.']])
    expect(generate()).toHaveFocus()
  })
})
