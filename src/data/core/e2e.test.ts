// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CT_MAX_CHARS,
  INFLATE_MAX,
  aadOf,
  b64urlDecode,
  b64urlEncode,
  canCompress,
  deriveKeys,
  open,
  plainTopic,
  readCapped,
  seal,
  type Envelope,
  type OpenResult,
  type SyncKeys,
} from './e2e'

/** CPU- and WebCrypto-heavy suites: generous so a fully loaded parallel run (all time zones, simulations) cannot flake. */
const HEAVY = { timeout: 60_000 }

// ---------------------------------------------------------------------------------------------
// Helpers (local on purpose: U2 imports nothing from the rest of the data layer)
// ---------------------------------------------------------------------------------------------

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('must: missing value')
  return value
}

/** Seeded PRNG (mulberry32): every random case below is reproducible from its seed. */
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

function bytes(r: () => number, n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = int(r, 256)
  return out
}

const KAT_SECRET = Uint8Array.from({ length: 16 }, (_, i) => i)
const R0 = 'AAAAAAAAAAAAAAAAAAAAAA'
const IV0 = new Uint8Array(12)
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s)

async function sealed(
  inner: string,
  keys: SyncKeys,
  z: 0 | 1 = 0,
  r: string = R0,
  iv: Uint8Array = IV0,
): Promise<Envelope> {
  const res = await seal(inner, keys, { r, iv, z })
  if (!res.ok) throw new Error('seal refused: ' + res.reason)
  return res.envelope
}

/** Encrypts arbitrary bytes with the right AAD: an authentic envelope whose content is bad. */
async function sealRawBytes(
  keys: SyncKeys,
  data: Uint8Array<ArrayBuffer>,
  z: 0 | 1,
): Promise<Record<string, unknown>> {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: IV0, additionalData: utf8(aadOf(keys.rowId, R0, z)), tagLength: 128 },
    keys.key,
    data,
  )
  return { st: 5, k: 1, r: R0, iv: b64urlEncode(IV0), z, ct: b64urlEncode(new Uint8Array(ct)) }
}

async function gzipBytes(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      c.enqueue(data)
      c.close()
    },
  }).pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The platform inflater, kept before any test stubs the global. */
const PlatformInflater = DecompressionStream

/**
 * A stand-in for `DecompressionStream` that counts the bytes its reader actually pulls (no
 * read-ahead: highWaterMark 0) and records whether that reader cancelled it.
 */
function meteredInflater(): {
  Inflater: new (format: CompressionFormat) => ReadableWritablePair<Uint8Array, BufferSource>
  inflated: () => number
  lastChunk: () => number
  cancelled: () => boolean
} {
  let inflated = 0
  let lastChunk = 0
  let cancelled = false
  class Inflater implements ReadableWritablePair<Uint8Array, BufferSource> {
    readonly writable: WritableStream<BufferSource>
    readonly readable: ReadableStream<Uint8Array>
    constructor(format: CompressionFormat) {
      const inner = new PlatformInflater(format)
      const reader = inner.readable.getReader()
      this.writable = inner.writable
      this.readable = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const step = await reader.read()
            if (step.done) {
              controller.close()
              return
            }
            inflated += step.value.length
            lastChunk = step.value.length
            controller.enqueue(step.value)
          },
          cancel(reason: unknown) {
            cancelled = true
            return reader.cancel(reason)
          },
        },
        { highWaterMark: 0 },
      )
    }
  }
  return {
    Inflater,
    inflated: () => inflated,
    lastChunk: () => lastChunk,
    cancelled: () => cancelled,
  }
}

function flipBit(b64: string, byteIndex: number, bit: number): string {
  const raw = must(b64urlDecode(b64))
  raw[byteIndex] = (raw[byteIndex] ?? 0) ^ (1 << bit)
  return b64urlEncode(raw)
}

type FailReason = Extract<OpenResult, { ok: false }>['reason']
const invalid = (reason: FailReason): OpenResult => ({ ok: false, kind: 'invalid', reason })

/** Every failure open may report: `newer` only for a version or for gzip the platform cannot read. */
const ALLOWED_FAILURES = new Set([
  'invalid/shape',
  'invalid/auth',
  'invalid/inflate',
  'invalid/utf8',
  'invalid/json',
  'newer/version',
  'newer/inflate',
])

function isAllowedResult(res: OpenResult): boolean {
  return res.ok || ALLOWED_FAILURES.has(`${res.kind}/${res.reason}`)
}

/** Random JSON-safe values, with the characters that matter for codecs (quotes, escapes, astral). */
function randomJson(r: () => number, depth = 0): unknown {
  const pick = int(r, depth > 3 ? 4 : 6)
  if (pick === 0) return int(r, 2) === 0 ? null : r() < 0.5
  if (pick === 1) return Math.round((r() - 0.5) * 1e6) / 100
  if (pick === 2 || pick === 3) {
    const parts = ['Kopi O', 'chicken rice', '"', '\\', 'é', '🍜', ',', ']', '{', ' ']
    let s = ''
    for (let i = int(r, 6); i > 0; i--) s += must(parts[int(r, parts.length)])
    return s
  }
  if (pick === 4) return Array.from({ length: int(r, 4) }, () => randomJson(r, depth + 1))
  const o: Record<string, unknown> = {}
  for (let i = int(r, 4); i > 0; i--) o['k' + String(int(r, 50))] = randomJson(r, depth + 1)
  return o
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------------------------

describe('base64url (strict alphabet, no padding)', HEAVY, () => {
  it('matches the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'Zg'],
      ['fo', 'Zm8'],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy'],
    ]
    for (const [plain, encoded] of vectors) {
      expect(b64urlEncode(utf8(plain))).toBe(encoded)
      expect(new TextDecoder().decode(must(b64urlDecode(encoded)))).toBe(plain)
    }
    expect(b64urlEncode(Uint8Array.from([0xfb, 0xff]))).toBe('-_8')
    expect(Array.from(must(b64urlDecode('-_8')))).toEqual([0xfb, 0xff])
  })

  it('round-trips random byte strings and agrees with the platform base64', () => {
    const r = rng(1)
    for (let n = 0; n < 300; n++) {
      const b = bytes(r, n % 70)
      const enc = b64urlEncode(b)
      const reference = btoa(String.fromCharCode(...b))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
      expect(enc).toBe(reference)
      expect(Array.from(must(b64urlDecode(enc)))).toEqual(Array.from(b))
    }
  })

  it('rejects anything that is not canonical unpadded base64url', () => {
    for (const bad of [
      'Zg==',
      'Zm9v+',
      'Zm9/',
      'Zm 9v',
      'Zm9v\n',
      'Z',
      'Zm9vY',
      'Zh',
      'Zm9',
      'éA',
    ]) {
      expect(b64urlDecode(bad)).toBeNull()
    }
    // 'Zh' and 'Zm9' carry non-zero leftover bits: two strings may never decode to the same bytes.
    expect(b64urlDecode('Zg')).not.toBeNull()
    expect(b64urlDecode('Zm8')).not.toBeNull()
  })
})

describe(
  'section 13.7 known-answer vectors (frozen: a change orphans every private row)',
  HEAVY,
  () => {
    it('derives the pinned row id and topic from secret 00..0f', async () => {
      const keys = await deriveKeys(KAT_SECRET)
      expect(keys.rowId).toBe('e4555323-21f5-8f92-8c6a-97e208c0967b')
      expect(keys.topic).toBe('st:LlILSIkurgodVGmluLVEOQ')
    })

    it('builds the pinned AAD and ciphertext, in the pinned envelope layout', async () => {
      const keys = await deriveKeys(KAT_SECRET)
      expect(aadOf(keys.rowId, R0, 0)).toBe(
        'st5|k1|e4555323-21f5-8f92-8c6a-97e208c0967b|AAAAAAAAAAAAAAAAAAAAAA|z0',
      )
      const env = await sealed('{"a":1}', keys)
      expect(env.ct).toBe('25CMHMKJg6TS_JuohdXzIbyU_YRCs9M')
      expect(JSON.stringify(env)).toBe(
        '{"st":5,"k":1,"r":"AAAAAAAAAAAAAAAAAAAAAA","iv":"AAAAAAAAAAAAAAAA","z":0,"ct":"25CMHMKJg6TS_JuohdXzIbyU_YRCs9M"}',
      )
      expect(await open(JSON.parse(JSON.stringify(env)), keys)).toEqual({
        ok: true,
        inner: { a: 1 },
      })
    })

    it('derives the pinned plaintext topic, with exactly one st: prefix (P-6)', async () => {
      expect(await plainTopic('00000000-0000-4000-8000-000000000000')).toBe(
        'st:dbf7a76143b3c235e2fc2005db551df2',
      )
      const keys = await deriveKeys(KAT_SECRET)
      for (const topic of [keys.topic, await plainTopic('3f0b4b0e-6c35-4a6c-9b1e-0d1c2e3f4a5b')]) {
        expect(topic.startsWith('st:')).toBe(true)
        expect(topic.indexOf('st:', 1)).toBe(-1)
      }
    })
  },
)

describe('deriveKeys', HEAVY, () => {
  it('is deterministic, distinct per secret, and yields a UUIDv8 row id and a b64url topic', async () => {
    const r = rng(2)
    const seen = new Set<string>()
    for (let i = 0; i < 16; i++) {
      const secret = bytes(r, 16)
      const a = await deriveKeys(secret)
      const b = await deriveKeys(Uint8Array.from(secret))
      expect(a.rowId).toBe(b.rowId)
      expect(a.topic).toBe(b.topic)
      expect(a.rowId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
      expect(a.topic).toMatch(/^st:[A-Za-z0-9_-]{22}$/)
      expect(a.topic.includes(a.rowId.slice(0, 8))).toBe(false)
      seen.add(a.rowId)
      seen.add(a.topic)
    }
    expect(seen.size).toBe(32)
  })

  it('makes a non-extractable AES-GCM-256 key for encrypt and decrypt only', async () => {
    const { key } = await deriveKeys(KAT_SECRET)
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt'])
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('refuses a secret that is not exactly 16 bytes', async () => {
    await expect(deriveKeys(new Uint8Array(15))).rejects.toThrow(RangeError)
    await expect(deriveKeys(new Uint8Array(17))).rejects.toThrow(RangeError)
  })
})

describe('seal and open', HEAVY, () => {
  it('round-trips random payloads, with and without gzip, under random revisions and IVs', async () => {
    const r = rng(3)
    const keys = await deriveKeys(bytes(r, 16))
    for (let i = 0; i < 40; i++) {
      const value = randomJson(r)
      const json = JSON.stringify(value)
      const z = i % 2 === 0 ? 0 : 1
      const rev = b64urlEncode(bytes(r, 16))
      const env = await sealed(json, keys, z, rev, bytes(r, 12))
      expect(Object.keys(env)).toEqual(['st', 'k', 'r', 'iv', 'z', 'ct'])
      expect(env).toMatchObject({ st: 5, k: 1, r: rev, z })
      expect(env.iv).toMatch(/^[A-Za-z0-9_-]{16}$/)
      const wire: unknown = JSON.parse(JSON.stringify(env))
      const opened = await open(wire, keys)
      const inner: unknown = JSON.parse(json)
      expect(opened).toEqual({ ok: true, inner })
    }
  })

  it('compresses repetitive payloads when z = 1', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const rows = Array.from({ length: 641 }, (_, i) => ({
      id: 'row-' + String(i),
      itemName: i % 3 === 0 ? 'Chicken rice' : 'Grab to camp',
      amount: 3.5 + (i % 7),
      category: i % 3 === 0 ? 'Food' : 'Transport',
      date: '2026-10-18T04:00:00.000Z',
    }))
    const json = JSON.stringify({ expenses: rows })
    const plain = await sealed(json, keys, 0)
    const packed = await sealed(json, keys, 1)
    expect(packed.ct.length * 4).toBeLessThan(plain.ct.length)
    const inner: unknown = JSON.parse(json)
    expect(await open(packed, keys)).toEqual({ ok: true, inner })
  })

  it('needs no Blob (jsdom has none with stream()): byte streams come from ReadableStream', async () => {
    vi.stubGlobal('Blob', undefined)
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{"b":[1,2,3]}', keys, 1)
    expect(await open(env, keys)).toEqual({ ok: true, inner: { b: [1, 2, 3] } })
  })

  it('does not depend on the caller keeping its IV buffer unchanged', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const zs: (0 | 1)[] = [0, 1]
    for (const z of zs) {
      const iv = new Uint8Array(12)
      const pending = seal('{"a":1}', keys, { r: R0, iv, z })
      iv.fill(7)
      const res = await pending
      if (!res.ok) throw new Error('seal refused')
      expect(res.envelope.iv).toBe('AAAAAAAAAAAAAAAA')
      if (z === 0) expect(res.envelope.ct).toBe('25CMHMKJg6TS_JuohdXzIbyU_YRCs9M')
      expect(await open(res.envelope, keys)).toEqual({ ok: true, inner: { a: 1 } })
    }
  })

  it('refuses caller mistakes instead of writing an envelope that open would reject', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const cases: { r: string; iv: Uint8Array; z: 0 | 1 }[] = [
      { r: R0, iv: new Uint8Array(11), z: 0 },
      { r: R0, iv: new Uint8Array(13), z: 0 },
      { r: 'A'.repeat(15), iv: IV0, z: 0 },
      { r: 'A'.repeat(65), iv: IV0, z: 0 },
      { r: 'AAAAAAAAAAAAAAAAAAAAA=', iv: IV0, z: 0 },
    ]
    for (const params of cases) {
      await expect(seal('{}', keys, params)).rejects.toThrow(RangeError)
    }
  })

  it('refuses z = 1 where the platform cannot compress', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    vi.stubGlobal('CompressionStream', undefined)
    expect(canCompress()).toBe(false)
    await expect(seal('{}', keys, { r: R0, iv: IV0, z: 1 })).rejects.toThrow(RangeError)
    expect((await seal('{}', keys, { r: R0, iv: IV0, z: 0 })).ok).toBe(true)
  })

  it('reports too-large exactly at the ciphertext ceiling (z = 0)', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    // 1,049,984 plaintext bytes + 16 tag bytes = 1,050,000 bytes = exactly CT_MAX_CHARS chars.
    const fits = '"' + 'a'.repeat(1_049_982) + '"'
    const env = await sealed(fits, keys, 0)
    expect(env.ct.length).toBe(CT_MAX_CHARS)
    const opened = await open(env, keys)
    expect(opened.ok && typeof opened.inner === 'string' && opened.inner.length).toBe(1_049_982)
    const over = '"' + 'a'.repeat(1_049_983) + '"'
    expect(await seal(over, keys, { r: R0, iv: IV0, z: 0 })).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  it('reports too-large past the inflate ceiling (z = 1): never seals what open refuses', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const atCeiling = '"' + 'a'.repeat(INFLATE_MAX - 2) + '"'
    const env = await sealed(atCeiling, keys, 1)
    const opened = await open(env, keys)
    expect(opened.ok && typeof opened.inner === 'string' && opened.inner.length).toBe(
      INFLATE_MAX - 2,
    )
    const pastCeiling = '"' + 'a'.repeat(INFLATE_MAX - 1) + '"'
    expect(await seal(pastCeiling, keys, { r: R0, iv: IV0, z: 1 })).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })
})

describe('open never throws and fails closed', HEAVY, () => {
  it('rejects a flipped ciphertext bit anywhere, including the tag (invalid/auth)', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{"amount":12.5}', keys)
    const length = must(b64urlDecode(env.ct)).length
    for (let i = 0; i < length; i++) {
      expect(await open({ ...env, ct: flipBit(env.ct, i, i % 8) }, keys)).toEqual(invalid('auth'))
    }
  })

  it('rejects a relabelled revision, a swapped row, a wrong key, a flipped z or IV (invalid/auth)', async () => {
    const r = rng(4)
    const keys = await deriveKeys(KAT_SECRET)
    const other = await deriveKeys(bytes(r, 16))
    const env = await sealed('{"amount":12.5}', keys)
    expect(await open({ ...env, r: b64urlEncode(bytes(r, 16)) }, keys)).toEqual(invalid('auth'))
    expect(await open(env, { ...keys, rowId: other.rowId })).toEqual(invalid('auth'))
    expect(await open(env, other)).toEqual(invalid('auth'))
    expect(await open({ ...env, z: 1 }, keys)).toEqual(invalid('auth'))
    expect(await open({ ...env, iv: flipBit(env.iv, 0, 0) }, keys)).toEqual(invalid('auth'))
    expect(await open({ ...env, ct: '' }, keys)).toEqual(invalid('auth'))
  })

  it('reads st > 5 or k > 1 as newer, before judging the rest of the shape', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{}', keys)
    const newer = { ok: false, kind: 'newer', reason: 'version' }
    expect(await open({ ...env, st: 6 }, keys)).toEqual(newer)
    expect(await open({ ...env, k: 2 }, keys)).toEqual(newer)
    expect(await open({ st: 6 }, keys)).toEqual(newer)
    expect(await open({ st: 7, k: 9, iv: 'whatever', ct: 42 }, keys)).toEqual(newer)
    expect(await open({ st: 5, k: 2 }, keys)).toEqual(newer)
  })

  it('rejects every malformed envelope as invalid/shape', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{}', keys)
    // An accessor that would hand over the authentic ciphertext: only own data properties count.
    let getterRuns = 0
    const getter = { ...env }
    Object.defineProperty(getter, 'ct', {
      get() {
        getterRuns++
        return env.ct
      },
      enumerable: true,
    })
    const trap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap')
        },
        get() {
          throw new Error('trap')
        },
        has() {
          throw new Error('trap')
        },
      },
    )
    const shapes: unknown[] = [
      null,
      undefined,
      0,
      'st5',
      true,
      [],
      [env],
      {},
      Object.create(env),
      Object.assign([], env),
      getter,
      trap,
      { ...env, st: 4 },
      { ...env, st: '5' },
      { ...env, st: 5.5 },
      { ...env, st: Number.NaN },
      { ...env, st: Number.POSITIVE_INFINITY },
      { ...env, k: 0 },
      { ...env, k: '1' },
      { ...env, k: undefined },
      { ...env, r: 'A'.repeat(15) },
      { ...env, r: 'A'.repeat(65) },
      { ...env, r: 'A'.repeat(21) + '+' },
      { ...env, r: 22 },
      { ...env, iv: 'A'.repeat(15) },
      { ...env, iv: 'A'.repeat(17) },
      { ...env, iv: 'AAAAAAAAAAAAAAA=' },
      { ...env, iv: null },
      { ...env, z: 2 },
      { ...env, z: '0' },
      { ...env, z: false },
      { ...env, z: undefined },
      { ...env, ct: null },
      { ...env, ct: env.ct + '=' },
      { ...env, ct: env.ct.replace(/[A-Za-z0-9]/, '+') },
      { ...env, ct: 'A' },
      { ...env, ct: 'A'.repeat(CT_MAX_CHARS + 4) },
    ]
    for (const bad of shapes) {
      expect(await open(bad, keys)).toEqual(invalid('shape'))
    }
    expect(getterRuns).toBe(0)
  })

  it('ignores unknown extra fields (forward compatible) and survives a __proto__ key', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{"x":1}', keys)
    const wire: unknown = JSON.parse(
      JSON.stringify(env).replace('{', '{"__proto__":{"polluted":1},"extra":[1],'),
    )
    expect(await open(wire, keys)).toEqual({ ok: true, inner: { x: 1 } })
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('reports authentic but unreadable content as inflate, utf8 or json', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    expect(await open(await sealRawBytes(keys, utf8('{"a":1}'), 1), keys)).toEqual(
      invalid('inflate'),
    )
    const truncatedGzip = (await gzipBytes(utf8('{"a":1}'))).slice(0, 12)
    expect(await open(await sealRawBytes(keys, truncatedGzip, 1), keys)).toEqual(invalid('inflate'))
    expect(
      await open(await sealRawBytes(keys, Uint8Array.from([0x7b, 0xff, 0x7d]), 0), keys),
    ).toEqual(invalid('utf8'))
    expect(
      await open(await sealRawBytes(keys, await gzipBytes(Uint8Array.from([0xc3])), 1), keys),
    ).toEqual(invalid('utf8'))
    expect(await open(await sealRawBytes(keys, utf8('{"a":'), 0), keys)).toEqual(invalid('json'))
    expect(await open(await sealRawBytes(keys, utf8(''), 0), keys)).toEqual(invalid('json'))
  })

  it('aborts a 20 MiB gzip bomb past 16 MiB (invalid/inflate)', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const bomb = await gzipBytes(new Uint8Array(20 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(100_000)
    expect(await open(await sealRawBytes(keys, bomb, 1), keys)).toEqual(invalid('inflate'))
  })

  it('inflates the bomb at most one chunk past 16 MiB, then cancels the inflater', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const bomb = await gzipBytes(new Uint8Array(20 * 1024 * 1024))
    const meter = meteredInflater()
    vi.stubGlobal('DecompressionStream', meter.Inflater)
    expect(await open(await sealRawBytes(keys, bomb, 1), keys)).toEqual(invalid('inflate'))
    expect(meter.inflated()).toBeGreaterThan(INFLATE_MAX)
    expect(meter.inflated() - meter.lastChunk()).toBeLessThanOrEqual(INFLATE_MAX)
    expect(meter.cancelled()).toBe(true)
  })

  it('reads an honest gzip payload to the end without cancelling (control for the meter)', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const json = JSON.stringify({ note: 'x'.repeat(100_000) })
    const env = await sealed(json, keys, 1)
    const meter = meteredInflater()
    vi.stubGlobal('DecompressionStream', meter.Inflater)
    const inner: unknown = JSON.parse(json)
    expect(await open(env, keys)).toEqual({ ok: true, inner })
    expect(meter.inflated()).toBe(json.length)
    expect(meter.cancelled()).toBe(false)
  })

  it('treats z = 1 as newer where the platform cannot inflate (never invalid, so never repaired over)', async () => {
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{"a":1}', keys, 1)
    vi.stubGlobal('DecompressionStream', undefined)
    expect(canCompress()).toBe(false)
    expect(await open(env, keys)).toEqual({ ok: false, kind: 'newer', reason: 'inflate' })
    expect(await open(await sealed('{"a":1}', keys, 0), keys)).toEqual({
      ok: true,
      inner: { a: 1 },
    })
  })

  it('returns an allowed result for random values and random mutations of a valid envelope', async () => {
    const r = rng(5)
    const keys = await deriveKeys(KAT_SECRET)
    const env = await sealed('{"amount":4.2}', keys, 1)
    const fields = ['st', 'k', 'r', 'iv', 'z', 'ct', 'extra']
    for (let i = 0; i < 400; i++) {
      const candidate: Record<string, unknown> = { ...env }
      for (let m = 1 + int(r, 3); m > 0; m--) {
        const field = must(fields[int(r, fields.length)])
        candidate[field] = i % 5 === 0 ? undefined : randomJson(r)
      }
      const res = await open(i % 7 === 0 ? randomJson(r) : candidate, keys)
      expect(isAllowedResult(res)).toBe(true)
    }
  })
})

describe('readCapped', HEAVY, () => {
  /** A lazy source of 1 KiB chunks; it ends after 1,000 (1 MiB) so a broken cap fails instead of eating memory. */
  function counter(chunk: number): {
    stream: ReadableStream<Uint8Array>
    pulls: () => number
    cancelled: () => boolean
  } {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++
          c.enqueue(new Uint8Array(chunk))
          if (pulls === 1000) c.close()
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    return { stream, pulls: () => pulls, cancelled: () => cancelled }
  }

  it('stops reading as soon as the count passes the cap, and cancels the stream', async () => {
    const src = counter(1024)
    const res = await readCapped(src.stream, 10_000)
    expect(res).toEqual({ over: true, bytes: new Uint8Array(0) })
    expect(src.cancelled()).toBe(true)
    expect(src.pulls()).toBeLessThanOrEqual(11)
  })

  it('keeps every byte up to and including the cap, and refuses one byte more', async () => {
    const data = Uint8Array.from({ length: 5000 }, (_, i) => i % 251)
    const streamOfData = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(data.subarray(0, 1234))
          c.enqueue(data.subarray(1234))
          c.close()
        },
      })
    const res = await readCapped(streamOfData(), 5000)
    expect(res.over).toBe(false)
    expect(Array.from(res.bytes)).toEqual(Array.from(data))
    expect(await readCapped(streamOfData(), 4999)).toEqual({ over: true, bytes: new Uint8Array(0) })
  })

  it('rejects when the stream errors (open turns that into invalid/inflate)', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new TypeError('corrupt'))
      },
    })
    await expect(readCapped(failing, 10)).rejects.toThrow(TypeError)
  })
})
