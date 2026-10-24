import { describe, expect, it } from 'vitest'
import { CANON_MAX_DEPTH, canon, canonRow, fnv1a, nestsWithin } from './canon'

/** `{a: {a: … {a: leaf}}}`, `levels` objects deep. */
function nested(levels: number, leaf: unknown = 1): unknown {
  let value: unknown = leaf
  for (let i = 0; i < levels; i++) value = { a: value }
  return value
}

describe('canon', () => {
  it('sorts object keys at every depth', () => {
    expect(canon({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    )
  })

  it('is independent of key insertion order', () => {
    expect(canon({ x: 1, y: 'a' })).toBe(canon({ y: 'a', x: 1 }))
  })

  it('drops undefined members and keeps null', () => {
    expect(canon({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('keeps array order and renders undefined array slots as null', () => {
    expect(canon([2, 1, undefined])).toBe('[2,1,null]')
  })

  it('renders numbers and strings as JSON does', () => {
    expect(canon(4.5)).toBe('4.5')
    expect(canon(Number.NaN)).toBe('null')
    expect(canon('a"b')).toBe('"a\\"b"')
    expect(canon(true)).toBe('true')
    expect(canon(undefined)).toBe('null')
  })

  it('works on null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>
    o.b = 2
    o.a = 1
    expect(canon(o)).toBe('{"a":1,"b":2}')
  })

  it('keeps an own __proto__ key as data', () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"x":1},"a":1}')
    expect(canon(parsed)).toBe('{"__proto__":{"x":1},"a":1}')
  })

  it('writes exact JSON down to its depth limit', () => {
    const value = nested(CANON_MAX_DEPTH, 'leaf')
    expect(canon(value)).toBe(JSON.stringify(value))
    expect(canon(nested(CANON_MAX_DEPTH, 1))).not.toBe(canon(nested(CANON_MAX_DEPTH, 2)))
  })

  // A hostile relay row nested ~3,000 levels deep overflowed the recursion: every device then
  // failed to read the relay and retried forever. JSON.parse reads any depth, so canon must too.
  it('never overflows the stack, however deep the value', () => {
    for (const levels of [CANON_MAX_DEPTH + 1, 3000, 100_000]) {
      const value = nested(levels)
      expect(() => canon(value)).not.toThrow()
      expect(canon([value])).toBe(canon([nested(levels)]))
    }
    expect(canon(nested(100_000))).not.toContain('"a":1')
  })
})

describe('nestsWithin', () => {
  it('counts the levels of objects and arrays below the value', () => {
    expect(nestsWithin(1, 0)).toBe(true)
    expect(nestsWithin({ a: 1, b: 'x' }, 0)).toBe(true)
    expect(nestsWithin({ a: { b: 1 } }, 0)).toBe(false)
    expect(nestsWithin({ a: { b: 1 } }, 1)).toBe(true)
    expect(nestsWithin({ fs: { amount: [1, 2] } }, 2)).toBe(true)
    expect(nestsWithin({ fs: { amount: [1, [2]] } }, 2)).toBe(false)
  })

  it('answers for any depth without recursion', () => {
    expect(nestsWithin(nested(100_000), 16)).toBe(false)
    expect(nestsWithin(nested(16), 16)).toBe(true)
  })
})

describe('canonRow', () => {
  it('equals canon for objects and primitives', () => {
    const row = { id: 'a', amount: 1 }
    expect(canonRow(row)).toBe(canon(row))
    expect(canonRow(null)).toBe('null')
  })

  it('returns the cached string for the same object', () => {
    const row = { id: 'a', amount: 1 }
    const first = canonRow(row)
    expect(canonRow(row)).toBe(first)
  })
})

describe('fnv1a', () => {
  it('matches the FNV-1a 32-bit reference values', () => {
    expect(fnv1a('')).toBe((0x811c9dc5).toString(36))
    expect(fnv1a('a')).toBe((0xe40c292c).toString(36))
    expect(fnv1a('foobar')).toBe((0xbf9cf968).toString(36))
  })

  it('differs for different input', () => {
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'))
  })
})
