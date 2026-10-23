// Adapters that put the frozen v0.8.4 and v0.8.5 clients on the virtual network, and upgrade them
// in place to v5 (their localStorage migrated through fromV4Keys → decodeWire('local-v4')).
import { V4_KEYS } from '../../core/constants'
import { maxStampRec } from '../../core/record'
import type { Doc, OutboxKey, Stamp, V4Key } from '../../core/types'
import { decodeWire, fromV4Keys } from '../../core/wire'
import { V084Client, type RelayPort, type StoragePort } from '../legacy/v084'
import { V085Client } from '../legacy/v085'
import type { Rng } from '../support/rng'
import type { VirtualClock } from './clock'
import type { Relay } from './relay'

export class MemStorage implements StoragePort {
  readonly map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

export type OldKind = 'v084' | 'v085'

function revOf(payload: unknown): string | null {
  const wr: unknown =
    typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'wr') : undefined
  const rev: unknown = typeof wr === 'object' && wr !== null ? Reflect.get(wr, 'rev') : undefined
  return typeof rev === 'string' ? rev : null
}

/** Every record and register of a doc: the outbox of a freshly migrated device (§9.6.2 step 6). */
export function fullOutbox(doc: Doc): Map<OutboxKey, Stamp> {
  const out = new Map<OutboxKey, Stamp>()
  for (const [id, rec] of doc.expenses) out.set(`ex:${id}`, maxStampRec(rec))
  for (const [id, s] of doc.tombs) out.set(`del:${id}`, s)
  for (const n of doc.categories) out.set(`cat:${n}`, 0)
  for (const [k, g] of doc.renames) out.set(`ren:${k}`, g.s)
  for (const [k, g] of doc.mappings) out.set(`map:${k}`, g.s)
  for (const [k, g] of doc.budgets) out.set(`bud:${k}`, Math.max(g.set, g.del))
  for (const [k, g] of doc.prefs) out.set(`pref:${k}`, g.s)
  return out
}

export class OldDevice {
  readonly storage = new MemStorage()
  readonly client: V084Client | V085Client

  constructor(
    readonly clock: VirtualClock,
    readonly relay: Relay,
    readonly rng: Rng,
    readonly name: string,
    readonly kind: OldKind,
    readonly skew: number,
  ) {
    const port: RelayPort =
      kind === 'v084'
        ? relay.legacyPort(name)
        : {
            ...relay.legacyPort(name),
            subscribe: (_syncId, _cb) =>
              relay.subscribe(name, (e) => {
                if (this.client instanceof V085Client) this.client.onRemoteEvent(revOf(e.payload))
              }),
          }
    this.client =
      kind === 'v084'
        ? new V084Client(clock.port(skew), rng.next, this.storage, port)
        : new V085Client(clock.port(skew), rng.next, this.storage, port)
  }

  get pushes(): number {
    return this.client.pushes
  }

  start(syncId: string): Promise<void> {
    this.client.hydrate()
    return this.client.setupSync(syncId)
  }

  /** Reads the v4 keys as PR-2's migration will: each key parsed on its own. */
  v4Keys(): Partial<Record<V4Key, unknown>> {
    const out: Partial<Record<V4Key, unknown>> = {}
    for (const k of V4_KEYS) {
      const raw = this.storage.getItem(k)
      if (raw === null) continue
      try {
        out[k] = JSON.parse(raw)
      } catch {
        // a corrupt key is skipped here; PR-2 salvages and quarantines it
      }
    }
    return out
  }

  /** In-place upgrade: flush, stop the old app, migrate its storage into a doc. */
  migrate(): { readonly doc: Doc; readonly outbox: Map<OutboxKey, Stamp> } {
    this.client.flushPendingSave()
    this.client.close()
    const legacyRank = this.storage.getItem('spendtrack:app') === '0.8.5' ? 1 : 0
    const doc = decodeWire(fromV4Keys(this.v4Keys()), 'local-v4', { legacyRank }).doc
    return { doc, outbox: fullOutbox(doc) }
  }
}
