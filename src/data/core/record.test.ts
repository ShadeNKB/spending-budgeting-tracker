// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { extrasOf } from '../__tests__/support/gen'
import { must, parseJson } from '../__tests__/support/must'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import { localNoonIso } from './dates'
import {
  addRecord,
  cmpReg,
  decodeRecord,
  editRecord,
  encodeRecord,
  lostFields,
  materialize,
  maxStampRec,
  mergeRecord,
  recEqual,
  recordString,
  reviveRecord,
  sealOf,
} from './record'
import { sanitizeExpense } from './sanitize'
import { iso } from './stamp'
import type { ExpenseRec, Extras, Hlc, OpCtx, Rank, Reg } from './types'

const T0 = Date.UTC(2026, 9, 19, 8)
const DAY = 86_400_000
const D = '2026-10-18T04:00:00.000Z'

const ctx = (wall: number, clock: Hlc = { last: 0 }): OpCtx => ({
  wall,
  clock,
  dev: 'dev-a',
  rng: makeRng(1).next,
})
const decode = (raw: unknown, srcRank: 0 | 1 = 1): ExpenseRec => {
  const r = sanitizeExpense(raw)
  if (r.kind === 'quarantine') throw new Error(r.reason)
  return decodeRecord(r.rec, srcRank)
}
const wire = (rec: ExpenseRec): Record<string, unknown> => {
  const v = parseJson(recordString(rec))
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object')
  return { ...v }
}
const legacy = {
  id: 'e1',
  itemName: 'kopi',
  amount: 1.8,
  category: 'Food',
  date: D,
  createdAt: D,
}
const add = (wall = T0, clock: Hlc = { last: 0 }): ExpenseRec =>
  addRecord(
    'e1',
    { n: 'grab', a: 12, c: 'Transport', day: '2026-10-18', o: null },
    ctx(wall, clock),
  )

describe('encodeRecord (§5.4, P-14)', HEAVY, () => {
  it('a v0.8 add-shaped record re-encodes byte-identically (no churn, no seal)', () => {
    const { createdAt, ...head } = legacy
    for (const raw of [
      legacy,
      { ...head, notes: 'to camp', createdAt },
      { ...legacy, updatedAt: '2026-10-19T04:00:00.000Z' },
      { ...head, notes: '', createdAt, updatedAt: '2026-10-19T04:00:00.000Z' },
    ]) {
      expect(recordString(decode(raw))).toBe(JSON.stringify(raw))
    }
  })

  it('emits extras always (uniform or sealed), sorted, before the seal', () => {
    const u = decode({ ...legacy, zeta: 1, kind: 'expense' })
    expect(recordString(u)).toBe(JSON.stringify({ ...legacy, kind: 'expense', zeta: 1 }))
    const s = editRecord(u, { a: 2 }, ctx(T0))
    const keys = Object.keys(wire(s))
    expect(keys).toEqual([
      'id',
      'itemName',
      'amount',
      'category',
      'date',
      'createdAt',
      'updatedAt',
      'fs',
      'kind',
      'zeta',
      'h',
    ])
  })

  it('a v5 add carries day, a seal and no fs (all fields at C, rank 2)', () => {
    const r = add()
    const w = wire(r)
    expect(Object.keys(w)).toEqual([
      'id',
      'itemName',
      'amount',
      'category',
      'date',
      'createdAt',
      'day',
      'h',
    ])
    expect(w.createdAt).toBe(iso(T0))
    expect(w.date).toBe(localNoonIso('2026-10-18'))
    expect(w.h).toBe(sealOf(w))
    expect(encodeRecord(r)).toBe(encodeRecord(r)) // cached per record object
  })

  it('fs lists stamps that differ from (C, 2): numbers for rank 2, pairs for ranks 0/1', () => {
    const r: ExpenseRec = {
      ...add(),
      n: { v: 'grab', s: T0 + 5, r: 1 },
      a: { v: 12, s: T0 + 7, r: 2 },
      o: { v: null, s: T0 + 9, r: 0 },
    }
    expect(wire(r).fs).toEqual({ n: [T0 + 5, 1], a: T0 + 7, o: [T0 + 9, 0] })
    expect(wire(r).updatedAt).toBe(iso(T0 + 9))
  })

  it('golden seals and record strings (persisted across builds; zone-independent inputs)', () => {
    // the date text is fixed (local noon in Singapore) so the pin holds in every time zone
    const r: ExpenseRec = { ...add(), d: { v: { date: D, day: '2026-10-18' }, s: T0, r: 2 } }
    expect(sealOf(wire(r))).toBe(must(wire(r).h))
    expect(wire(r).h).toBe('96rewr')
    const e = editRecord(r, { a: 21, o: 'to camp' }, ctx(T0 + 1000, { last: T0 }))
    expect(recordString(e)).toBe(
      '{"id":"e1","itemName":"grab","amount":21,"category":"Transport","date":"2026-10-18T04:00:00.000Z"' +
        ',"notes":"to camp","createdAt":"2026-10-19T08:00:00.000Z","updatedAt":"2026-10-19T08:00:01.000Z"' +
        ',"day":"2026-10-18","fs":{"a":1792396801000,"o":1792396801000},"h":"xrp3v0"}',
    )
  })
})

describe('decodeRecord: the §5.3 interpretation table', HEAVY, () => {
  it('sealed: fs stamps (clamped ≥ C), ranks from fs, day kept', () => {
    const r = editRecord(add(), { a: 21 }, ctx(T0 + 1000, { last: T0 }))
    const back = decode(wire(r), 0)
    expect(recEqual(back, r)).toBe(true)
    expect(back.d.v.day).toBe('2026-10-18')
    expect(back.a).toEqual({ v: 21, s: T0 + 1000, r: 2 })
    expect(back.n).toEqual({ v: 'grab', s: T0, r: 2 })
    // a sealed fs stamp below C is clamped to C
    const w = wire(add())
    const low = { ...w, fs: { a: T0 - 5 } }
    const lowSealed = { ...low, h: sealOf(low) }
    expect(decode(lowSealed).a.s).toBe(T0)
  })

  it('legacy (no h): every field at U = max(C, updatedAt) with the source rank, day dropped', () => {
    const r = decode({ ...legacy, updatedAt: '2026-10-19T04:00:00.000Z', day: '2026-10-18' }, 0)
    for (const f of [r.n, r.a, r.c, r.d, r.o, r.x]) {
      expect([f.s, f.r]).toEqual([Date.parse('2026-10-19T04:00:00.000Z'), 0])
    }
    expect(r.d.v.day).toBeUndefined()
    expect(decode(legacy, 1).a.r).toBe(1)
  })

  it('old stamped edit (h stale, U > maxF): every field at U, source rank, day dropped', () => {
    const v5 = wire(editRecord(add(), { o: 'x' }, ctx(T0 + 1000, { last: T0 })))
    const old = { ...v5, amount: 50, updatedAt: iso(T0 + 3_600_000) } // v0.8 {...e, ...patch, updatedAt}
    const r = decode(old, 1)
    expect([r.a.v, r.a.s, r.a.r]).toEqual([50, T0 + 3_600_000, 1])
    expect([r.o.v, r.o.s, r.o.r]).toEqual(['x', T0 + 3_600_000, 1])
    expect(r.d.v.day).toBeUndefined()
  })

  it('unstamped mutation (h stale, U ≤ maxF): fs stamps, rank 0, day dropped (W5)', () => {
    const v5 = wire(add())
    const refiled = { ...v5, category: 'Shopping' } // keyword re-file / old rename: no stamp
    const r = decode(refiled, 1)
    expect([r.c.v, r.c.s, r.c.r]).toEqual(['Shopping', T0, 0])
    expect(r.d.v.day).toBeUndefined()
    expect(mergeRecord(add(), r).c.v).toBe('Transport')
    expect(mergeRecord(r, add()).c.v).toBe('Transport')
  })

  it('a forged higher fs stamp without the seal is an unstamped mutation (rank 0)', () => {
    const w = wire(editRecord(add(), { a: 21 }, ctx(T0 + 1000, { last: T0 })))
    const forged = { ...w, amount: 99999, fs: { a: T0 + 99 * DAY } }
    expect(sealOf(forged)).not.toBe(w.h)
    const r = decode(forged)
    expect(r.a.r).toBe(0)
  })

  it('W6: a v0.8.4 straggler re-file of a never-edited legacy record loses to the local copy', () => {
    const towel = { ...legacy, itemName: 'Kitchen towel', category: 'Other' }
    const mine = decode(towel, 1)
    const straggler = decode({ ...towel, category: 'Shopping' }, 0)
    expect(mergeRecord(mine, straggler).c.v).toBe('Other')
    expect(mergeRecord(straggler, mine).c.v).toBe('Other')
  })

  it('W2: the rollout probe, a later old-client edit (50) wins every field it carries', () => {
    const c: Hlc = { last: 0 }
    const v5 = editRecord(add(T0, c), { a: 5 }, ctx(T0 + 60_000, c))
    const oldPhone = { ...wire(add()), amount: 50, updatedAt: iso(T0 + 3_600_000) }
    const m = mergeRecord(v5, decode(oldPhone, 1))
    expect(m.a.v).toBe(50)
    expect(m.d.v.day).toBeUndefined()
  })

  it('W3/W4: per-field outcome against an old whole-record edit', () => {
    const c: Hlc = { last: 0 }
    const base = add(T0, c)
    // W3: v5 notes at T2 > old amount at T1
    const old1 = decode({ ...wire(base), amount: 50, updatedAt: iso(T0 + 60_000) }, 1)
    const v5notes = editRecord(base, { o: 'to camp' }, ctx(T0 + 3_600_000, c))
    expect([mergeRecord(v5notes, old1).a.v, mergeRecord(v5notes, old1).o.v]).toEqual([
      50,
      'to camp',
    ])
    // W4: old edit at T3 > T2 carries stale notes and wins every field it carries
    const old2 = decode({ ...wire(base), amount: 60, updatedAt: iso(T0 + 7_200_000) }, 1)
    const m = mergeRecord(v5notes, old2)
    expect([m.a.v, m.o.v]).toEqual([60, null])
    // the unsealed old copy carries no day, so `d` is overwritten too (the view derives the day)
    expect(lostFields(v5notes, m)).toEqual(['a', 'd', 'o'])
  })
})

describe('worked examples W1–W8 (§5.6), one test each', HEAVY, () => {
  it('W1: phone edits amount 12→21 at T1, laptop edits notes at T2, both offline → both kept', () => {
    const base = add()
    const phone = editRecord(base, { a: 21 }, ctx(T0 + 1000, { last: T0 }))
    const laptop = editRecord(base, { o: 'to camp' }, ctx(T0 + 2000, { last: T0 }))
    for (const m of [mergeRecord(phone, laptop), mergeRecord(laptop, phone)]) {
      expect(m.a).toEqual({ v: 21, s: T0 + 1000, r: 2 })
      expect(m.o).toEqual({ v: 'to camp', s: T0 + 2000, r: 2 })
    }
  })

  it('W2: v5 amount 5 at T, the old phone’s whole-record 50 at T+1h → 50 wins every field it carries', () => {
    const c: Hlc = { last: 0 }
    const v5 = editRecord(add(T0, c), { a: 5 }, ctx(T0 + 60_000, c))
    const phone = decode({ ...wire(add()), amount: 50, updatedAt: iso(T0 + 3_600_000) }, 1)
    for (const m of [mergeRecord(v5, phone), mergeRecord(phone, v5)]) {
      expect(m.a.v).toBe(50)
      for (const f of [m.n, m.a, m.c, m.d, m.o, m.x]) expect(f.s).toBe(T0 + 3_600_000)
    }
  })

  it('W3: v5 notes at T2 and an old amount edit at T1 < T2 → amount from the old client, notes from v5', () => {
    const c: Hlc = { last: 0 }
    const base = add(T0, c)
    const old = decode({ ...wire(base), amount: 50, updatedAt: iso(T0 + 60_000) }, 1)
    const v5 = editRecord(base, { o: 'to camp' }, ctx(T0 + 3_600_000, c))
    for (const m of [mergeRecord(v5, old), mergeRecord(old, v5)]) {
      expect([m.a.v, m.o.v]).toEqual([50, 'to camp'])
    }
  })

  it('W4: an old edit at T3 > T2 carries stale notes → it wins every field; the v5 notes loss is reported', () => {
    const c: Hlc = { last: 0 }
    const base = add(T0, c)
    const v5 = editRecord(base, { o: 'to camp' }, ctx(T0 + 3_600_000, c))
    const old = decode({ ...wire(base), amount: 60, updatedAt: iso(T0 + 7_200_000) }, 1)
    const m = mergeRecord(v5, old)
    expect([m.a.v, m.o.v]).toEqual([60, null])
    expect(lostFields(v5, m)).toContain('o')
  })

  it('W5: the old client re-files a SEALED record’s category without a stamp → rank 0, authentic stays', () => {
    const sealed = add()
    const refiled = decode({ ...wire(sealed), category: 'Shopping' }, 1)
    expect([refiled.c.s, refiled.c.r]).toEqual([sealed.c.s, 0])
    for (const m of [mergeRecord(sealed, refiled), mergeRecord(refiled, sealed)]) {
      expect(m.c.v).toBe('Transport')
    }
  })

  it('W6: a v0.8.4 straggler re-files a never-edited legacy record → rank 0 payload loses to rank 1', () => {
    const towel = { ...legacy, itemName: 'Kitchen towel', category: 'Other' }
    const mine = decode(towel, 1)
    const straggler = decode({ ...towel, category: 'Shopping' }, 0)
    for (const m of [mergeRecord(mine, straggler), mergeRecord(straggler, mine)]) {
      expect(m.c.v).toBe('Other')
    }
  })

  it('W7: 9999-12-31 orders as 0 and loses; a 2099-12-31 stamp wins until the user’s base + 1 edit', () => {
    const mine = add()
    const far = decode(
      { ...legacy, id: 'e1', amount: 99999, updatedAt: '9999-12-31T00:00:00.000Z' },
      1,
    )
    expect(far.a.s).toBe(Date.parse(D))
    expect(mergeRecord(mine, far).a.v).toBe(12)
    const hostile = decode(
      { ...legacy, id: 'e1', amount: 99999, updatedAt: '2099-12-31T00:00:00.000Z' },
      1,
    )
    const pinned = mergeRecord(mine, hostile)
    expect(pinned.a.v).toBe(99999)
    const fixed = editRecord(pinned, { a: 12 }, ctx(T0 + 1000, { last: T0 }))
    expect(fixed.a.s).toBe(Date.parse('2099-12-31T00:00:00.000Z') + 1)
    expect(mergeRecord(fixed, hostile).a.v).toBe(12)
    expect(mergeRecord(hostile, fixed).a.v).toBe(12)
  })

  it('W8: the slow device (−1 day) edits after seeing the fast device’s edit → base + 1 wins', () => {
    const fastClock: Hlc = { last: 0 }
    const fast = editRecord(add(T0, fastClock), { a: 2 }, ctx(T0 + DAY, fastClock))
    // the slow device's wall is a day behind, but its edit supersedes the version it saw
    const slow = editRecord(fast, { a: 3 }, ctx(T0 + 1000, { last: T0 }))
    expect(slow.a.s).toBe(fast.a.s + 1)
    for (const m of [mergeRecord(fast, slow), mergeRecord(slow, fast)]) expect(m.a.v).toBe(3)
  })
})

describe('mergeRecord (§5.1)', HEAVY, () => {
  function randRec(rng: ReturnType<typeof makeRng>): ExpenseRec {
    const C = T0 + rng.int(3) * 1000
    const g = <T>(vals: readonly T[]): Reg<T> => ({
      v: rng.pick(vals),
      s: C + rng.int(4) * 1000,
      r: rng.pick<Rank>([0, 1, 2]),
    })
    const extras: Extras[] = [extrasOf({}), extrasOf({ kind: 'expense' })]
    return {
      id: 'e1',
      createdAt: iso(C),
      C,
      n: g(['kopi', 'grab', 'chicken rice']),
      a: g([1.8, 12, 21]),
      c: g(['Food', 'Transport', 'Other']),
      d: g([
        { date: D },
        { date: D, day: '2026-10-18' },
        { date: '2026-10-17T04:00:00.000Z', day: '2026-10-17' },
      ]),
      o: g<string | null>([null, 'to camp', 'lunch']),
      x: g(extras),
    }
  }

  it('is commutative, associative and idempotent (1,000 triples here; 5,000 in props/)', () => {
    const rng = makeRng(1)
    for (let i = 0; i < 1000; i++) {
      const a = randRec(rng)
      const b = randRec(rng)
      const c = randRec(rng)
      expect(recordString(mergeRecord(a, b))).toBe(recordString(mergeRecord(b, a)))
      expect(recordString(mergeRecord(mergeRecord(a, b), c))).toBe(
        recordString(mergeRecord(a, mergeRecord(b, c))),
      )
      expect(mergeRecord(a, a)).toBe(a)
    }
  })

  it('version-first fast path returns the left object when nothing differs', () => {
    const a = add()
    const b = decode(wire(a))
    expect(b).not.toBe(a)
    expect(mergeRecord(a, b)).toBe(a)
    expect(mergeRecord(b, a)).toBe(b)
  })

  it('createdAt is the (C, string) minimum; registers by (s, r, canon(v))', () => {
    const a = add(T0)
    const b = { ...add(T0 + 5000), a: { v: 99, s: T0 + 5000, r: 2 as const } }
    const m = mergeRecord(a, b)
    expect(m.createdAt).toBe(a.createdAt)
    expect(m.a.v).toBe(99)
    expect(cmpReg({ v: 'b', s: 1, r: 1 }, { v: 'a', s: 1, r: 1 })).toBeGreaterThan(0)
    expect(cmpReg({ v: 'a', s: 1, r: 2 }, { v: 'b', s: 1, r: 1 })).toBeGreaterThan(0)
    expect(cmpReg({ v: 'a', s: 2, r: 0 }, { v: 'b', s: 1, r: 2 })).toBeGreaterThan(0)
    expect(cmpReg({ v: 9, s: 1, r: 1 }, { v: 21, s: 1, r: 1 })).toBeGreaterThan(0) // canon text order
  })
})

describe('record ops (§5.5)', HEAVY, () => {
  it('addRecord: every field (value, C, 2), createdAt = iso(C), day + local-noon date', () => {
    const r = add()
    expect(r.C).toBe(T0)
    for (const f of [r.n, r.a, r.c, r.d, r.o, r.x]) expect([f.s, f.r]).toEqual([T0, 2])
    expect(r.d.v).toEqual({ date: localNoonIso('2026-10-18'), day: '2026-10-18' })
  })

  it('editRecord stamps only changed fields, above their own stamps; no change → same object', () => {
    const c: Hlc = { last: 0 }
    const r = add(T0, c)
    expect(editRecord(r, { a: 12, n: 'grab' }, ctx(T0 + 10, c))).toBe(r)
    const e = editRecord(r, { a: 21 }, ctx(T0 + 10, c))
    expect(e.a).toEqual({ v: 21, s: T0 + 10, r: 2 })
    expect(e.n).toBe(r.n)
    // causal floor: a slow clock still writes above the superseded stamp
    const slow = editRecord(e, { a: 30 }, ctx(T0 - DAY, { last: 0 }))
    expect(slow.a.s).toBe(T0 + 11)
  })

  it('a day-preserving edit keeps the time; a day change writes local noon unless the date is on it', () => {
    const c: Hlc = { last: 0 }
    const r = decode({ ...legacy, date: '2026-10-18T01:23:45.000Z' })
    const sameDay = must(r.d.v.date)
    const localOfDate = editRecord(r, { a: 2 }, ctx(T0, c))
    expect(localOfDate.d.v.date).toBe(sameDay)
    const moved = editRecord(r, { day: '2026-10-10' }, ctx(T0, c))
    expect(moved.d.v).toEqual({ date: localNoonIso('2026-10-10'), day: '2026-10-10' })
    const v5 = add(T0, c)
    expect(editRecord(v5, { day: '2026-10-18' }, ctx(T0 + 5, c))).toBe(v5)
  })

  it('a day edit onto the day its date already falls on here keeps that time (a record from another zone)', () => {
    const c: Hlc = { last: 0 }
    const v5 = add(T0, c)
    // written where this instant was still the 17th; here it is 09:00 local on the 18th
    const nine = new Date(2026, 9, 18, 9, 0, 0, 0).toISOString()
    const rec: ExpenseRec = { ...v5, d: { ...v5.d, v: { date: nine, day: '2026-10-17' } } }
    const e = editRecord(rec, { day: '2026-10-18' }, ctx(T0 + 5, c))
    expect(e.d.v).toEqual({ date: nine, day: '2026-10-18' })
    expect(e.d.s).toBeGreaterThan(rec.d.s)
    // a day its date is not on moves the date to local noon of that day
    const moved = editRecord(rec, { day: '2026-10-16' }, ctx(T0 + 6, c))
    expect(moved.d.v).toEqual({ date: localNoonIso('2026-10-16'), day: '2026-10-16' })
  })

  it('reviveRecord: fresh stamps for every field above the copy, createdAt kept, new id', () => {
    const r = editRecord(add(), { a: 21 }, ctx(T0 + 1000, { last: T0 }))
    const v = reviveRecord(r, 'e1~rabc', ctx(T0 - 5000, { last: 0 }))
    expect(v.id).toBe('e1~rabc')
    expect(v.createdAt).toBe(r.createdAt)
    expect(v.C).toBe(r.C)
    for (const f of [v.n, v.a, v.c, v.d, v.o, v.x]) expect([f.s, f.r]).toEqual([T0 + 1001, 2])
    expect(maxStampRec(v)).toBe(T0 + 1001)
  })

  it('materialize changes c.v only and never stamps', () => {
    const r = add()
    const m = materialize(r, (n) => (n === 'Transport' ? 'Transit' : n))
    expect(m.c).toEqual({ v: 'Transit', s: r.c.s, r: r.c.r })
    expect(m.a).toBe(r.a)
    expect(materialize(r, (n) => n)).toBe(r)
  })
})
