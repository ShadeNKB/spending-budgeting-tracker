// The st5:db envelope (DATA-ENGINE-SPEC §9.3, track spec §8.3): "5|" + digest + "|" + body.
// One atomic setItem per flush; the digest is verified on every load.
import { digestDoc } from '../core/doc'
import { isPlainObject, own } from '../core/sanitize'
import type { Doc, MemoState, OutboxKey, SanitizeResult, Stamp } from '../core/types'
import { decodeWire, wireString } from '../core/wire'
import { listOf, parseJson } from './json'
import type { SyncMeta } from './types'

export interface EnvelopeMeta {
  readonly hlc: Stamp
  readonly gen: string
  readonly outbox: readonly (readonly [OutboxKey, Stamp])[]
  readonly sync: SyncMeta
  /** fnv36 of the v4 strings last written; null = mirror off or never written. */
  readonly mirrorSum: string | null
  readonly mirrorOff: 'quota' | null
  readonly persisted: boolean | null
  readonly persistAskedAt: number | null
  readonly lastBackupAt: number | null
  readonly dailySnapDay: string | null
  readonly migratedAt: number | null
  /** How many quarantine entries the owner has seen (needs-attention badge). */
  readonly attentionSeen: number
}

const EMPTY_MEMO: MemoState = { memo: [], extRefreshAt: 0 }

export const freshSyncMeta = (): SyncMeta => ({
  lastRev: null,
  memo: EMPTY_MEMO,
  legacySeen: {},
  repairAt: 0,
})

export const freshMeta = (): EnvelopeMeta => ({
  hlc: 0,
  gen: '',
  outbox: [],
  sync: freshSyncMeta(),
  mirrorSum: null,
  mirrorOff: null,
  persisted: null,
  persistAskedAt: null,
  lastBackupAt: null,
  dailySnapDay: null,
  migratedAt: null,
  attentionSeen: 0,
})

export const ENVELOPE_PREFIX = '5|'

/** The envelope string: the doc as its wire text (cached record strings), then the meta. */
export function buildEnvelope(doc: Doc, meta: EnvelopeMeta): string {
  return `${ENVELOPE_PREFIX}${digestDoc(doc)}|{"f":1,"doc":${wireString(doc)},"meta":${JSON.stringify(meta)}}`
}

// ── tolerant meta reading: a damaged field falls back to its fresh value ────────────────────

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const OUTBOX_KINDS: ReadonlySet<string> = new Set(['ex', 'del', 'cat', 'ren', 'map', 'bud', 'pref'])

function isOutboxKey(v: unknown): v is OutboxKey {
  if (typeof v !== 'string') return false
  const at = v.indexOf(':')
  return at > 0 && OUTBOX_KINDS.has(v.slice(0, at))
}

function readOutbox(v: unknown): readonly (readonly [OutboxKey, Stamp])[] {
  const out: (readonly [OutboxKey, Stamp])[] = []
  for (const pair of listOf(v)) {
    const [k, s] = listOf(pair)
    if (isOutboxKey(k) && typeof s === 'number' && Number.isFinite(s)) out.push([k, s])
  }
  return out
}

function readMemo(v: unknown): MemoState {
  if (!isPlainObject(v)) return EMPTY_MEMO
  const memo: (readonly [string, number])[] = []
  for (const pair of listOf(own(v, 'memo'))) {
    const [k, t] = listOf(pair)
    if (typeof k === 'string' && typeof t === 'number' && Number.isFinite(t)) memo.push([k, t])
  }
  return { memo, extRefreshAt: num(own(v, 'extRefreshAt'), 0) }
}

function readSync(v: unknown): SyncMeta {
  if (!isPlainObject(v)) return freshSyncMeta()
  const seen = own(v, 'legacySeen')
  const legacySeen: { v084?: number; v085?: number } = {}
  if (isPlainObject(seen)) {
    const a = numOrNull(own(seen, 'v084'))
    const b = numOrNull(own(seen, 'v085'))
    if (a !== null) legacySeen.v084 = a
    if (b !== null) legacySeen.v085 = b
  }
  return {
    lastRev: strOrNull(own(v, 'lastRev')),
    memo: readMemo(own(v, 'memo')),
    legacySeen,
    repairAt: num(own(v, 'repairAt'), 0),
  }
}

export function readMeta(v: unknown): EnvelopeMeta {
  if (!isPlainObject(v)) return freshMeta()
  const persisted = own(v, 'persisted')
  return {
    hlc: num(own(v, 'hlc'), 0),
    gen: strOrNull(own(v, 'gen')) ?? '',
    outbox: readOutbox(own(v, 'outbox')),
    sync: readSync(own(v, 'sync')),
    mirrorSum: strOrNull(own(v, 'mirrorSum')),
    mirrorOff: own(v, 'mirrorOff') === 'quota' ? 'quota' : null,
    persisted: typeof persisted === 'boolean' ? persisted : null,
    persistAskedAt: numOrNull(own(v, 'persistAskedAt')),
    lastBackupAt: numOrNull(own(v, 'lastBackupAt')),
    dailySnapDay: strOrNull(own(v, 'dailySnapDay')),
    migratedAt: numOrNull(own(v, 'migratedAt')),
    attentionSeen: num(own(v, 'attentionSeen'), 0),
  }
}

/**
 * Another tab's stored meta joined into ours (§9.9): sync memo and stamps by max, the stored
 * mirror sum (the keys are shared storage), facts by the newer reading.
 */
export function joinMeta(ours: EnvelopeMeta, theirs: EnvelopeMeta): EnvelopeMeta {
  const max = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.max(a, b)
  const memo = new Map(ours.sync.memo.memo)
  for (const [k, t] of theirs.sync.memo.memo) memo.set(k, Math.max(memo.get(k) ?? 0, t))
  const seen = (k: 'v084' | 'v085'): { v084?: number; v085?: number } => {
    const v = max(ours.sync.legacySeen[k] ?? null, theirs.sync.legacySeen[k] ?? null)
    return v === null ? {} : { [k]: v }
  }
  const sync: SyncMeta = {
    lastRev: theirs.sync.lastRev ?? ours.sync.lastRev,
    memo: {
      memo: [...memo],
      extRefreshAt: Math.max(ours.sync.memo.extRefreshAt, theirs.sync.memo.extRefreshAt),
    },
    legacySeen: { ...seen('v084'), ...seen('v085') },
    repairAt: Math.max(ours.sync.repairAt, theirs.sync.repairAt),
  }
  const day = (a: string | null, b: string | null): string | null =>
    a === null ? b : b === null ? a : a > b ? a : b
  return {
    ...ours,
    sync,
    mirrorSum: theirs.mirrorSum,
    mirrorOff: theirs.mirrorOff ?? ours.mirrorOff,
    persisted: theirs.persisted ?? ours.persisted,
    persistAskedAt: max(ours.persistAskedAt, theirs.persistAskedAt),
    lastBackupAt: max(ours.lastBackupAt, theirs.lastBackupAt),
    dailySnapDay: day(ours.dailySnapDay, theirs.dailySnapDay),
    migratedAt: max(ours.migratedAt, theirs.migratedAt),
    attentionSeen: Math.max(ours.attentionSeen, theirs.attentionSeen),
  }
}

export type ParsedEnvelope =
  | {
      readonly ok: true
      readonly doc: Doc
      readonly meta: EnvelopeMeta
      readonly dec: SanitizeResult
      readonly digest: string
    }
  | {
      readonly ok: false
      readonly reason: 'prefix' | 'json' | 'shape' | 'digest'
      /** The body's body, when it parsed (a digest mismatch): one input of the recovery merge. */
      readonly dec?: SanitizeResult
      readonly meta?: EnvelopeMeta
    }

/** The body of an envelope string (after "5|<digest>|"), or null without the prefix. */
export function envelopeBody(
  raw: string,
): { readonly digest: string; readonly body: string } | null {
  if (!raw.startsWith(ENVELOPE_PREFIX)) return null
  const bar = raw.indexOf('|', ENVELOPE_PREFIX.length)
  if (bar < 0) return null
  return { digest: raw.slice(ENVELOPE_PREFIX.length, bar), body: raw.slice(bar + 1) }
}

/**
 * Prefix, JSON.parse, decodeWire('local-envelope'), digest check. Never throws. With `verify: false`
 * (boot) the digest is returned as stored and checked by the caller once the views are up: hashing
 * every record of a freshly decoded doc is the single largest boot cost (§8.12).
 */
export function parseEnvelope(raw: string, at: number, reuse?: Doc, verify = true): ParsedEnvelope {
  const parts = envelopeBody(raw)
  if (parts === null) return { ok: false, reason: 'prefix' }
  const parsed = parseJson(parts.body)
  if (parsed === null) return { ok: false, reason: 'json' }
  const body = parsed.value
  if (!isPlainObject(body) || own(body, 'f') !== 1 || !isPlainObject(own(body, 'doc'))) {
    return { ok: false, reason: 'shape' }
  }
  const meta = readMeta(own(body, 'meta'))
  const dec = decodeWire(
    own(body, 'doc'),
    'local-envelope',
    reuse === undefined ? { at } : { at, reuse },
  )
  if (dec.writer !== 'v5' || (verify && digestDoc(dec.doc) !== parts.digest)) {
    return { ok: false, reason: 'digest', dec, meta }
  }
  return { ok: true, doc: dec.doc, meta, dec, digest: parts.digest }
}
