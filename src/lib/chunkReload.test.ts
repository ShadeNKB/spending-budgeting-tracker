import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChunkReloadDeps } from './chunkReload'

// The "a reload has already started" flag lives at module scope (one per page), so each
// test loads a fresh copy of the module. A fresh module + the same storage = the page
// after a reload.
async function load() {
  vi.resetModules()
  return import('./chunkReload')
}

class MemoryStorage {
  readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

const KEY = 'spendtrack:chunk-reload-at'
const T0 = Date.UTC(2026, 9, 19, 4, 0, 0)

function makeDeps(overrides: Partial<ChunkReloadDeps> = {}) {
  const storage = new MemoryStorage()
  const reload = vi.fn()
  const deps: ChunkReloadDeps = {
    getStorage: () => storage,
    isOnline: () => true,
    hasUnsavedWork: () => false,
    now: () => T0,
    reload,
    ...overrides,
  }
  return { deps, storage, reload }
}

const chromium = new TypeError(
  'Failed to fetch dynamically imported module: https://spendtrack.test/assets/LedgerScreen-C69rfST8.js',
)
const firefox = new TypeError(
  'error loading dynamically imported module: https://spendtrack.test/assets/LedgerScreen-C69rfST8.js',
)
const webkit = new TypeError('Importing a module script failed.')
const mime = new TypeError("'text/html' is not a valid JavaScript MIME type.")
const cssPreload = new Error('Unable to preload CSS for /assets/index-BP_t_1Vb.css')

async function settles(promise: Promise<unknown>, ms = 30): Promise<string> {
  return Promise.race([
    promise.then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ])
}

describe('isChunkLoadError', () => {
  it.each([
    ['Chromium', chromium],
    ['Firefox', firefox],
    ['WebKit', webkit],
    ['WebKit MIME', mime],
    ['Vite CSS preload', cssPreload],
    ['webpack-style JS chunk', new Error('Loading chunk 42 failed.')],
    ['webpack-style CSS chunk', new Error('Loading CSS chunk vendors-main failed.')],
  ])('recognises the %s message', async (_label, error) => {
    const { isChunkLoadError } = await load()
    expect(isChunkLoadError(error)).toBe(true)
  })

  it('recognises an error named ChunkLoadError', async () => {
    const { isChunkLoadError } = await load()
    const error = new Error('whatever')
    error.name = 'ChunkLoadError'
    expect(isChunkLoadError(error)).toBe(true)
  })

  it.each([
    ['a plain TypeError', new TypeError("Cannot read properties of undefined (reading 'amount')")],
    ['a RangeError', new RangeError('Invalid time value')],
    ['a string', 'Failed to fetch dynamically imported module'],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { message: 42 }],
  ])('rejects %s', async (_label, value) => {
    const { isChunkLoadError } = await load()
    expect(isChunkLoadError(value)).toBe(false)
  })
})

describe('tryChunkReload', () => {
  it('reloads once, records the time and reports the reload as started', async () => {
    const { tryChunkReload } = await load()
    const { deps, storage, reload } = makeDeps()
    expect(tryChunkReload(deps)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(storage.getItem(KEY)).toBe(String(T0))
    // A second failure on the same page joins the reload already under way.
    expect(tryChunkReload(deps)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload again within 60 s of the last automatic reload', async () => {
    const first = makeDeps()
    expect((await load()).tryChunkReload(first.deps)).toBe(true)

    const reload = vi.fn()
    const after30s = { ...first.deps, now: () => T0 + 30_000, reload }
    expect((await load()).tryChunkReload(after30s)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(first.storage.getItem(KEY)).toBe(String(T0))
  })

  it('reloads again once the 60 s window has passed', async () => {
    const first = makeDeps()
    expect((await load()).tryChunkReload(first.deps)).toBe(true)

    const reload = vi.fn()
    const after61s = { ...first.deps, now: () => T0 + 61_000, reload }
    expect((await load()).tryChunkReload(after61s)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(first.storage.getItem(KEY)).toBe(String(T0 + 61_000))
  })

  it('treats a guard written in the future (clock moved back) or garbage as expired', async () => {
    for (const stored of [String(T0 + 3_600_000), 'not-a-number', '']) {
      const { deps, storage, reload } = makeDeps()
      storage.setItem(KEY, stored)
      expect((await load()).tryChunkReload(deps)).toBe(true)
      expect(reload).toHaveBeenCalledTimes(1)
    }
  })

  it('never reloads while offline', async () => {
    const { deps, storage, reload } = makeDeps({ isOnline: () => false })
    expect((await load()).tryChunkReload(deps)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(storage.getItem(KEY)).toBeNull()
  })

  it('never reloads over unsaved work', async () => {
    const { deps, reload } = makeDeps({ hasUnsavedWork: () => true })
    expect((await load()).tryChunkReload(deps)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('never reloads when sessionStorage is blocked (no guard means no loop protection)', async () => {
    const blocked = makeDeps({
      getStorage: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
    })
    expect((await load()).tryChunkReload(blocked.deps)).toBe(false)
    expect(blocked.reload).not.toHaveBeenCalled()

    const full = makeDeps({
      getStorage: () => ({
        getItem: () => null,
        setItem: () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        },
      }),
    })
    expect((await load()).tryChunkReload(full.deps)).toBe(false)
    expect(full.reload).not.toHaveBeenCalled()

    const silent = makeDeps({ getStorage: () => ({ getItem: () => null, setItem: () => {} }) })
    expect((await load()).tryChunkReload(silent.deps)).toBe(false)
    expect(silent.reload).not.toHaveBeenCalled()
  })
})

describe('importWithReload', () => {
  it('passes a successful import straight through', async () => {
    const { importWithReload } = await load()
    const { deps, reload } = makeDeps()
    const mod = { LedgerScreen: 'ok' }
    await expect(importWithReload(() => Promise.resolve(mod), deps)).resolves.toBe(mod)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads on the first chunk failure and never settles, so Suspense keeps its fallback', async () => {
    const { importWithReload } = await load()
    const { deps, reload } = makeDeps()
    const pending = importWithReload(() => Promise.reject(chromium), deps)
    expect(await settles(pending)).toBe('pending')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('rethrows the original chunk error when it cannot reload', async () => {
    const first = makeDeps()
    expect((await load()).tryChunkReload(first.deps)).toBe(true)

    const { importWithReload } = await load()
    const again = { ...first.deps, now: () => T0 + 5_000, reload: vi.fn() }
    await expect(importWithReload(() => Promise.reject(webkit), again)).rejects.toBe(webkit)
    expect(again.reload).not.toHaveBeenCalled()
  })

  it.each([
    ['offline', { isOnline: () => false }],
    ['unsaved work', { hasUnsavedWork: () => true }],
  ])('rethrows when %s', async (_label, overrides) => {
    const { importWithReload } = await load()
    const { deps, reload } = makeDeps(overrides)
    await expect(importWithReload(() => Promise.reject(firefox), deps)).rejects.toBe(firefox)
    expect(reload).not.toHaveBeenCalled()
  })

  it('rethrows non-chunk errors untouched and never reloads for them', async () => {
    const { importWithReload } = await load()
    const { deps, reload, storage } = makeDeps()
    const bug = new TypeError("Cannot read properties of undefined (reading 'map')")
    await expect(importWithReload(() => Promise.reject(bug), deps)).rejects.toBe(bug)
    expect(reload).not.toHaveBeenCalled()
    expect(storage.getItem(KEY)).toBeNull()
  })

  it('joins the reload the preloadError listener already started (Vite reports first)', async () => {
    // Vite's helper fires vite:preloadError, then rejects the import with the same error.
    const { importWithReload, installPreloadErrorRecovery } = await load()
    const { deps, reload } = makeDeps()
    const target = new EventTarget()
    installPreloadErrorRecovery(target, deps)
    target.dispatchEvent(
      Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: chromium }),
    )
    const pending = importWithReload(() => Promise.reject(chromium), deps)
    expect(await settles(pending)).toBe('pending')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads only once when two lazy chunks fail together', async () => {
    const { importWithReload } = await load()
    const { deps, reload } = makeDeps()
    const a = importWithReload(() => Promise.reject(chromium), deps)
    const b = importWithReload(() => Promise.reject(cssPreload), deps)
    expect(await settles(a)).toBe('pending')
    expect(await settles(b)).toBe('pending')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('installPreloadErrorRecovery', () => {
  let target: EventTarget
  beforeEach(() => {
    target = new EventTarget()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Vite puts the failure on `payload`.
  function preloadError(payload: unknown = cssPreload): Event {
    return Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload })
  }

  // Preventing it would make Vite resolve the import with undefined, and `m.Screen` on that is
  // a TypeError that no longer reads as a chunk failure.
  it('starts the reload but never prevents the default, so the import still rejects', async () => {
    const { installPreloadErrorRecovery } = await load()
    const { deps, reload } = makeDeps()
    installPreloadErrorRecovery(target, deps)
    const event = preloadError()
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('lets the error through when it cannot reload, so the error UI shows', async () => {
    const { installPreloadErrorRecovery } = await load()
    const { deps, reload } = makeDeps({ isOnline: () => false })
    installPreloadErrorRecovery(target, deps)
    const event = preloadError()
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('starts a reload for a failed base import (the helper reports those too)', async () => {
    const { installPreloadErrorRecovery } = await load()
    const { deps, reload } = makeDeps()
    installPreloadErrorRecovery(target, deps)
    const event = preloadError(webkit)
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores errors that are not chunk failures (a module that throws while loading)', async () => {
    const { installPreloadErrorRecovery } = await load()
    const { deps, reload, storage } = makeDeps()
    installPreloadErrorRecovery(target, deps)
    const event = preloadError(new ReferenceError('process is not defined'))
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    expect(storage.getItem(KEY)).toBeNull()
  })

  // A navigation away cancels in-flight chunk loads (WebKit does it as the navigation starts).
  // Reloading then would hijack the navigation the user asked for.
  it.each(['beforeunload', 'pagehide'])('never reloads once the page fired %s', async (type) => {
    const { installPreloadErrorRecovery, importWithReload } = await load()
    const { deps, reload, storage } = makeDeps()
    installPreloadErrorRecovery(target, deps)
    target.dispatchEvent(new Event(type))

    const event = preloadError(webkit)
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await expect(importWithReload(() => Promise.reject(webkit), deps)).rejects.toBe(webkit)
    expect(reload).not.toHaveBeenCalled()
    expect(storage.getItem(KEY)).toBeNull()
  })

  it('recovers again when the page comes back from the back-forward cache', async () => {
    const { installPreloadErrorRecovery } = await load()
    const { deps, reload } = makeDeps()
    installPreloadErrorRecovery(target, deps)
    target.dispatchEvent(new Event('pagehide'))
    target.dispatchEvent(new Event('pageshow'))
    target.dispatchEvent(preloadError(webkit))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('returns a disposer that removes the listener', async () => {
    const { installPreloadErrorRecovery } = await load()
    const { deps, reload } = makeDeps()
    const dispose = installPreloadErrorRecovery(target, deps)
    dispose()
    target.dispatchEvent(new Event('beforeunload'))
    const event = preloadError()
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    // The unload listeners went with it: a direct retry still reloads.
    expect((await import('./chunkReload')).tryChunkReload(deps)).toBe(true)
  })
})

describe('reloadedRecently', () => {
  it('is false before any automatic reload', async () => {
    const { reloadedRecently } = await load()
    const { deps } = makeDeps()
    expect(reloadedRecently(deps)).toBe(false)
  })

  it('is true on the page after an automatic reload, for the guard window only', async () => {
    const first = makeDeps()
    expect((await load()).tryChunkReload(first.deps)).toBe(true)

    const { reloadedRecently } = await load()
    expect(reloadedRecently({ ...first.deps, now: () => T0 + 5_000 })).toBe(true)
    expect(reloadedRecently({ ...first.deps, now: () => T0 + 60_000 })).toBe(false)
    // Clock moved back: not "recent".
    expect(reloadedRecently({ ...first.deps, now: () => T0 - 1 })).toBe(false)
  })

  it('is false when sessionStorage is blocked', async () => {
    const { reloadedRecently } = await load()
    const blocked = makeDeps({
      getStorage: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(reloadedRecently(blocked.deps)).toBe(false)
  })
})
