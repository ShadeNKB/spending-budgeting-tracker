// The quarantine (DATA-ENGINE-SPEC §8.3, P2-15): everything the engine could not keep live, kept
// raw and never auto-deleted. `st5:q` is an append-only log of QEntry, deduped by (origin, raw
// hash) and capped at QUARANTINE_BYTES (it then stops growing and says so); a corrupt whole key is
// copied to `st5:q:<key>:<ts>`. A tab that keeps meeting another tab's envelope it cannot read
// keeps at most RAW_COPIES_PER_KEY distinct copies of it (it must not fill storage with them).
import { LIVE_AND_DELETED, QUARANTINE_BYTES, nullRecord } from '../core/constants'
import { fnv36 } from '../core/hash'
import { isPlainObject, own } from '../core/sanitize'
import type { Origin, QEntry } from '../core/types'
import { storedList } from './json'
import type { Io, WriteResult } from './io'
import { QUARANTINE_KEY, QUARANTINE_RAW_PREFIX } from './keys'

const ORIGINS: ReadonlySet<string> = new Set([
  'local-envelope',
  'local-v4',
  'remote',
  'file',
  'snapshot',
])

const isOrigin = (v: unknown): v is Origin => typeof v === 'string' && ORIGINS.has(v)

/**
 * Distinct raw copies a tab keeps of another tab's envelope it cannot read; past them it does not
 * overwrite that envelope. Boot, migration and the relay copy are not capped: each is one copy per
 * event, and a cap there would turn the next damaged value into running in memory only.
 */
export const RAW_COPIES_PER_KEY = 3

/** Entries the owner should look at: unreadable rows. Repairs and dropped pieces are logged only. */
export const needsAttention = (q: QEntry): boolean =>
  !q.reason.startsWith('repaired:') &&
  !q.reason.startsWith('dropped:') &&
  q.reason !== LIVE_AND_DELETED

const dedupeKey = (q: QEntry): string => `${q.origin}|${fnv36(q.raw)}`

function parseLog(text: string | null): QEntry[] {
  const out: QEntry[] = []
  for (const e of storedList(text)) {
    if (!isPlainObject(e)) continue
    const at = own(e, 'at')
    const origin = own(e, 'origin')
    const reason = own(e, 'reason')
    const raw = own(e, 'raw')
    if (typeof at === 'number' && isOrigin(origin) && typeof reason === 'string') {
      if (typeof raw === 'string') out.push({ at, origin, reason, raw })
    }
  }
  return out
}

export interface QuarantineAdd {
  /** Entries that were new (not already logged). */
  readonly added: number
  /** New needs-attention entries among them. */
  readonly attention: number
  /** False when the log could not be written (the entries are then not kept on disk). */
  readonly stored: boolean
}

export class Quarantine {
  private entries: QEntry[] = []
  private seen = new Set<string>()
  private chars = 2
  private rawCopies = 0
  private isFull = false

  constructor(
    private readonly io: Io,
    /** Writes with the engine's shedding (§9.11), never shedding the quarantine itself. */
    private readonly writeShed: (key: string, value: string) => WriteResult,
  ) {}

  /** Reads the log and counts the raw copies (boot, and before a write from another tab). */
  load(): void {
    const text = this.io.get(QUARANTINE_KEY)
    this.entries = parseLog(text)
    this.seen = new Set(this.entries.map(dedupeKey))
    this.chars = text?.length ?? 2
    this.isFull = this.chars >= QUARANTINE_BYTES
    this.rawCopies = this.io
      .keysWithPrefix(QUARANTINE_RAW_PREFIX)
      .filter((k) => !isSecretCopy(k)).length
  }

  /** Appends the entries not yet logged. Read-merge-write, so two tabs never drop each other's. */
  add(entries: readonly QEntry[]): QuarantineAdd {
    if (entries.length === 0) return { added: 0, attention: 0, stored: true }
    this.load()
    const fresh: QEntry[] = []
    let size = this.chars
    for (const q of entries) {
      const k = dedupeKey(q)
      if (this.seen.has(k)) continue
      const cost = JSON.stringify(q).length + 1
      if (size + cost > QUARANTINE_BYTES) {
        // stops growing; eviction comes only after a download (PR-4)
        this.isFull = true
        break
      }
      size += cost
      this.seen.add(k)
      fresh.push(q)
    }
    if (fresh.length === 0) return { added: 0, attention: 0, stored: true }
    const next = [...this.entries, ...fresh]
    const text = JSON.stringify(next)
    if (this.writeShed(QUARANTINE_KEY, text) !== 'ok') {
      for (const q of fresh) this.seen.delete(dedupeKey(q))
      return { added: 0, attention: 0, stored: false }
    }
    this.entries = next
    this.chars = text.length
    return {
      added: fresh.length,
      attention: fresh.filter(needsAttention).length,
      stored: true,
    }
  }

  /**
   * Copies a corrupt whole key byte for byte. False when that copy cannot be stored: no room, or
   * `cap` other copies of the key are kept already.
   */
  addRaw(key: string, raw: string, at: number, cap = Number.POSITIVE_INFINITY): boolean {
    const existing = this.io.keysWithPrefix(`${QUARANTINE_RAW_PREFIX}${key}:`)
    // the same bytes are already kept: nothing new to store
    for (const k of existing) if (this.io.get(k) === raw) return true
    if (existing.length >= cap) return false
    let ts = at
    while (this.io.get(`${QUARANTINE_RAW_PREFIX}${key}:${String(ts)}`) !== null) ts++
    if (this.writeShed(`${QUARANTINE_RAW_PREFIX}${key}:${String(ts)}`, raw) !== 'ok') return false
    this.rawCopies++
    return true
  }

  /** Needs-attention count: unreadable rows plus raw copies of whole keys. */
  count(): number {
    return this.entries.filter(needsAttention).length + this.rawCopies
  }

  /**
   * Of count(), the raw copies of whole stored values (a damaged envelope, a v4 key, a relay
   * copy): not entries, and said differently. Copies of the sync code are not counted at all:
   * they never leave the device in the download, and sync falls back on its own.
   */
  copies(): number {
    return this.rawCopies
  }

  full(): boolean {
    return this.isFull
  }

  /** The needs-attention entries and raw copies as one downloadable object (no secrets). */
  file(exportedAt: string): unknown {
    const raw = nullRecord<string>()
    for (const k of this.io.keysWithPrefix(QUARANTINE_RAW_PREFIX)) {
      if (isSecretCopy(k)) continue
      const v = this.io.get(k)
      if (v !== null) raw[k] = v
    }
    return {
      app: 'SpendTrack',
      kind: 'needs-attention',
      version: 1,
      exportedAt,
      note: "Entries SpendTrack couldn't read, kept exactly as they were found.",
      entries: this.entries.filter(needsAttention),
      rawKeys: raw,
    }
  }
}

/** Raw copies of the sync config or code never leave the device in a file. */
export const isSecretCopy = (key: string): boolean =>
  key.startsWith(`${QUARANTINE_RAW_PREFIX}syncId:`) ||
  key.startsWith(`${QUARANTINE_RAW_PREFIX}st5:sync:`)
