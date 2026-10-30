/**
 * A controllable stand-in for the Web Animations API, which jsdom lacks (no `animate`, no
 * `getAnimations`), so the code paths a browser takes can run under test.
 *
 * - Every element under a `data-state="closed"` ancestor (itself included) reports one pending
 *   finite exit animation, as a browser reports the CSS transitions an exit starts. It stays
 *   pending until `finish(el)` or `finishAll()`; with `settles: false` its `finished` promise
 *   never settles (WebKit drops the promise of a transition a reversing one replaced).
 * - `animate()` is recorded and returns a fake animation the test can move (`currentTime`),
 *   finish or cancel. Cancelling rejects `finished` with an AbortError, marked as handled as a
 *   browser marks it.
 * - `add()` puts any other animation on an element (an infinite spinner, a content animation).
 *
 * Installed with `Object.defineProperty` on `Element.prototype`; `restore()` removes it.
 */
import { vi } from 'vitest'

export interface FakeAnimation {
  readonly element: Element
  /** Null for an exit animation the fake reports by itself. */
  readonly keyframes: readonly Keyframe[] | null
  readonly options: number | KeyframeAnimationOptions | undefined
  readonly effect: {
    readonly getComputedTiming: () => { readonly endTime: number; readonly progress: number | null }
  }
  currentTime: number | null
  /** Its eased progress, as the browser reports it (null: not started or over). */
  progress: number | null
  playState: 'running' | 'finished' | 'idle'
  onfinish: (() => void) | null
  readonly finished: Promise<FakeAnimation>
  finish: () => void
  cancel: () => void
}

export interface FakeAnimations {
  /** Every `animate()` call, in order. */
  readonly animated: readonly FakeAnimation[]
  /** An animation of the test's own on `element` (an infinite spinner, a content transition). */
  add: (element: Element, timing: { readonly endTime: number }) => FakeAnimation
  /** Finishes every running finite animation on `element`. */
  finish: (element: Element) => void
  /** Finishes every running finite animation, as the browser does when they end. */
  finishAll: () => void
  restore: () => void
}

interface Options {
  /** How long the exit animations it reports last, in ms; null: elements report none. */
  readonly exitMs?: number | null
  /** False: no `finished` promise ever settles. */
  readonly settles?: boolean
}

function durationOf(options: number | KeyframeAnimationOptions | undefined): number {
  if (typeof options === 'number') return options
  const duration = options?.duration
  return typeof duration === 'number' ? duration : 0
}

export function installFakeAnimations({
  exitMs = 400,
  settles = true,
}: Options = {}): FakeAnimations {
  const all: FakeAnimation[] = []
  const animated: FakeAnimation[] = []
  const exits = new Map<Element, FakeAnimation>()

  function make(
    element: Element,
    keyframes: readonly Keyframe[] | null,
    options: number | KeyframeAnimationOptions | undefined,
    endTime: number,
  ): FakeAnimation {
    const settle: { resolve: (a: FakeAnimation) => void; reject: (e: unknown) => void } = {
      resolve: () => undefined,
      reject: () => undefined,
    }
    const finished = new Promise<FakeAnimation>((resolve, reject) => {
      settle.resolve = resolve
      settle.reject = reject
    })
    // A browser marks the promise it rejects on cancel as handled.
    finished.catch(() => undefined)
    const animation: FakeAnimation = {
      element,
      keyframes,
      options,
      effect: { getComputedTiming: () => ({ endTime, progress: animation.progress }) },
      currentTime: 0,
      progress: null,
      playState: 'running',
      onfinish: null,
      finished,
      finish: () => {
        if (animation.playState !== 'running') return
        animation.playState = 'finished'
        animation.currentTime = endTime
        if (settles) settle.resolve(animation)
        animation.onfinish?.()
      },
      cancel: () => {
        if (animation.playState === 'idle') return
        animation.playState = 'idle'
        animation.currentTime = null
        if (settles) settle.reject(new DOMException('cancelled', 'AbortError'))
      },
    }
    all.push(animation)
    return animation
  }

  function running(element: Element): FakeAnimation[] {
    const list: FakeAnimation[] = []
    if (exitMs !== null && element.closest('[data-state="closed"]')) {
      let exit = exits.get(element)
      if (exit?.playState !== 'running') {
        exit = make(element, null, undefined, exitMs)
        exits.set(element, exit)
      }
      list.push(exit)
    }
    for (const a of all) {
      if (a.element === element && a.playState === 'running' && !list.includes(a)) list.push(a)
    }
    return list
  }

  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: function getAnimations(this: Element, options?: GetAnimationsOptions) {
      const list = running(this)
      if (options?.subtree === true) {
        for (const el of this.querySelectorAll('*')) list.push(...running(el))
      }
      return list
    },
  })
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function animate(
      this: Element,
      keyframes: readonly Keyframe[],
      options?: number | KeyframeAnimationOptions,
    ) {
      const animation = make(this, keyframes, options, durationOf(options))
      animated.push(animation)
      return animation
    },
  })

  const finishAll = () => {
    for (const a of [...all]) {
      if (Number.isFinite(a.effect.getComputedTiming().endTime)) a.finish()
    }
  }

  return {
    animated,
    add: (element, { endTime }) => make(element, null, undefined, endTime),
    finish: (element) => {
      for (const a of running(element)) {
        if (Number.isFinite(a.effect.getComputedTiming().endTime)) a.finish()
      }
    },
    finishAll,
    restore: () => {
      Reflect.deleteProperty(Element.prototype, 'getAnimations')
      Reflect.deleteProperty(Element.prototype, 'animate')
    },
  }
}

/**
 * The system's Reduce Motion setting, as `matchMedia` reports it (jsdom has no matchMedia).
 * Undo with `vi.unstubAllGlobals()`.
 */
export function setReducedMotion(on: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: on && query.includes('prefers-reduced-motion: reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}
