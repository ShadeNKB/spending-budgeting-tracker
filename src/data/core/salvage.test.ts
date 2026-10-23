// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { salvageJsonArray } from './salvage'

/** CPU- and WebCrypto-heavy suites: generous so a fully loaded parallel run (all time zones, simulations) cannot flake. */
const HEAVY = { timeout: 60_000 }

// ---------------------------------------------------------------------------------------------
// Helpers (local on purpose: U2 imports nothing from the rest of the data layer)
// ---------------------------------------------------------------------------------------------

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('must: missing value')
  return value
}

/** Seeded PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const int = (r: () => number, n: number): number => Math.floor(r() * n)

const parseJson = (raw: string): unknown => JSON.parse(raw)

const NASTY = [
  '"',
  '\\',
  ',',
  ']',
  '[',
  '{',
  '}',
  ':',
  ' ',
  '\n',
  'é',
  '🍜',
  'Kopi',
  '\\u0041',
  '\u0000',
]

function randomValue(r: () => number, depth = 0): unknown {
  const pick = int(r, depth > 2 ? 6 : 8)
  switch (pick) {
    case 0:
      return null
    case 1:
      return r() < 0.5
    case 2:
      return Math.round((r() - 0.5) * 10 ** int(r, 8)) / 10 ** int(r, 3)
    case 3:
      return int(r, 2) === 0 ? 1e21 * r() : -int(r, 1000)
    case 4:
    case 5: {
      let s = ''
      for (let i = int(r, 8); i > 0; i--) s += must(NASTY[int(r, NASTY.length)])
      return s
    }
    case 6:
      return Array.from({ length: int(r, 4) }, () => randomValue(r, depth + 1))
    default: {
      const o: Record<string, unknown> = {}
      for (let i = int(r, 4); i > 0; i--)
        o['k' + String(int(r, 9)) + ','] = randomValue(r, depth + 1)
      return o
    }
  }
}

interface Layout {
  readonly text: string
  readonly parts: readonly {
    readonly json: string
    readonly end: number
    readonly closed: boolean
  }[]
}

/** Lays an array out by hand so every element's span is known (compact or with whitespace). */
function layout(values: readonly unknown[], pretty: boolean): Layout {
  const open = pretty ? '[\n  ' : '['
  const sep = pretty ? ',\n  ' : ','
  const close = pretty ? '\n]' : ']'
  let text = open
  const parts: { json: string; end: number; closed: boolean }[] = []
  values.forEach((v, i) => {
    if (i > 0) text += sep
    const json = JSON.stringify(v)
    text += json
    parts.push({ json, end: text.length, closed: /^[[{"]/.test(json) })
  })
  return { text: text + close, parts }
}

/**
 * The oracle: an element survives a cut at k when its whole text is before the cut and it is
 * provably finished: a container or string (closed by its own last character), or anything
 * followed by its delimiter or whitespace. A bare number at the cut may itself be cut (12 of 125).
 */
function expectedAt(l: Layout, k: number): unknown[] {
  return l.parts
    .filter((p) => p.end <= k && (p.closed || k > p.end))
    .map((p): unknown => JSON.parse(p.json))
}

// ---------------------------------------------------------------------------------------------

describe('salvageJsonArray: intact input', HEAVY, () => {
  it('returns every element of a valid array as complete', () => {
    const r = rng(21)
    for (let i = 0; i < 200; i++) {
      const values = Array.from({ length: int(r, 12) }, () => randomValue(r))
      for (const pretty of [false, true]) {
        const { text } = layout(values, pretty)
        expect(salvageJsonArray(text)).toEqual({
          items: parseJson(text),
          complete: true,
          skipped: 0,
        })
      }
    }
  })

  it('reads empty arrays, surrounding whitespace and a byte order mark', () => {
    expect(salvageJsonArray('[]')).toEqual({ items: [], complete: true, skipped: 0 })
    expect(salvageJsonArray(' \n[ ] \r\n')).toEqual({ items: [], complete: true, skipped: 0 })
    expect(salvageJsonArray('\uFEFF[1]')).toEqual({ items: [1], complete: true, skipped: 0 })
  })

  it('keeps null elements (the sanitiser decides about them later)', () => {
    expect(salvageJsonArray('[{"a":1},null,2]')).toEqual({
      items: [{ a: 1 }, null, 2],
      complete: true,
      skipped: 0,
    })
  })
})

describe('salvageJsonArray: non-array input', HEAVY, () => {
  it('returns nothing, incomplete, for anything that is not an array', () => {
    const none = { items: [], complete: false, skipped: 0 }
    for (const raw of [
      null,
      '',
      '   ',
      'null',
      '42',
      '"[1,2]"',
      '{"expenses":[1,2]}',
      'x[1]',
      '{[1]}',
    ]) {
      expect(salvageJsonArray(raw)).toEqual(none)
    }
  })
})

describe('salvageJsonArray: damaged input', HEAVY, () => {
  it('keeps the elements around an unreadable one and counts it', () => {
    expect(salvageJsonArray('[{"a":1},{"b":tru},{"c":3}]')).toEqual({
      items: [{ a: 1 }, { c: 3 }],
      complete: true,
      skipped: 1,
    })
    expect(salvageJsonArray('[1, garbage, {"a":[1,2]}, "x", {"y":1}z]')).toEqual({
      items: [1, { a: [1, 2] }, 'x'],
      complete: true,
      skipped: 2,
    })
  })

  it('tolerates trailing commas and empty slots without counting them', () => {
    expect(salvageJsonArray('[1,2,]')).toEqual({ items: [1, 2], complete: true, skipped: 0 })
    expect(salvageJsonArray('[1,,2, ,]')).toEqual({ items: [1, 2], complete: true, skipped: 0 })
    expect(salvageJsonArray('[,]')).toEqual({ items: [], complete: true, skipped: 0 })
  })

  it('stays in step across strings holding brackets, commas, quotes and backslashes', () => {
    const raw = '["a,b]c", "{", "\\"]", "\\\\", {"k":"]}"}, [",", "["]]'
    expect(salvageJsonArray(raw)).toEqual({
      items: ['a,b]c', '{', '"]', '\\', { k: ']}' }, [',', '[']],
      complete: true,
      skipped: 0,
    })
    expect(salvageJsonArray(raw.slice(0, -1))).toEqual({
      items: ['a,b]c', '{', '"]', '\\', { k: ']}' }, [',', '[']],
      complete: false,
      skipped: 0,
    })
  })

  it('treats a stray closing bracket as part of a bad element, not as the end of the array', () => {
    expect(salvageJsonArray('[1}, {]}, 2]')).toEqual({ items: [2], complete: true, skipped: 2 })
  })

  it('marks content after the closing bracket as incomplete but keeps the elements', () => {
    expect(salvageJsonArray('[1,2] trailing')).toEqual({
      items: [1, 2],
      complete: false,
      skipped: 0,
    })
    expect(salvageJsonArray('[1,2]]')).toEqual({ items: [1, 2], complete: false, skipped: 0 })
  })

  it('drops an element cut inside a string or an escape', () => {
    for (const raw of ['[1,"ab', '[1,"ab\\', '[1,"ab\\"', '[1,"ab\\u00', '[1,{"a":"x']) {
      expect(salvageJsonArray(raw)).toEqual({ items: [1], complete: false, skipped: 0 })
    }
  })

  it('keeps a finished element at the cut but drops a number that may be cut', () => {
    expect(salvageJsonArray('[1,{"a":1}')).toEqual({
      items: [1, { a: 1 }],
      complete: false,
      skipped: 0,
    })
    expect(salvageJsonArray('[1,"ab"')).toEqual({ items: [1, 'ab'], complete: false, skipped: 0 })
    expect(salvageJsonArray('[1,[2]  ')).toEqual({ items: [1, [2]], complete: false, skipped: 0 })
    expect(salvageJsonArray('[1,23')).toEqual({ items: [1], complete: false, skipped: 0 })
    expect(salvageJsonArray('[1,23 ')).toEqual({ items: [1, 23], complete: false, skipped: 0 })
    expect(salvageJsonArray('[1,tru')).toEqual({ items: [1], complete: false, skipped: 0 })
    expect(salvageJsonArray('[1,nul\n')).toEqual({ items: [1], complete: false, skipped: 1 })
    expect(salvageJsonArray('[1,{"a":{"b":1}')).toEqual({ items: [1], complete: false, skipped: 0 })
  })

  it('never throws on deep nesting', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const res = salvageJsonArray('[1,' + deep + ',2]')
    expect(res.complete).toBe(true)
    expect(res.items[0]).toBe(1)
    expect(res.items[res.items.length - 1]).toBe(2)
    expect(salvageJsonArray('[1,' + '['.repeat(100_000))).toEqual({
      items: [1],
      complete: false,
      skipped: 0,
    })
  })
})

describe('salvageJsonArray: truncation (F-014)', HEAVY, () => {
  it('returns exactly the complete prefix elements at every cut of random arrays', () => {
    const r = rng(22)
    for (let n = 0; n < 160; n++) {
      const values = Array.from({ length: int(r, 10) }, () => randomValue(r))
      const l = layout(values, n % 4 === 3)
      for (let k = 0; k <= l.text.length; k++) {
        const res = salvageJsonArray(l.text.slice(0, k))
        expect(res).toEqual({
          items: expectedAt(l, k),
          complete: k === l.text.length,
          skipped: 0,
        })
      }
    }
  })

  it('recovers 299 of 300 rows from the 42,236-char blob truncated by 37 chars (corrupt.cjs)', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: 'id' + String(i),
      itemName: 'item ' + String(i),
      amount: 1 + i,
      category: 'Other',
      date: '2026-10-01T12:00:00.000Z',
      createdAt: '2026-10-01T12:00:00.000Z',
    }))
    const good = JSON.stringify(rows)
    const truncated = good.slice(0, good.length - 37)
    expect(truncated.length).toBe(42_236)
    expect(() => parseJson(truncated)).toThrow()
    const res = salvageJsonArray(truncated)
    expect(res.items).toHaveLength(299)
    expect(res.items).toEqual(rows.slice(0, 299))
    expect(res.complete).toBe(false)
    expect(res.skipped).toBe(0)
  })

  it('recovers all but the last row of 5,000 owner-shaped rows cut inside the last one', () => {
    const r = rng(23)
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: 'c0ffee00-0000-4000-8000-' + String(i).padStart(12, '0'),
      itemName: ['Chicken rice', 'Grab to camp', 'Kopi O kosong', 'MRT top-up'][i % 4],
      amount: Math.round(r() * 3000) / 100 + 1,
      category: ['Food', 'Transport', 'Food', 'Transport'][i % 4],
      date: '2026-10-18T04:00:00.000Z',
      createdAt: '2026-10-18T04:00:00.000Z',
      ...(i % 9 === 0 ? { notes: 'split with "JX", 2 pax [camp]' } : {}),
    }))
    const good = JSON.stringify(rows)
    const last = JSON.stringify(rows[rows.length - 1])
    const cut = good.length - 1 - 1 - int(r, last.length - 1)
    const res = salvageJsonArray(good.slice(0, cut))
    expect(res.items).toHaveLength(4999)
    expect(res.items[4998]).toEqual(rows[4998])
  })
})

describe('salvageJsonArray: never throws', HEAVY, () => {
  it('handles random garbage and random damage to valid arrays', () => {
    const r = rng(24)
    const alphabet = '[]{}",:\\ 0123456789-.eEtrufalsn\né'
    for (let i = 0; i < 3000; i++) {
      let raw: string
      if (i % 2 === 0) {
        raw = ''
        for (let n = int(r, 60); n > 0; n--) raw += alphabet.charAt(int(r, alphabet.length))
        if (i % 4 === 0) raw = '[' + raw
      } else {
        raw = JSON.stringify(Array.from({ length: int(r, 6) }, () => randomValue(r)))
        for (let m = 1 + int(r, 3); m > 0; m--) {
          const pos = int(r, raw.length + 1)
          raw =
            int(r, 2) === 0
              ? raw.slice(0, pos) + raw.slice(pos + 1)
              : raw.slice(0, pos) + alphabet.charAt(int(r, alphabet.length)) + raw.slice(pos)
        }
      }
      const res = salvageJsonArray(raw)
      expect(Array.isArray(res.items)).toBe(true)
      expect(Number.isInteger(res.skipped) && res.skipped >= 0).toBe(true)
      let parsed: unknown = undefined
      try {
        parsed = parseJson(raw)
      } catch {
        parsed = undefined
      }
      if (Array.isArray(parsed)) {
        expect(res).toEqual({ items: parsed, complete: true, skipped: 0 })
      }
      // Whatever was kept re-reads as itself (as JSON: `1e999` was kept as Infinity, writes as null).
      const rewritten = JSON.stringify(res.items)
      expect(salvageJsonArray(rewritten)).toEqual({
        items: parseJson(rewritten),
        complete: true,
        skipped: 0,
      })
    }
  })
})
