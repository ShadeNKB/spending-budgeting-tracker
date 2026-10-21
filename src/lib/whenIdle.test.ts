import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_FALLBACK_MS, IDLE_TIMEOUT_MS, whenIdle, type IdleHost } from './whenIdle'

class FakeHost extends EventTarget implements IdleHost {
  document: { readyState: DocumentReadyState } = { readyState: 'loading' }
  setTimeout(handler: () => void, ms: number): number {
    return window.setTimeout(handler, ms)
  }
  clearTimeout(id: number): void {
    window.clearTimeout(id)
  }
}

class IdleCapableHost extends FakeHost {
  readonly idle = new Map<number, () => void>()
  readonly requested: { timeout?: number }[] = []
  private nextId = 1
  requestIdleCallback(callback: () => void, options?: { timeout?: number }): number {
    const id = this.nextId++
    this.idle.set(id, callback)
    this.requested.push(options ?? {})
    return id
  }
  cancelIdleCallback(id: number): void {
    this.idle.delete(id)
  }
  runIdle(): void {
    const callbacks = [...this.idle.values()]
    this.idle.clear()
    for (const cb of callbacks) cb()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('whenIdle', () => {
  it('waits for window load, then for an idle period with a 2 s timeout', () => {
    const host = new IdleCapableHost()
    const callback = vi.fn()
    whenIdle(callback, host)

    expect(host.idle.size).toBe(0)
    host.dispatchEvent(new Event('load'))
    expect(host.idle.size).toBe(1)
    expect(host.requested).toEqual([{ timeout: IDLE_TIMEOUT_MS }])
    expect(IDLE_TIMEOUT_MS).toBe(2000)
    expect(callback).not.toHaveBeenCalled()

    host.runIdle()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('skips the load wait when the page has already loaded', () => {
    const host = new IdleCapableHost()
    host.document.readyState = 'complete'
    const callback = vi.fn()
    whenIdle(callback, host)
    expect(host.idle.size).toBe(1)
    host.runIdle()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('falls back to a 1.2 s timer where requestIdleCallback is missing (Safari)', () => {
    const host = new FakeHost()
    const callback = vi.fn()
    whenIdle(callback, host)
    host.dispatchEvent(new Event('load'))

    expect(IDLE_FALLBACK_MS).toBe(1200)
    vi.advanceTimersByTime(IDLE_FALLBACK_MS - 1)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('runs the callback once even if load fires twice', () => {
    const host = new FakeHost()
    const callback = vi.fn()
    whenIdle(callback, host)
    host.dispatchEvent(new Event('load'))
    host.dispatchEvent(new Event('load'))
    vi.advanceTimersByTime(10_000)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('cancels before load', () => {
    const host = new IdleCapableHost()
    const callback = vi.fn()
    const cancel = whenIdle(callback, host)
    cancel()
    host.dispatchEvent(new Event('load'))
    expect(host.idle.size).toBe(0)
    expect(callback).not.toHaveBeenCalled()
  })

  it('cancels a scheduled idle callback', () => {
    const host = new IdleCapableHost()
    host.document.readyState = 'complete'
    const callback = vi.fn()
    const cancel = whenIdle(callback, host)
    expect(host.idle.size).toBe(1)
    cancel()
    expect(host.idle.size).toBe(0)
    host.runIdle()
    expect(callback).not.toHaveBeenCalled()
  })

  it('cancels a scheduled fallback timer', () => {
    const host = new FakeHost()
    host.document.readyState = 'complete'
    const callback = vi.fn()
    const cancel = whenIdle(callback, host)
    cancel()
    vi.advanceTimersByTime(10_000)
    expect(callback).not.toHaveBeenCalled()
  })
})
