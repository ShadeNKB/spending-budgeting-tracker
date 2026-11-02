// The snapshot ring (DATA-ENGINE-SPEC §9.7, track spec §8.6). A pre-destructive snapshot is written
// synchronously as "z0|" + body before the destructive commit; a background task later replaces it
// with "z1|" + base64url(gzip(body)) where CompressionStream exists. Restoring one is an import
// restore (revive, never delete), so it survives sync.
import { SNAP_BYTES, SNAP_DAILY, SNAP_PRE } from '../core/constants'
import { b64urlDecode, b64urlEncode, canCompress } from '../core/e2e'
import { isPlainObject, own } from '../core/sanitize'
import type { Doc } from '../core/types'
import { wireString } from '../core/wire'
import type { Io, WriteResult } from './io'
import { storedList } from './json'
import { SNAPS_KEY, SNAP_PREFIX } from './keys'

export type SnapReason = 'daily' | 'pre-v5' | 'delete-all' | 'import' | 'replace' | 'mass'

export interface SnapMeta {
  readonly id: string
  readonly at: number
  readonly reason: SnapReason
  readonly rows: number
  readonly chars: number
  readonly z: 0 | 1
}

const REASONS: ReadonlySet<string> = new Set([
  'daily',
  'pre-v5',
  'delete-all',
  'import',
  'replace',
  'mass',
])
const isReason = (v: unknown): v is SnapReason => typeof v === 'string' && REASONS.has(v)

const DAY_MS = 86_400_000
/** Shedding never touches a snapshot younger than this (§9.11). */
const KEEP_YOUNG = 7 * DAY_MS
/** Pre-destructive snapshots older than this may be shed under quota (§9.11 step 3). */
const PRE_OLD = 30 * DAY_MS
/** Compression waits past the 30 s undo window, so an undo always finds the plain copy. */
export const COMPRESS_DELAY = 35_000
/**
 * A z0 copy left by an earlier session (one closed inside its compression delay, as a quick add
 * is) is compressed this long after the next boot, off the boot path.
 */
export const RESUME_DELAY = 3000

/** The raw strings of the v4 keys, as the pre-v5 snapshot keeps them. */
export const V4_SNAPSHOT_TAG = 'spendtrackV4'

function readIndex(text: string | null): SnapMeta[] {
  const out: SnapMeta[] = []
  for (const e of storedList(text)) {
    if (!isPlainObject(e)) continue
    const id = own(e, 'id')
    const at = own(e, 'at')
    const reason = own(e, 'reason')
    const rows = own(e, 'rows')
    const chars = own(e, 'chars')
    const z = own(e, 'z')
    if (
      typeof id === 'string' &&
      typeof at === 'number' &&
      isReason(reason) &&
      typeof rows === 'number' &&
      typeof chars === 'number'
    ) {
      out.push({ id, at, reason, rows, chars, z: z === 1 ? 1 : 0 })
    }
  }
  return out
}

async function gzip(text: string): Promise<string | null> {
  const source = new Response(text).body
  if (source === null) return null
  const zipped = source.pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(zipped).arrayBuffer())
  return b64urlEncode(bytes)
}

async function gunzip(text: string): Promise<string | null> {
  const bytes = b64urlDecode(text)
  if (bytes === null) return null
  const source = new Response(bytes).body
  if (source === null) return null
  const plain = source.pipeThrough(new DecompressionStream('gzip'))
  return new Response(plain).text()
}

const isDaily = (s: SnapMeta): boolean => s.reason === 'daily'

/**
 * Writes with the engine's shedding (§9.11) up to `maxLevel`; a daily snapshot passes 1, so it
 * only ever makes room by shedding an older daily, never a more valuable copy.
 */
export type SnapWriter = (key: string, value: string, maxLevel?: number) => WriteResult

/** The shedding level a daily snapshot may use: older dailies only. */
const DAILY_LEVEL = 1
/** A compressed copy replaces a longer plain one: it never sheds anything to fit. */
const NO_SHED = 0

export class Snapshots {
  /** z0 copies waiting for compression, with when each is due: never evicted (§9.7). */
  private readonly pending = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDue = Number.POSITIVE_INFINITY

  constructor(
    private readonly io: Io,
    private readonly writeShed: SnapWriter,
  ) {}

  index(): readonly SnapMeta[] {
    return readIndex(this.io.get(SNAPS_KEY))
  }

  private saveIndex(list: readonly SnapMeta[], maxLevel?: number): WriteResult {
    return this.writeShed(SNAPS_KEY, JSON.stringify(list), maxLevel)
  }

  /**
   * Boot: every z0 copy an earlier session left is queued for compression again (and so is never
   * evicted while it waits), whether or not that session stayed open for its delay. Read from the
   * index alone, so the boot reads no snapshot body: a copy that turns out to be gone or already
   * compressed is skipped when its turn comes.
   */
  resume(now: number): void {
    if (!canCompress()) return
    let queued = false
    for (const s of this.index()) {
      if (s.z !== 0 || this.pending.has(s.id)) continue
      this.pending.set(s.id, now + RESUME_DELAY)
      queued = true
    }
    if (queued) this.schedule(now)
  }

  /** A snapshot of the whole doc, synchronously, as z0. Null when it cannot be stored. */
  takeDoc(doc: Doc, reason: SnapReason, at: number): SnapMeta | null {
    return this.take(wireString(doc), reason, doc.expenses.size, at)
  }

  /** The pre-v5 snapshot: the raw strings of the v4 keys, before anything rewrites them. */
  takeV4(raws: Readonly<Record<string, string>>, rows: number, at: number): SnapMeta | null {
    return this.take(JSON.stringify({ [V4_SNAPSHOT_TAG]: raws }), 'pre-v5', rows, at)
  }

  private take(body: string, reason: SnapReason, rows: number, at: number): SnapMeta | null {
    const list = this.index()
    let ts = at
    while (list.some((s) => s.id === String(ts))) ts++
    const id = String(ts)
    const text = `z0|${body}`
    const level = reason === 'daily' ? DAILY_LEVEL : undefined
    if (this.writeShed(`${SNAP_PREFIX}${id}`, text, level) !== 'ok') return null
    const meta: SnapMeta = { id, at, reason, rows, chars: text.length, z: 0 }
    if (this.saveIndex([...list, meta], level) !== 'ok') {
      this.io.removeKey(`${SNAP_PREFIX}${id}`)
      return null
    }
    // without CompressionStream a copy stays z0 for good: it is not waiting, so it stays evictable
    if (canCompress()) this.pending.set(id, Date.now() + COMPRESS_DELAY)
    this.evict(id)
    this.schedule(Date.now())
    return meta
  }

  /**
   * Removes one snapshot this engine just took and no longer needs (the migration's pre-v5 copy
   * when the v4 keys it copies stay untouched, P2-16).
   */
  drop(id: string): void {
    this.pending.delete(id)
    this.io.removeKey(`${SNAP_PREFIX}${id}`)
    this.saveIndex(this.index().filter((s) => s.id !== id))
  }

  /** The plain body of a z0 snapshot (synchronous), or null. */
  bodySync(id: string): string | null {
    const text = this.io.get(`${SNAP_PREFIX}${id}`)
    return text?.startsWith('z0|') === true ? text.slice(3) : null
  }

  /** The plain body of any snapshot. */
  async body(id: string): Promise<string | null> {
    const text = this.io.get(`${SNAP_PREFIX}${id}`)
    if (text === null) return null
    if (text.startsWith('z0|')) return text.slice(3)
    if (!text.startsWith('z1|') || !canCompress()) return null
    try {
      return await gunzip(text.slice(3))
    } catch {
      return null
    }
  }

  /** Every readable snapshot body, newest first (the recovery ladder). */
  async bodies(): Promise<readonly string[]> {
    const out: string[] = []
    for (const s of [...this.index()].sort((a, b) => b.at - a.at)) {
      const b = await this.body(s.id)
      if (b !== null) out.push(b)
    }
    return out
  }

  /**
   * Keeps 3 daily and 5 pre-destructive, then the SNAP_BYTES budget by evicting the oldest daily
   * snapshots only (§9.7): the 5 newest pre-destructive copies never go to make room.
   */
  private evict(keep: string): void {
    let list = [...this.index()].sort((a, b) => a.at - b.at)
    const drop = (s: SnapMeta): void => {
      this.io.removeKey(`${SNAP_PREFIX}${s.id}`)
      list = list.filter((x) => x.id !== s.id)
    }
    const evictable = (s: SnapMeta): boolean => s.id !== keep && !this.pending.has(s.id)
    for (const [pick, cap] of [
      [isDaily, SNAP_DAILY],
      [(s: SnapMeta) => !isDaily(s), SNAP_PRE],
    ] as const) {
      let kind = list.filter(pick)
      while (kind.length > cap) {
        const victim = kind.find(evictable)
        if (victim === undefined) break
        drop(victim)
        kind = list.filter(pick)
      }
    }
    const total = (): number => list.reduce((n, s) => n + s.chars, 0)
    while (total() > SNAP_BYTES) {
      const victim = list.find((s) => isDaily(s) && evictable(s))
      if (victim === undefined) break
      drop(victim)
    }
    this.saveIndex(list)
  }

  /** §9.11 shedding step 1: the oldest daily snapshot (never one younger than 7 days). */
  shedDaily(now: number): boolean {
    return this.shedOne((s) => isDaily(s) && now - s.at > KEEP_YOUNG)
  }

  /** §9.11 shedding step 3: pre-destructive snapshots older than 30 days. */
  shedOldPre(now: number): boolean {
    return this.shedOne((s) => !isDaily(s) && now - s.at > PRE_OLD)
  }

  private shedOne(pick: (s: SnapMeta) => boolean): boolean {
    const list = [...this.index()].sort((a, b) => a.at - b.at)
    const victim = list.find((s) => pick(s) && !this.pending.has(s.id))
    if (victim === undefined) return false
    this.io.removeKey(`${SNAP_PREFIX}${victim.id}`)
    this.saveIndex(list.filter((s) => s.id !== victim.id))
    return true
  }

  /** Arms the timer for the earliest copy due (sooner than an armed one, never later). */
  private schedule(now: number): void {
    if (!canCompress() || this.pending.size === 0) return
    const due = Math.min(...this.pending.values())
    if (this.timer !== null && this.timerDue <= due) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timerDue = due
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.timerDue = Number.POSITIVE_INFINITY
        void this.compressPending(Date.now())
      },
      Math.max(0, due - now),
    )
  }

  /**
   * Replaces every z0 snapshot due by `now` (all of them without it) with its z1 copy; a failed
   * one stays z0 (and may be evicted). Copies not due yet keep waiting.
   */
  async compressPending(now: number = Number.POSITIVE_INFINITY): Promise<void> {
    if (!canCompress()) {
      this.pending.clear()
      return
    }
    for (const [id, due] of [...this.pending]) {
      if (due > now) continue
      const body = this.bodySync(id)
      this.pending.delete(id)
      if (body === null) continue
      let zipped: string | null = null
      try {
        zipped = await gzip(body)
      } catch {
        zipped = null
      }
      if (zipped === null) continue
      const text = `z1|${zipped}`
      // through the engine's writer, which writes nothing in memory-only mode or once this device
      // was wiped while the compression ran
      if (this.writeShed(`${SNAP_PREFIX}${id}`, text, NO_SHED) !== 'ok') continue
      this.saveIndex(
        this.index().map((s) => (s.id === id ? { ...s, z: 1 as const, chars: text.length } : s)),
      )
    }
    this.schedule(Date.now())
  }

  /** Cancels the background work (re-boot, remove from this device). */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.timerDue = Number.POSITIVE_INFINITY
  }
}
