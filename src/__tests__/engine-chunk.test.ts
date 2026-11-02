/**
 * The data engine is its own chunk (track spec P2-1).
 *
 * The data core and the local engine (src/data/**) measure about 47 KB minified, three times what
 * the entry chunk may grow by. They load as the lazy `engine` chunk that main.tsx starts fetching
 * before React renders, so the entry chunk must never import src/data at runtime: one value
 * import from a screen or a store would silently pull the whole core into the first download.
 * Type-only imports are erased and pass. The sync bridge (syncEngine, itself lazy) may import the
 * core.
 */
import { describe, expect, it } from 'vitest'
import { DEMO_PREFIX } from '../data/core/constants'
import { SAMPLE_ID_PREFIX } from '../stores/useExpenseStore'

const SOURCES = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
)

/** Modules allowed to import src/data at runtime. */
const ALLOWED = (path: string): boolean =>
  path.startsWith('/src/data/') || path === '/src/stores/syncEngine.ts'

/** Resolves a relative specifier against the importing file (posix, no file system). */
function resolve(from: string, spec: string): string {
  if (!spec.startsWith('.')) return spec
  const parts = from.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

// import … from '…' / export … from '…' / import '…', across lines
const STATIC =
  /^[ \t]*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]|^[ \t]*import\s+['"]([^'"]+)['"]/gm

interface Edge {
  readonly file: string
  readonly target: string
  readonly typeOnly: boolean
}

function edges(file: string, text: string): Edge[] {
  const out: Edge[] = []
  for (const m of text.matchAll(STATIC)) {
    const spec = m[4] ?? m[5]
    if (spec === undefined) continue
    const clause = m[3] ?? ''
    // `import { type A, type B } from` is erased too
    const inline = /^\{([^}]*)\}$/.exec(clause.trim())
    const allTypes =
      inline !== null &&
      (inline[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .every((s) => s.startsWith('type '))
    out.push({ file, target: resolve(file, spec), typeOnly: m[2] !== undefined || allTypes })
  }
  return out
}

const all = Object.entries(SOURCES).flatMap(([file, text]) => edges(file, text))

describe('the engine chunk (P2-1)', () => {
  it('finds the imports it guards (the pattern matches real code)', () => {
    expect(all.length).toBeGreaterThan(300)
    expect(all.some((e) => e.target.startsWith('/src/data/') && e.typeOnly)).toBe(true)
  })

  it('tells a value import from a type-only one', () => {
    const sample = [
      "import { dayOf } from '../data/core/dates'",
      "import type { Doc } from '../data/core/types'",
      "import { type Doc, type Stamp } from '../data/core/types'",
      'import {',
      '  encodeWire,',
      '  type Doc,',
      "} from '../data/core/wire'",
      "export { OTHER } from '../data/core/constants'",
      "import '../data/local/engine'",
    ].join('\n')
    const found = edges('/src/lib/x.ts', sample).map((e) => [e.target, e.typeOnly])
    expect(found).toEqual([
      ['/src/data/core/dates', false],
      ['/src/data/core/types', true],
      ['/src/data/core/types', true],
      ['/src/data/core/wire', false],
      ['/src/data/core/constants', false],
      ['/src/data/local/engine', false],
    ])
  })

  it('no module outside src/data (and the lazy sync bridge) imports src/data at runtime', () => {
    const bad = all
      .filter((e) => !ALLOWED(e.file) && e.target.startsWith('/src/data/') && !e.typeOnly)
      .map((e) => `${e.file} → ${e.target}`)
    expect(bad).toEqual([])
  })

  it('the facade loads the engine only through importWithReload', () => {
    const facade = SOURCES['/src/stores/useExpenseStore.ts'] ?? ''
    expect(facade).toMatch(/importWithReload\(\(\) => import\('\.\.\/data\/local\/engine'\)\)/)
    expect([...facade.matchAll(/\bimport\(/g)]).toHaveLength(1)
  })

  // The facade names the sample rows' prefix itself (no runtime import of the core).
  it('the facade’s sample-row prefix is the core’s demo prefix', () => {
    expect(SAMPLE_ID_PREFIX).toBe(DEMO_PREFIX)
  })

  it('main.tsx starts the engine load before anything else runs', () => {
    const main = SOURCES['/src/main.tsx'] ?? ''
    const firstStatement = main
      .split('\n')
      .find((line) => line.trim() !== '' && !/^(import|\/\/)/.test(line.trim()))
    expect(firstStatement?.trim()).toBe('startEngineLoad()')
  })
})
