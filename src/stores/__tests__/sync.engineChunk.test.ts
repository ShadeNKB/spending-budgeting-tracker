// The sync engine is a lazy chunk, loaded through T5's importWithReload: after a deploy, a page
// still running the old build that asks for the old engine chunk reloads once (online, nothing
// typed) instead of failing. When it cannot reload, the code is kept, the failure is honest,
// and the next Sync now (or resume, or `online`) sets up again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_CODE, expense, relayRows, resetRelay, stubRelayEnv } from '../../__tests__/fakeRelay'
import { CHUNK_RELOAD_KEY, STUCK_HINT } from '../../lib/chunkReload'
import { syncMessage } from '../useSyncStore'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

const chunk = vi.hoisted(() => ({ calls: 0, failures: 0 }))

vi.mock('../../lib/chunkReload', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/chunkReload')>()
  return {
    ...real,
    importWithReload: <T>(load: () => Promise<T>): Promise<T> => {
      chunk.calls++
      if (chunk.failures > 0) {
        chunk.failures--
        // A stale chunk whose reload is not allowed now (offline, or typed text on screen).
        return Promise.reject(
          new TypeError('Failed to fetch dynamically imported module: /assets/syncEngine-old.js'),
        )
      }
      return real.importWithReload(load)
    },
  }
})

type Sync = typeof import('../useSyncStore')
let sync: Sync | null = null
let ui: typeof import('../useUIStore') | null = null
let controller: ReturnType<typeof import('../../app/swUpdate').getUpdateController> | null = null

beforeEach(async () => {
  localStorage.clear()
  sessionStorage.clear()
  chunk.calls = 0
  chunk.failures = 0
  stubRelayEnv()
  resetRelay()
  vi.resetModules()
  const { useExpenseStore } = await import('../useExpenseStore')
  useExpenseStore.setState({ hydrated: true, expenses: [expense('e1')] })
  sync = await import('../useSyncStore')
  ui = await import('../useUIStore')
  controller = (await import('../../app/swUpdate')).getUpdateController()
})

afterEach(() => {
  sync?.useSyncStore.getState().disconnectSync()
  sync = null
  ui = null
  controller = null
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

const toasts = () => ui?.useUIStore.getState().toasts ?? []

describe('the sync engine chunk', () => {
  it('is loaded through importWithReload, once', async () => {
    if (!sync) throw new Error('not loaded')
    await sync.loadSyncEngine()
    await sync.loadSyncEngine()
    expect(chunk.calls).toBe(1)
  })

  // Online, the browser keeps a failed module import for the life of the page: nothing but a
  // reload fetches it again, so the state asks for one (never "retrying", never "can't reach").
  it('that fails to load keeps the code, asks for a reload, and the next Sync now sets up again', async () => {
    if (!sync) throw new Error('not loaded')
    chunk.failures = 1
    const failed = await sync.useSyncStore.getState().setupSync(SYNC_CODE)

    expect(failed).toMatchObject({ ok: false, error: 'reload', message: syncMessage('reload') })
    expect(syncMessage('reload')).toContain('Reload SpendTrack to sync')
    expect(syncMessage('reload')).not.toContain(STUCK_HINT) // no reload has failed yet
    expect(sync.useSyncStore.getState()).toMatchObject({
      syncId: SYNC_CODE,
      cloudStatus: 'paused',
      pendingLocal: true,
      engineFailed: true,
      lastError: { kind: 'reload' },
    })
    expect(localStorage.getItem('syncId')).toBe(SYNC_CODE)
    expect(relayRows()).toEqual([])

    const retried = await sync.useSyncStore.getState().triggerSync()
    expect(retried).toMatchObject({ ok: true, pushed: true })
    expect(chunk.calls).toBe(2)
    expect(sync.useSyncStore.getState()).toMatchObject({
      cloudStatus: 'synced',
      lastError: null,
      engineFailed: false,
    })
    expect(relayRows()).toEqual([expect.objectContaining({ id: 'e1' })])
  })

  // WebKit keeps a failed chunk failed for the life of the tab, through reloads: once the
  // automatic reload has not helped, the pause says how to get unstuck, as the error screens do.
  it('that still fails after the automatic reload says how to get unstuck', async () => {
    if (!sync) throw new Error('not loaded')
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now() - 5000)) // T5 reloaded 5 s ago
    chunk.failures = 1
    const failed = await sync.useSyncStore.getState().setupSync(SYNC_CODE)
    expect(failed).toEqual({
      ok: false,
      error: 'reload',
      message: `${syncMessage('reload')} ${STUCK_HINT}`,
    })
    expect(sync.useSyncStore.getState().lastError?.message).toBe(failed.ok ? '' : failed.message)
  })

  // A stale engine chunk usually means a new build is out: look for it, so Reload runs it.
  it('looks for a new build once when it pauses for a reload', async () => {
    if (!sync || !controller) throw new Error('not loaded')
    const checkNow = vi.spyOn(controller, 'checkNow')
    chunk.failures = 2
    await sync.useSyncStore.getState().setupSync(SYNC_CODE)
    await sync.useSyncStore.getState().triggerSync()
    expect(sync.useSyncStore.getState().lastError?.kind).toBe('reload')
    expect(checkNow).toHaveBeenCalledTimes(1)
  })

  // The pill is desktop-only: on a phone nothing on a main screen would say sync stopped.
  it('tells a phone once, with a Reload that runs the newest build, when it cannot start', async () => {
    if (!sync || !controller) throw new Error('not loaded')
    const reloadToLatest = vi.spyOn(controller, 'reloadToLatest').mockImplementation(() => {})
    localStorage.setItem('syncId', SYNC_CODE)
    chunk.failures = 2
    sync.useSyncStore.getState().initSync() // start-up with the saved code: no owner waiting
    await vi.waitFor(() => {
      expect(sync?.useSyncStore.getState().lastError?.kind).toBe('reload')
    })
    expect(toasts()).toEqual([
      expect.objectContaining({
        kind: 'warning',
        message: syncMessage('reload'),
        action: expect.objectContaining({ label: 'Reload' }) as unknown,
      }),
    ])
    toasts()[0]?.action?.onClick()
    expect(reloadToLatest).toHaveBeenCalledTimes(1)

    // A later background attempt (resume, 'online') fails again: no second toast.
    ui?.useUIStore.setState({ toasts: [] })
    sync.useSyncStore.getState().initSync()
    await vi.waitFor(() => {
      expect(chunk.calls).toBe(2)
    })
    expect(sync.useSyncStore.getState().lastError?.kind).toBe('reload')
    expect(toasts()).toEqual([])
  })

  it.each([
    ['the Sync panel is open', 'panel'],
    ['the pill is on screen (1280 px and up)', 'pill'],
  ] as const)('does not toast it where %s', async (_label, surface) => {
    if (!sync || !ui) throw new Error('not loaded')
    if (surface === 'panel') ui.useUIStore.setState({ settingsOpen: true, settingsTab: 'sync' })
    else {
      const pill = sync.SYNC_PILL_MEDIA
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === pill, media: query }))
    }
    localStorage.setItem('syncId', SYNC_CODE)
    chunk.failures = 1
    sync.useSyncStore.getState().initSync()
    await vi.waitFor(() => {
      expect(sync?.useSyncStore.getState().lastError?.kind).toBe('reload')
    })
    expect(toasts()).toEqual([])
  })

  it('that fails to load while offline is offline (amber, nothing to retry), not a red failure', async () => {
    if (!sync) throw new Error('not loaded')
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    sync.installSync() // no saved code yet: it only listens for 'online' and resume
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    chunk.failures = 1
    const failed = await sync.useSyncStore.getState().setupSync(SYNC_CODE)

    // No promise to sync once back: WebKit never loads a failed chunk again in that tab.
    expect(failed).toEqual({
      ok: false,
      error: 'offline',
      message: "You're offline. Changes are saved on this device.",
    })
    const { lastError } = sync.useSyncStore.getState()
    expect(sync.useSyncStore.getState()).toMatchObject({
      syncId: SYNC_CODE,
      cloudStatus: 'offline',
      pendingLocal: true,
      engineFailed: true,
      lastError: { kind: 'offline' },
    })
    expect(sync.syncsWhenOnline(sync.useSyncStore.getState())).toBe(false)
    expect(toasts()).toEqual([]) // the offline strip says it
    if (!lastError) throw new Error('no failure recorded')
    // Hours later it is still offline in amber, never "failing since".
    expect(sync.failureSeverity(lastError, lastError.since + 60 * 60_000)).toBe('warning')
    expect(sync.isFailing(lastError, lastError.since + 60 * 60_000)).toBe(false)

    // Back online: 'online' sets up again (the engine has not loaded, so this store does it).
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => {
      expect(sync?.useSyncStore.getState()).toMatchObject({
        cloudStatus: 'synced',
        lastError: null,
      })
    })
    expect(relayRows()).toEqual([expect.objectContaining({ id: 'e1' })])
  })
})
