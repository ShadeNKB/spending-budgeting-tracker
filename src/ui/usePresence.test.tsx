import { StrictMode, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { mergeLeaving, useHeldWhileClosing, usePresence, type Presence } from './usePresence'
import {
  installFakeAnimations,
  setReducedMotion,
  type FakeAnimations,
} from '../__tests__/fakeAnimations'

/**
 * A layer as the overlays draw one: a box carrying `data-state` around the part that animates,
 * with content inside (which may run animations of its own).
 */
function Layer({
  open,
  appear,
  onExitComplete,
  label = 'content',
  seen,
}: {
  open: boolean
  appear?: boolean
  onExitComplete?: () => void
  label?: string
  seen?: (presence: Presence) => void
}) {
  const part = useRef<HTMLDivElement>(null)
  const presence = usePresence(open, { parts: () => [part.current], appear, onExitComplete })
  const shown = useHeldWhileClosing(open, label)
  seen?.(presence)
  if (!presence.mounted) return null
  return (
    <div data-testid="layer" data-state={presence.state}>
      <div ref={part} data-testid="part">
        <span data-testid="content">{shown}</span>
      </div>
    </div>
  )
}

const layer = () => screen.queryByTestId('layer')
const part = () => screen.getByTestId('part')

let fake: FakeAnimations | null = null
function withAnimations(options?: Parameters<typeof installFakeAnimations>[0]): FakeAnimations {
  fake = installFakeAnimations(options)
  return fake
}

afterEach(() => {
  fake?.restore()
  fake = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Lets settled `finished` promises run their callbacks. */
const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

describe('usePresence: entering', () => {
  it('renders nothing while closed', () => {
    render(<Layer open={false} />)
    expect(layer()).toBeNull()
  })

  it('without the Web Animations API (jsdom) it opens straight to the open state', () => {
    const states: string[] = []
    render(<Layer open seen={(p) => states.push(p.state)} />)
    expect(layer()).toHaveAttribute('data-state', 'open')
    expect(states).not.toContain('starting')
  })

  it('starts from the closed look, reads the style, then turns open before any paint', () => {
    withAnimations()
    const order: string[] = []
    const native = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      order.push(`flush:${el.closest('[data-state]')?.getAttribute('data-state') ?? '-'}`)
      return native(el, pseudo)
    })
    const states: string[] = []
    render(<Layer open seen={(p) => states.push(p.state)} />)
    expect(states.slice(0, 1)).toEqual(['starting'])
    expect(order).toContain('flush:starting')
    expect(layer()).toHaveAttribute('data-state', 'open')
  })

  it('opening later also starts from the closed look', () => {
    withAnimations()
    const states: string[] = []
    const view = render(<Layer open={false} seen={(p) => states.push(p.state)} />)
    states.length = 0
    view.rerender(<Layer open seen={(p) => states.push(p.state)} />)
    expect(states).toContain('starting')
    expect(layer()).toHaveAttribute('data-state', 'open')
  })

  it('with appear false, a first mount open is open at once (framer’s initial={false})', () => {
    withAnimations()
    const states: string[] = []
    render(<Layer open appear={false} seen={(p) => states.push(p.state)} />)
    expect(states).not.toContain('starting')
    expect(layer()).toHaveAttribute('data-state', 'open')
  })

  it('under reduced motion it is open on the first commit', () => {
    withAnimations()
    setReducedMotion(true)
    const states: string[] = []
    render(<Layer open seen={(p) => states.push(p.state)} />)
    expect(states).not.toContain('starting')
    expect(layer()).toHaveAttribute('data-state', 'open')
  })

  it('under reduced motion, opening later is open on its first commit too', () => {
    withAnimations()
    setReducedMotion(true)
    const states: string[] = []
    const view = render(<Layer open={false} seen={(p) => states.push(p.state)} />)
    view.rerender(<Layer open seen={(p) => states.push(p.state)} />)
    expect(states).not.toContain('starting')
    expect(layer()).toHaveAttribute('data-state', 'open')
  })
})

describe('usePresence: leaving', () => {
  it('without the Web Animations API it leaves at once, calling onExitComplete once', () => {
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    view.rerender(<Layer open={false} onExitComplete={done} />)
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('under reduced motion it leaves at once, even with animations running', () => {
    withAnimations()
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    setReducedMotion(true)
    view.rerender(<Layer open={false} onExitComplete={done} />)
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('stays, closed, until its part’s exit animation ends, then leaves', async () => {
    const animations = withAnimations()
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    const node = layer()
    view.rerender(<Layer open={false} onExitComplete={done} />)
    expect(layer()).toBe(node)
    expect(layer()).toHaveAttribute('data-state', 'closed')
    await flush()
    expect(layer()).toBe(node)
    expect(done).not.toHaveBeenCalled()

    animations.finishAll()
    await flush()
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('waits for its parts only: never for an animation of what they contain, nor an infinite one', async () => {
    const animations = withAnimations()
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    animations.add(part(), { endTime: Infinity })
    view.rerender(<Layer open={false} onExitComplete={done} />)
    // The content runs a finite animation of its own (a countdown, a button's transition).
    const content = screen.getByTestId('content')
    expect(content.getAnimations().length).toBeGreaterThan(0)
    animations.finish(part())
    await flush()
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('leaves at once when its parts run no finite animation', () => {
    withAnimations({ exitMs: null })
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    view.rerender(<Layer open={false} onExitComplete={done} />)
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('leaves by the longest exit left + 250 ms when the browser never settles it', async () => {
    vi.useFakeTimers()
    withAnimations({ exitMs: 400, settles: false })
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    view.rerender(<Layer open={false} onExitComplete={done} />)
    act(() => {
      vi.advanceTimersByTime(649)
    })
    await flush()
    expect(layer()).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('caps from the time the exit has left, not its full length', () => {
    vi.useFakeTimers()
    const animations = withAnimations({ exitMs: null, settles: false })
    const view = render(<Layer open />)
    // A transition already 300 ms into its 400 ms when the close commits.
    const exit = animations.add(part(), { endTime: 400 })
    exit.currentTime = 300
    view.rerender(<Layer open={false} />)
    act(() => {
      vi.advanceTimersByTime(349)
    })
    expect(layer()).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(layer()).toBeNull()
  })

  it('calls onExitComplete once when both the animation and the cap end it', async () => {
    vi.useFakeTimers()
    const animations = withAnimations({ exitMs: 400 })
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    view.rerender(<Layer open={false} onExitComplete={done} />)
    // In one go, before React re-renders (which would clear the cap): the cap ends the exit,
    // then the browser's own end of the animation arrives.
    await act(async () => {
      vi.advanceTimersByTime(650)
      animations.finishAll()
      for (let tick = 0; tick < 5; tick++) await Promise.resolve()
    })
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(done).toHaveBeenCalledTimes(1)
  })
})

describe('usePresence: interrupted', () => {
  it('reopened while leaving, it keeps the same node, turns open and drops the pending exit', async () => {
    vi.useFakeTimers()
    const animations = withAnimations()
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    const node = layer()
    view.rerender(<Layer open={false} onExitComplete={done} />)
    view.rerender(<Layer open onExitComplete={done} />)
    expect(layer()).toBe(node)
    expect(layer()).toHaveAttribute('data-state', 'open')

    animations.finishAll()
    await flush()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(layer()).toBe(node)
    expect(done).not.toHaveBeenCalled()
  })

  it('a storm of closes and opens ends in the state asked for last, one exit at most', async () => {
    const animations = withAnimations()
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    const node = layer()
    for (let i = 0; i < 9; i++) view.rerender(<Layer open={i % 2 === 1} onExitComplete={done} />)
    // Last asked: closed.
    expect(layer()).toBe(node)
    expect(layer()).toHaveAttribute('data-state', 'closed')
    animations.finishAll()
    await flush()
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 10; i++) view.rerender(<Layer open={i % 2 === 0} onExitComplete={done} />)
    // Last asked: open.
    view.rerender(<Layer open onExitComplete={done} />)
    expect(layer()).toHaveAttribute('data-state', 'open')
    animations.finishAll()
    await flush()
    expect(layer()).toHaveAttribute('data-state', 'open')
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('unmounted while leaving, it leaves no timer, callback or state update behind', async () => {
    vi.useFakeTimers()
    const animations = withAnimations()
    const errors = vi.spyOn(console, 'error')
    const done = vi.fn()
    const view = render(<Layer open onExitComplete={done} />)
    view.rerender(<Layer open={false} onExitComplete={done} />)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    animations.finishAll()
    await flush()
    expect(done).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('in StrictMode it enters once, leaves once and leaves nothing behind', async () => {
    vi.useFakeTimers()
    const animations = withAnimations()
    const done = vi.fn()
    const view = render(
      <StrictMode>
        <Layer open onExitComplete={done} />
      </StrictMode>,
    )
    expect(layer()).toHaveAttribute('data-state', 'open')
    view.rerender(
      <StrictMode>
        <Layer open={false} onExitComplete={done} />
      </StrictMode>,
    )
    expect(layer()).toHaveAttribute('data-state', 'closed')
    animations.finishAll()
    await flush()
    expect(layer()).toBeNull()
    expect(done).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    view.rerender(
      <StrictMode>
        <Layer open onExitComplete={done} />
      </StrictMode>,
    )
    expect(layer()).toHaveAttribute('data-state', 'open')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useHeldWhileClosing', () => {
  it('shows what was shown when it closed, and follows again once reopened', async () => {
    const animations = withAnimations()
    const view = render(<Layer open label="kopi 2.40" />)
    view.rerender(<Layer open label="kopi 2.50" />)
    expect(screen.getByTestId('content')).toHaveTextContent('kopi 2.50')
    // Closing in the same render that clears it (Add clears the form, then closes the sheet).
    view.rerender(<Layer open={false} label="" />)
    expect(screen.getByTestId('content')).toHaveTextContent('kopi 2.50')
    view.rerender(<Layer open={false} label="something else" />)
    expect(screen.getByTestId('content')).toHaveTextContent('kopi 2.50')
    view.rerender(<Layer open label="fresh" />)
    expect(screen.getByTestId('content')).toHaveTextContent('fresh')
    animations.finishAll()
    await flush()
    expect(layer()).not.toBeNull()
  })
})

describe('mergeLeaving: a list whose removed items stay while they leave', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  const d = { id: 'd' }
  const shown = (list: ReturnType<typeof mergeLeaving<{ id: string }>>) =>
    list.map((i) => `${i.item.id}${i.present ? '' : '-'}`)

  it('keeps a removed item where it was, marked as leaving, and appends new ones', () => {
    const first = mergeLeaving([], [a, b, c], false)
    expect(shown(first)).toEqual(['a', 'b', 'c'])
    expect(first.every((i) => !i.appear)).toBe(true)
    const next = mergeLeaving(first, [a, c, d])
    expect(shown(next)).toEqual(['a', 'b-', 'c', 'd'])
    expect(next.find((i) => i.item === d)?.appear).toBe(true)
    expect(next.find((i) => i.item === a)?.appear).toBe(false)
  })

  it('brings a leaving item back if it returns, and drops nothing on its own', () => {
    const list = mergeLeaving(mergeLeaving([], [a, b]), [a])
    expect(shown(mergeLeaving(list, [a, b]))).toEqual(['a', 'b'])
    expect(shown(mergeLeaving(list, []))).toEqual(['a-', 'b-'])
  })

  it('takes the newest copy of an item still present', () => {
    const a2 = { id: 'a' }
    expect(mergeLeaving(mergeLeaving([], [a]), [a2])[0]?.item).toBe(a2)
  })
})
