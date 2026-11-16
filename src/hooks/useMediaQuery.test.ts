import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useMediaQuery } from './useMediaQuery'

/** A media query list whose answer the test sets, and that says so as the browser would. */
function fakeList(matches: boolean) {
  const list = Object.assign(new EventTarget(), { media: '', matches })
  const set = (next: boolean) => {
    list.matches = next
    list.dispatchEvent(new Event('change'))
  }
  return { list, set }
}

let current = fakeList(false)
beforeEach(() => {
  current = fakeList(false)
  vi.stubGlobal('matchMedia', (media: string) => {
    current.list.media = media
    return current.list
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useMediaQuery', () => {
  it('starts false, reads the query once mounted, and follows its changes', () => {
    current = fakeList(true)
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(true)
    expect(current.list.media).toBe('(max-width: 767px)')
    act(() => {
      current.set(false)
    })
    expect(result.current).toBe(false)
    act(() => {
      current.set(true)
    })
    expect(result.current).toBe(true)
  })

  it('without the mount read, keeps its first answer until the query changes', () => {
    current = fakeList(false)
    const { result } = renderHook(() =>
      useMediaQuery('(max-width: 767px)', { initial: () => true, readOnMount: false }),
    )
    expect(result.current).toBe(true)
    act(() => {
      current.set(true)
    })
    expect(result.current).toBe(true)
    act(() => {
      current.set(false)
    })
    expect(result.current).toBe(false)
  })

  it('stops listening on unmount', () => {
    const remove = vi.spyOn(current.list, 'removeEventListener')
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    unmount()
    expect(remove).toHaveBeenCalledWith('change', expect.any(Function))
  })
})
