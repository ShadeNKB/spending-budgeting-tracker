// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { T0, docOf } from '../__tests__/support/gen'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import { MEMO_WINDOW } from './constants'
import { EMPTY_DOC, digestDoc, mergeDoc } from './doc'
import { addExpense, updateExpense } from './ops'
import { NEW_MEMO, ackOutbox, commitPush, decidePush, guardTrips } from './push'
import { addRecord, recordString } from './record'
import { iso } from './stamp'
import type {
  Doc,
  ExpenseRec,
  Hlc,
  OpCtx,
  OutboxKey,
  PushDecision,
  SanitizeResult,
  Stamp,
} from './types'
import { decodeWire, encodeWire, movedMarker, wireString } from './wire'
import { must, parseJson } from '../__tests__/support/must'

const ctx = (wall: number, clock: Hlc): OpCtx => ({ wall, clock, dev: 'd', rng: makeRng(1).next })
const rec = (id: string, c: Hlc, wall = T0): ExpenseRec =>
  addRecord(id, { n: id, a: 1, c: 'Food', day: '2026-10-18', o: null }, ctx(wall, c))
const ROW = { etag: 'e1' }
const v5relay = (d: Doc): SanitizeResult =>
  decodeWire(parseJson(wireString(d, { rev: 'r' })), 'remote')
const v4 = (
  expenses: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): SanitizeResult =>
  decodeWire(
    {
      version: '4.0',
      exportDate: iso(T0),
      expenses,
      categories: ['Food'],
      categoryMappings: {},
      ...extra,
    },
    'remote',
  )
const legacy = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  itemName: id,
  amount: 1,
  category: 'Food',
  date: '2026-10-18T04:00:00.000Z',
  createdAt: '2026-10-18T04:00:00.000Z',
  ...over,
})

describe('decidePush (§11.4, P-10): total over writer classes', HEAVY, () => {
  const c: Hlc = { last: 0 }
  const doc = docOf({ expenses: [rec('e1', c)], categories: ['Food'] })

  it('creates when the row is missing; repairs an invalid relay; never pushes over moved/newer/e2e', () => {
    expect(decidePush(doc, decodeWire(null, 'remote'), null, 'boot', NEW_MEMO, T0)).toEqual({
      kind: 'push',
      why: 'create',
      memoKey: null,
    })
    expect(decidePush(doc, decodeWire({ x: 1 }, 'remote'), ROW, 'remote', NEW_MEMO, T0).why).toBe(
      'repair',
    )
    expect(
      decidePush(
        doc,
        decodeWire(movedMarker('private', iso(T0)), 'remote'),
        ROW,
        'manual',
        NEW_MEMO,
        T0,
      ),
    ).toEqual({ kind: 'none', why: 'moved', memoKey: null })
    expect(
      decidePush(doc, decodeWire({ x5: { schema: 6 } }, 'remote'), ROW, 'manual', NEW_MEMO, T0).why,
    ).toBe('newer')
    expect(decidePush(doc, decodeWire({ st: 5 }, 'remote'), ROW, 'manual', NEW_MEMO, T0).why).toBe(
      'e2e-unopened',
    )
  })

  it('against a v5 relay: push iff the digests differ (join fixed point)', () => {
    expect(decidePush(doc, v5relay(doc), ROW, 'remote', NEW_MEMO, T0)).toEqual({
      kind: 'none',
      why: 'equal',
      memoKey: null,
    })
    const more = docOf({ expenses: [rec('e1', { last: 0 }), rec('e2', c)], categories: ['Food'] })
    expect(decidePush(more, v5relay(doc), ROW, 'remote', NEW_MEMO, T0).why).toBe('v5-diff')
  })

  it('against an old relay: adoptable news pushes once, then the memo suppresses it for 10 minutes', () => {
    const relay = v4([legacy('e1')])
    const mine = decodeWire(
      { version: '4.0', expenses: [legacy('e1'), legacy('e2')] },
      'local-envelope',
    ).doc
    const d = decidePush(mine, relay, ROW, 'remote', NEW_MEMO, T0)
    expect(d).toEqual({ kind: 'push', why: 'adoptable', memoKey: digestDoc(relay.doc) })
    const memo = commitPush(NEW_MEMO, d, T0)
    expect(decidePush(mine, relay, ROW, 'remote', memo, T0 + MEMO_WINDOW - 1).kind).toBe(
      'suppressed',
    )
    expect(decidePush(mine, relay, ROW, 'remote', memo, T0 + MEMO_WINDOW + 1).kind).toBe('push')
  })

  it('ext-refresh re-publishes v5-only facts at most every 10 minutes, never on a remote event', () => {
    const relay = v4([legacy('e1')])
    const mine: Doc = {
      ...decodeWire(
        { version: '4.0', expenses: [legacy('e1')], categories: ['Food'] },
        'local-envelope',
      ).doc,
      tombs: new Map([['gone', T0]]),
    }
    expect(decidePush(mine, relay, ROW, 'remote', NEW_MEMO, T0 + MEMO_WINDOW + 1).why).toBe(
      'old-quiet',
    )
    const d = decidePush(mine, relay, ROW, 'resume', NEW_MEMO, T0 + MEMO_WINDOW + 1)
    expect(d.why).toBe('ext-refresh')
    const memo = commitPush(NEW_MEMO, d, T0 + MEMO_WINDOW + 1)
    expect(memo.extRefreshAt).toBe(T0 + MEMO_WINDOW + 1)
    expect(decidePush(mine, relay, ROW, 'local-change', memo, T0 + MEMO_WINDOW + 5).why).toBe(
      'old-quiet',
    )
    expect(decidePush(mine, relay, ROW, 'boot', memo, T0 + 2 * MEMO_WINDOW + 2).why).toBe(
      'ext-refresh',
    )
  })
})

describe('commitPush', HEAVY, () => {
  it('records the memo only for adoptable pushes and prunes entries older than the window', () => {
    const push: PushDecision = { kind: 'push', why: 'adoptable', memoKey: 'k1' }
    const m1 = commitPush(NEW_MEMO, push, T0)
    expect(m1.memo).toEqual([['k1', T0]])
    const m2 = commitPush(m1, { kind: 'push', why: 'v5-diff', memoKey: null }, T0 + MEMO_WINDOW + 1)
    expect(m2.memo).toEqual([])
    const m3 = commitPush(m1, { ...push, memoKey: 'k1' }, T0 + 5)
    expect(m3.memo).toEqual([['k1', T0 + 5]])
  })
})

describe('ackOutbox (§11.5, P-31)', HEAVY, () => {
  const c: Hlc = { last: 0 }
  const e1 = rec('e1', c)
  const box = (entries: readonly (readonly [OutboxKey, Stamp])[]): ReadonlyMap<OutboxKey, Stamp> =>
    new Map(entries)

  it('pushed: removes every sent entry still at its sent stamp', () => {
    const outbox = box([
      ['ex:e1', 5],
      ['cat:Food', 6],
      ['bud:Food', 9],
    ])
    const sent: [OutboxKey, Stamp][] = [
      ['ex:e1', 5],
      ['cat:Food', 6],
      ['bud:Food', 7],
    ]
    const r = ackOutbox(outbox, sent, decodeWire(null, 'remote'), 'pushed')
    expect([...r.outbox]).toEqual([['bud:Food', 9]])
    expect(r.waitingForOld).toBe(0)
  })

  it('none against a v5 relay: the relay holds everything', () => {
    const d = docOf({ expenses: [e1] })
    const r = ackOutbox(box([['ex:e1', e1.C]]), [['ex:e1', e1.C]], v5relay(d), {
      kind: 'none',
      why: 'equal',
      memoKey: null,
    })
    expect(r.outbox.size).toBe(0)
  })

  it('none/suppressed against an old relay: only keys the relay holds at ≥ the stamp; the rest wait', () => {
    const relay = v4([legacy('e1', { updatedAt: iso(T0 + 50) })], {
      deletedIds: ['x'],
      categoryMappings: { kopi: 'Food' },
      budgets: { Food: 5 },
      budgetUpdatedAt: { Food: iso(T0 + 9) },
    })
    const sent: [OutboxKey, Stamp][] = [
      ['ex:e1', T0 + 50],
      ['ex:e2', T0],
      ['del:x', T0],
      ['del:y', T0],
      ['cat:Food', T0],
      ['cat:Gym', T0],
      ['ren:Food', T0],
      ['map:kopi', T0],
      ['bud:Food', T0 + 9],
      ['pref:currency', T0],
    ]
    const r = ackOutbox(box(sent), sent, relay, { kind: 'suppressed', why: 'memo', memoKey: 'k' })
    expect([...r.outbox.keys()].sort()).toEqual([
      'cat:Gym',
      'del:y',
      'ex:e2',
      'map:kopi',
      'pref:currency',
      'ren:Food',
    ])
    expect(r.waitingForOld).toBe(6)
  })

  it('moved/newer keep everything and are not counted as waiting for an old device', () => {
    const sent: [OutboxKey, Stamp][] = [['ex:e1', 1]]
    const r = ackOutbox(box(sent), sent, decodeWire(movedMarker('stopped', iso(T0)), 'remote'), {
      kind: 'none',
      why: 'moved',
      memoKey: null,
    })
    expect(r.outbox.size).toBe(1)
    expect(r.waitingForOld).toBe(0)
  })
})

describe('guardTrips (§11.9)', HEAVY, () => {
  it('trips at ≥ 10 removed and (≥ 50 or ≥ 10 % of live)', () => {
    const live = (n: number): Doc => ({
      ...EMPTY_DOC,
      expenses: new Map(Array.from({ length: n }, (_, i) => [`e${i}`, rec(`e${i}`, { last: 0 })])),
    })
    expect(guardTrips(9, live(20))).toBe(false)
    expect(guardTrips(10, live(100))).toBe(true)
    expect(guardTrips(10, live(101))).toBe(false)
    expect(guardTrips(50, live(10_000))).toBe(true)
    expect(guardTrips(49, live(1000))).toBe(false)
    expect(guardTrips([rec('a', { last: 0 })], live(1))).toBe(false)
  })
})

describe('push bounds on two v5 replicas (I5 core form)', HEAVY, () => {
  it('after one exchange nothing is pushed; one add costs one push', () => {
    const c: Hlc = { last: 0 }
    let a = docOf({ expenses: [rec('e1', c)] })
    let b: Doc = EMPTY_DOC
    let relay = v5relay(a)
    b = mergeDoc(b, relay.doc).doc
    expect(decidePush(b, relay, ROW, 'remote', NEW_MEMO, T0).kind).toBe('none')
    a = { ...a, expenses: new Map([...a.expenses, ['e2', rec('e2', c)]]) }
    expect(decidePush(a, relay, ROW, 'local-change', NEW_MEMO, T0).kind).toBe('push')
    relay = decodeWire(parseJson(JSON.stringify(encodeWire(a, { rev: 'r2' }))), 'remote')
    b = mergeDoc(b, relay.doc).doc
    expect(decidePush(b, relay, ROW, 'remote', NEW_MEMO, T0).kind).toBe('none')
  })
})

describe('a device clock before 2000 never push-loops (I4, I5)', HEAVY, () => {
  it('an add and an edit made at a 1970 or 1999 wall survive their own round trip; idle cycles push nothing', () => {
    for (const wall0 of [Date.UTC(1970, 0, 1, 0, 5), Date.UTC(1999, 11, 31, 23)]) {
      const c: Hlc = { last: 0 }
      let wall = wall0
      const next = (): OpCtx => {
        wall += 60_000
        return ctx(wall, c)
      }
      let d = addExpense(EMPTY_DOC, next(), {
        itemName: 'kopi',
        amount: 1.8,
        category: 'Food',
        day: '2026-10-19',
      }).doc
      const id = must([...d.expenses.keys()][0])
      d = updateExpense(d, next(), id, { amount: 2.2 }).doc
      const relay = decodeWire(parseJson(wireString(d, { dev: 'phone', rev: 'r' })), 'remote')
      expect(recordString(must(relay.doc.expenses.get(id)))).toBe(
        recordString(must(d.expenses.get(id))),
      )
      expect(digestDoc(relay.doc)).toBe(digestDoc(d))
      const m = mergeDoc(d, relay.doc).doc
      expect(m).toBe(d)
      for (let i = 0; i < 5; i++) {
        expect(decidePush(m, relay, { etag: `e${String(i)}` }, 'remote', NEW_MEMO, wall).kind).toBe(
          'none',
        )
      }
    }
  })
})
