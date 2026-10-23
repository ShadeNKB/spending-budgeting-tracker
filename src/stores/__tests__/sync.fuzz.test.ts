// Seeded two-device fuzz with an oracle, ported from the final review's adversarial harness.
// Random adds, field edits, deletes, undos, shared offline windows and hide/show on two v0.8.5
// devices over one relay with random latency. After the dust settles: both devices and the
// relay hold the same content, no add is lost, no delete comes back, the relay stays quiet,
// and the last write of every field wins, except where both devices wrote that same field (the
// v4 wire has record stamps only: the newer record takes a field both changed, by design).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import { contentKey } from '../../services/syncService'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  relay,
  resetRelay,
  retireDevices,
  rowPayload,
  setVisibility,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
const SEEDS = 40
const OPS = 60
const MAX_GAP = 6000
const FIELDS = ['amount', 'notes', 'itemName', 'category'] as const
type Field = (typeof FIELDS)[number]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  stubRelayEnv()
  resetRelay()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

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

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value: online, configurable: true })
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}

const stateOf = (d: Device) => d.expense.useExpenseStore.getState()
const rowsById = (d: Device) => new Map(stateOf(d).expenses.map((e) => [e.id, e]))
const keyOf = (d: Device) => contentKey(stateOf(d).exportBackup())

interface Write {
  value: unknown
  t: number
  dev: 'A' | 'B'
}

/** One random step on one device. Returns false when it changed no row (shared events). */
async function step(d: Device, name: 'A' | 'B', i: number, seed: number, r: () => number) {
  const pick = <T>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
  const s = stateOf(d)
  const roll = r()
  if (roll < 0.22) {
    s.addExpense({ itemName: `n${String(seed)}-${String(i)}`, amount: 1 + Math.floor(r() * 50) })
  } else if (roll < 0.62) {
    const id = pick(s.expenses.map((e) => e.id))
    const field = pick(FIELDS) ?? 'amount'
    if (id === undefined) return true
    const patch: Partial<Expense> =
      field === 'amount'
        ? { amount: 100 + i }
        : field === 'notes'
          ? { notes: `note ${name}${String(i)}` }
          : field === 'itemName'
            ? { itemName: `item ${name}${String(i)}` }
            : { category: pick(['Other', 'Meals']) ?? 'Other' }
    s.updateExpense(id, patch)
  } else if (roll < 0.77) {
    const id = pick(s.expenses.map((e) => e.id))
    if (id !== undefined) s.deleteExpense(id)
  } else if (roll < 0.9) {
    const entry = s.undoStack.at(-1)
    if (entry) s.consumeUndo(entry.id)
  } else if (roll < 0.95) {
    await advance(1)
    setOnline(!navigator.onLine)
    return false
  } else {
    await advance(1)
    setVisibility('hidden')
    await advance(Math.floor(r() * 3000))
    setVisibility('visible')
    return false
  }
  return true
}

describe('two-device fuzz (seeded)', () => {
  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))('seed %i', async (seed) => {
    const r = rng(seed)
    const seedRows = () =>
      ['s1', 's2', 's3', 's4', 's5', 's6'].map((id) => expense(id, { amount: 10 }))
    const A = await bootDevice({ expenses: seedRows() })
    const B = await bootDevice({ expenses: seedRows() })
    relay().latency = {
      pull: 150 + Math.floor(r() * 400),
      push: 150 + Math.floor(r() * 400),
      realtime: 50 + Math.floor(r() * 200),
    }
    await connect(A)
    await connect(B)
    await advance(20_000)

    const devices = { A, B }
    const added = new Set<string>()
    const deleted = new Set<string>()
    const writes = new Map<string, Write[]>() // `${id}|${field}`

    for (let i = 0; i < OPS; i++) {
      await advance(Math.floor(r() * MAX_GAP))
      const name = r() < 0.5 ? 'A' : 'B'
      const d = devices[name]
      const before = rowsById(d)
      const t = Date.now()
      if (!(await step(d, name, i, seed, r))) continue
      const after = rowsById(d)
      for (const [id, row] of after) {
        const prev = before.get(id)
        if (!prev) added.add(id)
        else if (prev !== row) {
          for (const f of FIELDS) {
            if (Object.is(prev[f], row[f])) continue
            const list = writes.get(`${id}|${f}`) ?? []
            list.push({ value: row[f], t, dev: name })
            writes.set(`${id}|${f}`, list)
          }
        }
      }
      for (const id of before.keys()) if (!after.has(id)) deleted.add(id)
    }
    await advance(1)
    if (!navigator.onLine) setOnline(true)
    await advance(3 * MINUTE)

    const issues: string[] = []
    if (keyOf(A) !== keyOf(B)) issues.push('A and B differ')
    if (keyOf(A) !== contentKey(rowPayload(SYNC_CODE))) issues.push('A and the relay differ')
    for (const id of added) {
      if (deleted.has(id)) continue
      for (const [n, d] of Object.entries(devices)) {
        if (!rowsById(d).has(id)) issues.push(`lost add ${id} on ${n}`)
      }
    }
    for (const id of deleted) {
      for (const [n, d] of Object.entries(devices)) {
        if (rowsById(d).has(id)) issues.push(`deleted ${id} back on ${n}`)
      }
    }
    for (const [k, list] of writes) {
      const [id = '', f = 'amount'] = k.split('|') as [string?, Field?]
      if (deleted.has(id)) continue
      const last = list.reduce((a, b) => (b.t >= a.t ? b : a))
      const got = rowsById(A).get(id)?.[f]
      if (Object.is(got, last.value)) continue
      // Both devices wrote this field: the newer record decides it (record stamps only).
      if (list.some((w) => w.dev !== last.dev)) continue
      issues.push(`lost edit ${k}: want ${JSON.stringify(last.value)} got ${JSON.stringify(got)}`)
    }
    const upserts = relay().upserts
    await advance(10 * MINUTE)
    if (relay().upserts !== upserts) issues.push('not quiet after settling')
    expect(issues).toEqual([])
  })
})
