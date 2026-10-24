// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { extrasOf } from '../__tests__/support/gen'
import { must } from '../__tests__/support/must'
import { makeRng } from '../__tests__/support/rng'
import { canon, fnv36 } from './hash'
import { dedupeId, dedupeRoot, newId, newRev, reviveId, rootId, rootKey } from './ids'
import type { ExpenseRec, Extras, Reg } from './types'

const reg = <T>(v: T): Reg<T> => ({ v, s: 1_792_345_600_000, r: 2 })
const noExtras: Extras = extrasOf({})
const rec = (id: string, amount = 21): ExpenseRec => ({
  id,
  createdAt: '2026-10-18T13:02:11.123Z',
  C: 1_792_345_600_000,
  n: reg('Grab to camp'),
  a: reg(amount),
  c: reg('Food'),
  d: reg({ date: '2026-10-18T04:00:00.000Z', day: '2026-10-18' }),
  o: reg(null),
  x: reg(noExtras),
})
const never = (): boolean => false

describe('newId / newRev (P-7)', () => {
  it('newId is an RFC 4122 v4 UUID drawn from the injected rng only', () => {
    const a = newId(makeRng(1).next)
    const b = newId(makeRng(1).next)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const r = makeRng(2)
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) seen.add(newId(r.next))
    expect(seen.size).toBe(2000)
  })

  it('newRev is format-identical to 16 random bytes in base64url (22 chars)', () => {
    const r = makeRng(3)
    for (let i = 0; i < 500; i++) {
      const rev = newRev(r.next)
      expect(rev).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/)
    }
    expect(newRev(() => 0)).toBe('AAAAAAAAAAAAAAAAAAAAAA')
    expect(newRev(() => 0.999999)).toBe('_____________________w')
  })
})

describe('rootId', () => {
  it('strips one derived suffix', () => {
    expect(rootId('e1')).toBe('e1')
    expect(rootId('e1~r1x9k2q0')).toBe('e1')
    expect(rootId('e1~d3f.12')).toBe('e1')
    expect(rootId('e1~r1x9k2q0~d3f')).toBe('e1~r1x9k2q0')
    expect(rootId('e1~x12')).toBe('e1~x12')
    expect(rootId('e1~r12345678')).toBe('e1~r12345678')
  })

  it('rootKey is the ≤ 48-char root; dedupeRoot recognises dedupe-derived ids only', () => {
    expect(rootKey('e1~rq9p2jh.7')).toBe('e1')
    expect(rootKey('x'.repeat(64))).toBe('x'.repeat(48))
    expect(dedupeRoot('dup~d76bx7b')).toBe('dup')
    expect(dedupeRoot('dup~d76bx7b.12')).toBe('dup')
    expect(dedupeRoot('dup~rq9p2jh')).toBeNull()
    expect(dedupeRoot('dup')).toBeNull()
    expect(dedupeRoot('dup~d12345678')).toBeNull()
  })
})

describe('reviveId (§4.3, P-20)', () => {
  it('is deterministic from content (no stamps), so two devices derive the same id', () => {
    const a = reviveId(rec('e1'), 'Food', never)
    const b = reviveId({ ...rec('e1'), a: { v: 21, s: 1, r: 0 } }, 'Food', never)
    expect(a).toBe(b)
    expect(a).toBe(
      `e1~r${fnv36(canon(['Grab to camp', 21, 'Food', '2026-10-18T04:00:00.000Z', null, {}]))}`,
    )
    // golden: persisted across builds
    expect(a).toBe('e1~rq9p2jh')
  })

  it('uses the resolved category and differs by content', () => {
    expect(reviveId(rec('e1'), 'Meals', never)).not.toBe(reviveId(rec('e1'), 'Food', never))
    expect(reviveId(rec('e1', 22), 'Food', never)).not.toBe(reviveId(rec('e1'), 'Food', never))
  })

  it('skips taken candidates with .2, .3, … and keeps every id ≤ 64 chars', () => {
    const base = must(reviveId(rec('e1'), 'Food', never))
    const taken = new Set([base, `${base}.2`])
    expect(reviveId(rec('e1'), 'Food', (id) => taken.has(id))).toBe(`${base}.3`)
    // the last candidate of the longest root is still ≤ 64 chars
    const long = 'x'.repeat(64)
    const derived = must(reviveId(rec(long), 'Food', (id) => !id.endsWith('.999')))
    expect(derived).toMatch(/^x{48}~r[0-9a-z]{1,7}\.999$/)
    expect(derived.length).toBeLessThanOrEqual(64)
  })

  it('is total: when every candidate is taken it returns null, never a taken id', () => {
    const seen: string[] = []
    const all = (id: string): boolean => {
      seen.push(id)
      return true
    }
    expect(reviveId(rec('e1'), 'Food', all)).toBeNull()
    // the candidate and .2 … .999, each asked once
    expect(seen.length).toBe(999)
    expect(new Set(seen).size).toBe(999)
    expect(dedupeId({ id: 'dup', itemName: 'Lunch A', amount: 4.5 }, () => true)).toBeNull()
  })

  it('reviving a revived id does not stack suffixes', () => {
    const once = must(reviveId(rec('e1'), 'Food', never))
    expect(rootId(once)).toBe('e1')
    expect(rootId(must(reviveId(rec(once, 5), 'Food', never)))).toBe('e1')
  })
})

describe('dedupeId (§7.9)', () => {
  it('derives a stable id from the canonical wire copy', () => {
    const raw = { id: 'dup', itemName: 'Lunch A', amount: 4.5 }
    const id = dedupeId(raw, never)
    expect(id).toBe(`dup~d${fnv36(canon(raw))}`)
    expect(id).toBe(dedupeId({ amount: 4.5, itemName: 'Lunch A', id: 'dup' }, never))
    expect(id).toBe('dup~d76bx7b')
    expect(dedupeId(raw, (x) => x === id)).toBe(`${id}.2`)
  })
})
