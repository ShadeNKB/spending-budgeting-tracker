// A 0.10.0 device beside an old one on the same code, on the real stores and the fake relay:
// the frozen 0.9.2 client (PR-0, re-frozen from the merged code, P2-5) through legacyPeer092,
// and the v0.8.4 model through legacyPeer. What 0.10.0 must guarantee next to them:
// - no write that reached the 0.10.0 device is lost, and nothing it deleted comes back
//   (acceptance 11, 13, 14; T-004-1, T-011-2, T-013-1);
// - item picks are last-writer-wins in both directions: the top-level `mappingUpdatedAt`
//   round-trips through the v5 wire (P2-3, acceptance 18);
// - it goes quiet: at most one push per 10 minutes while the old device is idle (acceptance 17).
//
// 0.9.2 merges whole records by `updatedAt ?? createdAt` (an edit there re-stamps every field of
// the record), 0.10.0 per field; the oracle of the seeded run models exactly that: the final
// value of a field is the one written last, where a 0.9.2 edit writes all of its record's fields.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolver } from '../../data/core/categories'
import { isRecord, listOf } from '../../lib/backup'
import type { Expense } from '../../types'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  relayDeleted,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  setClientOffline,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'
import { LegacyPeer } from '../../__tests__/legacyPeer'
import { Peer092 } from '../../__tests__/legacyPeer092'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 120_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
const LIST = ['Other', 'Meals', 'Transport', 'Shopping']
const LATENCY = { pull: 150, push: 150, realtime: 60 }

/** mulberry32: a small seeded PRNG. */
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

/** The engine's ids and revs (crypto) and v0.8.4's ids (Math.random) come from the seed too. */
function seedRandomness(seed: number): void {
  const bytes = rng(seed ^ 0x5eed5eed)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(
    <T extends ArrayBufferView | null>(array: T): T => {
      if (array !== null) {
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
        for (let i = 0; i < view.length; i++) view[i] = Math.floor(bytes() * 256)
      }
      return array
    },
  )
  vi.spyOn(Math, 'random').mockImplementation(rng(seed ^ 0x0ddba11))
}

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
  vi.restoreAllMocks()
})

const S = (d: Device) => d.expense.useExpenseStore.getState()
const iso = (ms: number) => new Date(ms).toISOString()
const ids = (rows: readonly { id: string }[]): string[] => rows.map((e) => e.id).sort()

function relayIds(): string[] {
  return relayRows()
    .flatMap((r) => (isRecord(r) && typeof r.id === 'string' ? [r.id] : []))
    .sort()
}

function relayRecord(key: string): Record<string, unknown> {
  const payload = rowPayload(SYNC_CODE)
  const value = isRecord(payload) ? payload[key] : undefined
  return isRecord(value) ? value : {}
}

/** A null-prototype view as a plain object, for toEqual. */
const plain = <V>(view: Readonly<Record<string, V>>): Record<string, V> => ({ ...view })

interface Scene {
  laptop: Device
  phone: Peer092
  /** Pushes the 0.10.0 laptop has landed on the relay. */
  readonly laptopPushes: () => number
}

/** The 0.10.0 laptop and a 0.9.2 phone on one code, after their first exchange. */
async function beside092(
  opts: {
    laptop?: Parameters<typeof bootDevice>[0]
    phone?: ConstructorParameters<typeof Peer092>[0]
    rngSeed?: number
  } = {},
): Promise<Scene> {
  const laptop = await bootDevice({ v4: { categories: LIST }, ...opts.laptop })
  relay().latency = LATENCY
  const client = relay().nextClient
  await connect(laptop)
  const phone = new Peer092({ categories: LIST, ...opts.phone }, opts.rngSeed)
  void phone.connect(SYNC_CODE)
  await advance(MINUTE)
  return {
    laptop,
    phone,
    laptopPushes: () => relay().pushes.filter((p) => p.client === client).length,
  }
}

// ---------------------------------------------------------------------------
// Beside an idle 0.9.2 phone
// ---------------------------------------------------------------------------

describe('beside a 0.9.2 phone', () => {
  it('a first exchange shows everything on both, picks and budgets with their stamps, then goes quiet', async () => {
    const T1 = iso(NOW - 3 * 24 * 60 * MINUTE)
    const T2 = iso(NOW - 2 * 24 * 60 * MINUTE)
    const { laptop, phone, laptopPushes } = await beside092({
      laptop: {
        expenses: [expense('e1', { itemName: 'Lunch', amount: 4.5, category: 'Meals' })],
        v4: {
          categories: LIST,
          categoryMappings: { lunch: 'Meals' },
          categoryMappingUpdatedAt: { lunch: T1 },
          categoryBudgets: { Meals: 300 },
          categoryBudgetUpdatedAt: { Meals: T1 },
          categoryBudgetDeletedAt: { Shopping: T1 },
        },
      },
      phone: {
        expenses: [expense('e2', { itemName: 'Grab', amount: 12, category: 'Transport' })],
        categoryMappings: { grab: 'Transport' },
        categoryMappingUpdatedAt: { grab: T2 },
      },
    })

    for (const shown of [ids(S(laptop).expenses), phone.ids()]) expect(shown).toEqual(['e1', 'e2'])
    expect(plain(S(laptop).categoryMappings)).toEqual({ lunch: 'Meals', grab: 'Transport' })
    expect(phone.app.s.categoryMappings).toEqual({ lunch: 'Meals', grab: 'Transport' })
    // 0.9.2 keeps last-writer-wins picks only with their stamps: both arrived (P2-3).
    expect(phone.app.s.mappingUpdatedAt).toEqual({ lunch: T1, grab: T2 })
    expect(relayRecord('mappingUpdatedAt')).toEqual({ lunch: T1, grab: T2 })
    expect(plain(S(laptop).budgets)).toEqual({ Meals: 300 })
    expect(phone.app.s.budgets).toEqual({ Meals: 300 })
    expect(phone.app.s.budgetUpdatedAt.Meals).toBe(T1)

    // Quiet: at most one push per 10 minutes from 0.10.0 while the phone does nothing.
    for (let window = 0; window < 3; window++) {
      const before = laptopPushes()
      const phoneBefore = phone.pushes()
      await advance(10 * MINUTE)
      expect(laptopPushes() - before, `window ${String(window)}`).toBeLessThanOrEqual(1)
      expect(phone.pushes() - phoneBefore, `window ${String(window)}`).toBeLessThanOrEqual(1)
    }
    phone.close()
  })

  describe('item picks are last-writer-wins both ways (P2-3, acceptance 18)', () => {
    it('a pick made on 0.9.2 after the one made here wins on both devices', async () => {
      const { laptop, phone } = await beside092()
      S(laptop).addExpense({ itemName: 'Kopi', amount: 1.5, category: 'Meals' })
      await advance(MINUTE)
      expect(phone.app.s.categoryMappings.kopi).toBe('Meals')

      phone.app.addExpense({ itemName: 'kopi', amount: 1.6, category: 'Transport' })
      await advance(MINUTE)
      expect(phone.app.s.categoryMappings.kopi).toBe('Transport')
      expect(S(laptop).categoryMappings.kopi).toBe('Transport')
      expect(S(laptop).getSmartCategory('kopi')).toBe('Transport')
      expect(relayRecord('categoryMappings').kopi).toBe('Transport')
      expect(relayRecord('mappingUpdatedAt').kopi).toBe(phone.app.s.mappingUpdatedAt.kopi)
      phone.close()
    })

    it('a pick made here after the one made on 0.9.2 wins on both devices', async () => {
      const { laptop, phone } = await beside092()
      phone.app.addExpense({ itemName: 'Kopi', amount: 1.5, category: 'Meals' })
      await advance(MINUTE)
      expect(S(laptop).categoryMappings.kopi).toBe('Meals')

      S(laptop).addExpense({ itemName: 'kopi', amount: 1.6, category: 'Transport' })
      await advance(MINUTE)
      expect(S(laptop).categoryMappings.kopi).toBe('Transport')
      expect(phone.app.s.categoryMappings.kopi).toBe('Transport')
      expect(phone.app.getSmartCategory('kopi')).toBe('Transport')
      const stamp = relayRecord('mappingUpdatedAt').kopi
      expect(stamp).toBe(phone.app.s.mappingUpdatedAt.kopi)
      expect(Date.parse(String(stamp))).toBeGreaterThan(NOW + MINUTE)
      phone.close()
    })
  })

  describe('undo sticks after the change has synced (T-011-2)', () => {
    it('delete, sync, undo, sync: back on both under a new id; the old id stays dead', async () => {
      const { laptop, phone } = await beside092({
        laptop: { expenses: [expense('e1', { itemName: 'Lunch', amount: 4.5 })] },
      })
      S(laptop).deleteExpense('e1')
      await advance(3000)
      expect(phone.ids()).toEqual([])
      expect(relayDeleted()).toContain('e1')

      const undo = S(laptop).undoStack.at(-1)
      if (undo === undefined) throw new Error('no undo entry')
      expect(S(laptop).consumeUndo(undo.id)).toEqual({ applied: 1, skipped: 0 })
      await advance(MINUTE)
      const back = S(laptop).expenses
      expect(back.map((e) => [e.itemName, e.amount])).toEqual([['Lunch', 4.5]])
      const revived = back[0]?.id
      expect(revived).not.toBe('e1')
      expect(phone.ids()).toEqual([revived])
      expect(relayIds()).toEqual([revived])
      expect(relayDeleted()).toContain('e1')

      // The next syncs, from either side, keep it.
      phone.app.addExpense({ itemName: 'Kopi', amount: 1.5 })
      await advance(MINUTE)
      expect(ids(S(laptop).expenses)).toEqual(phone.ids())
      expect(S(laptop).expenses.some((e) => e.id === revived)).toBe(true)
      phone.close()
    })

    it('an undo never overwrites a later change made on 0.9.2, and says so', async () => {
      const { laptop, phone } = await beside092({
        laptop: { expenses: [expense('e1', { itemName: 'Lunch', amount: 4.5 })] },
      })
      relay().latency = { pull: 100, push: 100, realtime: 50 }
      const t0 = Date.now()
      S(laptop).updateExpense('e1', { amount: 45 })
      await advance(2400) // pushed at 1.5 s, merged on the phone by +2.3 s
      expect(phone.app.s.expenses.find((e) => e.id === 'e1')?.amount).toBe(45)

      phone.app.updateExpense('e1', { notes: 'with Ana' })
      void phone.app.triggerSync()
      await advance(t0 + 4200 - Date.now()) // the phone's edit is here, inside the 5 s undo
      expect(S(laptop).expenses.find((e) => e.id === 'e1')?.notes).toBe('with Ana')

      const undo = S(laptop).undoStack.find((u) => u.id.startsWith('update-e1-'))
      if (undo === undefined) throw new Error('no undo entry')
      const outcome = S(laptop).consumeUndo(undo.id)
      expect(outcome).toEqual({ applied: 0, skipped: 1 })
      if (outcome === null) throw new Error('expired')
      expect(S(laptop).expenses.find((e) => e.id === 'e1')?.amount).toBe(45)
      expect(laptop.expense.undoOutcomeMessage(outcome)).toBe(
        'Nothing to undo: 1 entry changed on another device',
      )
      await advance(MINUTE)
      for (const e1 of [
        S(laptop).expenses.find((e) => e.id === 'e1'),
        phone.app.s.expenses.find((e) => e.id === 'e1'),
      ]) {
        expect([e1?.amount, e1?.notes]).toEqual([45, 'with Ana'])
      }
      phone.close()
    })

    it('edit, sync, undo, sync: the old amount on both, with a later stamp', async () => {
      const { laptop, phone } = await beside092({
        laptop: { expenses: [expense('e1', { itemName: 'Lunch', amount: 4.5 })] },
      })
      S(laptop).updateExpense('e1', { amount: 45 })
      await advance(3000)
      expect(phone.app.s.expenses.find((e) => e.id === 'e1')?.amount).toBe(45)
      const undo = S(laptop).undoStack.at(-1)
      if (undo === undefined) throw new Error('no undo entry')
      expect(S(laptop).consumeUndo(undo.id)).toEqual({ applied: 1, skipped: 0 })
      await advance(MINUTE)
      const onPhone = phone.app.s.expenses.find((e) => e.id === 'e1')
      expect(onPhone?.amount).toBe(4.5)
      expect(Date.parse(onPhone?.updatedAt ?? '')).toBeGreaterThan(NOW + MINUTE)
      expect(S(laptop).expenses.find((e) => e.id === 'e1')?.amount).toBe(4.5)
      phone.close()
    })
  })
})

// ---------------------------------------------------------------------------
// Delete everywhere, then bring it back (T-004-1, acceptance 13, 14)
// ---------------------------------------------------------------------------

const TWELVE = Array.from({ length: 12 }, (_, i) =>
  expense(`e${String(i + 1)}`, { itemName: `Lunch ${String(i + 1)}`, amount: 4 + i }),
)

/** An old phone on the code: what the test reads of it. */
interface OldPhone {
  ids(): string[]
  close(): void
}

async function beside(kind: '0.9.2' | 'v0.8.4'): Promise<{ laptop: Device; phone: OldPhone }> {
  const laptop = await bootDevice({ expenses: TWELVE, v4: { categories: LIST } })
  relay().latency = LATENCY
  await connect(laptop)
  if (kind === '0.9.2') {
    const peer = new Peer092({ expenses: TWELVE, categories: LIST })
    void peer.connect(SYNC_CODE)
    await advance(MINUTE)
    return { laptop, phone: peer }
  }
  const peer = new LegacyPeer([...TWELVE], LIST)
  peer.connect(SYNC_CODE)
  await advance(MINUTE)
  return {
    laptop,
    phone: {
      ids: () => ids(peer.state.expenses),
      close: () => {
        peer.disconnect()
      },
    },
  }
}

describe.each(['0.9.2', 'v0.8.4'] as const)(
  'delete everywhere, sync, bring it back, sync, beside a %s phone (T-004-1)',
  (kind) => {
    it('Undo: every entry is back on both devices and stays back', async () => {
      const { laptop, phone } = await beside(kind)
      S(laptop).deleteAllEverywhere()
      await advance(5000)
      expect(phone.ids()).toEqual([])
      expect(relayIds()).toEqual([])

      const undo = S(laptop).undoStack.find((u) => u.id.startsWith('all-'))
      if (undo === undefined) throw new Error('no undo entry')
      expect(S(laptop).consumeUndo(undo.id)).toEqual({ applied: 12, skipped: 0 })
      await advance(MINUTE)
      const back = ids(S(laptop).expenses)
      expect(back).toHaveLength(12)
      expect(phone.ids()).toEqual(back)
      expect(relayIds()).toEqual(back)

      await advance(10 * MINUTE) // more syncs, the old phone's included
      expect(ids(S(laptop).expenses)).toEqual(back)
      expect(phone.ids()).toEqual(back)
      phone.close()
    })

    it('Restore from a backup file: every entry is back on both devices and stays back', async () => {
      const { laptop, phone } = await beside(kind)
      const file = JSON.stringify(S(laptop).exportBackup())
      S(laptop).deleteAllEverywhere()
      await advance(MINUTE) // the Undo is gone; only the file is left
      expect(phone.ids()).toEqual([])

      const preview = await S(laptop).previewImport(new Blob([file], { type: 'application/json' }))
      expect(preview.counts).toMatchObject({ inFile: 12, restored: 12 })
      const outcome = S(laptop).applyImport(preview, 'restore')
      expect(outcome.restored).toBe(12)
      await advance(MINUTE)
      const back = ids(S(laptop).expenses)
      expect(back).toHaveLength(12)
      expect(phone.ids()).toEqual(back)
      expect(relayIds()).toEqual(back)

      await advance(10 * MINUTE)
      expect(ids(S(laptop).expenses)).toEqual(back)
      expect(phone.ids()).toEqual(back)
      phone.close()
    })
  },
)

// ---------------------------------------------------------------------------
// 1,500 tombstones against v0.8.4's cap of 1,000 (T-013-1, F-013)
// ---------------------------------------------------------------------------

describe('a 1,500-row clear beside v0.8.4 devices that keep 1,000 tombstones (T-013-1)', () => {
  it('no cleared row comes back here or on the relay, and the pushes stay bounded', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) =>
      expense(`r${String(i).padStart(4, '0')}`, { amount: 1 + (i % 50) }),
    )
    const laptop = await bootDevice({ expenses: rows, v4: { categories: LIST } })
    relay().latency = LATENCY
    const laptopClient = relay().nextClient
    await connect(laptop)
    const online = new LegacyPeer([...rows], LIST)
    online.connect(SYNC_CODE)
    // A second old phone with every row, offline through the clear (it comes back later).
    const stale = new LegacyPeer([...rows], LIST)
    stale.connect(SYNC_CODE)
    await advance(MINUTE)
    setClientOffline(stale.client.id, true)

    S(laptop).deleteAllEverywhere()
    await advance(2 * MINUTE)
    // The online old phone kept only its newest 1,000 tombstones and pushed them back.
    expect(online.state.expenses).toEqual([])
    expect(online.state.deletedIds).toHaveLength(1000)
    expect(S(laptop).expenses).toEqual([])
    // Here every tombstone is kept (the envelope is uncapped), and the relay gets them all back.
    expect(laptop.expense.getSyncPort()?.doc().tombs.size).toBe(1500)

    // The stale phone returns: its rows whose tombstones the relay no longer lists come back
    // on the wire, and die again here.
    setClientOffline(stale.client.id, false)
    void stale.triggerSync()
    let worst = 0
    for (let s = 0; s < 40; s++) {
      await advance(15_000)
      worst = Math.max(worst, S(laptop).expenses.length)
    }
    expect(worst).toBe(0)
    expect(relayIds()).toEqual([])
    expect(stale.state.expenses).toEqual([])
    expect(online.state.expenses).toEqual([])

    // The old phones chatter on every event (F-002); 0.10.0 pushes at most once per 10 minutes.
    const ours = relay().pushes.filter((p) => p.client === laptopClient).length
    await advance(20 * MINUTE)
    const later = relay().pushes.filter((p) => p.client === laptopClient).length
    expect(later - ours).toBeLessThanOrEqual(2)
    online.disconnect()
    stale.disconnect()
  })
})

// ---------------------------------------------------------------------------
// 60 seconds of everything on both devices, seeded (sync.mixed, acceptance 11, 12, 17, 18)
// ---------------------------------------------------------------------------

type Field = 'itemName' | 'amount' | 'notes'
const FIELDS: readonly Field[] = ['itemName', 'amount', 'notes']
type Dev = 'A' | 'O'

interface Shown {
  readonly itemName: string
  readonly amount: number
  readonly notes: string
  /** The stamp 0.9.2 orders the record by (a change of it is a whole-record write). */
  readonly stamp: string
}

const shownOf = (e: Expense): Shown => ({
  itemName: e.itemName,
  amount: e.amount,
  notes: e.notes ?? '',
  stamp: e.updatedAt ?? e.createdAt,
})

const byId = (rows: readonly Expense[]): Map<string, Shown> =>
  new Map(rows.map((e) => [e.id, shownOf(e)]))

/** Every write either device made, per entry and field, in time order. */
class Writes {
  readonly log = new Map<string, { dev: Dev; value: unknown; stamp: string }[]>()
  readonly added = new Map<string, Dev>()
  readonly deleted = new Map<string, Dev>()

  private put(id: string, f: Field, dev: Dev, value: unknown, stamp: string): void {
    const key = `${id}|${f}`
    const list = this.log.get(key) ?? []
    list.push({ dev, value, stamp })
    this.log.set(key, list)
  }

  /**
   * What an op changed. On 0.10.0 a write is a field (it merges per field); on 0.9.2 an edit
   * re-stamps the whole record, so every field of a re-stamped record is written.
   */
  record(dev: Dev, before: Map<string, Shown>, after: Map<string, Shown>): void {
    for (const [id, next] of after) {
      const prev = before.get(id)
      if (prev === undefined) {
        this.added.set(id, dev)
        for (const f of FIELDS) this.put(id, f, dev, next[f], next.stamp)
        continue
      }
      const whole = dev === 'O' && prev.stamp !== next.stamp
      for (const f of FIELDS) {
        if (whole || prev[f] !== next[f]) this.put(id, f, dev, next[f], next.stamp)
      }
    }
    for (const id of before.keys()) if (!after.has(id)) this.deleted.set(id, dev)
  }

  /**
   * The value written last to a field, of the writes that reached this device: its own, and the
   * phone's that the phone pushed (every landed push reaches it, by realtime or by pull). A phone
   * edit that 0.9.2 itself dropped for a newer record from here before pushing it (its
   * whole-record merge, §16.4 of the track spec) never reached it.
   */
  last(id: string, f: Field, pushed: ReadonlySet<string>): unknown {
    const reached = (this.log.get(`${id}|${f}`) ?? []).filter(
      (w) => w.dev === 'A' || pushed.has(`${id}|${w.stamp}`),
    )
    return reached.at(-1)?.value
  }
}

const MIXED_SEEDS = Array.from({ length: 24 }, (_, i) => 3101 + i)

describe('60 s of adds, edits, deletes, undos, renames, budgets and picks beside 0.9.2', () => {
  it.each(MIXED_SEEDS)(
    'seed %i: no write that reached 0.10.0 is lost; then quiet',
    async (seed) => {
      seedRandomness(seed)
      const r = rng(seed * 7919 + 13)
      const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
      const start = [
        expense('e1', { itemName: 'Lunch', amount: 4.5, category: 'Meals' }),
        expense('e2', { itemName: 'Grab', amount: 12, category: 'Transport' }),
        expense('e3', { itemName: 'Socks', amount: 9, category: 'Shopping' }),
      ]
      const { laptop, phone, laptopPushes } = await beside092({
        laptop: { expenses: start },
        phone: { expenses: start },
        rngSeed: seed,
      })
      const writes = new Writes()
      const issues: string[] = []
      const items = ['kopi', 'grab', 'lunch', 'socks', 'gym pass']
      const names = ['Food', 'Travel', 'Gym', 'Fees']

      const onLaptop = (i: number) => {
        const s = S(laptop)
        const before = byId(s.expenses)
        const roll = r()
        try {
          if (roll < 0.25) {
            const category = r() < 0.6 ? pick(s.categories) : undefined
            s.addExpense({
              itemName: pick(items) ?? 'kopi',
              amount: 1000 + 2 * i,
              ...(category === undefined ? {} : { category }),
            })
          } else if (roll < 0.45) {
            const id = pick(s.expenses.map((e) => e.id))
            if (id !== undefined) s.updateExpense(id, { amount: 1000 + 2 * i })
          } else if (roll < 0.6) {
            const id = pick(s.expenses.map((e) => e.id))
            if (id !== undefined) s.updateExpense(id, { notes: `A${String(i)}` })
          } else if (roll < 0.7) {
            const id = pick(s.expenses.map((e) => e.id))
            if (id !== undefined) s.deleteExpense(id)
          } else if (roll < 0.8) {
            const entry = s.undoStack.at(-1)
            if (entry !== undefined) s.consumeUndo(entry.id)
          } else if (roll < 0.85) {
            const from = pick(s.categories.filter((c) => c !== 'Other'))
            const to = pick(names)
            if (from !== undefined && to !== undefined) s.renameCategory(from, to)
          } else if (roll < 0.95) {
            const category = pick(s.categories)
            if (category !== undefined) s.setBudget(category, 100 + i)
          } else {
            const category = pick(Object.keys(s.budgets))
            if (category !== undefined) s.removeBudget(category)
          }
        } catch (err) {
          // A readable refusal (a rename onto an existing name…) is fine; a crash is not.
          if (!(err instanceof Error) || err.message.length === 0) issues.push(`op ${String(i)}`)
        }
        writes.record('A', before, byId(S(laptop).expenses))
      }

      const onPhone = (i: number) => {
        const s = phone.app.s
        const before = byId(s.expenses)
        const roll = r()
        if (roll < 0.25) {
          phone.app.addExpense({
            itemName: pick(items) ?? 'kopi',
            amount: 1001 + 2 * i,
            ...(r() < 0.6 ? { category: pick(s.categories) ?? 'Other' } : {}),
          })
        } else if (roll < 0.45) {
          const id = pick(s.expenses.map((e) => e.id))
          if (id !== undefined) phone.app.updateExpense(id, { amount: 1001 + 2 * i })
        } else if (roll < 0.6) {
          const id = pick(s.expenses.map((e) => e.id))
          if (id !== undefined) phone.app.updateExpense(id, { notes: `O${String(i)}` })
        } else if (roll < 0.7) {
          const id = pick(s.expenses.map((e) => e.id))
          if (id !== undefined) phone.app.deleteExpense(id)
        } else if (roll < 0.8) {
          const entry = s.undoStack.at(-1)
          if (entry !== undefined) phone.app.consumeUndo(entry.id)
        } else if (roll < 0.85) {
          const from = pick(s.categories.filter((c) => c !== 'Other'))
          const to = pick(names)
          if (from !== undefined && to !== undefined) phone.app.renameCategory(from, to)
        } else if (roll < 0.95) {
          const category = pick(s.categories)
          if (category !== undefined) phone.app.setBudget(category, 101 + i)
        } else {
          const category = pick(Object.keys(s.budgets))
          if (category !== undefined) phone.app.removeBudget(category)
        }
        writes.record('O', before, byId(phone.app.s.expenses))
      }

      const end = Date.now() + MINUTE
      for (let i = 0; Date.now() < end; i++) {
        await advance(50 + Math.floor(r() * 2400))
        if (r() < 0.5) onLaptop(i)
        else onPhone(i)
      }
      await advance(5 * MINUTE)

      const here = byId(S(laptop).expenses)
      const there = byId(phone.app.s.expenses)
      // Adds and deletes: none lost, none undone by the other device, the same set on both.
      for (const [id, dev] of writes.added) {
        if (!writes.deleted.has(id) && !here.has(id)) issues.push(`LOST ADD ${id} (${dev})`)
      }
      for (const [id, dev] of writes.deleted) {
        if (here.has(id) || there.has(id)) issues.push(`RESURRECTED ${id} (${dev})`)
      }
      expect([...here.keys()].sort()).toEqual([...there.keys()].sort())
      expect(relayIds()).toEqual([...here.keys()].sort())
      // Fields: the value written last, of the writes that reached this device, on both devices.
      const pushed = new Set(
        relay()
          .pushes.filter((p) => p.client === phone.client.id)
          .flatMap((p) => listOf(isRecord(p.payload) ? p.payload.expenses : [], isRecord))
          .flatMap((row) =>
            typeof row.id === 'string'
              ? [`${row.id}|${String(row.updatedAt ?? row.createdAt)}`]
              : [],
          ),
      )
      for (const [id, shown] of here) {
        for (const f of FIELDS) {
          const expected = writes.last(id, f, pushed) ?? start.find((e) => e.id === id)?.[f] ?? ''
          if (shown[f] !== expected) issues.push(`LOST WRITE ${id}.${f}: ${String(shown[f])}`)
          if (there.get(id)?.[f] !== shown[f]) issues.push(`DIVERGED ${id}.${f}`)
        }
      }
      // Categories, picks and budgets. 0.9.2 knows no renames: it keeps filing under a name this
      // device renamed, and here that name resolves through the rename table (acceptance 12).
      const doc = laptop.expense.getSyncPort()?.doc()
      if (doc === undefined) throw new Error('not hydrated')
      const res = resolver(doc.renames)
      const listed = new Set(S(laptop).categories)
      for (const e of S(laptop).expenses) {
        if (!listed.has(e.category)) issues.push(`UNLISTED ${e.id}: ${e.category}`)
        const theirs = phone.app.s.expenses.find((x) => x.id === e.id)?.category
        if (theirs === undefined || res(theirs) !== e.category) {
          issues.push(`CATEGORY ${e.id}: ${e.category} vs ${String(theirs)}`)
        }
      }
      // Item picks: the same pick with the same stamp on both (last writer wins, P2-3).
      const picks = phone.app.s.categoryMappings
      for (const k of new Set([...doc.mappings.keys(), ...Object.keys(picks)])) {
        const reg = doc.mappings.get(k)
        const stamp = Date.parse(phone.app.s.mappingUpdatedAt[k] ?? '')
        if (reg?.v !== picks[k] || reg?.s !== stamp) issues.push(`PICK ${k}`)
      }
      for (const [k, v] of Object.entries(S(laptop).categoryMappings)) {
        if (res(picks[k] ?? '') !== v) issues.push(`PICK VIEW ${k}`)
      }
      // Budgets: one per live name here (never doubled), each one the phone holds under a name
      // that resolves to it.
      const phoneBudgets = Object.entries(phone.app.s.budgets)
      for (const [name, amount] of Object.entries(S(laptop).budgets)) {
        if (!phoneBudgets.some(([k, v]) => res(k) === name && v === amount)) {
          issues.push(`BUDGET ${name}: ${String(amount)}`)
        }
      }
      for (const [k] of phoneBudgets) {
        if (listed.has(res(k)) && S(laptop).budgets[res(k)] === undefined) {
          issues.push(`BUDGET MISSING ${k}`)
        }
      }
      expect(issues, `seed ${String(seed)}`).toEqual([])

      // Quiet: while the phone is idle, at most one push per 10 minutes from 0.10.0.
      const ours = laptopPushes()
      const theirs = phone.pushes()
      await advance(20 * MINUTE)
      expect(laptopPushes() - ours).toBeLessThanOrEqual(2)
      expect(phone.pushes() - theirs).toBeLessThanOrEqual(2)
      phone.close()
    },
  )
})
