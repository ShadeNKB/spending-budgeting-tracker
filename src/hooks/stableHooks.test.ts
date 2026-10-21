import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Profiler, createElement } from 'react'
import { act, render, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useToast } from './useToast'
import { useHaptic } from './useHaptic'
import { useCurrencySymbol, useFormatMoney } from './useFormatMoney'
import { useUIStore } from '../stores/useUIStore'
import { useExpenseStore } from '../stores/useExpenseStore'
import { AppShell } from '../app/AppShell'

// AppShell's children subscribe to stores of their own; replacing them with empty components
// means every Profiler commit below comes from AppShell itself. The sheets record the
// `onClose` they receive: Sheet re-runs its focus effect whenever that identity changes.
const received = vi.hoisted(() => {
  const addSheetOnClose: (() => void)[] = []
  const hintsOnClose: (() => void)[] = []
  return { addSheetOnClose, hintsOnClose }
})
vi.mock('../app/TopBar', () => ({ TopBar: () => null }))
vi.mock('../app/TabBar', () => ({ TabBar: () => null }))
vi.mock('../features/settings/SettingsDrawer', () => ({ SettingsDrawer: () => null }))
vi.mock('../features/entry/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('../features/entry/AddExpenseSheet', () => ({
  AddExpenseSheet: ({ onClose }: { onClose: () => void }) => {
    received.addSheetOnClose.push(onClose)
    return null
  },
}))
vi.mock('../ui/ToastHost', () => ({ ToastHost: () => null }))
// Overlays mount through OverlaySlot once the app is idle (T5). Go idle at once so the sheets
// mount at boot, as a real session does a second after load.
vi.mock('../lib/whenIdle', () => ({
  whenIdle: (callback: () => void) => {
    callback()
    return () => undefined
  },
}))
vi.mock('../ui/HotkeyHints', () => ({
  HotkeyHints: ({ onClose }: { onClose: () => void }) => {
    received.hintsOnClose.push(onClose)
    return null
  },
}))

beforeEach(() => {
  useUIStore.setState({ currency: 'SGD', theme: 'dark', toasts: [] })
  useExpenseStore.setState({ expenses: [], undoStack: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useToast', () => {
  it('returns the same API object across re-renders and components', () => {
    const a = renderHook(() => useToast())
    const b = renderHook(() => useToast())
    const first = a.result.current
    a.rerender()
    expect(a.result.current).toBe(first)
    expect(b.result.current).toBe(first)
  })

  it('pushes toasts of each kind with their options', () => {
    const { result } = renderHook(() => useToast())
    const onClick = vi.fn()
    result.current.success('Added', { action: { label: 'Undo', onClick } })
    result.current.error('Failed', { duration: 12_000 })
    result.current.info('Updated')
    result.current.warning('Careful')
    expect(useUIStore.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ['success', 'Added'],
      ['error', 'Failed'],
      ['info', 'Updated'],
      ['warning', 'Careful'],
    ])
    expect(useUIStore.getState().toasts[0]?.action?.onClick).toBe(onClick)
    expect(useUIStore.getState().toasts[1]?.duration).toBe(12_000)
  })
})

describe('useHaptic', () => {
  it('returns the same function across re-renders', () => {
    const { result, rerender } = renderHook(() => useHaptic())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('vibrates with the given pattern, defaulting to a short tick', () => {
    const vibrate = vi.fn(() => true)
    vi.stubGlobal('navigator', { vibrate })
    const { result } = renderHook(() => useHaptic())
    result.current()
    result.current([10, 30, 10])
    expect(vibrate.mock.calls).toEqual([[8], [[10, 30, 10]]])
  })

  it('is a silent no-op where vibration is missing or throws', () => {
    const { result } = renderHook(() => useHaptic())
    vi.stubGlobal('navigator', {})
    expect(() => {
      result.current(10)
    }).not.toThrow()
    vi.stubGlobal('navigator', {
      vibrate: () => {
        throw new Error('blocked by permissions policy')
      },
    })
    expect(() => {
      result.current(10)
    }).not.toThrow()
  })
})

describe('useFormatMoney', () => {
  it('keeps its identity until the currency changes', () => {
    const { result, rerender } = renderHook(() => useFormatMoney())
    const first = result.current
    rerender()
    rerender()
    expect(result.current).toBe(first)
    expect(result.current(14.6)).toBe('S$14.60')

    act(() => {
      useUIStore.getState().setCurrency('JPY')
    })
    expect(result.current).not.toBe(first)
    expect(result.current(1500)).toBe('¥1,500')
    const second = result.current
    rerender()
    expect(result.current).toBe(second)
  })

  it('passes the options through', () => {
    const { result } = renderHook(() => useFormatMoney())
    expect(result.current(1500, { compact: true })).toBe('S$1.5k')
    expect(result.current(10, { sign: true })).toBe('+S$10.00')
  })
})

describe('useCurrencySymbol', () => {
  it('follows the selected currency', () => {
    const { result } = renderHook(() => useCurrencySymbol())
    expect(result.current).toBe('S$')
    act(() => {
      useUIStore.getState().setCurrency('MYR')
    })
    expect(result.current).toBe('RM')
  })
})

describe('AppShell', () => {
  async function mountShell() {
    let commits = 0
    const add = vi.spyOn(window, 'addEventListener')
    const view = render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          Profiler,
          {
            id: 'shell',
            onRender: () => {
              commits++
            },
          },
          createElement(AppShell),
        ),
      ),
    )
    // Let bootstrap hydrate, the idle overlays mount and their lazy children resolve.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    const listenerCount = (type: string) => add.mock.calls.filter(([t]) => t === type).length
    return { view, commits: () => commits, listenerCount }
  }

  it('does not re-render when an expense is added or its undo entry changes', async () => {
    const { view, commits } = await mountShell()
    const before = commits()
    act(() => {
      const created = useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
      useExpenseStore.getState().clearUndo(`add-${created.id}`)
    })
    expect(commits()).toBe(before)
    view.unmount()
  })

  it('binds its keydown and quota listeners once while it re-renders', async () => {
    const { view, listenerCount, commits } = await mountShell()
    const before = commits()
    for (let i = 0; i < 3; i++) {
      act(() => {
        useUIStore.getState().setHotkeysOpen(true)
      })
      act(() => {
        useUIStore.getState().setHotkeysOpen(false)
      })
    }
    expect(commits()).toBeGreaterThan(before)
    expect(listenerCount('keydown')).toBe(1)
    expect(listenerCount('spendtrack:quota-exceeded')).toBe(1)
    view.unmount()
  })

  it('hands its sheets a stable onClose, so an open sheet keeps focus while the shell re-renders', async () => {
    received.addSheetOnClose.length = 0
    received.hintsOnClose.length = 0
    const { view } = await mountShell()
    act(() => {
      useUIStore.getState().setAddSheetOpen(true)
    })
    act(() => {
      useExpenseStore.getState().setOffline(true)
    })
    act(() => {
      useExpenseStore.getState().setOffline(false)
    })
    expect(received.addSheetOnClose.length).toBeGreaterThan(2)
    expect(new Set(received.addSheetOnClose).size).toBe(1)
    expect(new Set(received.hintsOnClose).size).toBe(1)
    act(() => {
      received.addSheetOnClose[0]?.()
    })
    expect(useUIStore.getState().addSheetOpen).toBe(false)
    view.unmount()
  })

  it('undoes the latest add on mod+z', async () => {
    const { view } = await mountShell()
    act(() => {
      useExpenseStore.getState().addExpense({ itemName: 'kopi', amount: 1.8 })
      useExpenseStore.getState().addExpense({ itemName: 'grab', amount: 12 })
    })
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }),
      )
    })
    expect(useExpenseStore.getState().expenses.map((e) => e.itemName)).toEqual(['kopi'])
    view.unmount()
  })

  it('shows the storage-full toast when the quota event fires', async () => {
    const { view } = await mountShell()
    act(() => {
      window.dispatchEvent(new CustomEvent('spendtrack:quota-exceeded'))
    })
    expect(useUIStore.getState().toasts.map((t) => t.kind)).toEqual(['error'])
    view.unmount()
  })
})
