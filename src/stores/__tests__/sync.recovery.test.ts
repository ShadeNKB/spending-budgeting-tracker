// The Recovery centre's restores on two devices and the fake relay (PR-4, F-004):
// - T-004-4 (acceptance 3–5): after Delete all has synced and its Undo is gone, "Before Delete
//   all" brings every entry back here and, after sync, on the other device (a 0.11-style device,
//   a frozen 0.9.2 one and a v0.8.4 one), with names, amounts, categories and days unchanged; an
//   entry restored here and then deleted there stays deleted for good; a mass removal's copy
//   brings back only what that removal took, never an entry deleted in a later separate sync;
//   with no room for the safety copy nothing changes.
// - T-004-5 (acceptance 7–8): one "Deleted on your other device" row per entry of a quiet
//   removal, each restorable on its own on both devices; a conflict put back everywhere through
//   a fresh-stamped edit, and refused when the entry changed again or was deleted since.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/backup'
import type { ChangeItem, RecoveryApi } from '../../data/local/types'
import type { Expense } from '../../types'
import {
  MemoryStorage,
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
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
const recovery = (d: Device): Promise<RecoveryApi> => S(d).recovery()
const sorted = (ids: readonly string[]): string[] => [...ids].sort()

/** What the owner sees of an entry: name, amount, category, day, notes. */
const shownOf = (e: Pick<Expense, 'itemName' | 'amount' | 'category' | 'date' | 'notes'>) =>
  JSON.stringify([e.itemName, e.amount, e.category, e.date.slice(0, 10), e.notes ?? ''])

const shown = (rows: readonly Expense[]): string[] => rows.map(shownOf).sort()

function relayIds(): string[] {
  return sorted(relayRows().flatMap((r) => (isRecord(r) && typeof r.id === 'string' ? [r.id] : [])))
}

function relayShown(): string[] {
  return relayRows()
    .flatMap((r) =>
      isRecord(r) &&
      typeof r.itemName === 'string' &&
      typeof r.amount === 'number' &&
      typeof r.category === 'string' &&
      typeof r.date === 'string'
        ? [
            shownOf({
              itemName: r.itemName,
              amount: r.amount,
              category: r.category,
              date: r.date,
              notes: typeof r.notes === 'string' ? r.notes : undefined,
            }),
          ]
        : [],
    )
    .sort()
}

const TWELVE = Array.from({ length: 12 }, (_, i) =>
  expense(`e${String(i + 1)}`, {
    itemName: `Lunch ${String(i + 1)}`,
    amount: 4 + i,
    category: LIST[i % LIST.length] ?? 'Other',
    date: `2026-10-${String(i + 1).padStart(2, '0')}T12:00:00`,
  }),
)

/** The other device, as the test reads and drives it. */
interface Other {
  ids(): string[]
  shown(): string[]
  /** Deletes `id` there (its own delete, synced by its own engine). */
  remove(id: string): void
  close(): void
}

type Kind = '0.11' | '0.9.2' | 'v0.8.4'

async function pairWith(
  kind: Kind,
  rows: readonly Expense[] = TWELVE,
): Promise<{ laptop: Device; phone: Other; laptopClient: number }> {
  const laptop = await bootDevice({ expenses: rows, v4: { categories: LIST } })
  relay().latency = LATENCY
  const laptopClient = relay().nextClient
  await connect(laptop)
  if (kind === '0.11') {
    const device = await bootDevice({ expenses: rows, v4: { categories: LIST } })
    await connect(device)
    await advance(MINUTE)
    return {
      laptop,
      laptopClient,
      phone: {
        ids: () => sorted(S(device).expenses.map((e) => e.id)),
        shown: () => shown(S(device).expenses),
        remove: (id) => {
          S(device).deleteExpense(id)
        },
        close: () => undefined,
      },
    }
  }
  if (kind === '0.9.2') {
    const peer = new Peer092({ expenses: rows, categories: LIST })
    void peer.connect(SYNC_CODE)
    await advance(MINUTE)
    return {
      laptop,
      laptopClient,
      phone: {
        ids: () => peer.ids(),
        shown: () => shown(peer.app.s.expenses),
        remove: (id) => {
          peer.app.deleteExpense(id)
        },
        close: () => {
          peer.close()
        },
      },
    }
  }
  const peer = new LegacyPeer([...rows], LIST)
  peer.connect(SYNC_CODE)
  await advance(MINUTE)
  return {
    laptop,
    laptopClient,
    phone: {
      ids: () => sorted(peer.state.expenses.map((e) => e.id)),
      shown: () => shown(peer.state.expenses),
      remove: (id) => {
        peer.remove(id)
      },
      close: () => {
        peer.disconnect()
      },
    },
  }
}

/** `n` more minutes of syncing, a cycle started on the laptop every minute. */
async function cycles(laptop: Device, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    void laptop.sync.useSyncStore.getState().triggerSync()
    await advance(MINUTE)
  }
}

async function restoreDeleteAll(laptop: Device): Promise<void> {
  const r = await recovery(laptop)
  const snap = r.snapshots().find((s) => s.reason === 'delete-all')
  if (snap === undefined) throw new Error('no "Before Delete all" copy')
  const preview = await r.previewSnapshot(snap.id)
  expect(preview.counts).toMatchObject({ inFile: 12, restored: 12, added: 0, updated: 0 })
  const outcome = S(laptop).applyImport(preview, 'restore')
  expect(outcome).toMatchObject({ restored: 12, removed: 0 })
}

// ---------------------------------------------------------------------------
// T-004-4: Delete all, then "Before Delete all" (acceptance 3–5)
// ---------------------------------------------------------------------------

describe.each(['0.11', '0.9.2', 'v0.8.4'] as const)(
  'Delete all, sync, wait out the Undo, restore "Before Delete all", beside a %s phone (T-004-4)',
  (kind) => {
    it('every entry is back on both devices, unchanged, and stays back', async () => {
      const { laptop, phone } = await pairWith(kind)
      const before = shown(S(laptop).expenses)
      S(laptop).deleteAllEverywhere()
      await advance(MINUTE) // synced, and the 30 s Undo is gone
      expect(phone.ids()).toEqual([])
      expect(relayIds()).toEqual([])
      expect(S(laptop).undoStack.some((u) => u.expiresAt >= Date.now())).toBe(false)

      await restoreDeleteAll(laptop)
      await advance(MINUTE)
      const back = sorted(S(laptop).expenses.map((e) => e.id))
      expect(back).toHaveLength(12)
      expect(shown(S(laptop).expenses)).toEqual(before)
      expect(phone.ids()).toEqual(back)
      expect(phone.shown()).toEqual(before)
      expect(relayIds()).toEqual(back)
      expect(relayShown()).toEqual(before)

      await cycles(laptop, 10)
      expect(sorted(S(laptop).expenses.map((e) => e.id))).toEqual(back)
      expect(phone.ids()).toEqual(back)
      phone.close()
    })

    it('an entry restored here and then deleted there stays deleted on both, cycle after cycle', async () => {
      const { laptop, phone } = await pairWith(kind)
      S(laptop).deleteAllEverywhere()
      await advance(MINUTE)
      await restoreDeleteAll(laptop)
      await advance(MINUTE)
      const victim = phone.ids()[3]
      if (victim === undefined) throw new Error('nothing came back')
      phone.remove(victim)
      await advance(MINUTE)
      await cycles(laptop, 20)
      expect(S(laptop).expenses.map((e) => e.id)).not.toContain(victim)
      expect(phone.ids()).not.toContain(victim)
      expect(relayIds()).not.toContain(victim)
      expect(S(laptop).expenses).toHaveLength(11)
      expect(phone.ids()).toHaveLength(11)
      phone.close()
    })
  },
)

describe('the precision rule beside a 0.11 phone (T-004-4, acceptance 4)', () => {
  it('"Before your other device removed entries" brings back only what that removal took', async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      expense(`m${String(i + 1)}`, { itemName: `Kopi ${String(i + 1)}`, amount: 1 + i / 10 }),
    )
    const laptop = await bootDevice({ expenses: rows, v4: { categories: LIST } })
    relay().latency = LATENCY
    await connect(laptop)
    const phone = await bootDevice({ expenses: rows, v4: { categories: LIST } })
    await connect(phone)
    await advance(MINUTE)

    // the phone removes 20 (the laptop's guard keeps a copy), and later, separately, one more
    const took = rows.slice(0, 20).map((e) => e.id)
    for (const id of took) S(phone).deleteExpense(id)
    await advance(MINUTE)
    expect(S(laptop).expenses).toHaveLength(20)
    S(phone).deleteExpense('m30')
    await advance(MINUTE)
    expect(S(laptop).expenses.map((e) => e.id)).not.toContain('m30')

    const r = await recovery(laptop)
    const snap = r.snapshots().find((s) => s.reason === 'mass')
    if (snap === undefined) throw new Error('no mass copy')
    const preview = await r.previewSnapshot(snap.id)
    expect(preview.counts).toMatchObject({ inFile: 20, restored: 20 })
    S(laptop).applyImport(preview, 'restore')
    await advance(MINUTE)
    await cycles(laptop, 5)
    for (const d of [laptop, phone]) {
      const ids = S(d).expenses.map((e) => e.id)
      expect(ids).toHaveLength(39)
      expect(ids.some((id) => id === 'm30' || id.startsWith('m30~'))).toBe(false)
    }
  })
})

describe('no room for the safety copy (T-004-4, acceptance 5)', () => {
  it('a snapshot restore changes nothing here or on the relay, and says why', async () => {
    const storage = new MemoryStorage()
    const laptop = await bootDevice({ expenses: TWELVE, v4: { categories: LIST }, storage })
    relay().latency = LATENCY
    await connect(laptop)
    S(laptop).deleteAllEverywhere()
    await advance(MINUTE)
    const r = await recovery(laptop)
    const snap = r.snapshots().find((s) => s.reason === 'delete-all')
    if (snap === undefined) throw new Error('no copy')
    const preview = await r.previewSnapshot(snap.id)
    storage.refuse.add('st5:snap*')
    storage.refuse.add('st5:snaps')
    expect(() => S(laptop).applyImport(preview, 'restore')).toThrow(
      "Couldn't keep a safety copy on this device. Download a backup first, then try again.",
    )
    await advance(MINUTE)
    expect(S(laptop).expenses).toEqual([])
    expect(relayIds()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// T-004-5: what a merge changed here, put back (acceptance 7–8)
// ---------------------------------------------------------------------------

const byKind = (list: readonly ChangeItem[], kind: ChangeItem['kind']): ChangeItem[] =>
  list.filter((c) => c.kind === kind)

describe('a quiet removal on the other device (T-004-5, acceptance 7)', () => {
  it.each(['0.11', '0.9.2'] as const)(
    'one row per entry (beside %s); Restore brings back just that one, on both devices, for good',
    async (kind) => {
      const { laptop, phone } = await pairWith(kind)
      phone.remove('e2')
      phone.remove('e5')
      await advance(MINUTE)
      await cycles(laptop, 1)
      expect(S(laptop).expenses.map((e) => e.id)).not.toContain('e2')
      const r = await recovery(laptop)
      const removed = byKind(r.changes(), 'removed')
      expect(removed.map((c) => c.before?.itemName).sort()).toEqual(['Lunch 2', 'Lunch 5'])
      const row = removed.find((c) => c.before?.itemName === 'Lunch 5')
      if (row === undefined) throw new Error('no row')
      const res = await r.restoreChange(row.id)
      expect(res).toMatchObject({ applied: 1, why: null })
      await advance(MINUTE)
      await cycles(laptop, 20)
      const revived = S(laptop).expenses.find((e) => e.id.startsWith('e5~r'))
      expect(revived && shownOf(revived)).toBe(shownOf(TWELVE[4] ?? expense('x')))
      expect(phone.ids()).toContain(revived?.id)
      for (const ids of [S(laptop).expenses.map((e) => e.id), phone.ids()]) {
        expect(ids).not.toContain('e2')
        expect(ids.some((id) => id.startsWith('e2~'))).toBe(false)
        expect(ids).toHaveLength(11)
      }
      phone.close()
    },
  )
})

describe('a conflict with the other device (T-004-5, acceptance 8)', () => {
  it("lists before → after; Restore puts this device's value back everywhere; again: already back", async () => {
    const rows = TWELVE
    const laptop = await bootDevice({ expenses: rows, v4: { categories: LIST } })
    relay().latency = LATENCY
    const laptopClient = relay().nextClient
    await connect(laptop)
    const phone = await bootDevice({ expenses: rows, v4: { categories: LIST } })
    await connect(phone)
    await advance(MINUTE)

    setClientOffline(laptopClient, true)
    S(laptop).updateExpense('e1', { amount: 10 })
    await advance(30_000)
    S(phone).updateExpense('e1', { amount: 99 })
    await advance(MINUTE)
    setClientOffline(laptopClient, false)
    await cycles(laptop, 2)
    expect(S(laptop).expenses.find((e) => e.id === 'e1')?.amount).toBe(99)

    const r = await recovery(laptop)
    const c = byKind(r.changes(), 'conflict')[0]
    if (c === undefined) throw new Error('no conflict listed')
    expect(c).toMatchObject({ pinned: true, seen: false })
    expect([c.before?.amount, c.after?.amount]).toEqual([10, 99])
    expect(r.summary().newChanges).toBe(1)

    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 1, why: null })
    await advance(MINUTE)
    await cycles(laptop, 20)
    expect(S(laptop).expenses.find((e) => e.id === 'e1')?.amount).toBe(10)
    expect(S(phone).expenses.find((e) => e.id === 'e1')?.amount).toBe(10)
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'already' })
    expect(r.summary().newChanges).toBe(0)
  })

  it('changed again on the other device since: refused, nothing changes', async () => {
    const laptop = await bootDevice({ expenses: TWELVE, v4: { categories: LIST } })
    relay().latency = LATENCY
    const laptopClient = relay().nextClient
    await connect(laptop)
    const phone = await bootDevice({ expenses: TWELVE, v4: { categories: LIST } })
    await connect(phone)
    await advance(MINUTE)
    setClientOffline(laptopClient, true)
    S(laptop).updateExpense('e1', { amount: 10 })
    await advance(30_000)
    S(phone).updateExpense('e1', { amount: 99 })
    await advance(MINUTE)
    setClientOffline(laptopClient, false)
    await cycles(laptop, 2)
    const r = await recovery(laptop)
    const c = byKind(r.changes(), 'conflict')[0]
    if (c === undefined) throw new Error('no conflict listed')

    S(phone).updateExpense('e1', { amount: 55 })
    await advance(MINUTE)
    await cycles(laptop, 1)
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'changed-since' })
    await cycles(laptop, 3)
    expect(S(laptop).expenses.find((e) => e.id === 'e1')?.amount).toBe(55)
    expect(S(phone).expenses.find((e) => e.id === 'e1')?.amount).toBe(55)
  })

  it('deleted on the other device since: refused, and it stays deleted on both for good', async () => {
    const laptop = await bootDevice({ expenses: TWELVE, v4: { categories: LIST } })
    relay().latency = LATENCY
    const laptopClient = relay().nextClient
    await connect(laptop)
    const phone = await bootDevice({ expenses: TWELVE, v4: { categories: LIST } })
    await connect(phone)
    await advance(MINUTE)
    setClientOffline(laptopClient, true)
    S(laptop).updateExpense('e1', { amount: 10 })
    await advance(30_000)
    S(phone).updateExpense('e1', { amount: 99 })
    await advance(MINUTE)
    setClientOffline(laptopClient, false)
    await cycles(laptop, 2)
    const r = await recovery(laptop)
    const c = byKind(r.changes(), 'conflict')[0]
    if (c === undefined) throw new Error('no conflict listed')

    S(phone).deleteExpense('e1')
    await advance(MINUTE)
    await cycles(laptop, 1)
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'deleted-since' })
    await cycles(laptop, 20)
    for (const d of [laptop, phone]) {
      const ids = S(d).expenses.map((e) => e.id)
      expect(ids.some((id) => id === 'e1' || id.startsWith('e1~'))).toBe(false)
    }
  })
})
