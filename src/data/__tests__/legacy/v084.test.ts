// @vitest-environment node
// Golden vectors of the frozen v0.8.4 model (equivalence with the shipped code was proven once in
// scratch on 3,000 merges, 3,000 migrations, 3,000 parses and 300 × 30 store steps; P-27).
import { describe, expect, it } from 'vitest'
import { EMPTY_DOC } from '../../core/doc'
import { addExpense } from '../../core/ops'
import { encodeBackupFile, movedMarker } from '../../core/wire'
import { makeRng } from '../support/rng'
import { must } from '../support/must'
import {
  StorageQuotaError,
  V084Client,
  makeStorage,
  mergeBackups,
  migrateExpenseCategory,
  parseBackup,
  pullSync,
  type BackupData,
  type ClockPort,
  type Expense,
  type RelayPort,
  type StoragePort,
} from './v084'

const NOW = Date.UTC(2026, 9, 19, 8)
const fixedClock: ClockPort = { now: () => NOW, setTimeout: () => 0, clearTimeout: () => undefined }
const e = (id: string, over: Partial<Expense> = {}): Expense => ({
  id,
  itemName: id,
  amount: 1,
  category: 'Food',
  date: '2026-10-18T04:00:00.000Z',
  createdAt: '2026-10-18T04:00:00.000Z',
  ...over,
})
const backup = (over: Partial<BackupData> = {}): BackupData => ({
  expenses: [],
  categories: ['Food'],
  categoryMappings: {},
  exportDate: '2026-10-18T00:00:00.000Z',
  version: '4.0',
  ...over,
})
function memStorage(): StoragePort & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('mergeBackups (golden)', () => {
  it('whole-record LWW: equal stamps keep the LOCAL copy; newer remote wins', () => {
    const l = e('a', { amount: 1 })
    const r = e('a', { amount: 2 })
    expect(
      mergeBackups(backup({ expenses: [l] }), backup({ expenses: [r] }), fixedClock).expenses,
    ).toEqual([l])
    const newer = e('a', { amount: 3, updatedAt: '2026-10-19T00:00:00.000Z' })
    expect(
      mergeBackups(backup({ expenses: [l] }), backup({ expenses: [newer] }), fixedClock).expenses,
    ).toEqual([newer])
    // a 9999 stamp always wins (F-006 evidence)
    const hostile = e('a', { amount: 99999, updatedAt: '9999-12-31T00:00:00.000Z' })
    expect(
      mergeBackups(backup({ expenses: [newer] }), backup({ expenses: [hostile] }), fixedClock)
        .expenses[0]?.amount,
    ).toBe(99999)
  })

  it('tombstones union and are capped with slice(-1000) by insertion order (F-013)', () => {
    const localIds = Array.from({ length: 1200 }, (_, i) => `old${i}`)
    const m = mergeBackups(
      backup({ deletedIds: localIds }),
      backup({ deletedIds: ['new1'] }),
      fixedClock,
    )
    expect(m.deletedIds).toHaveLength(1000)
    expect(m.deletedIds?.[0]).toBe('old201')
    expect(m.deletedIds?.at(-1)).toBe('new1')
    // a tombstoned id is never live, whatever the stamps
    const killed = mergeBackups(
      backup({ expenses: [e('a', { updatedAt: '2030-01-01T00:00:00.000Z' })] }),
      backup({ deletedIds: ['a'] }),
      fixedClock,
    )
    expect(killed.expenses).toEqual([])
  })

  it('mappings: local wins on conflict; categories: union, local order first', () => {
    const m = mergeBackups(
      backup({ categories: ['B', 'A'], categoryMappings: { kopi: 'Food', tea: 'Drinks' } }),
      backup({ categories: ['A', 'C'], categoryMappings: { kopi: 'Drinks', milo: 'Drinks' } }),
      fixedClock,
    )
    expect(m.categories).toEqual(['B', 'A', 'C'])
    expect(m.categoryMappings).toEqual({ kopi: 'Food', tea: 'Drinks', milo: 'Drinks' })
    expect(m.exportDate).toBe(new Date(NOW).toISOString())
  })

  it('budgets: a value without budgetUpdatedAt takes its backup’s exportDate; deletion wins ties', () => {
    const m = mergeBackups(
      backup({ budgets: { Food: 150 }, exportDate: '2026-10-01T00:00:00.000Z' }),
      backup({ budgets: { Food: 200 }, budgetUpdatedAt: { Food: '2026-10-05T00:00:00.000Z' } }),
      fixedClock,
    )
    expect(m.budgets).toEqual({ Food: 200 })
    const tie = mergeBackups(
      backup({ budgets: { Food: 150 }, budgetUpdatedAt: { Food: '2026-10-05T00:00:00.000Z' } }),
      backup({ budgetDeletedAt: { Food: '2026-10-05T00:00:00.000Z' } }),
      fixedClock,
    )
    expect(tie.budgets).toEqual({})
    expect(tie.budgetDeletedAt).toEqual({ Food: '2026-10-05T00:00:00.000Z' })
  })

  it('throws on the moved marker before any push (G5)', async () => {
    const marker: unknown = JSON.parse(
      JSON.stringify(movedMarker('private', new Date(NOW).toISOString())),
    )
    const relay: RelayPort = {
      pull: () => Promise.resolve({ payload: marker }),
      push: () => Promise.resolve(),
      subscribe: () => () => undefined,
    }
    const remote = must(await pullSync(relay, 'row'))
    expect(() => mergeBackups(backup(), remote, fixedClock)).toThrow(TypeError)
  })
})

describe('keyword re-filing (F-015 evidence, golden)', () => {
  it('re-files the deliberately filed rows from the audit', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['Kitchen towel', 'Other', 'Shopping'],
      ['GitHub shares', 'Investment', 'Subscriptions'],
      ['SQL course', 'Education', 'Subscriptions'],
      ['SP Group electricity', 'Bills & Utilities', 'Travel'],
      ['Steamboat dinner', 'Social & Leisure', 'Gaming'],
      ['Chicken rice', 'Food & Dining', 'Food & Dining'],
    ]
    for (const [itemName, category, to] of cases) {
      expect(migrateExpenseCategory(e('x', { itemName, category })).category, itemName).toBe(to)
    }
  })
})

describe('parseBackup', () => {
  it('accepts a v5 backup file and ignores its extras (§10.6 rollback import)', () => {
    let doc = EMPTY_DOC
    const ctx = { wall: NOW, clock: { last: 0 }, dev: 'd', rng: makeRng(1).next }
    doc = addExpense(doc, ctx, { itemName: 'kopi', amount: 1.8, category: 'Food', notes: 'o' }).doc
    doc = addExpense(doc, { ...ctx, wall: NOW + 1 }, { itemName: 'grab', amount: 12 }).doc
    const file: unknown = JSON.parse(JSON.stringify(encodeBackupFile(doc)))
    const parsed = parseBackup(file, fixedClock)
    expect(parsed.expenses.map((x) => x.itemName).sort()).toEqual(['grab', 'kopi'])
    expect(Object.keys(must(parsed.expenses[0]))).not.toContain('h')
    expect(parsed.version).toBe('5.0')
  })

  it('rejects the whole file on one bad row (shipped behaviour)', () => {
    expect(() =>
      parseBackup({ expenses: [e('a'), { ...e('b'), date: 'last tuesday' }] }, fixedClock),
    ).toThrow('bad date')
  })
})

describe('storage (F-014 model)', () => {
  it('repairs a trailing comma, deletes an unparseable key, trusts row shapes', () => {
    const s = memStorage()
    const store = makeStorage(s)
    s.map.set('expenses', '[{"id":"a"},]')
    expect(store.getExpenses()).toEqual([{ id: 'a' }])
    s.map.set('expenses', '[{"id":"a"}')
    expect(store.getExpenses()).toEqual([])
    expect(s.map.has('expenses')).toBe(false)
  })

  it('safeSet maps a quota DOMException to StorageQuotaError', () => {
    const full: StoragePort = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
      removeItem: () => undefined,
    }
    expect(() => makeStorage(full).saveExpenses([])).toThrow(StorageQuotaError)
  })
})

describe('V084Client', () => {
  it('hydrate migrates categories and fills the 1970 budget epoch', () => {
    const s = memStorage()
    s.map.set(
      'expenses',
      JSON.stringify([e('a', { itemName: 'Kitchen towel', category: 'Other' })]),
    )
    s.map.set('categoryBudgets', JSON.stringify({ Food: 300 }))
    const c = new V084Client(fixedClock, makeRng(1).next, s, {
      pull: () => Promise.resolve(null),
      push: () => Promise.resolve(),
      subscribe: () => () => undefined,
    })
    c.hydrate()
    expect(c.s.expenses[0]?.category).toBe('Shopping')
    expect(c.s.budgetUpdatedAt).toEqual({ Food: '1970-01-01T00:00:00.000Z' })
  })

  it('F-001 shape: an add made while the pull is in flight is lost from memory and the relay', async () => {
    let release: () => void = () => undefined
    let stored: unknown = { ...backup({ expenses: [e('r1')] }) }
    const relay: RelayPort = {
      pull: () =>
        new Promise((resolve) => {
          release = () => resolve({ payload: stored })
        }),
      push: (_id, p) => {
        stored = JSON.parse(JSON.stringify(p))
        return Promise.resolve()
      },
      subscribe: () => () => undefined,
    }
    const c = new V084Client(fixedClock, makeRng(2).next, memStorage(), relay)
    c.hydrate()
    c.syncId = 'row'
    const sync = c.triggerSync()
    c.addExpense({ itemName: 'chicken rice', amount: 4.5 })
    expect(c.s.expenses).toHaveLength(1)
    release()
    await sync
    expect(c.s.expenses.map((x) => x.id)).toEqual(['r1'])
    expect(c.pushes).toBe(1)
  })
})
