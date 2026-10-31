/**
 * Accessibility guards that read the source (T6, F-066). Three rules no single component test
 * can hold for the whole app:
 *
 * 1. One focus indicator. The global `:focus-visible` outline (index.css) is the only focus
 *    style. Tailwind ring utilities, utilities that remove the outline, and focus borders or
 *    shadows drawn per component were the reason focus was nearly invisible (a 25 % alpha halo,
 *    gone in forced colours and the same as "selected"). The only exception is a container that
 *    takes focus from code and is never tabbed to: a dialog panel or a `tabIndex={-1}` heading
 *    (and the C2 `.field-control`, whose `.field-focus` frame draws the indicator).
 * 2. Reduced motion. Every module that animates (Web Animations with keyframes, `usePresence`,
 *    a pointer drag) honours the user's `prefers-reduced-motion`: it asks
 *    `prefersReducedMotion()` (src/ui/motion.ts) before it moves anything, or carries the CSS
 *    guard `motion-reduce:!transform-none` on what it moves. And no module imports an animation
 *    library: framer-motion went in T5b, for CSS transitions and the Web Animations API.
 * 3. No focusable element hidden from assistive tech: `aria-hidden` never sits on an element
 *    that is in the tab order (a non-negative or computed `tabIndex`, or a natively focusable
 *    tag without `tabIndex={-1}`).
 *
 * Sources are read through Vite (`?raw`), like lazy-imports.test.ts, and parsed with the
 * TypeScript compiler, so class names are found in JSX attributes, `clsx` calls, template
 * literals and `cva` tables alike. Nested interactive content and the rendered result are
 * checked by axe in the e2e matrix (e2e/a11y.spec.ts).
 */
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Class names in this file are written in capitals and lowered here. Tailwind reads every file
 * under src for class names, tests included: written as they are, the banned names in the rules
 * and samples below would be compiled into the app's stylesheet.
 */
const tw = (classes: string) => classes.toLowerCase()

const SOURCES = import.meta.glob<string>(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

// ─── parsing ──────────────────────────────────────────────────────────────────

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement

const parsed = new Map<string, { text: string; file: ts.SourceFile }>()

/** Parses `text` once: an app file read by several rules is parsed for the first of them. */
function parse(path: string, text: string): ts.SourceFile {
  const hit = parsed.get(path)
  if (hit?.text === text) return hit.file
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  parsed.set(path, { text, file })
  return file
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => {
    walk(child, visit)
  })
}

function isJsxTag(node: ts.Node): node is JsxTag {
  return ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
}

function enclosingTag(node: ts.Node): JsxTag | null {
  for (let at = node.parent; !ts.isSourceFile(at); at = at.parent) {
    if (isJsxTag(at)) return at
    // A string inside a child element's body belongs to that child, not to this tag.
    if (ts.isJsxElement(at) || ts.isJsxFragment(at)) return null
  }
  return null
}

function attribute(tag: JsxTag, name: string): ts.JsxAttribute | undefined {
  return tag.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  )
}

/** The attribute's literal value: a string, a number, a boolean, or null when computed. */
function literalValue(attr: ts.JsxAttribute): string | number | boolean | null {
  const init = attr.initializer
  if (init === undefined) return true
  if (ts.isStringLiteral(init)) return init.text
  if (!ts.isJsxExpression(init) || init.expression === undefined) return null
  const expr = init.expression
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isNumericLiteral(expr)) return Number(expr.text)
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  )
    return -Number(expr.operand.text)
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
  return null
}

const tagName = (tag: JsxTag) => tag.tagName.getText()

/** Every piece of literal text in the file: strings, template chunks and JSX attribute strings. */
function literalTexts(file: ts.SourceFile): { text: string; node: ts.Node }[] {
  const out: { text: string; node: ts.Node }[] = []
  walk(file, (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      // Import specifiers are module names, not class lists.
      if (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) return
      out.push({ text: node.text, node })
    }
  })
  return out
}

// ─── rule 1: one focus indicator ──────────────────────────────────────────────

const VARIANTS = String.raw`(?:[\w-]+:)*`
const ON_FOCUS = String.raw`${tw('FOCUS')}(?:-visible|-within)?:`
/** An outline removed (`none`) or zeroed (`0`). */
const OUTLINE_OFF = new RegExp(
  String.raw`^${VARIANTS}(?:${tw('OUTLINE-NONE')}|${tw('OUTLINE-0')})$`,
)
/** Ad-hoc focus styles that replace or fake the global :focus-visible outline. */
const BANNED_FOCUS = [
  new RegExp(String.raw`^${VARIANTS}${ON_FOCUS}${tw('RING')}(?:-|$)`),
  new RegExp(String.raw`^${VARIANTS}${ON_FOCUS}${tw('SHADOW')}(?:-|$)`),
  new RegExp(String.raw`^${VARIANTS}${ON_FOCUS}${tw('BORDER')}(?:-|$)`),
  OUTLINE_OFF,
]
const HEADING = /^h[1-6]$/

/**
 * A container that only ever takes focus from code (a dialog panel, a `tabIndex={-1}` heading
 * or main) may hide the indicator index.css hides for it anyway; a C2 `.field-control` draws none
 * because its `.field-focus` wrapper does.
 */
function mayDropOutline(tag: JsxTag | null): boolean {
  if (!tag) return false
  const className = attribute(tag, 'className')
  const classText = className?.initializer?.getText() ?? ''
  if (/\bfield-control\b/.test(classText)) return true
  const tabIndex = attribute(tag, 'tabIndex')
  if (!tabIndex || literalValue(tabIndex) !== -1) return false
  const role = attribute(tag, 'role')
  const name = tagName(tag)
  return (
    (role !== undefined && literalValue(role) === 'dialog') ||
    HEADING.test(name) ||
    name === 'main' ||
    // A heading picked at run time (`const Heading = scope === 'app' ? 'h1' : 'h2'`).
    /^Heading$/.test(name)
  )
}

function bannedFocusStyles(path: string, text: string): string[] {
  const found: string[] = []
  const file = parse(path, text)
  for (const { text: literal, node } of literalTexts(file)) {
    for (const token of literal.split(/\s+/)) {
      if (!BANNED_FOCUS.some((re) => re.test(token))) continue
      if (OUTLINE_OFF.test(token) && mayDropOutline(enclosingTag(node))) continue
      const { line } = file.getLineAndCharacterOfPosition(node.getStart())
      found.push(`${path}:${String(line + 1)} ${token}`)
    }
  }
  return found
}

// ─── rule 2: reduced motion ───────────────────────────────────────────────────

/** framer-motion, its successor `motion` and their parts (the packages T5b removed). */
const ANIMATION_LIBRARY = /^(?:framer-motion|motion|motion-dom|motion-utils)(?:\/|$)/

/** A static import or re-export of an animation library, or a dynamic `import()` of one. */
function importsAnimationLibrary(path: string, text: string): boolean {
  let found = false
  walk(parse(path, text), (node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined
    if (specifier && ts.isStringLiteral(specifier) && ANIMATION_LIBRARY.test(specifier.text))
      found = true
  })
  return found
}

/**
 * Moves something on screen: a Web Animation with keyframes (`el.animate(keyframes, …)`), an
 * element that animates in and out (`usePresence(…)`), or a drag (`el.setPointerCapture(…)`).
 */
function animates(path: string, text: string): boolean {
  let found = false
  walk(parse(path, text), (node) => {
    if (!ts.isCallExpression(node)) return
    const callee = node.expression
    if (ts.isPropertyAccessExpression(callee)) {
      const name = callee.name.text
      if ((name === 'animate' && node.arguments.length > 0) || name === 'setPointerCapture')
        found = true
    } else if (ts.isIdentifier(callee) && callee.text === 'usePresence') {
      found = true
    }
  })
  return found
}

/** `prefersReducedMotion()` called. */
function asksReducedMotion(file: ts.SourceFile): boolean {
  let asks = false
  walk(file, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'prefersReducedMotion'
    )
      asks = true
  })
  return asks
}

/** `prefersReducedMotion()` called, or `motion-reduce:!transform-none` in its class text. */
function honoursReducedMotion(path: string, text: string): boolean {
  const file = parse(path, text)
  const guard = tw('MOTION-REDUCE:!TRANSFORM-NONE')
  return (
    asksReducedMotion(file) ||
    literalTexts(file).some(({ text: t }) => t.split(/\s+/).includes(guard))
  )
}

// ─── rule 3: nothing focusable inside aria-hidden ─────────────────────────────

const NATIVELY_FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])

function focusableHidden(path: string, text: string): string[] {
  const found: string[] = []
  const file = parse(path, text)
  walk(file, (node) => {
    if (!isJsxTag(node)) return
    const hidden = attribute(node, 'aria-hidden')
    if (!hidden) return
    const value = literalValue(hidden)
    if (value === false || value === 'false') return
    const tabIndex = attribute(node, 'tabIndex')
    const index = tabIndex ? literalValue(tabIndex) : undefined
    const tabbable =
      tabIndex !== undefined
        ? typeof index !== 'number' || index >= 0
        : NATIVELY_FOCUSABLE.has(tagName(node))
    if (!tabbable) return
    const { line } = file.getLineAndCharacterOfPosition(node.getStart())
    found.push(`${path}:${String(line + 1)} <${tagName(node)}>`)
  })
  return found
}

// ─── the rules, on the app ────────────────────────────────────────────────────

describe('accessibility guards (source)', () => {
  const files = Object.entries(SOURCES)
  /** The files whose text contains `word`: only those can break the rule that looks for it. */
  const mentioning = (word: RegExp) => files.filter(([, text]) => word.test(text))
  /**
   * Parsing with the TypeScript compiler is CPU-bound: on a CI runner busy with the whole suite
   * a scan can pass the 5 s default, though it never waits on anything.
   */
  const SCAN = 30_000

  it('scans the app source', () => {
    expect(files.length).toBeGreaterThan(40)
    expect(Object.keys(SOURCES)).toContain('/src/ui/Sheet.tsx')
  })

  it(
    'draws no ad-hoc focus styles: the global :focus-visible outline is the only indicator',
    () => {
      const candidates = mentioning(/focus|outline/)
      expect(candidates.length).toBeGreaterThan(10)
      expect(candidates.flatMap(([path, text]) => bannedFocusStyles(path, text))).toEqual([])
    },
    SCAN,
  )

  it(
    'honours prefers-reduced-motion in every module that animates',
    () => {
      const animating = mentioning(/\.animate\(|usePresence\(|setPointerCapture\(/).filter(
        ([path, text]) => animates(path, text),
      )
      // Sheet, the palette, the toast host and the ledger row's swipe.
      expect(animating.length).toBeGreaterThanOrEqual(4)
      expect(
        animating.filter(([path, text]) => !honoursReducedMotion(path, text)).map(([path]) => path),
      ).toEqual([])
    },
    SCAN,
  )

  it(
    'imports no animation library: framer-motion and its parts are gone',
    () => {
      const named = mentioning(/framer-motion|['"]motion(?:-dom|-utils)?['"/]/)
      expect(
        named.filter(([path, text]) => importsAnimationLibrary(path, text)).map(([p]) => p),
      ).toEqual([])
    },
    SCAN,
  )

  it(
    'puts nothing focusable under aria-hidden',
    () => {
      const candidates = mentioning(/aria-hidden/)
      expect(candidates.length).toBeGreaterThan(10)
      expect(candidates.flatMap(([path, text]) => focusableHidden(path, text))).toEqual([])
    },
    SCAN,
  )
})

// ─── the detectors themselves (they must catch what they guard) ───────────────

describe('accessibility guard detectors', () => {
  const tsx = (body: string) => `export const X = () => (${body})`
  /** The findings for `classes` on line 1 of `path`. */
  const found = (path: string, ...classes: string[]) => classes.map((c) => `${path}:1 ${tw(c)}`)

  it('flags rings, removed outlines, focus borders and shadows wherever the class string lives', () => {
    expect(
      bannedFocusStyles('/a.tsx', tsx(`<button className="${tw('PX-2 FOCUS-VISIBLE:RING-2')}" />`)),
    ).toEqual(found('/a.tsx', 'FOCUS-VISIBLE:RING-2'))
    expect(
      bannedFocusStyles(
        '/b.tsx',
        tsx(
          `<div className={clsx("a", on && "${tw('MD:FOCUS:OUTLINE-NONE FOCUS:BORDER-ACCENT/60')}")} />`,
        ),
      ),
    ).toEqual(found('/b.tsx', 'MD:FOCUS:OUTLINE-NONE', 'FOCUS:BORDER-ACCENT/60'))
    expect(
      bannedFocusStyles(
        '/c.tsx',
        `const v = cva("${tw('INLINE-FLEX OUTLINE-NONE FOCUS-WITHIN:SHADOW-[0_0_0_3PX_RED]')}")`,
      ),
    ).toEqual(found('/c.tsx', 'OUTLINE-NONE', 'FOCUS-WITHIN:SHADOW-[0_0_0_3PX_RED]'))
    expect(
      bannedFocusStyles(
        '/d.tsx',
        tsx('<div className={`x ${a} ' + tw('FOCUS-VISIBLE:RING-INSET') + '`} />'),
      ),
    ).toEqual(found('/d.tsx', 'FOCUS-VISIBLE:RING-INSET'))
  })

  it('flags a focus border on any focus variant and an outline zeroed instead of removed', () => {
    expect(
      bannedFocusStyles(
        '/f.tsx',
        tsx(
          `<label className="${tw('FOCUS-WITHIN:BORDER-ACCENT FOCUS-VISIBLE:BORDER-2 SM:OUTLINE-0')}" />`,
        ),
      ),
    ).toEqual(
      found('/f.tsx', 'FOCUS-WITHIN:BORDER-ACCENT', 'FOCUS-VISIBLE:BORDER-2', 'SM:OUTLINE-0'),
    )
    // The ring's offset or colour may be tuned; only removing or replacing the ring is banned.
    expect(
      bannedFocusStyles(
        '/g.tsx',
        tsx(
          `<button className="${tw('FOCUS-VISIBLE:OUTLINE-OFFSET-0 BORDER-2 OUTLINE-OFFSET-2')}" />`,
        ),
      ),
    ).toEqual([])
    expect(
      bannedFocusStyles('/h.tsx', tsx(`<h1 tabIndex={-1} className="${tw('OUTLINE-0')}">x</h1>`)),
    ).toEqual([])
  })

  it('lets only code-focused containers and C2 field controls drop the outline', () => {
    const ok = [
      `<h1 tabIndex={-1} className="${tw('OUTLINE-NONE')}">Ledger</h1>`,
      `<Heading ref={r} tabIndex={-1} className="${tw('FOCUS:OUTLINE-NONE')}">x</Heading>`,
      `<div role="dialog" tabIndex={-1} className="${tw('OUTLINE-NONE')}" />`,
      `<input className="${tw('FIELD-CONTROL OUTLINE-NONE')}" />`,
      `<div className="${tw('GROUP-FOCUS-WITHIN:OPACITY-100 FOCUS-INSET')}" />`,
    ]
    for (const body of ok) expect(bannedFocusStyles('/ok.tsx', tsx(body)), body).toEqual([])
    const bad = [
      `<h1 className="${tw('OUTLINE-NONE')}">Ledger</h1>`,
      `<button tabIndex={-1} className="${tw('OUTLINE-NONE')}" />`,
      `<h1 tabIndex={-1} className="${tw('FOCUS-VISIBLE:RING-2')}">Ledger</h1>`,
    ]
    for (const body of bad) expect(bannedFocusStyles('/bad.tsx', tsx(body)), body).toHaveLength(1)
  })

  it('a string in a child element is judged by the child, not by its parent', () => {
    expect(
      bannedFocusStyles(
        '/e.tsx',
        tsx(`<h1 tabIndex={-1}><span className="${tw('OUTLINE-NONE')}">x</span></h1>`),
      ),
    ).toEqual(found('/e.tsx', 'OUTLINE-NONE'))
  })

  it('knows a module that animates: keyframes, presence or a drag, never a mention', () => {
    const moving = [
      'export const f = (el: Element) => el.animate([{ opacity: 0 }, { opacity: 1 }], 200)',
      'export function X({ open }: { open: boolean }) { return usePresence(open, { parts }) }',
      'export const f = (el: Element, id: number) => { el.setPointerCapture(id) }',
    ]
    for (const body of moving) expect(animates('/a.tsx', body), body).toBe(true)
    const still = [
      'export const can = typeof Element.prototype.animate === "function"',
      'export const n = (el: Element) => el.getAnimations().length',
      '// el.animate([{ opacity: 0 }]), usePresence(open), el.setPointerCapture(1)',
      'export function usePresence() { return null }',
      'export const f = (a: { animate: () => void }) => { a.animate() }',
    ]
    for (const body of still) expect(animates('/b.tsx', body), body).toBe(false)
  })

  it('recognises prefersReducedMotion() and the motion-reduce guard class, never a comment', () => {
    expect(
      honoursReducedMotion('/m.ts', 'export const f = () => (prefersReducedMotion() ? 0 : 1)'),
    ).toBe(true)
    expect(
      honoursReducedMotion(
        '/m.tsx',
        tsx(`<div className="${tw('FIXED INSET-0 MOTION-REDUCE:!TRANSFORM-NONE')}" />`),
      ),
    ).toBe(true)
    expect(
      honoursReducedMotion(
        '/m.tsx',
        `const c = clsx("${tw('ROUNDED-XL MOTION-REDUCE:!TRANSFORM-NONE')}", tone)`,
      ),
    ).toBe(true)
    expect(honoursReducedMotion('/m.ts', '// prefersReducedMotion() in a comment')).toBe(false)
    expect(
      honoursReducedMotion('/m.tsx', tsx(`<div className="${tw('MOTION-REDUCE:OPACITY-50')}" />`)),
    ).toBe(false)
    // Imported but never asked.
    expect(honoursReducedMotion('/m.ts', "import { prefersReducedMotion } from './motion'")).toBe(
      false,
    )
  })

  it('flags an import of framer-motion or its parts, static, re-exported or dynamic', () => {
    const bad = [
      "import { motion } from 'framer-motion'",
      "import { animate } from 'motion/react'",
      "import { spring } from 'motion-dom'",
      "export { frame } from 'motion-utils'",
      "export const load = () => import('framer-motion')",
    ]
    for (const body of bad) expect(importsAnimationLibrary('/x.ts', body), body).toBe(true)
    const ok = [
      "import { prefersReducedMotion } from './motion'",
      "import { spring } from '../ui/spring'",
      "// import { motion } from 'framer-motion'",
      "export const name = 'framer-motion'",
    ]
    for (const body of ok) expect(importsAnimationLibrary('/y.ts', body), body).toBe(false)
  })

  it('flags aria-hidden on anything in the tab order', () => {
    const bad = [
      '<div aria-hidden tabIndex={0} />',
      '<div aria-hidden="true" tabIndex={active ? 0 : -1} />',
      '<button aria-hidden="true" />',
      '<a aria-hidden href="/ledger" />',
    ]
    for (const body of bad) expect(focusableHidden('/h.tsx', tsx(body)), body).toHaveLength(1)
    const ok = [
      '<button aria-hidden="true" tabIndex={-1} data-swipe-delete />',
      '<span aria-hidden className="x" />',
      '<button aria-hidden={false} />',
      '<Icon aria-hidden />',
    ]
    for (const body of ok) expect(focusableHidden('/h.tsx', tsx(body)), body).toEqual([])
  })
})
