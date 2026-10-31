import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canAnimate,
  cssMs,
  cssToken,
  finiteAnimations,
  flushStyle,
  longestRemainingMs,
  prefersReducedMotion,
} from './motion'
import { installFakeAnimations, setReducedMotion } from '../__tests__/fakeAnimations'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('style')
})

describe('prefersReducedMotion', () => {
  it('is false where the browser has no matchMedia (jsdom)', () => {
    expect(typeof window.matchMedia).toBe('undefined')
    expect(prefersReducedMotion()).toBe(false)
  })

  it('asks the reduced-motion query, and reads it again on every call', () => {
    const queries: string[] = []
    let reduce = true
    // A stub with no addEventListener, as several suites install: nothing may subscribe.
    vi.stubGlobal('matchMedia', (query: string) => {
      queries.push(query)
      return { media: query, matches: reduce }
    })
    expect(prefersReducedMotion()).toBe(true)
    reduce = false
    expect(prefersReducedMotion()).toBe(false)
    expect(queries).toEqual([
      '(prefers-reduced-motion: reduce)',
      '(prefers-reduced-motion: reduce)',
    ])
  })

  it('follows the shared test switch', () => {
    setReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
    setReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('canAnimate', () => {
  it('is false without the Web Animations API (jsdom)', () => {
    expect(canAnimate()).toBe(false)
  })

  it('is true once Element.animate and getAnimations exist', () => {
    const fake = installFakeAnimations()
    try {
      expect(canAnimate()).toBe(true)
    } finally {
      fake.restore()
    }
    expect(canAnimate()).toBe(false)
  })
})

describe('finiteAnimations', () => {
  it('lists the finite animations of the parts themselves, never of what they contain', () => {
    const fake = installFakeAnimations()
    try {
      const box = document.createElement('div')
      const part = document.createElement('div')
      const child = document.createElement('span')
      part.append(child)
      box.append(part)
      document.body.append(box)
      box.dataset.state = 'closed'
      const spinner = fake.add(part, { endTime: Infinity })
      fake.add(child, { endTime: 900 })

      const found = finiteAnimations([part, null, undefined])
      expect(found).toHaveLength(1)
      expect(found[0]).not.toBe(spinner)
      expect(found[0]?.effect?.getComputedTiming().endTime).toBe(400)
      box.remove()
    } finally {
      fake.restore()
    }
  })

  it('is empty without the Web Animations API', () => {
    expect(finiteAnimations([document.body])).toEqual([])
  })
})

describe('longestRemainingMs', () => {
  it('is the longest end time still ahead, counting a pending animation from its start', () => {
    const fake = installFakeAnimations()
    try {
      const a = fake.add(document.body, { endTime: 400 })
      const b = fake.add(document.body, { endTime: 350 })
      a.currentTime = 300
      b.currentTime = null
      expect(longestRemainingMs([a, b])).toBe(350)
      expect(longestRemainingMs([])).toBe(0)
    } finally {
      fake.restore()
    }
  })
})

describe('flushStyle', () => {
  it('reads a computed value of the element, so a transition starts from the current style', () => {
    const read = vi.spyOn(window, 'getComputedStyle')
    const el = document.createElement('div')
    flushStyle(el)
    expect(read).toHaveBeenCalledWith(el)
  })
})

describe('CSS tokens', () => {
  it('reads a custom property of the root, trimmed', () => {
    document.documentElement.style.setProperty('--motion-test-ease', '  linear(0, 1)  ')
    expect(cssToken('--motion-test-ease')).toBe('linear(0, 1)')
    expect(cssToken('--motion-missing')).toBe('')
  })

  it('reads a duration token in ms, from ms or s, else the fallback', () => {
    document.documentElement.style.setProperty('--motion-a', '350ms')
    document.documentElement.style.setProperty('--motion-b', '0.4s')
    // How the production CSS minifier writes 350ms inside a custom property.
    document.documentElement.style.setProperty('--motion-d', '.35s')
    document.documentElement.style.setProperty('--motion-c', 'soon')
    expect(cssMs('--motion-a', 1)).toBe(350)
    expect(cssMs('--motion-b', 1)).toBe(400)
    expect(cssMs('--motion-d', 1)).toBeCloseTo(350, 9)
    expect(cssMs('--motion-c', 123)).toBe(123)
    expect(cssMs('--motion-missing', 250)).toBe(250)
  })
})
