import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const CURRENCY_KEY = 'spendtrack:currency'
/**
 * Each test re-imports the store. Only the first import transforms the module graph; on a busy
 * machine that alone can pass the default 5 s, so it happens once up front with room to spare.
 */
const IMPORT_TIMEOUT_MS = 30_000

// The store reads its persisted preferences once, when the module loads.
async function loadStore() {
  vi.resetModules()
  const { useUIStore } = await import('./useUIStore')
  return useUIStore.getState()
}

/** Pretend the device is in `timeZone` with `languages`, without touching the real clock. */
function stubDevice(timeZone: string, languages: readonly string[]) {
  vi.stubGlobal('Intl', {
    NumberFormat: Intl.NumberFormat,
    DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }),
  })
  vi.stubGlobal('navigator', { languages, language: languages[0] ?? '' })
}

describe('useUIStore persisted preferences', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    await import('./useUIStore')
  }, IMPORT_TIMEOUT_MS)
  beforeEach(() => {
    localStorage.clear()
    stubDevice('America/New_York', ['en-US'])
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('restores a stored theme and currency', async () => {
    localStorage.setItem('spendtrack:theme', 'light')
    localStorage.setItem(CURRENCY_KEY, 'SGD')
    const state = await loadStore()
    expect(state.theme).toBe('light')
    expect(state.currency).toBe('SGD')
  })

  it('defaults the theme to system when nothing is stored', async () => {
    expect((await loadStore()).theme).toBe('system')
  })

  it.each(['blue', '', 'DARK', '{"theme":"dark"}'])(
    'falls back to the system theme for a stored %j',
    async (stored) => {
      localStorage.setItem('spendtrack:theme', stored)
      expect((await loadStore()).theme).toBe('system')
    },
  )

  it('keeps a stored USD choice on a Singapore device', async () => {
    stubDevice('Asia/Singapore', ['en-SG'])
    localStorage.setItem(CURRENCY_KEY, 'USD')
    expect((await loadStore()).currency).toBe('USD')
    expect(localStorage.getItem(CURRENCY_KEY)).toBe('USD')
  })

  it('starts a fresh Singapore profile in SGD and persists it', async () => {
    stubDevice('Asia/Singapore', ['en-US'])
    expect((await loadStore()).currency).toBe('SGD')
    expect(localStorage.getItem(CURRENCY_KEY)).toBe('SGD')
  })

  it('starts a fresh en-US profile in New York in USD and persists it', async () => {
    expect((await loadStore()).currency).toBe('USD')
    expect(localStorage.getItem(CURRENCY_KEY)).toBe('USD')
  })

  it('uses the language region when the time zone does not map', async () => {
    stubDevice('UTC', ['en-SG', 'en-US'])
    expect((await loadStore()).currency).toBe('SGD')
  })

  it('does not drift after travelling: the first resolved default sticks', async () => {
    stubDevice('Asia/Singapore', ['en-SG'])
    await loadStore()
    stubDevice('Asia/Tokyo', ['ja-JP'])
    expect((await loadStore()).currency).toBe('SGD')
  })

  it.each(['blue', '', 'usd', 'XYZ'])(
    'replaces an invalid stored currency %j with the resolved default',
    async (stored) => {
      stubDevice('Asia/Singapore', ['en-SG'])
      localStorage.setItem(CURRENCY_KEY, stored)
      expect((await loadStore()).currency).toBe('SGD')
      expect(localStorage.getItem(CURRENCY_KEY)).toBe('SGD')
    },
  )

  it('falls back to USD when Intl and navigator are unavailable', async () => {
    vi.stubGlobal('Intl', undefined)
    vi.stubGlobal('navigator', undefined)
    expect((await loadStore()).currency).toBe('USD')
  })

  it('falls back to USD when reading the device settings throws', async () => {
    vi.stubGlobal('Intl', {
      NumberFormat: Intl.NumberFormat,
      DateTimeFormat: () => {
        throw new RangeError('no time zone data')
      },
    })
    vi.stubGlobal('navigator', {
      get languages(): readonly string[] {
        throw new Error('blocked')
      },
    })
    expect((await loadStore()).currency).toBe('USD')
  })

  it('still resolves the default when storage cannot be written', async () => {
    stubDevice('Asia/Singapore', ['en-SG'])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect((await loadStore()).currency).toBe('SGD')
  })

  it('persists a currency switch', async () => {
    const state = await loadStore()
    state.setCurrency('JPY')
    expect(localStorage.getItem(CURRENCY_KEY)).toBe('JPY')
    expect((await loadStore()).currency).toBe('JPY')
  })
})

describe('toasts', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    await import('./useUIStore')
  }, IMPORT_TIMEOUT_MS)

  it('show one toast for the same kind and message while it is on screen', async () => {
    const store = await loadStore()
    const first = store.pushToast({ kind: 'error', message: 'Sync failed' })
    const second = store.pushToast({ kind: 'error', message: 'Sync failed' })
    const { useUIStore } = await import('./useUIStore')
    expect(second).toBe(first)
    expect(useUIStore.getState().toasts).toHaveLength(1)

    store.pushToast({ kind: 'warning', message: 'Sync failed' })
    store.pushToast({ kind: 'error', message: 'Something else' })
    expect(useUIStore.getState().toasts).toHaveLength(3)

    useUIStore.getState().dismissToast(first)
    store.pushToast({ kind: 'error', message: 'Sync failed' })
    expect(useUIStore.getState().toasts).toHaveLength(3)
  })

  it('never merges toasts that carry an action (each Undo undoes its own change)', async () => {
    const store = await loadStore()
    const undo = { label: 'Undo', onClick: () => undefined }
    store.pushToast({ kind: 'success', message: 'Deleted "Lunch"', action: undo })
    store.pushToast({ kind: 'success', message: 'Deleted "Lunch"', action: { ...undo } })
    const { useUIStore } = await import('./useUIStore')
    expect(useUIStore.getState().toasts).toHaveLength(2)
  })
})
