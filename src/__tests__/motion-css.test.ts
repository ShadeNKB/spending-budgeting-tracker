/**
 * Motion contract (T5b): the overlay motion that replaced framer-motion lives in index.css as
 * tokens and part classes. framer's springs are `linear()` easings sampled from the same physics
 * (src/ui/spring.ts, checked against framer's own outputs), with `cubic-bezier` fallbacks where
 * `linear()` is not supported; parts move with transform and opacity only (the compositor); and
 * Reduce Motion holds every part still, live. index.css is read from disk (see
 * `readSourceText`), so a later edit that breaks a curve or animates layout fails here.
 */
import { describe, expect, it } from 'vitest'
import { linearEasing, springEasing, type SpringPhysics } from '../ui/spring'

interface NodeFs {
  readFileSync: (path: string, encoding: 'utf8') => string
}
interface NodeUrl {
  fileURLToPath: (url: string) => string
}

function exposes<T>(mod: unknown, fn: keyof T & string): mod is T {
  return typeof mod === 'object' && mod !== null && typeof Reflect.get(mod, fn) === 'function'
}

/** Vitest blanks every .css import, so the stylesheet's source is read from disk. */
async function readSourceText(relativeToThisFile: string): Promise<string> {
  const load = (name: string): Promise<unknown> => import(/* @vite-ignore */ name)
  const [fs, url] = await Promise.all([load('node:fs'), load('node:url')])
  if (!exposes<NodeFs>(fs, 'readFileSync') || !exposes<NodeUrl>(url, 'fileURLToPath')) {
    throw new Error('the motion contract runs in the Node process that hosts vitest')
  }
  const file = url.fileURLToPath(new URL(relativeToThisFile, import.meta.url).href)
  return fs.readFileSync(file, 'utf8')
}

const css = (await readSourceText('../index.css')).replace(/\/\*[\s\S]*?\*\//g, '')

/** The text between the braces of the block that opens at or after `from`. */
function blockAfter(text: string, from: number): string {
  const open = text.indexOf('{', from)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return ''
}

/** Every innermost rule of `text` whose selector list contains `needle`: [selector, body]. */
function rules(text: string, needle: string): [string, string][] {
  const out: [string, string][] = []
  for (const m of text.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim()
    if (selector.includes(needle)) out.push([selector, m[2] ?? ''])
  }
  return out
}

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarations(text: string, selector: string): string {
  const found = rules(text, selector).filter(([s]) =>
    s.split(',').some((part) => part.trim() === selector),
  )
  expect(found, selector).not.toHaveLength(0)
  return found.map(([, body]) => body).join(';')
}

function value(body: string, property: string): string | undefined {
  const m = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)
  return m?.[1]?.trim()
}

/** Everything inside `@media (prefers-reduced-motion: reduce)` blocks. */
const reducedMotion = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)]
  .map((m) => blockAfter(css, m.index))
  .join('\n')

/** The root tokens outside any @supports fallback. */
const rootTokens = rules(css, ':root')
  .map(([, body]) => body)
  .join(';')

const SPRINGS: readonly { name: string; physics: SpringPhysics; ms: number }[] = [
  { name: 'sheet', physics: { stiffness: 380, damping: 40 }, ms: 400 },
  { name: 'palette', physics: { stiffness: 420, damping: 36 }, ms: 250 },
  { name: 'toast', physics: { stiffness: 420, damping: 32 }, ms: 350 },
]

const PARTS = [
  '.sheet-backdrop',
  '.sheet-panel',
  '.palette-backdrop',
  '.palette-panel',
  '.toast-box',
]

describe('motion tokens', () => {
  it.each([
    ['--motion-sheet-ms', 400],
    ['--motion-palette-ms', 250],
    ['--motion-toast-ms', 350],
    ['--motion-sheet-fade-ms', 150],
    ['--motion-palette-fade-ms', 120],
  ])('%s is %d ms, within the 400 ms motion rule', (token, ms) => {
    expect(value(rootTokens, token)).toBe(`${String(ms)}ms`)
    expect(ms).toBeLessThanOrEqual(400)
  })

  it.each(SPRINGS)(
    'the $name easing is framer’s spring as linear(), within 0.01 per stop',
    ({ name, physics, ms }) => {
      const easing = value(rootTokens, `--motion-${name}-ease`) ?? ''
      const inner = /^linear\(([^)]*)\)$/.exec(easing)?.[1]
      expect(inner, easing).toBeDefined()
      const stops = (inner ?? '').split(',').map((s) => Number(s.trim()))
      expect(stops.length).toBeGreaterThanOrEqual(33)
      expect(stops[0]).toBe(0)
      expect(stops.at(-1)).toBe(1)
      const expected = springEasing(physics, ms, stops.length - 1)
      stops.forEach((stop, i) => {
        expect(Math.abs(stop - (expected[i] ?? NaN)), `stop ${String(i)}`).toBeLessThanOrEqual(0.01)
      })
      // Written by spring.ts itself, so a regenerated token is the only way to change a curve.
      expect(easing.replace(/\s+/g, '')).toBe(linearEasing(expected).replace(/\s+/g, ''))
    },
  )

  it('falls back to a cubic-bezier for each spring where linear() is not supported', () => {
    const at = css.indexOf('@supports not (transition-timing-function: linear(0, 1))')
    expect(at).toBeGreaterThan(-1)
    const fallback = blockAfter(css, at)
    for (const { name } of SPRINGS) {
      expect(value(fallback, `--motion-${name}-ease`)).toMatch(
        /^cubic-bezier\(0?\.\d+, 0?\.\d+, 0?\.\d+, 1\)$/,
      )
    }
  })
})

describe('overlay parts', () => {
  it.each(PARTS)('%s transitions transform and opacity only, on the motion tokens', (part) => {
    const transition = value(declarations(css, part), 'transition') ?? ''
    expect(transition).toMatch(/var\(--motion-/)
    const properties = transition.split(',').map((t) => t.trim().split(/\s+/)[0])
    expect(properties.length).toBeGreaterThan(0)
    for (const property of properties) expect(['transform', 'opacity']).toContain(property)
  })

  it('slides a bottom sheet up and a side sheet in from the right, and fades the backdrop', () => {
    expect(value(declarations(css, '.sheet-panel--bottom'), 'transform')).toBe('translateY(100%)')
    expect(value(declarations(css, '.sheet-panel--right'), 'transform')).toBe('translateX(100%)')
    expect(value(declarations(css, "[data-state='open'] > .sheet-panel"), 'transform')).toBe('none')
    expect(value(declarations(css, '.sheet-backdrop'), 'opacity')).toBe('0')
    expect(value(declarations(css, "[data-state='open'] > .sheet-backdrop"), 'opacity')).toBe('1')
    expect(value(declarations(css, '.sheet-panel'), 'transition')).toBe(
      'transform var(--motion-sheet-ms) var(--motion-sheet-ease)',
    )
    expect(value(declarations(css, '.sheet-backdrop'), 'transition')).toBe(
      'opacity var(--motion-sheet-fade-ms) ease-out',
    )
  })

  it('brings the palette down from -16 px at 97 %, and sends it up to -8 px', () => {
    const start = declarations(css, '.palette-panel')
    expect(value(start, 'transform')).toBe('translateY(-16px) scale(0.97)')
    expect(value(start, 'opacity')).toBe('0')
    const open = declarations(css, "[data-state='open'] > .palette-panel")
    expect(value(open, 'transform')).toBe('none')
    expect(value(open, 'opacity')).toBe('1')
    expect(value(declarations(css, "[data-state='closed'] > .palette-panel"), 'transform')).toBe(
      'translateY(-8px) scale(0.97)',
    )
    expect(value(declarations(css, '.palette-backdrop'), 'transition')).toBe(
      'opacity var(--motion-palette-fade-ms) ease-out',
    )
  })

  it('raises a toast from +16 px at 96 %, and lets it drop 8 px as it leaves', () => {
    const start = declarations(css, '.toast-box')
    expect(value(start, 'transform')).toBe('translateY(16px) scale(0.96)')
    expect(value(start, 'opacity')).toBe('0')
    const open = declarations(css, ".toast-box[data-state='open']")
    expect(value(open, 'transform')).toBe('none')
    expect(value(open, 'opacity')).toBe('1')
    expect(value(declarations(css, ".toast-box[data-state='closed']"), 'transform')).toBe(
      'translateY(8px) scale(0.96)',
    )
  })

  it('shrinks the countdown bar with a linear transform-only animation from the left', () => {
    const bar = declarations(css, '.toast-countdown')
    expect(value(bar, 'transform-origin')).toBe('left')
    const animation = value(bar, 'animation') ?? ''
    expect(animation).toMatch(/\blinear\b/)
    const name = /^([\w-]+)/.exec(animation)?.[1] ?? ''
    const keyframes = blockAfter(css, css.indexOf(`@keyframes ${name}`))
    const properties = [...keyframes.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1])
    expect(new Set(properties)).toEqual(new Set(['transform']))
    expect(keyframes).toMatch(/scaleX\(1\)[\s\S]*scaleX\(0\)/)
  })
})

describe('reduced motion', () => {
  it.each(PARTS)('%s holds still: no transform, no translate', (part) => {
    const held = rules(reducedMotion, part).map(([, body]) => body)
    expect(held.join(';')).toMatch(/transform:\s*none\s*!important/)
    expect(held.join(';')).toMatch(/translate:\s*none\s*!important/)
  })

  // Turned on while a part is moving: `transform: none !important` matches the end of an opening
  // transition, which then runs on to its end (CSS Transitions: a running transition whose end
  // value is unchanged is not modified, and a transition outranks !important). Taking the
  // property out of the part's transitions cancels the running one, so it holds still at once.
  it.each(PARTS)('%s stops a transition already running when the setting turns on', (part) => {
    const held = rules(reducedMotion, part).map(([, body]) => body)
    expect(held.join(';')).toMatch(/transition-property:\s*none\s*!important/)
  })

  it('hides the countdown bar', () => {
    expect(value(declarations(reducedMotion, '.toast-countdown'), 'display')).toBe('none')
  })
})

describe('the contract’s own readers', () => {
  it('find declarations and catch a part that animates layout', () => {
    const sample = '.x { transition: top 1s, opacity 1s; } .y{opacity:0}'
    expect(value(declarations(sample, '.x'), 'transition')).toBe('top 1s, opacity 1s')
    expect(value(declarations(sample, '.y'), 'opacity')).toBe('0')
    const properties = (value(declarations(sample, '.x'), 'transition') ?? '')
      .split(',')
      .map((t) => t.trim().split(/\s+/)[0])
    expect(properties).toContain('top')
  })
})
