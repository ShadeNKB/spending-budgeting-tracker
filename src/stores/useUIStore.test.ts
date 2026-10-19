import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store reads its persisted preferences once, when the module loads.
async function loadStore() {
  vi.resetModules()
  const { useUIStore } = await import('./useUIStore')
  return useUIStore.getState()
}

describe('useUIStore persisted preferences', () => {
  beforeEach(() => localStorage.clear())

  it('restores a stored theme and currency', async () => {
    localStorage.setItem('spendtrack:theme', 'light')
    localStorage.setItem('spendtrack:currency', 'SGD')
    const state = await loadStore()
    expect(state.theme).toBe('light')
    expect(state.currency).toBe('SGD')
  })

  it('defaults when nothing is stored', async () => {
    const state = await loadStore()
    expect(state.theme).toBe('system')
    expect(state.currency).toBe('USD')
  })

  it.each(['blue', '', 'DARK', '{"theme":"dark"}'])(
    'falls back to the system theme for a stored %j',
    async (stored) => {
      localStorage.setItem('spendtrack:theme', stored)
      expect((await loadStore()).theme).toBe('system')
    },
  )

  it.each(['blue', '', 'usd', 'XYZ'])(
    'falls back to USD for a stored currency %j',
    async (stored) => {
      localStorage.setItem('spendtrack:currency', stored)
      expect((await loadStore()).currency).toBe('USD')
    },
  )
})
