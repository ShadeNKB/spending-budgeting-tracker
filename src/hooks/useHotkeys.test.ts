import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useHotkeys } from './useHotkeys'

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

const keydownAdds = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([type]) => type === 'keydown').length

describe('useHotkeys', () => {
  let input: HTMLInputElement

  beforeEach(() => {
    input = document.createElement('input')
    document.body.append(input)
  })
  afterEach(() => {
    input.remove()
    vi.restoreAllMocks()
  })

  it('binds keydown once across re-renders with a fresh binds object each time', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { rerender } = renderHook(() => {
      useHotkeys({ n: () => undefined, 'mod+k': () => undefined })
    })
    for (let i = 0; i < 5; i++) rerender()
    expect(keydownAdds(add)).toBe(1)
    expect(keydownAdds(remove)).toBe(0)
  })

  it('calls the handler from the latest render', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ fn }) => {
        useHotkeys({ n: fn })
      },
      { initialProps: { fn: first } },
    )
    rerender({ fn: second })
    press('n')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('picks up bindings added after the first render', () => {
    const late = vi.fn()
    const { rerender } = renderHook(
      ({ withLate }) => {
        useHotkeys(withLate ? { n: late } : {})
      },
      { initialProps: { withLate: false } },
    )
    press('n')
    rerender({ withLate: true })
    press('n')
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('maps meta or ctrl to mod+ and lowercases the key, preventing the default', () => {
    const palette = vi.fn()
    renderHook(() => {
      useHotkeys({ 'mod+k': palette })
    })
    expect(press('K', { metaKey: true }).defaultPrevented).toBe(true)
    expect(press('k', { ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press('k').defaultPrevented).toBe(false)
    expect(palette).toHaveBeenCalledTimes(2)
  })

  it('keeps the editable-target rules: plain keys and mod+z stay with the field', () => {
    const n = vi.fn()
    const undo = vi.fn()
    const palette = vi.fn()
    const escape = vi.fn()
    renderHook(() => {
      useHotkeys({ n, 'mod+z': undo, 'mod+k': palette, escape })
    })
    expect(press('n', {}, input).defaultPrevented).toBe(false)
    expect(press('z', { ctrlKey: true }, input).defaultPrevented).toBe(false)
    press('k', { ctrlKey: true }, input)
    press('Escape', {}, input)
    expect(n).not.toHaveBeenCalled()
    expect(undo).not.toHaveBeenCalled()
    expect(palette).toHaveBeenCalledTimes(1)
    expect(escape).toHaveBeenCalledTimes(1)
    press('z', { ctrlKey: true })
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('does not bind while disabled and unbinds on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const fn = vi.fn()
    const { rerender, unmount } = renderHook(
      ({ enabled }) => {
        useHotkeys({ n: fn }, enabled)
      },
      { initialProps: { enabled: false } },
    )
    press('n')
    expect(fn).not.toHaveBeenCalled()
    expect(keydownAdds(add)).toBe(0)
    rerender({ enabled: true })
    press('n')
    expect(fn).toHaveBeenCalledTimes(1)
    unmount()
    press('n')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(keydownAdds(add)).toBe(1)
    expect(keydownAdds(remove)).toBe(1)
  })

  it('ignores keys that only exist on Object.prototype', () => {
    renderHook(() => {
      useHotkeys({ n: () => undefined })
    })
    expect(press('constructor').defaultPrevented).toBe(false)
    expect(press('toString').defaultPrevented).toBe(false)
  })
})
