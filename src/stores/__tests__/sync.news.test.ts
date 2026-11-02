// Crossing pushes beside an old device (LEDGER entry criterion d, P2-10, acceptance 19), on the
// real stores and the fake relay. PR-0's documented mixed-version delayed sync: an old device
// (0.9.2 or v0.8.4) pushes entry X while a 0.10.0 push that pulled BEFORE X landed is on the
// wire; the 0.10.0 push lands right after and overwrites X on the relay (plain upsert, no
// compare-and-set yet). The old device is then pocketed. Its push still reached the 0.10.0 device
// as a realtime event, and the bridge keeps that payload and merges it at the start of its next
// cycle, so X reaches the relay with no further change on the old device. The merge is a join,
// so a payload that is stale or already merged costs nothing.
//
// The timeline, in network legs of L ms (pull and push take L each; a push lands at L/2; a
// realtime event arrives L/2 after the write):
//   t0               0.10.0: add Y          → its push timer fires at t0 + 1500 (PUSH_QUIET)
//   t0 + 1500 − L/4  old: add X, Sync now   → its pull reads at t0 + 1500 + 3L/4
//   t0 + 1500 + L    0.10.0 reads the relay (no X yet)
//   t0 + 1500 + 5L/4 old's push lands (with X)
//   t0 + 1500 + 5L/4 + 1  the old device is pocketed: no more events, cycles or pushes
//   t0 + 1500 + 3L/2 0.10.0's push lands: X is gone from the relay (the crossing)
//   t0 + 1500 + 7L/4 0.10.0 gets the old push's event (foreign, it carries X): kept as news
//   300 ms later     0.10.0's next cycle merges the news before the pull and pushes X back
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/backup'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'
import { LegacyPeer } from '../../__tests__/legacyPeer'
import { Peer092 } from '../../__tests__/legacyPeer092'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const PUSH_QUIET = 1500

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const S = (d: Device) => d.expense.useExpenseStore.getState()

const relayIds = (): string[] =>
  relayRows().flatMap((r) => (isRecord(r) && typeof r.id === 'string' ? [r.id] : []))

/** An old phone on the code: it adds X and syncs on demand, and can be pocketed. */
interface OldPhone {
  connect(): void
  /** Adds X and taps Sync now; returns X's id. */
  addAndSync(): string
  /** No more events, cycles or pushes (a phone in a pocket, its tab frozen). */
  pocket(): void
  pushes(): number
}

function phone092(): OldPhone {
  const peer = new Peer092({ expenses: [expense('e1')] })
  return {
    connect: () => {
      void peer.connect(SYNC_CODE)
    },
    addAndSync: () => {
      const x = peer.app.addExpense({ itemName: 'X on the phone', amount: 4.5 })
      void peer.app.triggerSync()
      return x.id
    },
    pocket: () => {
      peer.close()
    },
    pushes: () => peer.pushes(),
  }
}

function phone084(): OldPhone {
  const peer = new LegacyPeer([expense('e1')])
  return {
    connect: () => {
      peer.connect(SYNC_CODE)
    },
    addAndSync: () => {
      const x = peer.add('X on the phone', 4.5)
      void peer.triggerSync()
      return x.id
    },
    pocket: () => {
      peer.disconnect()
    },
    pushes: () => peer.pushes(),
  }
}

const PHONES = { '0.9.2': phone092, 'v0.8.4': phone084 } as const
type PhoneKind = keyof typeof PHONES

/** The 0.10.0 laptop and the old phone on one code, in sync and quiet. */
async function scene(kind: PhoneKind, leg: number): Promise<{ laptop: Device; phone: OldPhone }> {
  const laptop = await bootDevice({ expenses: [expense('e1')] })
  relay().latency = { pull: leg, push: leg, realtime: leg / 2 }
  await connect(laptop)
  const phone = PHONES[kind]()
  phone.connect()
  await advance(20_000)
  return { laptop, phone }
}

describe('crossing pushes beside an old device (P2-10, acceptance 19)', () => {
  describe.each(['0.9.2', 'v0.8.4'] as const)('%s phone', (kind) => {
    it.each([100, 200, 400])(
      "its entry reaches the relay on the 0.10.0 device's next cycle (legs of %i ms)",
      async (leg) => {
        const { laptop, phone } = await scene(kind, leg)
        const t0 = Date.now()
        const y = S(laptop).addExpense({ itemName: 'Y on the laptop', amount: 2 })

        await advance(PUSH_QUIET - leg / 4)
        const x = phone.addAndSync()
        await advance((3 * leg) / 2 + 1) // the old push has landed
        expect(relayIds()).toContain(x)
        phone.pocket()
        const oldPushes = phone.pushes()

        // The 0.10.0 push, built on a pull from before X, lands over it: the relay loses X.
        await advance(t0 + PUSH_QUIET + (3 * leg) / 2 + 1 - Date.now())
        expect(relayIds()).toContain(y.id)
        expect(relayIds()).not.toContain(x)

        // The event of the old push carried X: the next cycle merges it and pushes it back.
        await advance(60_000)
        expect(S(laptop).expenses.map((e) => e.id)).toContain(x)
        expect(relayIds()).toContain(x)
        expect(relayIds()).toContain(y.id)
        // No help from the old device: it is in a pocket.
        expect(phone.pushes()).toBe(oldPushes)
      },
    )
  })

  it('a stale news payload merged again changes nothing and costs no push', async () => {
    const { laptop, phone } = await scene('0.9.2', 200)
    phone.addAndSync()
    await advance(10_000) // X arrives the ordinary way; the event is news, merged once
    const pushes = relay().upserts
    const before = S(laptop).expenses
    // The same payload again (a realtime redelivery after a reconnect): a join, so a no-op.
    const row = relay().rows.get(SYNC_CODE)
    if (row === undefined) throw new Error('no relay row')
    relay().rows.set(SYNC_CODE, { ...row, updated_at: new Date().toISOString() })
    for (const channel of relay().channels) {
      channel.deliver({
        eventType: 'UPDATE',
        schema: 'public',
        table: 'sync_buckets',
        new: { sync_id: SYNC_CODE, payload: row.payload, updated_at: row.updated_at },
        old: {},
      })
    }
    await advance(10_000)
    expect(S(laptop).expenses).toBe(before)
    expect(relay().upserts).toBe(pushes)
    phone.pocket()
  })
})
