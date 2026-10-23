// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { protoProbe } from '../__tests__/support/must'
import { nullRecord } from './constants'
import { FNV_A, FNV_B, canon, fnv36, fnvLane, hex8 } from './hash'

describe('canon (§4.4)', () => {
  it('sorts object keys, drops undefined members, keeps array order, no whitespace', () => {
    expect(canon({ b: 1, a: [3, 1, { z: 1, y: undefined }], c: undefined })).toBe(
      '{"a":[3,1,{"z":1}],"b":1}',
    )
    expect(canon([undefined, 1])).toBe('[null,1]')
    expect(canon(undefined)).toBe('null')
    expect(canon(null)).toBe('null')
    expect(canon('a"b')).toBe('"a\\"b"')
    expect(canon(true)).toBe('true')
  })

  it('renders numbers like JSON.stringify (NaN and ±Infinity become null)', () => {
    expect(canon([NaN, Infinity, -Infinity, -0, 1e21, 0.1])).toBe('[null,null,null,0,1e+21,0.1]')
  })

  it('is independent of key insertion order and prototype', () => {
    const np = nullRecord<number>()
    np.y = 2
    np.x = 1
    expect(canon(np)).toBe(canon({ x: 1, y: 2 }))
    // an own "__proto__" key (as JSON.parse creates) is an ordinary key
    const parsed: unknown = JSON.parse('{"__proto__":{"polluted":1},"a":1}')
    expect(canon(parsed)).toBe('{"__proto__":{"polluted":1},"a":1}')
    expect(protoProbe('polluted')).toBeUndefined()
  })
})

describe('FNV-1a 32 lanes', () => {
  it('matches the published FNV-1a 32 vectors on lane A', () => {
    expect(fnvLane('', FNV_A)).toBe(0x811c9dc5)
    expect(fnvLane('a', FNV_A)).toBe(0xe40c292c)
    expect(fnvLane('foobar', FNV_A)).toBe(0xbf9cf968)
  })

  it('lane B is an independent offset', () => {
    expect(FNV_B).toBe(0x050c5d1f)
    expect(fnvLane('', FNV_B)).toBe(0x050c5d1f)
    expect(fnvLane('foobar', FNV_B)).not.toBe(fnvLane('foobar', FNV_A))
  })

  it('hashes UTF-16 code units (pinned)', () => {
    expect(fnv36('')).toBe((0x811c9dc5).toString(36))
    expect(fnv36('foobar')).toBe((0xbf9cf968).toString(36))
    expect(fnv36('🍜 kopi')).toBe(fnvLane('🍜 kopi', FNV_A).toString(36))
    expect(fnv36('🍜 kopi')).toBe('9tn86')
  })

  it('hex8 pads to 8 lower-case hex digits', () => {
    expect(hex8(0)).toBe('00000000')
    expect(hex8(0xbf9cf968)).toBe('bf9cf968')
  })
})
