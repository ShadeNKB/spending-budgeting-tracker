import { describe, expect, it } from 'vitest'

// Every write to localStorage goes through the one safe writer, `safeSet` in
// src/services/storage.ts (OPERATING-MANUAL; F-043): it raises the quota event, so a full
// storage is said on screen instead of swallowed. This scans the app's source for direct writes
// to a Storage: setItem, removeItem, clear, and assignment by key. Each file allowed one says why
// and how many, so a new write fails here, in an allowed file too. (An ESLint rule would be the
// usual tool; the lint config is held still, so the guard is a test, like the move record's.)

const SOURCES = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
)

interface Allowed {
  readonly writes: number
  readonly why: string
}

const ALLOWED: Readonly<Record<string, Allowed>> = {
  '/src/services/storage.ts': {
    writes: 5,
    why: 'the safe writer itself, its best-effort remover, and Disconnect removing the sync keys',
  },
  '/src/lib/chunkReload.ts': {
    writes: 1,
    why: 'the stale-chunk reload guard, in sessionStorage: a refused write means no automatic reload, never a "storage full" warning about the data',
  },
  '/src/data/local/io.ts': {
    writes: 1,
    why: "the local engine's removeKey on the area it booted on (rotation, shedding, Remove from this device): a removal cannot hit the quota, and its writes already use safeSet",
  },
  '/src/data/sync/move.ts': {
    writes: 1,
    why: "removeMove, best effort on this module's own bound storage: a removal cannot hit the quota, and the next sweep decides again",
  },
  '/src/features/settings/previousCode.ts': {
    writes: 1,
    why: 'forgetPrevious, best effort: a removal cannot hit the quota, and blocked storage holds no slot to forget',
  },
}

/** The source without comments: a comment that names a call is not one. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\w])\/\/.*$/gm, '$1')

const WRITE = [
  /\.\s*(?:setItem|removeItem)\b/g,
  /\b(?:localStorage|sessionStorage)\s*(?:\.\s*clear\b|\[)/g,
  /\b(?:localStorage|sessionStorage)\s*\.\s*(?!getItem\b|key\b|length\b)\w+\s*=(?!=)/g,
]

const writesIn = (text: string): number =>
  WRITE.reduce((n, pattern) => n + (code(text).match(pattern)?.length ?? 0), 0)

describe('direct storage writes', () => {
  it('appear only where the allow-list says, as many as it says', () => {
    const found: Record<string, number> = {}
    for (const [path, text] of Object.entries(SOURCES)) {
      const n = writesIn(text)
      if (n > 0) found[path] = n
    }
    const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([p, a]) => [p, a.writes]))
    expect(found).toEqual(allowed)
  })

  it('catches each form of write, and not a read or a comment', () => {
    expect(writesIn("localStorage.setItem('k', 'v')")).toBe(1)
    expect(writesIn("window.localStorage.removeItem('k')")).toBe(1)
    expect(writesIn('area.setItem(key, value)')).toBe(1)
    expect(writesIn('Storage.prototype.setItem.call(s, k, v)')).toBe(1)
    expect(writesIn('sessionStorage.clear()')).toBe(1)
    expect(writesIn("localStorage['k'] = 'v'")).toBe(1)
    expect(writesIn("localStorage.k = 'v'")).toBe(1)
    expect(writesIn("localStorage.getItem('k') === null")).toBe(0)
    expect(writesIn('map.clear()')).toBe(0)
    expect(writesIn("// localStorage.setItem('k', 'v')\n/* area.removeItem(k) */")).toBe(0)
    expect(writesIn("const url = 'https://x.test'; localStorage.setItem('k', url)")).toBe(1)
  })

  it('gives every allowed file a reason', () => {
    for (const { writes, why } of Object.values(ALLOWED)) {
      expect(writes).toBeGreaterThan(0)
      expect(why.length).toBeGreaterThan(20)
    }
  })
})
