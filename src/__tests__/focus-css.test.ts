/**
 * Focus and target contract (T6 C2): the one focus indicator every control shares, the field
 * and inset variants, the coarse-pointer hit area, forced-colours selected states, focus kept
 * clear of the sticky header and the TabBar, and the solid danger fill. index.css is read from
 * disk (see `readSourceText`), so a later edit that brings back an invisible ring fails here.
 */
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import tailwindConfig from '../../tailwind.config.js?raw'
import { TabBar } from '../app/TabBar'
import { TopBar } from '../app/TopBar'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Pill } from '../ui/Pill'
import { Segmented } from '../ui/Segmented'
import { Select } from '../ui/Select'

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
    throw new Error('the focus contract runs in the Node process that hosts vitest')
  }
  const file = url.fileURLToPath(new URL(relativeToThisFile, import.meta.url).href)
  return fs.readFileSync(file, 'utf8')
}

const css = (await readSourceText('../index.css')).replace(/\/\*[\s\S]*?\*\//g, '')

/** Brace depth at `index` (0 = top level, outside every @layer/@media block). */
function depthAt(index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return depth
}

/** Body of the balanced `{ ... }` block that opens at or after `from`. */
function blockAfter(source: string, from: number): string {
  const open = source.indexOf('{', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return ''
}

/** Bodies of every block opened by exactly this at-rule prelude. */
function blocks(prelude: string, source = css): string[] {
  const out: string[] = []
  let at = source.indexOf(prelude)
  while (at >= 0) {
    out.push(blockAfter(source, at))
    at = source.indexOf(prelude, at + prelude.length)
  }
  return out
}

/** Every innermost rule as [selector, declarations]. */
function rules(source = css): [string, string][] {
  return [...source.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => [
    (m[1] ?? '').trim().replace(/\s+/g, ' '),
    m[2] ?? '',
  ])
}

/** Declarations of the rules whose whole selector list equals `selector`. */
function declarationsOf(selector: string, source = css): string {
  return rules(source)
    .filter(([s]) => s === selector)
    .map(([, d]) => d)
    .join(';')
}

function tokenIn(block: string, name: string): string {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? ''
}

function luminance(hex: string): number {
  const channels = (hex.replace('#', '').match(/../g) ?? []).map((c) => {
    const v = parseInt(c, 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  const [r = 0, g = 0, b = 0] = channels
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const darkTokens = blockAfter(css, css.indexOf(':root {'))
const lightTokens = blockAfter(css, css.indexOf("[data-theme='light'] {"))
const SURFACES = ['--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-4']

describe('focus ring tokens', () => {
  it('defines a solid --focus-ring per theme: cyan on dark, cyan-700 on light', () => {
    expect(tokenIn(darkTokens, '--focus-ring').toLowerCase()).toBe('#22d3ee')
    expect(tokenIn(lightTokens, '--focus-ring').toLowerCase()).toBe('#0e7490')
  })

  it.each([
    ['dark', darkTokens],
    ['light', lightTokens],
  ])('reaches 3:1 against every %s surface', (_theme, tokens) => {
    const ring = tokenIn(tokens, '--focus-ring')
    expect(ring).toMatch(/^#[0-9a-f]{6}$/i)
    for (const surface of SURFACES) {
      const bg = tokenIn(tokens, surface)
      expect(bg, surface).toMatch(/^#[0-9a-f]{6}$/i)
      expect(contrast(ring, bg), `${surface} ${bg}`).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('the global focus indicator', () => {
  it('draws a 2 px solid outline in the ring colour, 2 px out, on :focus-visible', () => {
    const decls = declarationsOf(':focus-visible')
    expect(decls).toMatch(/outline:\s*2px solid var\(--focus-ring\)/)
    expect(decls).toMatch(/outline-offset:\s*2px/)
  })

  it('hides the outline only for pointer focus (:focus without :focus-visible)', () => {
    expect(declarationsOf(':focus:not(:focus-visible)')).toMatch(/outline:\s*none/)
    expect(rules().some(([s]) => /(^|,\s*)\*:focus(\s*,|$)/.test(s))).toBe(false)
  })

  it('never removes an outline without a replacement', () => {
    const allowed = new Set([
      ':focus:not(:focus-visible)',
      // Replaced by the .field-focus wrapper ring (same @supports block, checked below).
      '.field-control:focus-visible',
      // Programmatic-focus containers: a dialog panel, a screen heading, the skip-link target.
      "[role='dialog']:focus-visible",
      "[role='alertdialog']:focus-visible",
      "h1[tabindex='-1']:focus-visible",
      "main[tabindex='-1']:focus-visible",
    ])
    const offenders = rules()
      .filter(([, d]) => /outline(-style)?:\s*(none|0)\b/.test(d))
      .flatMap(([s]) => s.split(',').map((part) => part.trim()))
      .filter((part) => !allowed.has(part))
    expect(offenders).toEqual([])
  })

  it('uses no box-shadow ring and no shape change on focus', () => {
    for (const [selector, decls] of rules()) {
      if (!selector.includes(':focus')) continue
      expect(decls, selector).not.toMatch(/box-shadow|border-radius/)
    }
  })
})

describe('field and inset variants', () => {
  const supports = blocks('@supports selector(:has(*))').join('\n')

  it('moves a field control’s ring onto its .field-focus wrapper (one indicator per field)', () => {
    expect(declarationsOf('.field-control:focus-visible', supports)).toMatch(/outline:\s*none/)
    const wrapper = declarationsOf('.field-focus:has(.field-control:focus-visible)', supports)
    expect(wrapper).toMatch(/outline:\s*2px solid var\(--focus-ring\)/)
    expect(wrapper).toMatch(/outline-offset:\s*2px/)
  })

  it('removes the control’s own outline only where :has() can draw the wrapper ring', () => {
    const outside = css.replace(supports, '')
    expect(declarationsOf('.field-control:focus-visible', outside)).toBe('')
  })

  it('insets the ring for controls flush against a clipping edge', () => {
    const inset = rules().filter(([s]) => s.includes('.focus-inset'))
    expect(inset.map(([s]) => s).join(',')).toContain('.focus-inset:focus-visible')
    for (const [, decls] of inset) expect(decls).toMatch(/outline-offset:\s*-2px/)
    expect(
      rules(supports).some(
        ([s, d]) => s.includes('.field-focus.focus-inset:has(') && /outline-offset:\s*-2px/.test(d),
      ),
    ).toBe(true)
  })
})

describe('coarse-pointer hit area (.tap-target)', () => {
  const coarse = blocks('@media (pointer: coarse)')

  it('lives only in top-level coarse-pointer blocks, so laptops keep their design sizes', () => {
    let at = css.indexOf('@media (pointer: coarse)')
    while (at >= 0) {
      expect(depthAt(at)).toBe(0)
      at = css.indexOf('@media (pointer: coarse)', at + 1)
    }
    let outside = css
    for (const body of coarse) outside = outside.replace(body, '')
    expect(rules(outside).filter(([s]) => s.includes('.tap-target'))).toEqual([])
  })

  it('adds an invisible, centred 44 x 44 px minimum hit area without resizing the element', () => {
    const all = coarse.join('\n')
    const after = declarationsOf('.tap-target::after', all)
    expect(after).toMatch(/content:\s*''/)
    expect(after).toMatch(/position:\s*absolute/)
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(after).toMatch(new RegExp(`${side}:\\s*min\\(0px,\\s*calc\\(50% - 22px\\)\\)`))
    }
    expect(after).not.toMatch(/background|border|box-shadow/)
    // Zero specificity: a positioned utility (absolute, fixed, sticky) keeps its position.
    expect(declarationsOf(':where(.tap-target)', all)).toMatch(/position:\s*relative/)
    expect(declarationsOf('.tap-target', all)).toBe('')
  })
})

describe('forced colours', () => {
  const forced = blocks('@media (forced-colors: active)').join('\n')
  const CHOSEN = [
    "[aria-pressed='true']",
    "[aria-checked='true']",
    "[aria-selected='true']",
    "[aria-current='page']",
  ]
  const fills = rules(forced).filter(([, d]) => /background:\s*Highlight/.test(d))

  it('paints every chosen state as the system selection, so it never relies on colour alone', () => {
    expect(fills).toHaveLength(1)
    const [selector = '', decls = ''] = fills[0] ?? []
    for (const state of CHOSEN) expect(selector).toContain(state)
    expect(decls).toMatch(/forced-color-adjust:\s*none/)
    expect(decls).toMatch(/color:\s*HighlightText/)
  })

  it('carries the selection into what a chosen element holds (a day button in its gridcell)', () => {
    const inside = rules(forced).find(([s]) => /\)\s*\*$/.test(s))
    const [selector = '', decls = ''] = inside ?? []
    for (const state of CHOSEN) expect(selector).toContain(state)
    expect(decls).toMatch(/color:\s*inherit/)
    // Inherited, not transparent: the inner control itself computes to the selection colours.
    expect(decls).toMatch(/background-color:\s*inherit/)
    expect(decls).not.toMatch(/transparent/)
  })

  it('rings today in the selection colour instead of filling it, so today never reads as chosen', () => {
    expect(fills.map(([s]) => s).join(',')).not.toContain("aria-current='date'")
    expect(declarationsOf("[aria-current='date']", forced)).toMatch(/border-color:\s*Highlight/)
  })

  it('keeps the focus outline, in a system colour', () => {
    expect(declarationsOf(':focus-visible', forced)).toMatch(/outline-color:\s*CanvasText/)
    expect(forced).not.toMatch(/outline:\s*none/)
  })
})

describe('focus is never hidden behind the sticky header or the TabBar', () => {
  const CONTROLS = ['a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]']

  it('keeps a focused control in the screen clear of the header, by its height plus room for a text field and its ring', () => {
    const [selector = '', decls = ''] = rules().find(([s]) => s.startsWith('main :where(')) ?? []
    for (const control of CONTROLS) expect(selector).toContain(control)
    const margin = /scroll-margin-top:\s*calc\(var\(--app-header-h,\s*72px\)\s*\+\s*(\d+)px\)/.exec(
      decls,
    )
    // WebKit reveals a focused text field's caret line, about 16 px inside the field's box.
    expect(Number(margin?.[1] ?? 0)).toBeGreaterThanOrEqual(20)
  })

  // As the page's scroll-padding the offset also applied to the header's own controls: each Tab
  // through the header, focus going back to Search, and typing in the header's quick add
  // scrolled the page under it. And WebKit moves the page whenever that padding changes (the
  // header's height is measured).
  it('leaves the header out: no top scroll-padding on the page', () => {
    expect(declarationsOf('html')).not.toMatch(/scroll-padding-top/)
  })

  it('pads the bottom by the TabBar (and the home indicator) below 768 px', () => {
    const phone = blocks('@media (max-width: 767px)').join('\n')
    const pad =
      /scroll-padding-bottom:\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*(\d+)px\)/.exec(
        declarationsOf('html', phone),
      )
    expect(Number(pad?.[1] ?? 0)).toBeGreaterThanOrEqual(80)
  })
})

describe('reduced motion', () => {
  const reduced = blocks('@media (prefers-reduced-motion: reduce)').join('\n')

  it('keeps the global block that stills animations, transitions and smooth scroll', () => {
    const decls = declarationsOf('*, *::before, *::after', reduced)
    expect(decls).toMatch(/animation-duration:\s*0\.01ms !important/)
    expect(decls).toMatch(/animation-iteration-count:\s*1 !important/)
    expect(decls).toMatch(/transition-duration:\s*0\.01ms !important/)
    expect(decls).toMatch(/scroll-behavior:\s*auto !important/)
  })

  // That block gives every element a 0.01 ms transition on every property, outline included,
  // so the first frame after Tab painted the outline's unfocused values (currentColor, 3 px,
  // offset 0): a transparent-text select showed no ring and inset rings were cut off.
  it('draws the ring whole on its first frame: a focused control or field frame takes no transition', () => {
    expect(declarationsOf(':focus-visible', reduced)).toMatch(
      /transition-duration:\s*0s\s*!important/,
    )
    const supports = blocks('@supports selector(:has(*))').join('\n')
    const inside = blocks('@media (prefers-reduced-motion: reduce)', supports).join('\n')
    expect(declarationsOf('.field-focus:has(.field-control:focus-visible)', inside)).toMatch(
      /transition-duration:\s*0s\s*!important/,
    )
  })
})

describe('focus scrolling', () => {
  it('stops short of a scroller’s edge by more than the ring (2 px offset + 2 px), in any scroller', () => {
    const [selector = '', decls = ''] =
      rules().find(([, d]) => /(^|;)\s*scroll-margin:/.test(d)) ?? []
    // Zero specificity: a component's own scroll-margin utility (the heatmap's) still wins.
    expect(selector.startsWith(':where(')).toBe(true)
    for (const control of ['a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]']) {
      expect(selector).toContain(control)
    }
    const margin = Number(/scroll-margin:\s*(\d+)px/.exec(decls)?.[1] ?? 0)
    expect(margin).toBeGreaterThanOrEqual(6)
  })
})

describe('solid danger fill (dangerSolid)', () => {
  const solid =
    /negative:\s*\{\s*DEFAULT:\s*'(#[0-9A-Fa-f]{6})',\s*solid:\s*'(#[0-9A-Fa-f]{6})'/.exec(
      tailwindConfig,
    )

  it('adds negative.solid next to the unchanged negative colour', () => {
    expect(solid?.[1]?.toUpperCase()).toBe('#EF4444')
    expect(solid?.[2]?.toUpperCase()).toBe('#DC2626')
  })

  it('keeps its white label at 4.5:1 in both themes', () => {
    expect(contrast('#ffffff', solid?.[2] ?? '#000000')).toBeGreaterThanOrEqual(4.5)
    // The light theme remaps .text-white to dark text; the label on the solid fill stays white.
    expect(declarationsOf("[data-theme='light'] .bg-negative-solid.text-white")).toMatch(
      /color:\s*#fff\b/,
    )
  })
})

describe('primitives rely on the shared ring and hit area', () => {
  const BANNED =
    /(^|\s)(focus(-visible|-within)?:(ring|outline|shadow|border)\S*|outline-none)(\s|$)/

  it('Button: no ad-hoc ring; small and medium sizes get the coarse hit area', () => {
    const sizes = ['sm', 'md', 'lg', 'icon', 'iconSm'] as const
    for (const size of sizes) {
      const { getByRole, unmount } = render(
        createElement(Button, { size, variant: 'dangerSolid' }, size),
      )
      const button = getByRole('button')
      expect(button.className).not.toMatch(BANNED)
      expect(button).toHaveClass('bg-negative-solid', 'text-white')
      // One transition list for colour, shadow and the press scale (two utilities overrode each
      // other, so hover colours used to snap).
      expect(button).toHaveClass('transition')
      expect(button.className).not.toMatch(/transition-(colors|transform)/)
      if (size === 'lg') expect(button).not.toHaveClass('tap-target')
      else expect(button).toHaveClass('tap-target')
      unmount()
    }
  })

  // Forced colours drop a fill but paint a border, transparent or not: without one, "Save
  // changes" or "Yes, delete all" read as plain text beside a bordered Cancel.
  it('Button: every variant with a fill has a border, so forced colours still outline it', () => {
    for (const variant of ['primary', 'dangerSolid', 'ghost'] as const) {
      const { getByRole, unmount } = render(createElement(Button, { variant }, variant))
      expect(getByRole('button')).toHaveClass('border')
      unmount()
    }
    const { getByRole } = render(createElement(Button, { variant: 'primary' }, 'Add'))
    expect(getByRole('button')).toHaveClass('border-transparent', 'bg-accent')
  })

  it('Input: the frame rings, and the input fills the whole box, side padding included', () => {
    const { getByRole } = render(createElement(Input, { label: 'Amount' }))
    const input = getByRole('textbox', { name: 'Amount' })
    expect(input).toHaveClass('field-control', 'h-full', 'min-w-0', 'pl-3', 'pr-3')
    expect(input.className).not.toMatch(BANNED)
    const frame = input.closest('.field-focus')
    expect(frame).not.toBeNull()
    expect(frame?.className ?? '').not.toMatch(BANNED)
    // No padding or gap of its own: a click anywhere inside the frame's border is in the input.
    expect(frame?.className ?? '').not.toMatch(/(^|\s)(p[xlr]?|gap)-/)
  })

  it('Input: a prefix and a suffix take the frame’s side padding; the gaps beside them are the input’s', () => {
    const { getByRole, getByText } = render(
      createElement(Input, { label: 'Amount', prefix: 'S$', suffix: 'SGD' }),
    )
    const input = getByRole('textbox', { name: 'Amount' })
    expect(input).toHaveClass('pl-2', 'pr-2')
    expect(input).not.toHaveClass('pl-3', 'pr-3')
    expect(getByText('S$')).toHaveClass('pl-3')
    expect(getByText('SGD')).toHaveClass('pr-3')
  })

  it('Select: the global outline only', () => {
    const { getByRole } = render(
      createElement(Select, { label: 'Size' }, createElement('option', { value: 's' }, 'Small')),
    )
    expect(getByRole('combobox', { name: 'Size' }).className).not.toMatch(BANNED)
  })

  it('Segmented and clickable Pill carry the hit area and no ad-hoc ring', () => {
    const { getAllByRole, getByRole } = render(
      createElement(
        'div',
        null,
        createElement(Segmented, {
          label: 'Period',
          value: 'month',
          onChange: () => undefined,
          options: [
            { value: 'month', label: 'Month' },
            { value: 'year', label: 'Year' },
          ],
        }),
        createElement(Pill, {
          onClick: () => undefined,
          'aria-label': 'Remove filter',
          children: 'x',
        }),
      ),
    )
    for (const radio of getAllByRole('radio')) {
      expect(radio).toHaveClass('tap-target', 'min-w-11')
      expect(radio.className).not.toMatch(BANNED)
    }
    expect(getByRole('button', { name: 'Remove filter' })).toHaveClass('tap-target')
  })
})

describe('the sticky header and the tab bar', () => {
  const root = document.documentElement
  const shell = (path = '/pulse') =>
    render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(TopBar),
        createElement(TabBar),
      ),
    )

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    root.style.removeProperty('--app-header-h')
  })

  it('publishes the header height as --app-header-h, follows it as it grows, and clears it', () => {
    let height = 78.4
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, 0, 1280, this.tagName === 'HEADER' ? height : 0)
    })
    let resized: (() => void) | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback
        }
        observe = () => undefined
        disconnect = () => undefined
      },
    )

    const { unmount } = shell()
    expect(root.style.getPropertyValue('--app-header-h')).toBe('79px')

    // The update banner opens under the bar: the scroll margin follows the taller header.
    height = 122
    act(() => {
      resized?.()
    })
    expect(root.style.getPropertyValue('--app-header-h')).toBe('122px')

    unmount()
    expect(root.style.getPropertyValue('--app-header-h')).toBe('')
  })

  it('still publishes the height once where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 375, 64),
    )
    shell()
    expect(root.style.getPropertyValue('--app-header-h')).toBe('64px')
  })

  it('names the palette button by its visible word, "Search", with its shortcut keys', () => {
    shell()
    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+K Meta+K',
    )
  })

  it('keeps the save and sync status region heard at every width (visually hidden below xl)', () => {
    shell()
    const [header] = screen.getAllByRole('banner')
    // The SyncPill's polite region (quick add's own status span has no aria-live).
    const region = header?.querySelector('[role="status"][aria-live="polite"]')
    expect(region).not.toBeNull()
    // Below 1280 px the pill has no room: its wrapper is screen-reader-only there, never
    // display: none, which would silence the live region on phones.
    const wrapper = region?.parentElement?.parentElement
    expect(wrapper).toHaveClass('sr-only', 'xl:not-sr-only')
    expect(wrapper).not.toHaveClass('hidden')
  })

  it('labels both navigations "Primary"; the logo is a plain link, never "current page"', () => {
    shell('/pulse')
    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'SpendTrack' })).not.toHaveAttribute('aria-current')
    const pulse = screen.getAllByRole('link', { name: 'Pulse' })
    expect(pulse).toHaveLength(2)
    for (const link of pulse) expect(link).toHaveAttribute('aria-current', 'page')
  })

  it('gives every header control under 44 px, and the round Add button, a 44 px touch hit area', () => {
    shell()
    const [header] = screen.getAllByRole('navigation', { name: 'Primary' })
    const small = [
      screen.getByRole('link', { name: 'SpendTrack' }),
      ...(header ? Array.from(header.querySelectorAll('a')) : []),
      screen.getByRole('button', { name: 'Search' }),
      screen.getByRole('button', { name: 'Settings' }),
      screen.getByRole('button', { name: 'Add expense' }),
    ]
    expect(small).toHaveLength(7)
    for (const control of small) expect(control).toHaveClass('tap-target')
  })

  // With no home indicator (an Android phone, an iPhone SE) the tabs end at the screen's bottom
  // edge, which would cut off the bottom of an outer ring.
  it('draws the tab bar items’ focus ring inside them, clear of the screen edge', () => {
    shell()
    const [, tabBar] = screen.getAllByRole('navigation', { name: 'Primary' })
    const items = [
      ...(tabBar ? Array.from(tabBar.querySelectorAll('a')) : []),
      screen.getByRole('button', { name: 'Open settings' }),
    ]
    expect(items).toHaveLength(4)
    for (const item of items) expect(item).toHaveClass('focus-inset')
  })
})
