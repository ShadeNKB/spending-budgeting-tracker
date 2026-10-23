// @vitest-environment node
// Join laws (§6.1, §16.4): record level on 5,000 triples, doc level on 3,000 random docs drawn from
// tiny universes (ties and collisions are common; reserved words appear in free text).
import { describe, expect, it } from 'vitest'
import { EMPTY_DOC, digestDoc, mergeDoc } from '../../core/doc'
import { mergeRecord, recordString } from '../../core/record'
import type { Doc } from '../../core/types'
import { decodeWire, wireString } from '../../core/wire'
import { IDS, freezeDoc, genDoc, genRecord } from '../support/gen'
import { parseJson } from '../support/must'
import { PROP_SCALE, PROP_TIMEOUT, makeRng } from '../support/rng'

const N_RECORDS = 5000 * PROP_SCALE
const N_DOCS = 3000 * PROP_SCALE

const merge = (a: Doc, b: Doc): Doc => mergeDoc(a, b).doc
/** A generated doc as a replica would hold it (records materialised under its own table). */
const replica = (r: ReturnType<typeof makeRng>, renames = true): Doc =>
  merge(genDoc(r, { renames }), genDoc(r, { renames }))

function sameRecords(a: Doc, b: Doc): boolean {
  if (a.expenses.size !== b.expenses.size) return false
  for (const [id, rec] of a.expenses) {
    const other = b.expenses.get(id)
    if (other === undefined || recordString(other) !== recordString(rec)) return false
  }
  return true
}

describe('record join laws', () => {
  it(
    `commutative, associative, idempotent over ${N_RECORDS} random triples`,
    () => {
      const r = makeRng(1)
      for (let i = 0; i < N_RECORDS; i++) {
        const a = genRecord(r, 'e1')
        const b = genRecord(r, 'e1')
        const c = genRecord(r, 'e1')
        expect(recordString(mergeRecord(a, b))).toBe(recordString(mergeRecord(b, a)))
        expect(recordString(mergeRecord(mergeRecord(a, b), c))).toBe(
          recordString(mergeRecord(a, mergeRecord(b, c))),
        )
        expect(mergeRecord(a, a)).toBe(a)
      }
    },
    PROP_TIMEOUT,
  )
})

describe(`doc join laws (${N_DOCS} random docs)`, () => {
  it(
    'commutative by digest and by record bytes (renames included)',
    () => {
      const r = makeRng(2)
      for (let i = 0; i < N_DOCS; i++) {
        const a = genDoc(r)
        const b = genDoc(r)
        const ab = merge(a, b)
        const ba = merge(b, a)
        expect(digestDoc(ab)).toBe(digestDoc(ba))
        expect(sameRecords(ab, ba)).toBe(true)
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'associative when no rename is in flight',
    () => {
      const r = makeRng(3)
      for (let i = 0; i < N_DOCS; i++) {
        const a = genDoc(r, { renames: false })
        const b = genDoc(r, { renames: false })
        const c = genDoc(r, { renames: false })
        expect(digestDoc(merge(merge(a, b), c))).toBe(digestDoc(merge(a, merge(b, c))))
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'idempotent and absorbing; merge(a, EMPTY).doc === a',
    () => {
      const r = makeRng(4)
      for (let i = 0; i < N_DOCS; i++) {
        const a = genDoc(r)
        const b = genDoc(r)
        const m = merge(a, b)
        expect(merge(m, m)).toBe(m)
        expect(digestDoc(merge(m, a))).toBe(digestDoc(m))
        expect(digestDoc(merge(m, b))).toBe(digestDoc(m))
        expect(mergeDoc(m, EMPTY_DOC).doc).toBe(m)
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'never resurrects a tombstoned id and never drops a live record silently',
    () => {
      const r = makeRng(5)
      for (let i = 0; i < N_DOCS; i++) {
        const a = genDoc(r)
        const b = genDoc(r)
        const res = mergeDoc(a, b)
        const removed = new Set(res.removed.map((x) => x.id))
        for (const id of [...a.tombs.keys(), ...b.tombs.keys()]) {
          expect(res.doc.tombs.has(id)).toBe(true)
          expect(res.doc.expenses.has(id)).toBe(false)
        }
        for (const id of a.expenses.keys())
          expect(res.doc.expenses.has(id) || removed.has(id)).toBe(true)
        for (const id of b.expenses.keys())
          expect(res.doc.expenses.has(id) || res.doc.tombs.has(id)).toBe(true)
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'the digest is independent of insertion order',
    () => {
      const r = makeRng(6)
      for (let i = 0; i < N_DOCS; i++) {
        const a = replica(r)
        const shuffled: Doc = {
          ...a,
          expenses: new Map(r.shuffle([...a.expenses])),
          tombs: new Map(r.shuffle([...a.tombs])),
          categories: r.shuffle(a.categories),
          renames: new Map(r.shuffle([...a.renames])),
          mappings: new Map(r.shuffle([...a.mappings])),
          budgets: new Map(r.shuffle([...a.budgets])),
          prefs: new Map(r.shuffle([...a.prefs])),
        }
        expect(digestDoc(shuffled)).toBe(digestDoc(a))
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'decode with reuse ≡ decode without (P-21), and a reused merge is a no-op',
    () => {
      const r = makeRng(7)
      for (let i = 0; i < N_DOCS; i++) {
        const a = replica(r)
        const raw = parseJson(wireString(a, { rev: 'r' }))
        const fresh = decodeWire(raw, 'remote').doc
        const reused = decodeWire(raw, 'remote', { reuse: a }).doc
        expect(digestDoc(reused)).toBe(digestDoc(fresh))
        expect(sameRecords(reused, fresh)).toBe(true)
        expect(merge(a, reused)).toBe(a)
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'inputs are never mutated (deep-frozen docs; maps throw on mutation)',
    () => {
      const r = makeRng(8)
      for (let i = 0; i < N_DOCS / 3; i++) {
        const a = freezeDoc(genDoc(r))
        const b = freezeDoc(genDoc(r))
        const before = [digestDoc(a), digestDoc(b)]
        expect(() => merge(a, b)).not.toThrow()
        expect(() => decodeWire(parseJson(wireString(a)), 'remote', { reuse: b })).not.toThrow()
        expect([digestDoc(a), digestDoc(b)]).toEqual(before)
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'universe sanity: collisions really happen',
    () => {
      const r = makeRng(9)
      let shared = 0
      for (let i = 0; i < 200; i++) {
        const a = genDoc(r)
        const b = genDoc(r)
        for (const id of IDS) if (a.expenses.has(id) && b.expenses.has(id)) shared++
      }
      expect(shared).toBeGreaterThan(200)
    },
    PROP_TIMEOUT,
  )
})
