// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { must, parseJson, protoProbe } from '../__tests__/support/must'
import { HEAVY, makeRng } from '../__tests__/support/rng'
import {
  cleanAmount,
  cleanWire,
  isPlainObject,
  own,
  ownEntries,
  sanitizeExpense,
  validCurrency,
  validId,
  validItemName,
  validMapKey,
  validName,
  type CleanExpense,
} from './sanitize'

const base = {
  id: 'e1',
  itemName: 'Chicken rice',
  amount: 4.5,
  category: 'Food & Dining',
  date: '2026-10-15T04:00:00.000Z',
  createdAt: '2026-10-15T04:00:00.000Z',
}

function clean(raw: unknown): CleanExpense {
  const r = sanitizeExpense(raw)
  if (r.kind === 'quarantine') throw new Error(`quarantined: ${r.reason}`)
  return r.rec
}

describe('field predicates', HEAVY, () => {
  it('validId: string 1–64, no control chars, not reserved', () => {
    expect(validId('e1')).toBe(true)
    expect(validId('x'.repeat(64))).toBe(true)
    expect(validId('x'.repeat(65))).toBe(false)
    expect(validId('')).toBe(false)
    expect(validId('a\nb')).toBe(false)
    expect(validId('a\u007fb')).toBe(false)
    expect(validId('constructor')).toBe(false)
    expect(validId('__proto__')).toBe(false)
    expect(validId(12)).toBe(false)
  })

  it('validName: not blank, no control chars, not reserved (raw or trimmed), any length (R5)', () => {
    expect(validName('Food & Dining')).toBe(true)
    expect(validName(' Food ')).toBe(true)
    expect(validName('   ')).toBe(false)
    // v0.8 never capped names: a longer one is real data, kept on the boundary (ops cap new input)
    expect(validName('x'.repeat(61))).toBe(true)
    expect(validName('x'.repeat(5000))).toBe(true)
    expect(validName('toString')).toBe(false)
    expect(validName(' toString ')).toBe(false)
    expect(validName('ToString')).toBe(true)
    expect(validName('a\tb')).toBe(false)
    expect(validName({ name: 'Hacked' })).toBe(false)
  })

  it('validItemName / validMapKey / validCurrency', () => {
    expect(validItemName(' kopi ')).toBe(true)
    expect(validItemName('')).toBe(false)
    expect(validItemName(' '.repeat(5))).toBe(false)
    expect(validItemName('x'.repeat(200))).toBe(true)
    expect(validItemName('x'.repeat(201))).toBe(true)
    expect(validItemName('x'.repeat(5000))).toBe(true)
    expect(validItemName('constructor')).toBe(true)
    expect(validMapKey('chicken rice')).toBe(true)
    expect(validMapKey('x'.repeat(201))).toBe(true)
    expect(validMapKey('constructor')).toBe(false)
    expect(validMapKey('')).toBe(false)
    expect(validCurrency('SGD')).toBe(true)
    expect(validCurrency('sgd')).toBe(false)
    expect(validCurrency('SGDX')).toBe(false)
  })

  it('cleanAmount: finite, 0 < x ≤ 1e7, numeric strings repaired', () => {
    expect(cleanAmount(4.5)).toEqual({ value: 4.5, repaired: false })
    expect(cleanAmount('300')).toEqual({ value: 300, repaired: true })
    expect(cleanAmount(' 12.50 ')).toEqual({ value: 12.5, repaired: true })
    expect(cleanAmount(1e7)).toEqual({ value: 1e7, repaired: false })
    for (const bad of [
      0,
      -1,
      -1e9,
      1e9,
      1e7 + 0.01,
      NaN,
      Infinity,
      -Infinity,
      'abc',
      '',
      '0x10',
      null,
      [5],
      {},
    ]) {
      expect(cleanAmount(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('own / ownEntries / isPlainObject read own data only', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":1},"a":1}')
    expect(isPlainObject(parsed)).toBe(true)
    if (!isPlainObject(parsed)) return
    expect(own(parsed, '__proto__')).toEqual({ polluted: 1 })
    expect(own(parsed, 'toString')).toBeUndefined()
    expect(must(ownEntries(parsed)).map(([k]) => k)).toEqual(['__proto__', 'a'])
    expect(ownEntries([1])).toBeNull()
    expect(ownEntries(null)).toBeNull()
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
    expect(protoProbe('polluted')).toBeUndefined()
  })
})

describe('sanitizeExpense (§8.1)', HEAVY, () => {
  it('accepts a v0.8 record unchanged', () => {
    const r = sanitizeExpense(base)
    expect(r.kind).toBe('ok')
    expect(cleanWire(clean(base))).toEqual(base)
  })

  it('quarantines with exact reasons, in table order', () => {
    const q = (raw: unknown): string => {
      const r = sanitizeExpense(raw)
      return r.kind === 'quarantine' ? r.reason : r.kind
    }
    expect(q(null)).toBe('not-object')
    expect(q([base])).toBe('not-object')
    expect(q('x')).toBe('not-object')
    expect(q(new Date())).toBe('not-object')
    expect(q({ ...base, id: '' })).toBe('bad-id')
    expect(q({ ...base, id: 'constructor' })).toBe('bad-id')
    expect(q({ ...base, id: 7 })).toBe('bad-id')
    expect(q({ ...base, id: '', itemName: '' })).toBe('bad-id')
    expect(q({ ...base, itemName: '' })).toBe('bad-name')
    expect(q({ ...base, itemName: '  ' })).toBe('bad-name')
    expect(q({ ...base, itemName: 5 })).toBe('bad-name')
    expect(q({ ...base, amount: 'abc' })).toBe('bad-amount')
    expect(q({ ...base, amount: -1e9 })).toBe('bad-amount')
    expect(q({ ...base, amount: 1e9 })).toBe('bad-amount')
    expect(q({ ...base, amount: NaN })).toBe('bad-amount')
    expect(q({ ...base, date: 'last tuesday' })).toBe('bad-date')
    expect(q({ ...base, date: '18/10/2026' })).toBe('bad-date')
    expect(q({ ...base, date: 'not-a-date' })).toBe('bad-date')
    expect(q({ ...base, date: undefined })).toBe('bad-date')
  })

  it('repairs deterministically and logs what it repaired', () => {
    const r = sanitizeExpense({
      ...base,
      amount: '12',
      category: { evil: 1 },
      createdAt: 'garbage',
      updatedAt: 'nope',
      notes: { x: 1 },
      day: '2026-02-30',
      fs: { a: 'x' },
      h: 'x'.repeat(17),
    })
    expect(r.kind).toBe('repaired')
    if (r.kind !== 'repaired') return
    expect(r.notes).toEqual([
      'amount',
      'category',
      'createdAt',
      'updatedAt',
      'notes',
      'day',
      'fs',
      'h',
    ])
    expect(r.rec.amount).toBe(12)
    expect(r.rec.category).toBe('Other')
    expect(r.rec.createdAt).toBe(base.date)
    expect(r.rec.updatedAt).toBeUndefined()
    expect(r.rec.notes).toBeUndefined()
    expect(r.rec.day).toBeUndefined()
    expect(r.rec.fs).toBeUndefined()
    expect(r.rec.h).toBeUndefined()
    // a missing createdAt falls back to the date
    expect(clean({ ...base, createdAt: undefined }).createdAt).toBe(base.date)
  })

  it('keeps valid v5 fields verbatim (day, fs, h, notes, null notes)', () => {
    const c = clean({
      ...base,
      notes: 'to camp',
      day: '2026-10-15',
      fs: { a: 1_792_345_678_901, n: [1_792_345_600_000, 1] },
      h: '1x9k2q0',
    })
    expect(c.notes).toBe('to camp')
    expect(c.day).toBe('2026-10-15')
    expect(c.fs).toEqual({ a: 1_792_345_678_901, n: [1_792_345_600_000, 1] })
    expect(c.h).toBe('1x9k2q0')
    expect(clean({ ...base, notes: null }).notes).toBeUndefined()
    expect(sanitizeExpense({ ...base, notes: null }).kind).toBe('ok')
    // v0.8 never capped notes, so notes of any length stay as-is (no repair, nothing dropped)
    const receipt = 'receipt line '.repeat(200)
    expect(clean({ ...base, notes: receipt }).notes).toBe(receipt)
    expect(sanitizeExpense({ ...base, notes: receipt }).kind).toBe('ok')
  })

  it('rejects malformed fs maps as a whole', () => {
    for (const fs of [
      { z: 1 },
      { a: [1, 2] },
      { a: [1] },
      { a: NaN },
      [1, 2],
      'x',
      { a: [1, 1, 1] },
      { constructor: 1 },
    ]) {
      expect(clean({ ...base, fs }).fs, JSON.stringify(fs)).toBeUndefined()
    }
    expect(clean({ ...base, fs: { a: [5, 0] } }).fs).toEqual({ a: [5, 0] })
  })

  it('keeps ≤ 16 valid extras keys within 2 KB, dropping the excess in sorted-key order', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) many[`k${String(i).padStart(2, '0')}`] = i
    const c = clean({ ...base, ...many })
    expect(Object.keys(c.extras)).toEqual(Object.keys(many).sort().slice(0, 16))
    expect(Object.getPrototypeOf(c.extras)).toBeNull()

    const big = clean({ ...base, aa: 'x'.repeat(1000), bb: 'y'.repeat(1000), cc: 'z'.repeat(100) })
    expect(Object.keys(big.extras)).toEqual(['aa', 'bb'])
    expect(JSON.stringify(big.extras).length).toBeLessThanOrEqual(2048)

    const odd = sanitizeExpense({ ...base, kind: 'expense', _x: 1, '1a': 2, 'a-b': 3, toString: 4 })
    expect(odd.kind).toBe('repaired')
    if (odd.kind === 'quarantine') return
    expect(Object.keys(odd.rec.extras)).toEqual(['kind'])
    expect(odd.rec.extras.kind).toBe('expense')
  })

  it('an own "__proto__" or "constructor" key never pollutes and never throws', () => {
    const raw: unknown = JSON.parse(
      '{"id":"p1","itemName":"Lunch","amount":5,"category":"Food","date":"2026-10-18T12:00:00",' +
        '"createdAt":"2026-10-18T04:00:00.000Z","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}',
    )
    const r = sanitizeExpense(raw)
    expect(r.kind).toBe('repaired')
    expect(protoProbe('polluted')).toBeUndefined()
    expect(protoProbe('polluted2')).toBeUndefined()
  })

  it('never throws: hostile getters, proxies, cycles, deep nesting, huge strings', () => {
    const getter = { ...base }
    Object.defineProperty(getter, 'notes', {
      enumerable: true,
      get() {
        throw new Error('boom')
      },
    })
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap')
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap')
        },
      },
    )
    const cyclic: Record<string, unknown> = { ...base }
    cyclic.loop = cyclic
    let deep: unknown = 1
    for (let i = 0; i < 100_000; i++) deep = [deep]
    const inputs: unknown[] = [
      getter,
      proxy,
      cyclic,
      { ...base, deep },
      { ...base, itemName: 'x'.repeat(5_000_000) },
      { ...base, notes: 'n'.repeat(5_000_000) },
      Object.create({ inherited: 1 }),
      undefined,
      Symbol('s'),
      () => 1,
      12n,
    ]
    for (const raw of inputs) {
      expect(() => sanitizeExpense(raw)).not.toThrow()
    }
    expect(sanitizeExpense(proxy)).toEqual({ kind: 'quarantine', reason: 'internal' })
    expect(sanitizeExpense(getter).kind).toBe('ok')
    expect(Object.keys(clean(cyclic).extras)).toEqual([])
    expect(Object.keys(clean({ ...base, deep }).extras)).toEqual([])
  })

  it('is deterministic and idempotent over random hostile records', () => {
    const r = makeRng(11)
    const values: unknown[] = [
      null,
      0,
      -1,
      1.5,
      '12',
      'abc',
      '',
      'constructor',
      '2026-10-15',
      '2026-10-15T04:00:00.000Z',
      'last tuesday',
      { x: 1 },
      [1, [0, 1]],
      1e9,
      true,
      '2099-12-31T00:00:00.000Z',
    ]
    const keys = [
      'id',
      'itemName',
      'amount',
      'category',
      'date',
      'createdAt',
      'updatedAt',
      'notes',
      'day',
      'fs',
      'h',
      'kind',
      '__proto__',
    ]
    for (let i = 0; i < 3000; i++) {
      const raw: Record<string, unknown> = { ...base }
      for (const k of keys) {
        if (r.chance(0.3)) {
          Object.defineProperty(raw, k, { value: r.pick(values), enumerable: true, writable: true })
        }
      }
      const a = sanitizeExpense(raw)
      const b = sanitizeExpense(parseJson(JSON.stringify(raw)))
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
      if (a.kind !== 'quarantine') {
        const again = sanitizeExpense(cleanWire(a.rec))
        expect(again.kind).toBe('ok')
        if (again.kind !== 'quarantine') expect(cleanWire(again.rec)).toEqual(cleanWire(a.rec))
      }
    }
  })
})
