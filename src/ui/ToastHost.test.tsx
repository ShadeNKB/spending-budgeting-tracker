import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { ToastHost } from './ToastHost'
import { GESTURE_MS } from './pressShield'
import { useUIStore } from '../stores/useUIStore'

// framer-motion reads prefers-reduced-motion through matchMedia (absent in jsdom): a stub whose
// answer the reduced-motion test flips, notifying the listener framer registers.
let reduceMotion = false
const motionListeners = new Set<() => void>()
beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return query.includes('reduced-motion') && reduceMotion
    },
    addListener: (listener: () => void) => motionListeners.add(listener),
    removeListener: (listener: () => void) => motionListeners.delete(listener),
    addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => motionListeners.delete(listener),
  }))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

function setReducedMotion(on: boolean) {
  reduceMotion = on
  for (const listener of motionListeners) listener()
}

function push(message: string, duration?: number) {
  act(() => {
    useUIStore.getState().pushToast({ kind: 'info', message, duration })
  })
}

function messages(): string[] {
  return useUIStore.getState().toasts.map((t) => t.message)
}

beforeEach(() => {
  vi.useFakeTimers()
  useUIStore.setState({ toasts: [] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ToastHost tones', () => {
  const kinds = ['success', 'error', 'warning', 'info'] as const

  // A tone tint as a second background class won or lost by stylesheet order: warning's came
  // after the surface, so amber toasts were 95 % see-through over the screen under them.
  it.each(kinds)('a %s toast has the surface as its one background', (kind) => {
    render(<ToastHost />)
    act(() => {
      useUIStore.getState().pushToast({ kind, message: `A ${kind} toast` })
    })
    const toast = screen.getByText(`A ${kind} toast`).parentElement
    const backgrounds = [...(toast?.classList ?? [])].filter((c) => /^bg-/.test(c))
    expect(backgrounds).toEqual(['bg-surface-1/95'])
  })

  // Neutral grey, as the sync pill and panel show the same states: cyan means a sync in progress.
  it('shows info in neutral grey, not the accent colour', () => {
    render(<ToastHost />)
    push('Sync disconnected')
    const toast = screen.getByText('Sync disconnected').parentElement
    expect(toast).toHaveClass('text-[var(--text-secondary)]')
    expect(toast?.className).not.toMatch(/accent/)
  })
})

describe('ToastHost durations', () => {
  it('dismisses a default toast after 4 s', () => {
    render(<ToastHost />)
    push('Saved')
    act(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(messages()).toEqual(['Saved'])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(messages()).toEqual([])
  })

  it.each([0, -1])('keeps a toast with duration %s until the user closes it', (duration) => {
    render(<ToastHost />)
    push('Storage is full', duration)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(messages()).toEqual(['Storage is full'])
    expect(screen.getByText('Storage is full')).toBeInTheDocument()

    act(() => {
      screen.getByRole('button', { name: 'Dismiss' }).click()
    })
    expect(messages()).toEqual([])
  })

  it('shows the countdown bar only on timed toasts', () => {
    const { container } = render(<ToastHost />)
    push('Sticky', 0)
    expect(container.querySelectorAll('.h-\\[2px\\]')).toHaveLength(0)
    push('Timed', 6000)
    expect(container.querySelectorAll('.h-\\[2px\\]')).toHaveLength(1)
  })
})

describe('ToastHost semantics', () => {
  it('is a named region outside the focus guard, with no live region of its own', () => {
    const { container } = render(<ToastHost />)
    push('Saved')
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region).toHaveAttribute('data-layer-exempt')
    // Toasts are announced by ToastAnnouncer's persistent regions, not by inserting them here.
    expect(container.querySelector('[aria-live]')).toBeNull()
  })

  it('gives Undo and Dismiss 44 px hit areas on touch screens', () => {
    render(<ToastHost />)
    act(() => {
      useUIStore.getState().pushToast({
        kind: 'success',
        message: 'Added',
        action: { label: 'Undo', onClick: () => {} },
      })
    })
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveClass('tap-target')
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveClass('tap-target')
  })

  it('under reduced motion, toasts appear without moving and without the countdown bar', () => {
    setReducedMotion(true)
    try {
      const { container } = render(<ToastHost />)
      push('Saved', 6000)
      const toast = screen.getByText('Saved').closest<HTMLElement>('[data-toast]')
      expect(toast).not.toBeNull()
      const transform = toast?.style.transform ?? ''
      expect(transform === '' || transform === 'none').toBe(true)
      expect(container.querySelectorAll('.h-\\[2px\\]')).toHaveLength(0)
    } finally {
      setReducedMotion(false)
    }
  })

  it('never moves a toast under Reduce Motion turned on while the app is open', () => {
    render(<ToastHost />)
    push('Saved')
    // In the page's CSS: no transform at all while the system asks for reduced motion
    // (framer-motion reads the setting once per toast).
    expect(screen.getByText('Saved').closest('[data-toast]')).toHaveClass(
      'motion-reduce:!transform-none',
    )
  })
})

// The toast after an add appears where the pointer is on a laptop (over the sheet's Add): the
// second press of a double click on Add must not undo the entry it just added. Presses are
// judged by when they were made: an event's time comes from Date.now() in jsdom.
describe('ToastHost action', () => {
  /** The page draws its next frame (animation frames run on the fake timers here). */
  const painted = () => {
    act(() => {
      vi.advanceTimersByTime(40)
    })
  }

  function pushUndo(onUndo: () => void) {
    act(() => {
      useUIStore.getState().pushToast({
        kind: 'success',
        message: 'Added "kopi" · S$2.40',
        action: { label: 'Undo', onClick: onUndo },
      })
    })
    return screen.getByRole('button', { name: 'Undo' })
  }

  it('ignores a press as the toast appears, but never a key', () => {
    let now = 50_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const onUndo = vi.fn()
      render(<ToastHost />)
      const undo = pushUndo(onUndo)
      now += 100
      fireEvent.click(undo, { detail: 1 })
      expect(onUndo).not.toHaveBeenCalled()
      // Enter or Space on a focused Undo: a key, never the tail of a press.
      fireEvent.click(undo, { detail: 0 })
      expect(onUndo).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('takes a press once the toast has been up for a moment', () => {
    let now = 80_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const onUndo = vi.fn()
      render(<ToastHost />)
      const undo = pushUndo(onUndo)
      // On screen, but not yet for long: a press now still belongs to what was there before.
      painted()
      now += GESTURE_MS - 100
      fireEvent.click(undo, { detail: 1 })
      expect(onUndo).not.toHaveBeenCalled()
      now += 101
      fireEvent.click(undo, { detail: 1 })
      expect(onUndo).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })
})
