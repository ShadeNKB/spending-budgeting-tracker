// @vitest-environment node
// Wire round trips (§5.4, §10, T-013-2): lossless for random records and docs, 5,000 records and
// 10,000 tombstones; legacy shapes re-encode byte-identically; unknown fields always survive.
import { describe, expect, it } from 'vitest'
import { digestDoc, mergeDoc } from '../../core/doc'
import { decodeRecord, encodeRecord, recordString } from '../../core/record'
import { sanitizeExpense } from '../../core/sanitize'
import type { Doc, ExpenseRec } from '../../core/types'
import { decodeWire, encodeWire, wireString } from '../../core/wire'
import { DAY, T0, docOf, genDoc, genRecord } from '../support/gen'
import { parseJson } from '../support/must'
import { ownerDoc } from '../support/ownerShape'
import { PROP_SCALE, PROP_TIMEOUT, makeRng } from '../support/rng'

const decode1 = (rec: ExpenseRec): ExpenseRec => {
  const r = sanitizeExpense(parseJson(recordString(rec)))
  if (r.kind === 'quarantine') throw new Error(r.reason)
  return decodeRecord(r.rec, 1)
}
const viaWire = (d: Doc): Doc => decodeWire(parseJson(wireString(d)), 'remote').doc

describe('record round trip', () => {
  it(
    `decodeRecord(encodeRecord(rec), 1) ≡ rec for ${5000 * PROP_SCALE} random records`,
    () => {
      const r = makeRng(31)
      for (let i = 0; i < 5000 * PROP_SCALE; i++) {
        const rec = genRecord(r, `e${i}`)
        expect(recordString(decode1(rec))).toBe(recordString(rec))
        expect(decode1(rec)).toEqual(rec)
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'canonical v0.8 shapes re-encode byte-identically; extras survive uniform and sealed encodes',
    () => {
      const shapes = [
        {
          id: 'a',
          itemName: 'kopi',
          amount: 1.8,
          category: 'Food',
          date: '2026-10-18T04:00:00.000Z',
          createdAt: '2026-10-18T04:00:00.000Z',
        },
        {
          id: 'b',
          itemName: 'grab',
          amount: 12,
          category: 'Transport',
          date: '2026-10-18T04:00:00.000Z',
          notes: 'camp',
          createdAt: '2026-10-18T13:02:11.123Z',
        },
        {
          id: 'c',
          itemName: 'mrt',
          amount: 2,
          category: 'Transport',
          date: '2026-10-18T04:00:00.000Z',
          createdAt: '2026-10-18T13:02:11.123Z',
          updatedAt: '2026-10-19T01:00:00.001Z',
        },
        {
          id: 'd',
          itemName: 'x',
          amount: 2,
          category: 'Other',
          date: '2026-10-18T04:00:00.000Z',
          createdAt: '2026-10-18T04:00:00.000Z',
          kind: 'expense',
          tag: [1, { a: null }],
        },
      ]
      for (const raw of shapes) {
        const r = sanitizeExpense(raw)
        if (r.kind === 'quarantine') throw new Error(r.reason)
        expect(recordString(decodeRecord(r.rec, 1))).toBe(JSON.stringify(raw))
      }
      const sealed = genRecord(makeRng(2), 'z', [T0])
      const withExtras = { ...encodeRecord(sealed), kind: 'transfer' }
      const r = sanitizeExpense(withExtras)
      if (r.kind === 'quarantine') throw new Error(r.reason)
      expect(recordString(decodeRecord(r.rec, 1))).toContain('"kind":"transfer"')
    },
    PROP_TIMEOUT,
  )
})

describe('doc round trip', () => {
  it(
    `decodeWire(encodeWire(x)) ≡ x for ${3000 * PROP_SCALE} random docs`,
    () => {
      const r = makeRng(32)
      for (let i = 0; i < 3000 * PROP_SCALE; i++) {
        const d = mergeDoc(genDoc(r), genDoc(r)).doc
        const back = viaWire(d)
        expect(digestDoc(back)).toBe(digestDoc(d))
        expect(JSON.stringify(encodeWire(back))).toBe(JSON.stringify(encodeWire(d)))
      }
    },
    PROP_TIMEOUT,
  )

  it(
    `wireString is exactly JSON.stringify(encodeWire) for ${1000 * PROP_SCALE} random docs and options`,
    () => {
      const r = makeRng(33)
      for (let i = 0; i < 1000 * PROP_SCALE; i++) {
        const d = mergeDoc(genDoc(r), genDoc(r)).doc
        const opts = {
          ...(r.chance(0.5) ? { dev: r.pick(['k3f9x2', '"q"']) } : {}),
          ...(r.chance(0.5) ? { rev: 'Qm9yZWwuLi4uLi4uLg' } : {}),
          ...(r.chance(0.3) ? { min: r.pick([4, 99]) } : {}),
          ...(r.chance(0.3) ? { omitIds: (id: string) => id < 'c' } : {}),
        }
        expect(wireString(d, opts)).toBe(JSON.stringify(encodeWire(d, opts)))
        // the cached pieces are shared, never mutated: a second call is identical
        expect(wireString(d, opts)).toBe(JSON.stringify(encodeWire(d, opts)))
      }
    },
    PROP_TIMEOUT,
  )

  it(
    'a 5,000-record owner-shaped doc round-trips with every record byte-identical',
    () => {
      const d = ownerDoc(5000, 1)
      const back = viaWire(d)
      expect(back.expenses.size).toBe(5000)
      expect(digestDoc(back)).toBe(digestDoc(d))
      for (const [id, rec] of d.expenses)
        expect(recordString(back.expenses.get(id) ?? rec)).toBe(recordString(rec))
    },
    PROP_TIMEOUT,
  )

  it(
    'T-013-2: 10,000 tombstones round-trip with nothing pruned, oldest first',
    () => {
      const tombs: [string, number][] = []
      for (let i = 0; i < 10_000; i++)
        tombs.push([`t${i}`, i % 3 === 0 ? 0 : T0 + ((i % 977) * DAY) / 977])
      const d = docOf({ tombs })
      const w = encodeWire(d)
      expect(w.deletedIds).toHaveLength(10_000)
      expect([...w.x5.dts]).toEqual([...w.x5.dts].sort((a, b) => a - b))
      const back = viaWire(d)
      expect(back.tombs.size).toBe(10_000)
      for (const [id, s] of tombs) expect(back.tombs.get(id)).toBe(Math.floor(s))
    },
    PROP_TIMEOUT,
  )
})
