import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useIdle } from './useIdle'
import { IDLE_FALLBACK_MS } from '../lib/whenIdle'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useIdle', () => {
  // jsdom has finished loading and has no requestIdleCallback, so the Safari fallback runs.
  it('turns true once the page is idle after load', () => {
    const { result } = renderHook(() => useIdle())
    expect(result.current).toBe(false)
    act(() => {
      vi.advanceTimersByTime(IDLE_FALLBACK_MS)
    })
    expect(result.current).toBe(true)
  })

  it('cancels the pending idle callback on unmount', () => {
    const { result, unmount } = renderHook(() => useIdle())
    unmount()
    act(() => {
      vi.advanceTimersByTime(IDLE_FALLBACK_MS * 2)
    })
    expect(result.current).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
