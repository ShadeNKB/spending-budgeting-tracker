/**
 * Light theme contract (T9, F-045). The app is dark first: the light theme repaints a white- or
 * black-based utility (`text-white`, `border-white/[0.06]`, `hover:border-white/10`) only through
 * a `[data-theme='light'] .<that exact class>` rule in index.css, so a utility with no rule keeps
 * its dark colour in light mode: a white border or ring on a white card. This reads every source
 * file and index.css and fails on any such utility without its light rule. index.css is read from
 * disk (see `readSourceText`); the sources come in through `import.meta.glob`.
 */
import { describe, expect, it } from 'vitest'

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
    throw new Error('the light theme contract runs in the Node process that hosts vitest')
  }
  const file = url.fileURLToPath(new URL(relativeToThisFile, import.meta.url).href)
  return fs.readFileSync(file, 'utf8')
}

const css = (await readSourceText('../index.css')).replace(/\/\*[\s\S]*?\*\//g, '')

const SOURCES = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
)

/**
 * Black- or white-based utilities that are right in both themes, so they have no light rule on
 * purpose. Each says why; one that is no longer used fails below, so the list stays true.
 */
const THEME_INVARIANT: ReadonlyMap<string, string> = new Map([
  ['bg-black/60', 'the scrim behind a sheet or the palette: it dims the page in either theme'],
])

/** Tailwind's colour utilities: the part before `-white` / `-black`. */
const PROPERTY =
  '(?:text|bg|border(?:-[xytrbl])?|divide|ring(?:-offset)?|outline|fill|stroke|from|via|to|shadow|placeholder|decoration|caret|accent)'
/** Variants (`hover:`, `md:`, `group-hover:`) and arbitrary ones (`[[data-theme=light]_&]:`). */
const VARIANTS = String.raw`(?:[\w-]+:|\[(?:[^\]\s[]|\[[^\]\s]*\])+\]:)*`
const OPACITY = String.raw`(?:\/(?:\d+|\[[^\]\s]+\]))?`
const UTILITY = new RegExp(
  String.raw`(?<![\w\-/[:])(${VARIANTS})!?(${PROPERTY}-(?:white|black)${OPACITY})(?![\w\-/])`,
  'g',
)

/** Every white- or black-based utility in the app's sources, with the files that use it. */
function utilitiesInUse(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const [path, text] of Object.entries(SOURCES)) {
    for (const match of text.matchAll(UTILITY)) {
      const variants = match[1] ?? ''
      // A variant that already scopes it to one theme needs no rule from the other.
      if (/data-theme=/.test(variants)) continue
      const utility = variants + (match[2] ?? '')
      const files = found.get(utility) ?? []
      if (!files.includes(path)) files.push(path)
      found.set(utility, files)
    }
  }
  return found
}

/** The class as a CSS selector writes it: a backslash before each `:`, `/`, `[`, `]` and `.`. */
function escapeClass(utility: string): string {
  return utility.replace(/[:/[\].!]/g, (c) => `\\${c}`)
}

/** [start, end) of each `@layer components` / `@layer utilities` block in index.css. */
function variantLayers(): [number, number][] {
  const ranges: [number, number][] = []
  for (const prelude of ['@layer components', '@layer utilities']) {
    let at = css.indexOf(prelude)
    while (at >= 0) {
      const open = css.indexOf('{', at)
      let depth = 0
      for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++
        else if (css[i] === '}' && --depth === 0) {
          ranges.push([open, i])
          break
        }
      }
      at = css.indexOf(prelude, open)
    }
  }
  return ranges
}
const LAYERS = variantLayers()

/** Offsets of every `[data-theme='light'] .<class>` selector for exactly this class. */
function lightRulesFor(utility: string): number[] {
  const selector = `[data-theme='light'] .${escapeClass(utility)}`
  const found: number[] = []
  let at = css.indexOf(selector)
  while (at >= 0) {
    if (!/[\w\\-]/.test(css.charAt(at + selector.length))) found.push(at)
    at = css.indexOf(selector, at + 1)
  }
  return found
}

/**
 * Whether the light theme repaints this utility. Either index.css names it exactly, or it is a
 * Tailwind variant (`hover:`, `md:`) of a class whose light rule sits in `@layer components` or
 * `@layer utilities`: Tailwind treats a class in those layers as its own and builds the variant
 * from it, light rule included: the light rule of `border-white/10` also repaints
 * `hover:border-white/10` on hover.
 */
function hasLightRule(utility: string): boolean {
  if (lightRulesFor(utility).length > 0) return true
  const variant = /^((?:[\w-]+:)+)(.+)$/.exec(utility)
  if (!variant?.[2]) return false
  return lightRulesFor(variant[2]).some((at) => LAYERS.some(([from, to]) => at > from && at < to))
}

describe('the light theme', () => {
  const inUse = utilitiesInUse()

  it('finds the utilities it guards (the scan itself works)', () => {
    expect(inUse.has('text-white')).toBe(true)
    expect(inUse.has('border-white/[0.06]')).toBe(true)
    expect(inUse.has('hover:text-white')).toBe(true)
  })

  it('has a light rule for every white- or black-based utility the app uses', () => {
    const missing = [...inUse]
      .filter(([utility]) => !THEME_INVARIANT.has(utility) && !hasLightRule(utility))
      .map(([utility, files]) => `${utility} (${files.join(', ')})`)
      .sort()
    expect(missing).toEqual([])
  })

  it('keeps its list of theme-invariant utilities to ones still in use', () => {
    expect([...THEME_INVARIANT.keys()].filter((utility) => !inUse.has(utility))).toEqual([])
  })

  // Class names below are split mid-word: Tailwind scans this file too, and a whole utility it
  // does not build already would be added to the stylesheet.
  const cls = (...parts: string[]) => parts.join('')

  it('reads a rule only for the exact class, never a longer one that starts the same', () => {
    expect(escapeClass(cls('hover:bor', 'der-white/[0.1]'))).toBe(
      cls(String.raw`hover\:bor`, String.raw`der-white\/\[0\.1\]`),
    )
    // text-white/15 has a rule; a /1 opacity must not borrow it.
    expect(hasLightRule('text-white/15')).toBe(true)
    expect(hasLightRule(cls('text-wh', 'ite/1'))).toBe(false)
  })

  it('counts a Tailwind variant of a class whose light rule is in a layer Tailwind builds from', () => {
    expect(hasLightRule(cls('focus:bor', 'der-white/10'))).toBe(true)
    expect(hasLightRule(cls('focus:ri', 'ng-white/10'))).toBe(false)
  })
})
