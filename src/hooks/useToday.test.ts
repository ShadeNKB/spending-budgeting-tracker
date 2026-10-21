import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useToday } from './useToday'

describe('useToday', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 18, 23, 59, 50))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns today's local day key", () => {
    const { result } = renderHook(() => useToday())
    expect(result.current).toBe('2026-10-18')
  })

  it('rolls over at local midnight while the screen stays open', () => {
    const { result } = renderHook(() => useToday())
    act(() => {
      vi.advanceTimersByTime(9_000)
    })
    expect(result.current).toBe('2026-10-18')
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(result.current).toBe('2026-10-19')
  })

  it('catches up when the app becomes visible again after the timer was suspended', () => {
    const { result } = renderHook(() => useToday())
    vi.setSystemTime(new Date(2026, 9, 20, 7, 30)) // phone asleep for a day and a half
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBe('2026-10-20')
  })

  it('also refreshes on focus and pageshow', () => {
    const { result } = renderHook(() => useToday())
    vi.setSystemTime(new Date(2026, 9, 21, 9))
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(result.current).toBe('2026-10-21')
    vi.setSystemTime(new Date(2026, 9, 22, 9))
    act(() => {
      window.dispatchEvent(new Event('pageshow'))
    })
    expect(result.current).toBe('2026-10-22')
  })

  it('re-renders only when the day changes, and unbinds when the last user unmounts', () => {
    let renders = 0
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => {
      renders++
      return useToday()
    })
    const before = renders
    act(() => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(renders).toBe(before)
    unmount()
    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
