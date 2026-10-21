/**
 * Platform contract: the build and deploy surface that no component test can see.
 *
 * index.html (pre-paint theme script, head hygiene, font preloads), vercel.json (security
 * headers, CSP, SPA rewrite), vite.config.js (no third-party font hosts), src/index.css
 * (self-hosted @font-face, colour scheme, the coarse-pointer 16 px floor, the compositor-only
 * logo glow) and public/fonts. Each block pins one contract from the T5 platform spec, so a
 * later edit that silently breaks the CSP hash, the theme flash fix or iOS focus zoom fails here.
 *
 * Files are read through Vite (`?raw` text, `import.meta.glob` listings with `?inline` base64
 * bytes) and hashed with Web Crypto: the src program is typed for the browser only (TypeScript
 * includes no Node types), and Vite resolves exactly the files the build ships. index.css is
 * the one exception, see `readSourceText`.
 */
import { createElement } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import viteConfig from '../../vite.config.js?raw'
import vercelJson from '../../vercel.json?raw'
import vercelConfig from '../../vercel.json'
import { SpendLogo } from '../ui/SpendLogo'

interface NodeFs {
  readFileSync: (path: string, encoding: 'utf8') => string
}
interface NodeUrl {
  fileURLToPath: (url: string) => string
}

/** Runtime check that a loaded module exposes the function this suite calls on it. */
function exposes<T>(mod: unknown, fn: keyof T & string): mod is T {
  return typeof mod === 'object' && mod !== null && typeof Reflect.get(mod, fn) === 'function'
}

/**
 * Vitest replaces every .css module with an empty string (`?raw` included) unless CSS
 * processing is switched on, so a stylesheet's source is read from disk. The Node built-ins are
 * loaded by name at runtime and checked, since the src program has no Node declarations.
 */
async function readSourceText(relativeToThisFile: string): Promise<string> {
  const load = (name: string): Promise<unknown> => import(/* @vite-ignore */ name)
  const [fs, url] = await Promise.all([load('node:fs'), load('node:url')])
  if (!exposes<NodeFs>(fs, 'readFileSync') || !exposes<NodeUrl>(url, 'fileURLToPath')) {
    throw new Error('the platform contract runs in the Node process that hosts vitest')
  }
  const file = url.fileURLToPath(new URL(relativeToThisFile, import.meta.url).href)
  return fs.readFileSync(file, 'utf8')
}

const indexCss = await readSourceText('../index.css')

/** Every file under public/, keyed by its path from the project root ('/public/...'). */
const PUBLIC_FILES = import.meta.glob<string>('/public/**/*', {
  query: '?inline',
  import: 'default',
  eager: true,
})

const exists = (publicPath: string) => Object.hasOwn(PUBLIC_FILES, `/public${publicPath}`)

/** Bytes of a binary file under public/ (Vite inlines it as a base64 data URL). */
function publicBytes(publicPath: string): Uint8Array {
  const dataUrl = PUBLIC_FILES[`/public${publicPath}`] ?? ''
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.slice(0, comma).endsWith(';base64')) {
    throw new Error(`public${publicPath} is missing or not inlined as base64`)
  }
  return Uint8Array.from(atob(dataUrl.slice(comma + 1)), (c) => c.charCodeAt(0))
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to))

const uint32 = (bytes: Uint8Array, at: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at)

const utf8Length = (text: string) => new TextEncoder().encode(text).length

const DARK = { theme: 'dark', color: '#0c0b0a' } as const
const LIGHT = { theme: 'light', color: '#faf8f5' } as const

const LATIN_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

function inlineScripts(doc: Document): HTMLScriptElement[] {
  return [...doc.querySelectorAll('script')].filter((s) => !s.hasAttribute('src'))
}

/** The CSP source expression for a script: base64 SHA-256 of its UTF-8 text, as browsers hash it. */
async function sha256Source(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`
}

function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) directives.set(name.toLowerCase(), sources)
  }
  return directives
}

function catchAllHeaders(): Map<string, string> {
  const rule = vercelConfig.headers.find((h) => h.source === '/(.*)')
  return new Map((rule?.headers ?? []).map((h) => [h.key, h.value]))
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Brace depth at `index` (0 = top level, outside every @layer/@media block). */
function depthAt(css: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return depth
}

/** Body of the balanced `{ ... }` block that opens at or after `from`. */
function blockAfter(css: string, from: number): string {
  const open = css.indexOf('{', from)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return ''
}

/** Every rule whose selector list contains `needle`, as [selector, declarations]. */
function rulesMatching(css: string, needle: string): [string, string][] {
  const out: [string, string][] = []
  for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim()
    if (selector.includes(needle)) out.push([selector, m[2] ?? ''])
  }
  return out
}

// jsdom ships no type declarations (and @types/jsdom is not a dependency), so the one
// constructor this suite needs is described locally. Vitest's jsdom environment exposes its
// JSDOM instance as the documented `jsdom` global; its constructor builds fresh windows.
interface JsdomOptions {
  url: string
  runScripts: 'dangerously'
  beforeParse: (window: Window) => void
}
type JsdomConstructor = new (html: string, options: JsdomOptions) => { window: Window }

function isJsdomConstructor(value: unknown): value is JsdomConstructor {
  return typeof value === 'function' && value.name === 'JSDOM'
}

function jsdomConstructor(): JsdomConstructor {
  const dom: unknown = Reflect.get(globalThis, 'jsdom')
  const ctor = typeof dom === 'object' && dom !== null ? dom.constructor : undefined
  if (!isJsdomConstructor(ctor)) throw new Error('needs the vitest jsdom environment')
  return ctor
}

const JSDOM = jsdomConstructor()

type Stored = 'dark' | 'light' | 'system' | 'junk' | null | 'throws'
type Os = 'dark' | 'light' | 'no-matchMedia'

/** Loads the real index.html in a fresh window with scripts on, as a browser would. */
function bootIndexHtml(stored: Stored, os: Os) {
  const { window } = new JSDOM(indexHtml, {
    url: 'https://spendtrack.test/pulse',
    runScripts: 'dangerously',
    beforeParse(win) {
      if (stored === 'throws') {
        Object.defineProperty(win, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException('Access is denied', 'SecurityError')
          },
        })
      } else {
        win.localStorage.clear()
        if (stored !== null) win.localStorage.setItem('spendtrack:theme', stored)
      }
      Object.defineProperty(win, 'matchMedia', {
        configurable: true,
        value:
          os === 'no-matchMedia'
            ? undefined
            : (query: string) => ({
                media: query,
                matches: query.includes('dark') ? os === 'dark' : os === 'light',
              }),
      })
    },
  })
  const doc = window.document
  const result = {
    dataTheme: doc.documentElement.getAttribute('data-theme'),
    themeColor: doc.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
    colorScheme: doc.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
  }
  window.close()
  return result
}

describe('index.html: the pre-paint theme script', () => {
  const doc = parseHtml(indexHtml)
  const scripts = inlineScripts(doc)
  const script = scripts[0]?.textContent ?? ''

  it('has exactly one inline script: classic, single line, ES5, under 600 bytes', () => {
    expect(scripts).toHaveLength(1)
    expect(scripts[0]?.hasAttribute('type')).toBe(false)
    expect(script).not.toMatch(/[\r\n]/)
    expect(script).not.toMatch(/=>|`|\b(?:let|const|class)\b/)
    expect(utf8Length(script)).toBeLessThan(600)
    expect(script).toContain("'spendtrack:theme'")
  })

  it('pins the script hash in the CSP script-src, with no unsafe script sources', async () => {
    const scriptSrc = parseCsp(catchAllHeaders().get('Content-Security-Policy') ?? '').get(
      'script-src',
    )
    expect(scriptSrc).toEqual(["'self'", await sha256Source(script)])
  })

  it('declares one theme-color and one color-scheme meta, both before the script', () => {
    const themeMetas = doc.querySelectorAll('meta[name="theme-color"]')
    const schemeMetas = doc.querySelectorAll('meta[name="color-scheme"]')
    expect(themeMetas).toHaveLength(1)
    expect(schemeMetas).toHaveLength(1)
    expect(themeMetas[0]?.getAttribute('content')).toBe(DARK.color)
    expect(schemeMetas[0]?.getAttribute('content')).toBe('dark light')
    const headChildren = [...doc.head.children]
    const scriptAt = headChildren.findIndex((el) => el.tagName === 'SCRIPT')
    expect(scriptAt).toBeGreaterThan(-1)
    for (const meta of [...themeMetas, ...schemeMetas]) {
      expect(headChildren.indexOf(meta)).toBeLessThan(scriptAt)
    }
    const firstStyle = headChildren.findIndex(
      (el) => el.tagName === 'STYLE' || el.matches('link[rel="stylesheet"]'),
    )
    if (firstStyle >= 0) expect(scriptAt).toBeLessThan(firstStyle)
  })

  // The C2 resolution table, run against the real index.html in a scripted window.
  const table: [Stored, Os, typeof DARK | typeof LIGHT][] = [
    ['dark', 'dark', DARK],
    ['dark', 'light', DARK],
    ['light', 'dark', LIGHT],
    ['light', 'light', LIGHT],
    ['system', 'dark', DARK],
    ['system', 'light', LIGHT],
    [null, 'dark', DARK],
    [null, 'light', LIGHT],
    ['junk', 'dark', DARK],
    ['junk', 'light', LIGHT],
    ['throws', 'dark', DARK],
    ['throws', 'light', LIGHT],
    [null, 'no-matchMedia', DARK],
    ['system', 'no-matchMedia', DARK],
    ['light', 'no-matchMedia', LIGHT],
  ]

  it.each(table)('stored %s with OS %s resolves to %o', (stored, os, expected) => {
    expect(bootIndexHtml(stored, os)).toEqual({
      dataTheme: expected.theme,
      themeColor: expected.color,
      colorScheme: expected.theme,
    })
  })
})

describe('index.html: head hygiene', () => {
  const doc = parseHtml(indexHtml)

  it('has no manifest link in source (the PWA plugin injects the only one, in head)', () => {
    expect(doc.querySelectorAll('link[rel="manifest"]')).toHaveLength(0)
    expect(Object.keys(PUBLIC_FILES).filter((path) => path.endsWith('.webmanifest'))).toEqual([])
  })

  it('never blocks pinch zoom', () => {
    const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
    expect(viewport).toContain('viewport-fit=cover')
    expect(viewport).not.toMatch(/maximum-scale|user-scalable/)
  })

  it('preloads at most 3 self-hosted woff2 faces, each CORS-matched and present on disk', () => {
    const preloads = [...doc.querySelectorAll('link[rel="preload"]')]
    expect(preloads.length).toBeGreaterThan(0)
    expect(preloads.length).toBeLessThanOrEqual(3)
    for (const link of preloads) {
      expect(link.getAttribute('as')).toBe('font')
      expect(link.getAttribute('type')).toBe('font/woff2')
      expect(link.hasAttribute('crossorigin')).toBe(true)
      const href = link.getAttribute('href') ?? ''
      expect(href).toMatch(/^\/fonts\/[a-z0-9-]+\.woff2$/)
      expect(exists(href), href).toBe(true)
    }
  })

  it.each([
    ['icon-maskable-192.png', 192],
    ['icon-maskable-512.png', 512],
    ['apple-touch-icon.png', 180],
    ['shortcut-add-96.png', 96],
  ])('%s is an opaque %ipx square (RGB PNG, no alpha channel)', (file, size) => {
    const png = publicBytes(`/${file}`)
    expect(ascii(png, 1, 4)).toBe('PNG')
    expect([uint32(png, 16), uint32(png, 20)]).toEqual([size, size])
    // IHDR colour type 2 = truecolour without alpha: opaque by construction.
    expect(png[25]).toBe(2)
  })

  it('references only install icons that exist', () => {
    const touch = doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')
    expect(touch).toBe('/apple-touch-icon.png')
    const icons = [...doc.querySelectorAll('link[rel="icon"]')]
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      const href = icon.getAttribute('href') ?? ''
      expect(exists(href), href).toBe(true)
    }
  })
})

describe('no third-party font hosts', () => {
  it.each([
    ['index.html', indexHtml],
    ['vercel.json', vercelJson],
    ['vite.config.js', viteConfig],
    ['src/index.css', indexCss],
  ])('%s never mentions Google Fonts', (_name, text) => {
    expect(text).not.toMatch(/googleapis|gstatic/i)
  })
})

describe('vercel.json: security headers and SPA rewrite', () => {
  it('puts the catch-all header rule first, then sw.js and the manifest', () => {
    expect(vercelConfig.headers.map((h) => h.source)).toEqual([
      '/(.*)',
      '/sw.js',
      '/manifest.webmanifest',
    ])
  })

  it('sends exactly the six security headers, in order, with exact values', () => {
    const rule = vercelConfig.headers[0]
    expect(rule?.headers.map((h) => h.key)).toEqual([
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'X-Frame-Options',
      'Cross-Origin-Opener-Policy',
      'Permissions-Policy',
    ])
    const headers = catchAllHeaders()
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headers.get('X-Frame-Options')).toBe('DENY')
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
    expect(headers.get('Permissions-Policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), display-capture=()',
    )
  })

  it('enforces a CSP that allows only this app, its fonts and Supabase', async () => {
    const csp = parseCsp(catchAllHeaders().get('Content-Security-Policy') ?? '')
    const script = inlineScripts(parseHtml(indexHtml))[0]?.textContent ?? ''
    expect(Object.fromEntries(csp)).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", await sha256Source(script)],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'],
      'manifest-src': ["'self'"],
      'worker-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    })
  })

  it('keeps the sw.js no-cache rule and the manifest content type', () => {
    const sw = vercelConfig.headers.find((h) => h.source === '/sw.js')
    expect(sw?.headers).toEqual([
      { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
    ])
    const manifest = vercelConfig.headers.find((h) => h.source === '/manifest.webmanifest')
    expect(manifest?.headers).toEqual([{ key: 'Content-Type', value: 'application/manifest+json' }])
  })

  // Vercel serves existing files first and applies rewrites to the pathname (no query).
  const rewrite = vercelConfig.rewrites[0]
  const pattern = new RegExp(`^${rewrite?.source ?? '$^'}$`, 'i')
  const rewritten = (url: string) => pattern.test(new URL(url, 'https://x.test').pathname)

  it('has one SPA rewrite to /index.html', () => {
    expect(vercelConfig.rewrites).toHaveLength(1)
    expect(rewrite?.destination).toBe('/index.html')
  })

  it.each(['/', '/pulse', '/ledger', '/insights', '/pulse?add=1', '/entry', '/ledger/deep'])(
    'rewrites the app route %s to the shell',
    (url) => {
      expect(rewritten(url)).toBe(true)
    },
  )

  it.each([
    '/assets/LedgerScreen-old.js',
    '/assets/index-old.css',
    '/fonts/a.woff2',
    '/fonts/ibm-plex-sans-latin-400-normal.woff2',
  ])('lets a missing %s 404 instead of answering with HTML', (url) => {
    expect(rewritten(url)).toBe(false)
  })
})

describe('self-hosted fonts', () => {
  const css = stripComments(indexCss)
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '')
  const prop = (face: string, name: string) =>
    new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(face)?.[1]?.trim() ?? ''

  it('declares the 8 latin faces the design uses, swap display, latin unicode-range', () => {
    const pairs = faces.map((f) => `${prop(f, 'font-family')} ${prop(f, 'font-weight')}`)
    expect(pairs.sort()).toEqual(
      ["'IBM Plex Sans'", "'JetBrains Mono'"]
        .flatMap((family) => ['400', '500', '600', '700'].map((w) => `${family} ${w}`))
        .sort(),
    )
    for (const face of faces) {
      expect(prop(face, 'font-style')).toBe('normal')
      expect(prop(face, 'font-display')).toBe('swap')
      expect(prop(face, 'unicode-range').replace(/\s+/g, '')).toBe(LATIN_RANGE)
      expect(prop(face, 'src')).toMatch(/^url\('\/fonts\/[a-z0-9-]+\.woff2'\) format\('woff2'\)$/)
    }
  })

  it('every /fonts url in index.css exists in public/fonts and is a real woff2', () => {
    const urls = [...css.matchAll(/url\(['"]?(\/fonts\/[^'")]+)['"]?\)/g)].map((m) => m[1] ?? '')
    expect(urls).toHaveLength(8)
    expect(new Set(urls).size).toBe(8)
    for (const url of urls) {
      expect(ascii(publicBytes(url), 0, 4), url).toBe('wOF2')
    }
  })

  it('ships exactly the 8 woff2 files plus both OFL licences and a README', () => {
    const fontDir = Object.keys(PUBLIC_FILES)
      .filter((path) => path.startsWith('/public/fonts/'))
      .map((path) => path.slice('/public/fonts/'.length))
    expect(fontDir.sort()).toEqual(
      [
        ...['400', '500', '600', '700'].map((w) => `ibm-plex-sans-latin-${w}-normal.woff2`),
        ...['400', '500', '600', '700'].map((w) => `jetbrains-mono-latin-${w}-normal.woff2`),
        'LICENSE-ibm-plex-sans.txt',
        'LICENSE-jetbrains-mono.txt',
        'README.txt',
      ].sort(),
    )
    for (const licence of ['LICENSE-ibm-plex-sans.txt', 'LICENSE-jetbrains-mono.txt']) {
      const text = new TextDecoder().decode(publicBytes(`/fonts/${licence}`))
      expect(text).toContain('SIL Open Font License, Version 1.1')
    }
  })
})

describe('index.css: colour scheme', () => {
  const css = stripComments(indexCss)

  it('tells the browser which scheme each theme paints, so native controls follow it', () => {
    expect(blockAfter(css, css.indexOf(':root {'))).toMatch(/color-scheme:\s*dark;/)
    expect(blockAfter(css, css.indexOf("[data-theme='light'] {"))).toMatch(/color-scheme:\s*light;/)
  })
})

describe('index.css: the coarse-pointer 16 px floor (no iOS focus zoom)', () => {
  const css = stripComments(indexCss)
  const at = css.indexOf('@media (pointer: coarse)')
  const body = blockAfter(css, at)

  it('is an unlayered rule, so it beats every component font-size utility', () => {
    expect(at).toBeGreaterThan(-1)
    expect(depthAt(css, at)).toBe(0)
    expect(at).toBeGreaterThan(css.lastIndexOf('@layer'))
  })

  it('floors text inputs, selects and textareas at 16 px, skipping non-text inputs', () => {
    expect(body).toMatch(/font-size:\s*16px\s*!important/)
    expect(body).toMatch(/\bselect\b/)
    expect(body).toMatch(/\btextarea\b/)
    const unquoted = body.replace(/['"]/g, '')
    for (const type of ['checkbox', 'radio', 'range', 'color', 'file', 'hidden']) {
      expect(unquoted).toContain(`[type=${type}]`)
    }
  })

  it('keeps the base 16 px / 14 px (>= 640 px) pair that sizes the shared Input', () => {
    const base = blockAfter(css, css.indexOf('@layer base'))
    expect(base).toMatch(/input,\s*select,\s*textarea\s*\{\s*font-size:\s*16px;/)
    expect(base).toMatch(
      /@media \(min-width: 640px\)\s*\{\s*input,\s*select,\s*textarea\s*\{\s*font-size:\s*14px;/,
    )
  })
})

describe('logo glow: compositor-only, never infinite', () => {
  const css = stripComments(indexCss)

  it('drops the box-shadow keyframes that repainted the blurred header every frame', () => {
    expect(css).not.toMatch(/@keyframes logo-glow\s*\{/)
    for (const [selector, decls] of rulesMatching(css, '.logo-glow')) {
      expect(`${selector} { ${decls} }`).not.toMatch(/infinite/)
    }
  })

  it('puts the static glow on ::after and animates only its opacity', () => {
    const after = rulesMatching(css, '.logo-glow::after').find(([s]) => s === '.logo-glow::after')
    const decls = after?.[1] ?? ''
    expect(decls).toMatch(/box-shadow:\s*0 0 22px -2px rgba\(34,\s*211,\s*238,\s*0\.7\)/)
    expect(decls).toMatch(/opacity:\s*0\.6/)
    expect(decls).toMatch(/pointer-events:\s*none/)
    expect(decls).toMatch(/border-radius:\s*inherit/)
    const name = /animation:\s*([\w-]+)/.exec(decls)?.[1] ?? ''
    expect(name).not.toBe('')
    const keyframes = blockAfter(css, css.indexOf(`@keyframes ${name}`))
    const properties = [...keyframes.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1])
    expect(properties.length).toBeGreaterThan(0)
    expect(new Set(properties)).toEqual(new Set(['opacity']))
  })

  it('holds still under reduced motion', () => {
    let reduced = ''
    for (const m of css.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)) {
      reduced += blockAfter(css, m.index)
    }
    expect(reduced).toMatch(/\.logo-glow::after\s*\{[^}]*animation:\s*none/)
  })

  it('SpendLogo marks the animated wrapper with the class instead of an inline animation', () => {
    const animated = render(createElement(SpendLogo, { size: 28, animated: true }))
    const wrapper = animated.container.firstElementChild
    expect(wrapper).toHaveClass('logo-glow')
    expect(wrapper?.getAttribute('style') ?? '').not.toMatch(/animation/)
    animated.unmount()

    const still = render(createElement(SpendLogo, { size: 28 }))
    expect(still.container.firstElementChild).not.toHaveClass('logo-glow')
    still.unmount()
  })
})
