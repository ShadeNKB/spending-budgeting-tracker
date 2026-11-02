// A 0.9.2 device (protocol 0.8.5, PR-0) for the store-level sync suites: the frozen model of the
// shipped client (src/data/__tests__/legacy/v085.ts, re-frozen from the merged PR-0, P2-5) on the
// fake relay, with the fake timers as its clock and a storage of its own. What it does that a
// 0.10.0 device must live with:
// - whole-record last-writer-wins by `updatedAt ?? createdAt`, ties to the larger canonical row;
// - it strips `x5` from every push and stamps it with `wr` (app '0.8.5');
// - item picks carry the top-level `mappingUpdatedAt` (P2-3 keeps them on the v5 wire);
// - it pushes only when the merge differs from the relay copy, and filters its own echo.
import { V085Client, type RelayChange, type RelayPort085 } from '../data/__tests__/legacy/v085'
import type { ClockPort } from '../data/__tests__/legacy/v084'
import { isRecord } from '../lib/backup'
import {
  FakeClient,
  MemoryStorage,
  relay,
  seedV4,
  type FakeChannel,
  type V4Seed,
} from './fakeRelay'

const TABLE = 'sync_buckets'

/** The fake timers as the model's clock, with numeric handles as in a browser. */
function fakeClock(): ClockPort {
  let next = 1
  const handles = new Map<number, ReturnType<typeof setTimeout>>()
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
      const id = next++
      handles.set(
        id,
        setTimeout(() => {
          handles.delete(id)
          fn()
        }, ms),
      )
      return id
    },
    clearTimeout: (id) => {
      const handle = handles.get(id)
      if (handle !== undefined) clearTimeout(handle)
      handles.delete(id)
    },
  }
}

/** The Supabase calls 0.9.2 makes (select, plain upsert, postgres_changes), on the fake relay. */
function relayPort(client: FakeClient): RelayPort085 {
  return {
    async pull(syncId) {
      const res = await client
        .from(TABLE)
        .select('payload')
        .eq('sync_id', syncId)
        .retry(false)
        .maybeSingle()
      if (res.error) throw new Error(res.error.message)
      const row = res.data
      return isRecord(row) ? { payload: row.payload } : null
    },
    async push(syncId, payload) {
      const res = await client
        .from(TABLE)
        .upsert({ sync_id: syncId, payload, updated_at: new Date().toISOString() })
        .retry(false)
      if (res.error) throw new Error(res.error.message)
    },
    subscribe(syncId, onChange: (change: RelayChange) => void) {
      const channel: FakeChannel = client.channel(`sync:${syncId}`)
      channel.on('postgres_changes', { filter: `sync_id=eq.${syncId}` }, (event) => {
        const updated = event.new.updated_at
        onChange({
          payload: event.new.payload,
          updatedAt: typeof updated === 'string' ? updated : null,
        })
      })
      channel.subscribe()
      return () => {
        void client.removeChannel(channel)
      }
    },
  }
}

/** mulberry32, so a peer's ids and revs are reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let peers = 0

/** A phone still on 0.9.2: its own storage (holding `seed`), hydrated, not yet connected. */
export class Peer092 {
  readonly client = new FakeClient()
  readonly storage = new MemoryStorage()
  readonly app: V085Client

  constructor(seed: V4Seed = {}, rngSeed = 0x0092 + peers++) {
    seedV4(this.storage, seed, `old${String(peers).padStart(3, '0')}`)
    this.app = new V085Client(fakeClock(), seeded(rngSeed), this.storage, relayPort(this.client))
    this.app.hydrate()
  }

  /** Connects to `code` (Settings › Sync › Connect). */
  connect(code: string): Promise<unknown> {
    return this.app.setupSync(code)
  }

  /** How many pushes this device has landed on the relay. */
  pushes(): number {
    return relay().pushes.filter((p) => p.client === this.client.id).length
  }

  /** Live ids, sorted. */
  ids(): string[] {
    return this.app.s.expenses.map((e) => e.id).sort()
  }

  close(): void {
    this.app.close()
  }
}
