import { describe, expect, it } from 'vitest'
import Fuse from 'fuse.js/basic'
import { FUSE_SCORE_CUTOFF, FUSE_THRESHOLD } from '../../constants'
import { EMPTY_DOC } from '../core/doc'
import type { Doc } from '../core/types'
import { closestKey, prepareNames } from './fuzzy'
import { smartCategory } from './smart'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)]
  if (item === undefined) throw new Error('pick from an empty list')
  return item
}

const VOCABULARY = [
  ...['chicken', 'rice', 'kopi', 'o', 'kosong', 'teh', 'grab', 'laksa', 'mala', 'sushi'],
  ...['fairprice', 'netflix', 'haircut', 'bubble', 'tea', 'toast', 'noodles', 'mrt'],
]

/** 400 distinct names of one to three words, some with a number, in insertion order. */
function seededNames(rand: () => number, count = 400): string[] {
  const names = new Set<string>()
  while (names.size < count) {
    const words = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(rand, VOCABULARY))
    if (rand() < 0.3) words.push(String(Math.floor(rand() * 100)))
    names.add(words.join(' '))
  }
  return [...names]
}

/** A name or two from the vocabulary with up to four typos; now and then very long or very short. */
function seededQuery(rand: () => number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz '
  let query = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(rand, VOCABULARY)).join(
    ' ',
  )
  for (let edits = Math.floor(rand() * 5); edits > 0; edits--) {
    const at = Math.floor(rand() * query.length)
    const letter = letters[Math.floor(rand() * letters.length)] ?? ''
    const kind = rand()
    query =
      kind < 0.33
        ? query.slice(0, at) + query.slice(at + 1)
        : kind < 0.66
          ? query.slice(0, at) + letter + query.slice(at)
          : query.slice(0, at) + letter + query.slice(at + 1)
  }
  if (rand() < 0.02) query = query.repeat(4)
  if (rand() < 0.15) query = query.slice(0, 1 + Math.floor(rand() * 3))
  return query.trim().toLowerCase()
}

describe('closestKey', () => {
  it('finds nothing in an empty list or for an empty query', () => {
    expect(closestKey(prepareNames([]), 'kopi', { threshold: 0.4 })).toBeNull()
    expect(closestKey(prepareNames(['kopi']), '', { threshold: 0.4 })).toBeNull()
  })

  it('finds a name through a typo, and none for something else', () => {
    const names = prepareNames(['coffee', 'grab home', 'chicken rice'])
    expect(closestKey(names, 'coffe', { threshold: 0.3 })?.key).toBe('coffee')
    expect(closestKey(names, 'chiken rice', { threshold: 0.3 })?.key).toBe('chicken rice')
    expect(closestKey(names, 'spotify', { threshold: 0.3 })).toBeNull()
  })

  // The guarantee the whole file rests on: same name, same score as Fuse, for a plain list.
  it("is exactly Fuse's top hit over a list of names (1,500 seeded queries, threshold 0.4)", () => {
    const rand = mulberry32(0xf0e5)
    const names = seededNames(rand)
    const prepared = prepareNames(names)
    const fuse = new Fuse(names, { threshold: 0.4, includeScore: true })
    let hits = 0
    for (let i = 0; i < 1500; i++) {
      const query = seededQuery(rand)
      if (query === '') continue
      const expected = fuse.search(query)[0]
      const got = closestKey(prepared, query, { threshold: 0.4 })
      expect({ query, key: got?.key, score: got?.score }).toEqual({
        query,
        key: expected?.item,
        score: expected?.score,
      })
      if (expected) hits++
    }
    expect(hits).toBeGreaterThan(300)
  }, 30_000)

  // The engine's own set-up, which this replaced there: a keyed index, threshold 0.3 and a match
  // of at least two characters in a row. Names the query equals are the exact lookup's, before
  // any fuzzy step, so they are left out here as they are there.
  it("is exactly the engine's old Fuse index's top hit (1,500 seeded queries)", () => {
    const rand = mulberry32(0x5a17)
    const names = seededNames(rand).sort()
    const prepared = prepareNames(names)
    const options = { threshold: FUSE_THRESHOLD, minMatchCharLength: 2 }
    const fuse = new Fuse(
      names.map((item) => ({ item })),
      { keys: ['item'], includeScore: true, ...options },
    )
    const known = new Set(names)
    let hits = 0
    for (let i = 0; i < 1500; i++) {
      const query = seededQuery(rand)
      if (query === '' || known.has(query)) continue
      const expected = fuse.search(query)[0]
      const got = closestKey(prepared, query, options)
      expect({ query, key: got?.key, score: got?.score }).toEqual({
        query,
        key: expected?.item.item,
        score: expected?.score,
      })
      if (expected) hits++
    }
    expect(hits).toBeGreaterThan(200)
  }, 30_000)

  // AC-22: a keystroke in the quick bar asks this once. Timed next to a plain Fuse search over
  // the same 2,000 names, so a loaded CI box cannot fail it: the median must stay 4x cheaper.
  it('is far cheaper than a full Fuse search (2,000 names, keystroke by keystroke)', () => {
    const rand = mulberry32(0xbea7)
    const names = seededNames(rand, 2000)
    const prepared = prepareNames(names)
    const options = { threshold: FUSE_THRESHOLD, minMatchCharLength: 2 }
    const fuse = new Fuse(
      names.map((item) => ({ item })),
      { keys: ['item'], includeScore: true, ...options },
    )
    closestKey(prepared, 'warm up', options)
    fuse.search('warm up')
    const keystrokes = ['chicken rce', 'kopi o kosong peng', 'zq lunch set 12'].flatMap((text) =>
      Array.from({ length: text.length }, (_, i) => text.slice(0, i + 1).trim()),
    )
    const mine: number[] = []
    const full: number[] = []
    for (const query of keystrokes) {
      if (query === '') continue
      const t0 = performance.now()
      closestKey(prepared, query, options)
      mine.push(performance.now() - t0)
      const t1 = performance.now()
      fuse.search(query)
      full.push(performance.now() - t1)
    }
    const median = (runs: number[]) => runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? 0
    expect(median(mine) * 4).toBeLessThan(median(full))
  })
})

describe('smartCategory', () => {
  const stamp = (v: string) => ({ v, s: 1 })
  function docWith(mappings: Record<string, string>, categories: readonly string[]): Doc {
    return {
      ...EMPTY_DOC,
      categories,
      mappings: new Map(Object.entries(mappings).map(([k, v]) => [k, stamp(v)])),
    }
  }

  it('answers an exact name, a typo of one, and nothing for a stranger', () => {
    const doc = docWith({ 'grab home': 'Transportation', coffee: 'Food & Dining' }, [
      'Transportation',
      'Food & Dining',
      'Other',
    ])
    expect(smartCategory(doc, '  Grab Home ')).toBe('Transportation')
    expect(smartCategory(doc, 'coffe')).toBe('Food & Dining')
    expect(smartCategory(doc, 'spotify')).toBeNull()
    expect(smartCategory(doc, '   ')).toBeNull()
  })

  it('never answers with a score at or past the cut-off', () => {
    const rand = mulberry32(0xc0ffee)
    const names = seededNames(rand, 200).sort()
    const doc = docWith(Object.fromEntries(names.map((name) => [name, 'Food & Dining'])), [
      'Food & Dining',
      'Other',
    ])
    const prepared = prepareNames(names)
    for (let i = 0; i < 400; i++) {
      const query = seededQuery(rand)
      if (query === '' || names.includes(query)) continue
      const best = closestKey(prepared, query, { threshold: FUSE_THRESHOLD, minMatchCharLength: 2 })
      const expected = best !== null && best.score < FUSE_SCORE_CUTOFF ? 'Food & Dining' : null
      expect({ query, category: smartCategory(doc, query) }).toEqual({ query, category: expected })
    }
  })

  it('follows new mappings: the names are made ready again for a new mappings map', () => {
    const before = docWith({ coffee: 'Food & Dining' }, ['Food & Dining', 'Shopping', 'Other'])
    expect(smartCategory(before, 'shoppe')).toBeNull()
    const after = { ...before, mappings: new Map(before.mappings).set('shopee', stamp('Shopping')) }
    expect(smartCategory(after, 'shoppe')).toBe('Shopping')
    expect(smartCategory(before, 'shoppe')).toBeNull()
  })
})
