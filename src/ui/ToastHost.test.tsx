import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ToastHost } from './ToastHost'
import { GESTURE_MS, toastJustLeft } from './pressShield'
import { useUIStore } from '../stores/useUIStore'
import {
  installFakeAnimations,
  setReducedMotion,
  type FakeAnimations,
} from '../__tests__/fakeAnimations'

// jsdom has no Web Animations API, so toasts come and go at once here, as under Reduce Motion.
// Tests of the motion install fake animations: an exit then lasts until they finish.
let fake: FakeAnimations | null = null
function animate(): FakeAnimations {
  fake = installFakeAnimations({ exitMs: 350 })
  return fake
}
const finishExits = (animations: FakeAnimations) =>
  act(async () => {
    animations.finishAll()
    await Promise.resolve()
    await Promise.resolve()
  })

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
  fake?.restore()
  fake = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const region = () => screen.getByRole('region', { name: 'Notifications' })
const boxOf = (message: string) => {
  const box = screen.getByText(message).closest<HTMLElement>('[data-toast]')
  if (!box) throw new Error(`no toast box for ${message}`)
  return box
}

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

  it('runs the countdown bar for exactly the toast’s time, from the left', () => {
    const { container } = render(<ToastHost />)
    push('Timed', 6000)
    const bar = container.querySelector<HTMLElement>('.toast-countdown')
    expect(bar).toHaveClass('h-[2px]', 'motion-reduce:hidden')
    expect(bar?.style.animationDuration).toBe('6000ms')
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
    animate()
    setReducedMotion(true)
    const { container } = render(<ToastHost />)
    push('Saved', 6000)
    const toast = boxOf('Saved')
    expect(toast).toHaveAttribute('data-state', 'open')
    expect(toast.style.transform).toBe('')
    expect(toast.style.translate).toBe('')
    expect(container.querySelectorAll('.h-\\[2px\\]')).toHaveLength(0)
  })

  it('never moves a toast under Reduce Motion turned on while it shows', () => {
    render(<ToastHost />)
    push('Saved')
    // In the page's CSS: no transform at all while the system asks for reduced motion.
    expect(boxOf('Saved')).toHaveClass('motion-reduce:!transform-none', 'toast-box')
  })
})

// The motion itself is CSS (index.css, src/__tests__/motion-css.test.ts) keyed on each toast's
// data-state; e2e/motion.spec.ts watches it in a browser.
describe('ToastHost motion', () => {
  /** The data-state values `run` moves toasts through, oldest first, then where they end. */
  function statesDuring(run: () => void): string[] {
    const observer = new MutationObserver(() => undefined)
    observer.observe(region(), {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
      attributeOldValue: true,
    })
    run()
    const states = observer.takeRecords().map((r) => r.oldValue ?? '')
    observer.disconnect()
    return states
  }

  /**
   * Lays the boxes out as the region stacks them: from its bottom edge up (flex-col-reverse,
   * the first toast lowest), 56 px tall, 8 px apart. jsdom does no layout.
   */
  function stackLayout() {
    const boxes = () => [...region().children].filter((el) => el instanceof HTMLElement)
    const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        const list = boxes()
        const i = list.indexOf(this)
        return i < 0 ? 0 : (list.length - 1 - i) * 64
      },
    })
    Object.defineProperty(region(), 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const n = boxes().length
        const top = 700 - Math.max(0, n * 64 - 8)
        return { top, bottom: 700, left: 16, right: 359, width: 343, height: 700 - top }
      },
    })
    return () => {
      if (native) Object.defineProperty(HTMLElement.prototype, 'offsetTop', native)
    }
  }

  it('a new toast enters from the closed look', () => {
    animate()
    render(<ToastHost />)
    const states = statesDuring(() => {
      push('Saved', 0)
    })
    expect(states).toEqual(['starting'])
    expect(boxOf('Saved')).toHaveAttribute('data-state', 'open')
  })

  it('a toast already there when the host appears does not animate in', () => {
    animate()
    useUIStore.getState().pushToast({ kind: 'info', message: 'Synced', duration: 0 })
    const states: string[] = []
    const observer = new MutationObserver((records) => {
      for (const r of records) states.push(r.oldValue ?? '')
    })
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
      attributeOldValue: true,
    })
    render(<ToastHost />)
    states.push(...observer.takeRecords().map((r) => r.oldValue ?? ''))
    observer.disconnect()
    expect(states).toEqual([])
    expect(boxOf('Synced')).toHaveAttribute('data-state', 'open')
  })

  it('a dismissed toast leaves in place, still pressable, then leaves the page', async () => {
    const animations = animate()
    const onUndo = vi.fn()
    render(<ToastHost />)
    act(() => {
      useUIStore.getState().pushToast({
        kind: 'success',
        message: 'Added',
        duration: 0,
        action: { label: 'Undo', onClick: onUndo },
      })
    })
    const box = boxOf('Added')
    fireEvent.click(within(box).getByRole('button', { name: 'Dismiss' }))
    expect(messages()).toEqual([])
    expect(box).toBeInTheDocument()
    expect(box).toHaveAttribute('data-state', 'closed')
    expect(box).toHaveClass('pointer-events-auto')
    // A key on its Undo while it leaves still undoes.
    fireEvent.click(within(box).getByRole('button', { name: 'Undo' }), { detail: 0 })
    expect(onUndo).toHaveBeenCalledTimes(1)

    await finishExits(animations)
    expect(box).not.toBeInTheDocument()
  })

  it('notes its spot for the trash beneath only once it has left the page', async () => {
    const animations = animate()
    render(<ToastHost />)
    push('Saved', 0)
    const box = boxOf('Saved')
    Object.defineProperty(box, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 5000, top: 5000, right: 5100, bottom: 5050, width: 100, height: 50 }),
    })
    const there = { clientX: 5050, clientY: 5025, timeStamp: 0 }
    fireEvent.click(within(box).getByRole('button', { name: 'Dismiss' }))
    expect(toastJustLeft(there)).toBe(false)
    await finishExits(animations)
    expect(box).not.toBeInTheDocument()
    expect(toastJustLeft(there)).toBe(true)
  })

  it('slides the toasts above a leaving one into place, on translate only', async () => {
    const animations = animate()
    render(<ToastHost />)
    const restore = stackLayout()
    try {
      push('First', 0)
      push('Second', 0)
      push('Third', 0)
      const before = animations.animated.length
      fireEvent.click(within(boxOf('First')).getByRole('button', { name: 'Dismiss' }))
      expect(animations.animated).toHaveLength(before)
      await finishExits(animations)

      const slides = animations.animated.slice(before)
      expect(slides.map((a) => a.element)).toEqual([boxOf('Second'), boxOf('Third')])
      for (const slide of slides) {
        // From where it was (64 px higher) to its place.
        expect(slide.keyframes).toEqual([{ translate: '0 -64px' }, { translate: '0 0' }])
        expect(slide.options).toMatchObject({ duration: 350 })
        expect(typeof slide.options === 'object' && slide.options.fill).toBeFalsy()
      }
    } finally {
      restore()
    }
  })

  it('starts a slide that the next leaving one interrupts from where it had got to', async () => {
    const animations = animate()
    render(<ToastHost />)
    const restore = stackLayout()
    try {
      push('First', 0)
      push('Second', 0)
      push('Third', 0)
      fireEvent.click(within(boxOf('First')).getByRole('button', { name: 'Dismiss' }))
      await finishExits(animations)
      const third = boxOf('Third')
      const first = animations.animated.find((a) => a.element === third)
      if (!first) throw new Error('no slide for Third')
      // Half-way (eased): 32 of its 64 px still to go.
      first.progress = 0.5

      const before = animations.animated.length
      fireEvent.click(within(boxOf('Second')).getByRole('button', { name: 'Dismiss' }))
      await act(async () => {
        animations.finish(boxOf('Second'))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(first.playState).toBe('idle')
      const next = animations.animated.slice(before).filter((a) => a.element === third)
      // From where it showed (32 px above its old place, 64 px above that) to its new place.
      expect(next.map((a) => a.keyframes)).toEqual([
        [{ translate: '0 -96px' }, { translate: '0 0' }],
      ])
    } finally {
      restore()
    }
  })

  it('slides nothing under reduced motion', async () => {
    const animations = animate()
    setReducedMotion(true)
    render(<ToastHost />)
    const restore = stackLayout()
    try {
      push('First', 0)
      push('Second', 0)
      fireEvent.click(within(boxOf('First')).getByRole('button', { name: 'Dismiss' }))
      expect(screen.queryByText('First')).toBeNull()
      await finishExits(animations)
      expect(animations.animated).toEqual([])
    } finally {
      restore()
    }
  })

  // The case above ends the exit inside the commit that starts it, before anything has moved;
  // here the exit is under way when the setting changes, so only the check of it holds back
  // the slide.
  it('slides nothing when Reduce Motion is turned on while a toast leaves', async () => {
    const animations = animate()
    render(<ToastHost />)
    const restore = stackLayout()
    try {
      push('First', 0)
      push('Second', 0)
      const before = animations.animated.length
      fireEvent.click(within(boxOf('First')).getByRole('button', { name: 'Dismiss' }))
      expect(boxOf('First')).toHaveAttribute('data-state', 'closed')
      setReducedMotion(true)
      await finishExits(animations)
      expect(screen.queryByText('First')).toBeNull()
      expect(animations.animated.slice(before)).toEqual([])
    } finally {
      restore()
    }
  })

  it('a leaving toast drops its own timer and starts no other: only its exit’s cap', () => {
    animate()
    render(<ToastHost />)
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    try {
      push('Saved', 6000)
      const own: unknown =
        timers.mock.results[timers.mock.calls.findIndex(([, ms]) => ms === 6000)]?.value
      expect(own).toBeDefined()
      timers.mockClear()
      fireEvent.click(within(boxOf('Saved')).getByRole('button', { name: 'Dismiss' }))
      expect(boxOf('Saved')).toHaveAttribute('data-state', 'closed')
      expect(cleared).toHaveBeenCalledWith(own)
      expect(timers.mock.calls.map(([, ms]) => ms)).toEqual([350 + 250])
    } finally {
      timers.mockRestore()
      cleared.mockRestore()
    }
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
