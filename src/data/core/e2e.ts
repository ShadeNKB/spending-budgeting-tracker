/**
 * Private sync codec (DATA-ENGINE-SPEC §13.2, §13.4, §13.7; track pins P-1, P-6, P-23, P-24).
 *
 * A private relay row holds only `{ st, k, r, iv, z, ct }`: AES-GCM-256 over (optionally gzipped)
 * JSON, under a row id, topic and key that are all derived from a 16-byte secret with HKDF-SHA256.
 * The additional data binds each ciphertext to its row, its revision and its compression flag, so
 * an envelope that is relabelled, moved to another row or flipped between gzip and plain fails
 * authentication. The inner JSON is the plaintext wire payload (§10.1); the caller decodes and
 * sanitises it like any other remote payload (authenticated data is still untrusted).
 *
 * Pure in the core sense: every random input (secret, IV, revision) comes from the caller, so the
 * outputs are pinned by the §13.7 known-answer vectors. WebCrypto, compression streams and text
 * codecs are computation, not IO. Byte streams are built with `ReadableStream`, never
 * `Blob.stream()` (absent under jsdom). `open` never throws: every failure is a typed result.
 *
 * FROZEN: the salt, the three HKDF labels, the plaintext-topic label, the AAD layout and the
 * envelope layout. A silent change would orphan every private row.
 */

const SALT = 'spendtrack/sync/v5'
const INFO_ROW_ID = 'row-id'
const INFO_TOPIC = 'topic'
const INFO_PAYLOAD_KEY = 'payload-key'
const PLAIN_TOPIC_LABEL = 'spendtrack/topic/v1|'
const TOPIC_PREFIX = 'st:'

const ST_VERSION = 5
const K_VERSION = 1
const SECRET_BYTES = 16
const IV_BYTES = 12
const TAG_BITS = 128
const TAG_BYTES = TAG_BITS / 8
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const REVISION = /^[A-Za-z0-9_-]{16,64}$/

/** Inflate ceiling: a gzip member that would expand past 16 MiB is refused (zip bomb). */
export const INFLATE_MAX = 16 * 1024 * 1024
/** Longest `ct` accepted, in base64url characters (1,050,000 bytes of ciphertext and tag). */
export const CT_MAX_CHARS = 1_400_000

export interface SyncKeys {
  /** Relay row id: a UUIDv8, so it passes the UUID check of migration 004 and never equals a v4 code. */
  readonly rowId: string
  /** Realtime channel name, including the `st:` prefix (P-6). */
  readonly topic: string
  /** AES-GCM-256, not extractable, for encrypt and decrypt only. */
  readonly key: CryptoKey
}

export interface Envelope {
  readonly st: 5
  readonly k: 1
  /** Revision: the same value as the inner `x5.rev`; bound into the AAD. */
  readonly r: string
  readonly iv: string
  readonly z: 0 | 1
  readonly ct: string
}

export interface SealParams {
  /** 16 to 64 base64url characters (16 random bytes from the caller). */
  readonly r: string
  /** 12 random bytes from the caller, fresh for every write. Copied before `seal` awaits anything. */
  readonly iv: Uint8Array
  /** 1 = gzip (needs `canCompress()`), 0 = none. */
  readonly z: 0 | 1
}

export type SealResult =
  | { readonly ok: true; readonly envelope: Envelope }
  | { readonly ok: false; readonly reason: 'too-large' }

export type OpenFailure = 'shape' | 'version' | 'auth' | 'inflate' | 'utf8' | 'json'

export type OpenResult =
  | { readonly ok: true; readonly inner: unknown }
  | { readonly ok: false; readonly kind: 'invalid' | 'newer'; readonly reason: OpenFailure }

// ---------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------

const utf8 = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

function buildB64urlTable(): Int8Array {
  const table = new Int8Array(128).fill(-1)
  for (let value = 0; value < B64URL.length; value++) table[B64URL.charCodeAt(value)] = value
  return table
}

/** Value of each base64url character by character code; -1 (or out of range) for anything else. */
const B64URL_VALUE = buildB64urlTable()

/** Unpadded base64url (RFC 4648 §5). */
export function b64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64URL.charAt((acc >>> bits) & 63)
    }
    acc &= (1 << bits) - 1
  }
  // The last 2 or 4 bits, padded with zero bits to a whole character.
  return bits > 0 ? out + B64URL.charAt(acc << (6 - bits)) : out
}

/**
 * Strict decoder: the base64url alphabet only, no padding, no whitespace, and zero leftover bits,
 * so every byte string has exactly one accepted spelling. Anything else is null.
 */
export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let acc = 0
  let bits = 0
  let j = 0
  for (let i = 0; i < text.length; i++) {
    const value = B64URL_VALUE[text.charCodeAt(i)] ?? -1
    if (value < 0) return null
    acc = ((acc << 6) | value) & 0xfff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[j++] = acc >>> bits
    }
  }
  return (acc & ((1 << bits) - 1)) === 0 ? out : null
}

/** Reads a whole byte stream; past `cap` bytes it cancels the stream and keeps nothing. Rejects if the stream errors. */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ readonly over: boolean; readonly bytes: Uint8Array<ArrayBuffer> }> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const step = await reader.read()
    if (step.done) break
    total += step.value.length
    if (total > cap) {
      await reader.cancel()
      return { over: true, bytes: new Uint8Array(0) }
    }
    parts.push(step.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return { over: false, bytes }
}

function streamOf(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const packed = streamOf(bytes).pipeThrough(new CompressionStream('gzip'))
  return (await readCapped(packed, Infinity)).bytes
}

/** Inflates with a running byte count: `over` past `INFLATE_MAX` (zip bomb). Rejects on corrupt gzip. */
function gunzip(bytes: Uint8Array<ArrayBuffer>): ReturnType<typeof readCapped> {
  return readCapped(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')), INFLATE_MAX)
}

/** Whether this platform can gzip and gunzip (Compression Streams API). */
export function canCompress(): boolean {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
}

// ---------------------------------------------------------------------------------------------
// Keys and topics
// ---------------------------------------------------------------------------------------------

/** Row id, topic and key for a private code's 16-byte secret (§13.2). */
export async function deriveKeys(secret: Uint8Array): Promise<SyncKeys> {
  if (secret.length !== SECRET_BYTES) throw new RangeError('A private sync secret is 16 bytes')
  const subtle = globalThis.crypto.subtle
  const ikm = await subtle.importKey('raw', Uint8Array.from(secret), 'HKDF', false, [
    'deriveBits',
    'deriveKey',
  ])
  const hkdf = (info: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: utf8(SALT),
    info: utf8(info),
  })
  const row = new Uint8Array(await subtle.deriveBits(hkdf(INFO_ROW_ID), ikm, 128)).map(
    // Version 8 in byte 6, the RFC 4122 variant in byte 8.
    (byte, i) => (i === 6 ? (byte & 0x0f) | 0x80 : i === 8 ? (byte & 0x3f) | 0x80 : byte),
  )
  const h = hex(row)
  const rowId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  const topicBits = new Uint8Array(await subtle.deriveBits(hkdf(INFO_TOPIC), ikm, 128))
  const key = await subtle.deriveKey(
    hkdf(INFO_PAYLOAD_KEY),
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return { rowId, topic: TOPIC_PREFIX + b64urlEncode(topicBits), key }
}

/** Realtime channel of a plaintext (UUID) row: `st:` + 32 hex of SHA-256 (§11.2). Pass the code as stored. */
export async function plainTopic(code: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8(PLAIN_TOPIC_LABEL + code))
  return TOPIC_PREFIX + hex(new Uint8Array(digest)).slice(0, 32)
}

/** Additional authenticated data: binds a ciphertext to its row, revision and compression flag. */
export function aadOf(rowId: string, r: string, z: 0 | 1): string {
  return `st5|k${K_VERSION}|${rowId}|${r}|z${z}`
}

const aesGcm = (iv: Uint8Array<ArrayBuffer>, rowId: string, r: string, z: 0 | 1): AesGcmParams => ({
  name: 'AES-GCM',
  iv,
  additionalData: utf8(aadOf(rowId, r, z)),
  tagLength: TAG_BITS,
})

/** Unpadded base64url length of `n` bytes. */
const b64urlLength = (n: number): number => Math.ceil((n * 4) / 3)

// ---------------------------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------------------------

/**
 * Encrypts the inner wire JSON. Never produces an envelope that `open` would refuse: past the
 * inflate ceiling or the ciphertext ceiling it returns `too-large` instead. A caller mistake (an IV
 * that is not 12 bytes, a malformed revision, gzip where the platform has none) throws RangeError.
 */
export async function seal(
  innerJson: string,
  keys: SyncKeys,
  params: SealParams,
): Promise<SealResult> {
  const iv = Uint8Array.from(params.iv)
  const { r, z } = params
  if (iv.length !== IV_BYTES) throw new RangeError('The IV is 12 bytes')
  if (!REVISION.test(r)) throw new RangeError('The revision is 16 to 64 base64url characters')
  if (z === 1 && !canCompress()) throw new RangeError('gzip is not available here: seal with z = 0')

  const plain = utf8(innerJson)
  if (plain.length > INFLATE_MAX) return { ok: false, reason: 'too-large' }
  const data = z === 1 ? await gzip(plain) : plain
  if (b64urlLength(data.length + TAG_BYTES) > CT_MAX_CHARS)
    return { ok: false, reason: 'too-large' }

  const ct = await globalThis.crypto.subtle.encrypt(aesGcm(iv, keys.rowId, r, z), keys.key, data)
  return {
    ok: true,
    envelope: {
      st: ST_VERSION,
      k: K_VERSION,
      r,
      iv: b64urlEncode(iv),
      z,
      ct: b64urlEncode(new Uint8Array(ct)),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------------------------

interface ParsedEnvelope {
  readonly r: string
  readonly iv: Uint8Array<ArrayBuffer>
  readonly z: 0 | 1
  readonly ct: Uint8Array<ArrayBuffer>
}

const invalid = (reason: OpenFailure): OpenResult => ({ ok: false, kind: 'invalid', reason })
const newer = (reason: OpenFailure): OpenResult => ({ ok: false, kind: 'newer', reason })

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value)

/** An own data property; never runs a getter and never reads the prototype chain. */
function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined || !('value' in descriptor)) return undefined
  const value: unknown = descriptor.value
  return value
}

/**
 * Steps 1 and 2 of §13.4: the version is judged first (a newer writer may change everything
 * else), then the exact shape. Extra fields are ignored.
 */
function readEnvelope(value: unknown): ParsedEnvelope | OpenResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('shape')
  const st = ownValue(value, 'st')
  if (!isInteger(st) || st < ST_VERSION) return invalid('shape')
  if (st > ST_VERSION) return newer('version')
  const k = ownValue(value, 'k')
  if (!isInteger(k) || k < K_VERSION) return invalid('shape')
  if (k > K_VERSION) return newer('version')

  const r = ownValue(value, 'r')
  const iv = ownValue(value, 'iv')
  const z = ownValue(value, 'z')
  const ct = ownValue(value, 'ct')
  if (typeof r !== 'string' || !REVISION.test(r)) return invalid('shape')
  if (typeof iv !== 'string' || iv.length !== b64urlLength(IV_BYTES)) return invalid('shape')
  if (z !== 0 && z !== 1) return invalid('shape')
  if (typeof ct !== 'string' || ct.length > CT_MAX_CHARS) return invalid('shape')
  const ivBytes = b64urlDecode(iv)
  const ctBytes = b64urlDecode(ct)
  if (ivBytes === null || ctBytes === null) return invalid('shape')
  return { r, iv: ivBytes, z, ct: ctBytes }
}

/**
 * Opens an envelope pulled from the relay (§13.4 steps 1-4 plus the JSON parse of step 5).
 * Never throws. `invalid` means repairable garbage (forged, tampered, damaged); `newer` means a
 * newer writer, or gzip this platform cannot read, so the caller must not overwrite the row.
 */
export async function open(value: unknown, keys: SyncKeys): Promise<OpenResult> {
  let envelope: ParsedEnvelope | OpenResult
  try {
    envelope = readEnvelope(value)
  } catch {
    return invalid('shape') // a hostile object (a proxy trap) is not an envelope
  }
  if ('ok' in envelope) return envelope

  let data: Uint8Array<ArrayBuffer>
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      aesGcm(envelope.iv, keys.rowId, envelope.r, envelope.z),
      keys.key,
      envelope.ct,
    )
    data = new Uint8Array(plain)
  } catch {
    return invalid('auth')
  }

  if (envelope.z === 1) {
    if (typeof DecompressionStream !== 'function') return newer('inflate')
    try {
      const inflated = await gunzip(data)
      if (inflated.over) return invalid('inflate')
      data = inflated.bytes
    } catch {
      return invalid('inflate')
    }
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return invalid('utf8')
  }
  try {
    const inner: unknown = JSON.parse(text)
    return { ok: true, inner }
  } catch {
    return invalid('json')
  }
}
