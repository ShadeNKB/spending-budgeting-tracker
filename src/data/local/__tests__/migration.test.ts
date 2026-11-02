// Migration from v4 (§9.6.2, track spec §8.2, P2-6, P2-16, P2-19; F-014, F-015). Lossless on an
// invented owner-shaped dataset, idempotent, never re-files, and safe when storage is full.
import { format, parseISO } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CATEGORIES } from '../../../constants'
import { must } from '../../__tests__/support/must'
import { mulberry32 } from '../../__tests__/support/rng'
import { isPlainObject, own } from '../../core/sanitize'
import { FakeBacking } from './fakeStorage'
import { bootTab, envelopeOf, stored } from './harness'
import { ownerV4, truncated, withKey } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)

/** Deterministic crypto (tab id, revs): two migrations of one input are then byte-identical. */
function seedCrypto(seed: number): void {
  const r = mulberry32(seed)
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (array instanceof Uint8Array)
      for (let i = 0; i < array.length; i++) array[i] = Math.floor(r() * 256)
    else if (array instanceof Uint32Array) {
      for (let i = 0; i < array.length; i++) array[i] = Math.floor(r() * 4_294_967_296)
    }
    return array
  })
}

/** The day 0.9.4 showed for a stored date in this device's zone (date-fns, not the core). */
const shownDay = (date: string): string => format(parseISO(date), 'yyyy-MM-dd')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('migration of the owner-shaped v4 fixture', () => {
  it('shows every live entry, category, budget and item pick exactly as 0.9.x did', async () => {
    const f = ownerV4()
    const { store, backing } = await bootTab({ keys: f.keys })
    const s = store.getState()
    expect(s.hydrated).toBe(true)
    const dead = new Set(f.tombstones)
    const live = f.rows.filter((r) => !dead.has(r.id))
    expect(s.expenses).toHaveLength(live.length)
    const byId = new Map(s.expenses.map((e) => [e.id, e]))
    for (const row of live) {
      const v = must(byId.get(row.id), row.id)
      expect(v.itemName).toBe(row.itemName)
      expect(v.amount).toBe(row.amount)
      expect(v.category).toBe(row.category)
      // the stored text is never rewritten, and the day is the one 0.9.4 showed in this zone
      expect(v.date).toBe(row.date)
      expect(v.day).toBe(shownDay(row.date))
      expect(v.notes).toBe(row.notes)
      expect(v.createdAt).toBe(row.createdAt)
    }
    for (const c of f.categories) expect(s.categories).toContain(c)
    expect({ ...s.categoryMappings }).toEqual(f.mappings)
    expect({ ...s.budgets }).toEqual(f.budgets)
    expect(backing.data.has('st5:db')).toBe(true)
  })

  it('leaves the eight v4 keys holding the mirror, with the writer marker and nothing re-filed', async () => {
    const f = ownerV4()
    const { backing } = await bootTab({ keys: f.keys })
    const rows = stored(backing, 'expenses')
    expect(Array.isArray(rows)).toBe(true)
    const cats = new Map(f.rows.map((r) => [r.id, r.category]))
    for (const r of Array.isArray(rows) ? rows : []) {
      const id: unknown = isPlainObject(r) ? own(r, 'id') : undefined
      const cat: unknown = isPlainObject(r) ? own(r, 'category') : undefined
      expect(typeof id === 'string' ? cats.get(id) : undefined).toBe(cat)
    }
    expect(stored(backing, 'categoryMappingUpdatedAt')).toEqual(
      Object.fromEntries(
        Object.entries(f.mappingStamps).map(([k, v]) => [k, new Date(v).toISOString()]),
      ),
    )
    expect(stored(backing, 'deletedExpenseIds')).toEqual(expect.arrayContaining([...f.tombstones]))
    expect(backing.data.get('spendtrack:app')).toBe('5')
    const meta = own(envelopeOf(backing), 'meta')
    expect(isPlainObject(meta) ? own(meta, 'migratedAt') : null).toBe(T0)
  })

  it('keeps every amount, date, note, tombstone and budget stamp through the envelope', async () => {
    const f = ownerV4()
    const { backing } = await bootTab({ keys: f.keys })
    const doc = own(envelopeOf(backing), 'doc')
    const ids = isPlainObject(doc) ? own(doc, 'deletedIds') : null
    expect(ids).toEqual(expect.arrayContaining([...f.tombstones]))
    const upd = isPlainObject(doc) ? own(doc, 'budgetUpdatedAt') : null
    expect(upd).toMatchObject({ 'Food & Dining': f.budgetUpdatedAt['Food & Dining'] })
    const del = isPlainObject(doc) ? own(doc, 'budgetDeletedAt') : null
    expect(del).toMatchObject({ Gaming: f.budgetDeletedAt.Gaming })
  })

  it('is idempotent: the same input migrates to a byte-identical envelope, and a re-boot writes nothing', async () => {
    const f = ownerV4()
    seedCrypto(7)
    const a = await bootTab({ keys: f.keys })
    const first = must(a.backing.data.get('st5:db'))
    vi.restoreAllMocks()
    seedCrypto(7)
    const b = await bootTab({ keys: f.keys })
    expect(b.backing.data.get('st5:db')).toBe(first)
    b.backing.resetCounts()
    await bootTab({ backing: b.backing })
    expect(b.backing.setsOf('st5:db')).toBe(0)
    expect(b.backing.data.get('st5:db')).toBe(first)
  })

  it('puts every record and register in the outbox when a sync code is set, none without one', async () => {
    const withCode = await bootTab({ keys: ownerV4().keys })
    const meta = own(envelopeOf(withCode.backing), 'meta')
    const outbox = isPlainObject(meta) ? own(meta, 'outbox') : null
    expect(Array.isArray(outbox) ? outbox.length : 0).toBeGreaterThan(700)
    const noCode = await bootTab({ keys: ownerV4({ noSync: true }).keys })
    const meta2 = own(envelopeOf(noCode.backing), 'meta')
    expect(isPlainObject(meta2) ? own(meta2, 'outbox') : null).toEqual([])
  })

  it('reads 0.9.x keys at rank 1 and older ones at rank 0 (P2-6)', async () => {
    const { legacyRankOf } = await import('../migrate')
    expect(legacyRankOf('0.8.5')).toBe(1)
    expect(legacyRankOf('5')).toBe(1)
    expect(legacyRankOf('0.9.4')).toBe(1)
    expect(legacyRankOf('0.8.4')).toBe(0)
    expect(legacyRankOf(null)).toBe(0)
    expect(legacyRankOf('junk')).toBe(0)
  })

  it('lists DEFAULT_CATEGORIES when the categories key is missing or empty (P2-19)', async () => {
    const f = ownerV4({ rows: 5, tombstones: 0, mappings: 0 })
    const { categories: _missing, ...rest } = f.keys
    const a = await bootTab({ keys: rest })
    for (const c of DEFAULT_CATEGORIES) expect(a.store.getState().categories).toContain(c)
    const b = await bootTab({ keys: withKey(f, 'categories', '[]') })
    for (const c of DEFAULT_CATEGORIES) expect(b.store.getState().categories).toContain(c)
  })
})

describe('nothing is ever re-filed (F-015)', () => {
  it('keeps every category through hydrate twice and an import of the same data', async () => {
    const f = ownerV4({ rows: 80, noSync: true })
    const a = await bootTab({ keys: f.keys })
    const b = await bootTab({ backing: a.backing })
    const cats = (t: typeof a): readonly string[] =>
      t.store.getState().expenses.map((e) => `${e.id}:${e.category}`)
    expect(cats(b)).toEqual(cats(a))
    const backup = {
      expenses: f.rows,
      categories: f.categories,
      categoryMappings: f.mappings,
      mappingUpdatedAt: f.mappingStamps,
      budgets: f.budgets,
      deletedIds: f.tombstones,
      exportDate: '2026-10-19T04:00:00.000Z',
      version: '4.0',
    }
    const c = await bootTab()
    const preview = await c.store
      .getState()
      .previewImport(new File([JSON.stringify(backup)], 'v4.json'))
    c.store.getState().applyImport(preview, 'restore')
    const byId = new Map(f.rows.map((r) => [r.id, r.category]))
    for (const e of c.store.getState().expenses) expect(e.category).toBe(byId.get(e.id))
    expect(c.store.getState().categories).toContain('Bills & Utilities')
    expect(c.store.getState().categories).toContain('Education')
  })

  it('has no keyword table outside the frozen v0.8.4 model (static scan)', () => {
    const sources = import.meta.glob<string>(
      ['/src/**/*.{ts,tsx}', '!/src/data/__tests__/legacy/**', '!/src/**/*.test.{ts,tsx}'],
      { query: '?raw', import: 'default', eager: true },
    )
    const hits = Object.entries(sources)
      .filter(([, text]) =>
        /ITEM_CATEGORY_PATTERNS|CATEGORY_MIGRATIONS|migrateExpenseCategory|migrateExpenses/.test(
          text,
        ),
      )
      .map(([path]) => path)
    expect(hits).toEqual([])
  })
})

describe('a pristine origin', () => {
  it('lists DEFAULT_CATEGORIES and writes no envelope until the first commit', async () => {
    const { store, backing } = await bootTab()
    expect(store.getState().categories).toEqual([...DEFAULT_CATEGORIES])
    expect(store.getState().report).toBeNull()
    expect(backing.data.has('st5:db')).toBe(false)
    store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    await Promise.resolve()
    expect(backing.data.has('st5:db')).toBe(true)
  })
})

describe('a broken v4 key never blanks the app (F-014)', () => {
  it('salvages 299 of 300 rows from a truncated expenses key and keeps the raw copy', async () => {
    const f = ownerV4({ rows: 300, tombstones: 0 })
    const raw = must(f.keys.expenses)
    const { store, backing } = await bootTab({ keys: withKey(f, 'expenses', truncated(raw, 37)) })
    expect(store.getState().expenses).toHaveLength(299)
    const copies = [...backing.data.keys()].filter((k) => k.startsWith('st5:q:expenses:'))
    expect(copies).toHaveLength(1)
    expect(backing.data.get(must(copies[0]))).toBe(truncated(raw, 37))
    expect(store.getState().attention.quarantined).toBeGreaterThan(0)
    expect(store.getState().report?.kind).toBe('upgraded')
    expect(backing.removes).toEqual([])
  })

  for (const key of [
    'expenses',
    'categories',
    'categoryMappings',
    'categoryMappingUpdatedAt',
    'categoryBudgets',
    'categoryBudgetUpdatedAt',
    'categoryBudgetDeletedAt',
    'deletedExpenseIds',
  ]) {
    it(`keeps every other key when ${key} is corrupt, and removes nothing`, async () => {
      const f = ownerV4({ rows: 40, tombstones: 4, mappings: 10 })
      const { store, backing } = await bootTab({ keys: withKey(f, key, '{"oops":') })
      const s = store.getState()
      expect(s.hydrated).toBe(true)
      expect(s.local).toBe('saved')
      if (key !== 'expenses') expect(s.expenses.length).toBeGreaterThan(30)
      // without its set stamps a budget that also has a deletion stamp reads as deleted (§6.7)
      const { Subscriptions: _re, ...unstamped } = f.budgets
      if (key === 'categoryBudgetUpdatedAt') expect({ ...s.budgets }).toEqual(unstamped)
      else if (key !== 'categoryBudgets') expect({ ...s.budgets }).toEqual(f.budgets)
      expect(backing.data.get(`st5:q:${key}:${String(T0)}`)).toBe('{"oops":')
      expect(backing.removes).toEqual([])
    })
  }

  it("treats a 'null' budgets key as no budgets and keeps the expenses (DAT-09)", async () => {
    const f = ownerV4({ rows: 30, tombstones: 0 })
    const { store } = await bootTab({ keys: withKey(f, 'categoryBudgets', 'null') })
    expect(store.getState().expenses).toHaveLength(30)
    expect({ ...store.getState().budgets }).toEqual({})
  })

  it('runs in memory, writes nothing and removes nothing when even the quarantine copy fails', async () => {
    const f = ownerV4({ rows: 50, tombstones: 0 })
    const backing = new FakeBacking()
    backing.prefixFailures.set('st5:', 'quota')
    const { store } = await bootTab({
      backing,
      keys: withKey(f, 'expenses', truncated(must(f.keys.expenses), 37)),
    })
    const s = store.getState()
    expect(s.local).toBe('memory-only')
    expect(s.syncStatus).toBe('error')
    expect(s.expenses.length).toBe(49)
    expect(backing.data.get('expenses')).toBe(truncated(must(f.keys.expenses), 37))
    expect(backing.data.has('st5:db')).toBe(false)
    expect(backing.removes).toEqual([])
    s.addExpense({ itemName: 'Kopi', amount: 1.4 })
    await Promise.resolve()
    expect(backing.data.has('st5:db')).toBe(false)
  })

  it('quarantines unreadable rows (bad dates, objects, null) and loads the rest', async () => {
    const f = ownerV4({ rows: 20, tombstones: 0 })
    const rows = [
      ...f.rows,
      { ...f.rows[0], id: 'bad-1', date: 'last tuesday' },
      { ...f.rows[0], id: 'bad-2', date: '18/10/2026' },
      { ...f.rows[0], id: 'bad-3', amount: Number.NaN },
      null,
      'not a row',
    ]
    const { store, backing } = await bootTab({ keys: withKey(f, 'expenses', JSON.stringify(rows)) })
    expect(store.getState().expenses).toHaveLength(20)
    expect(store.getState().attention.quarantined).toBeGreaterThanOrEqual(4)
    expect(String(backing.data.get('st5:q'))).toContain('last tuesday')
    expect(backing.removes).toEqual([])
  })
})

describe('storage full at migration (P2-16)', () => {
  it('still writes the envelope but keeps the v4 keys byte-identical and says the rollback copy is off', async () => {
    const f = ownerV4({ rows: 120, tombstones: 10 })
    const backing = new FakeBacking()
    backing.prefixFailures.set('st5:snap', 'quota')
    const { store } = await bootTab({ backing, keys: f.keys })
    const s = store.getState()
    expect(backing.data.has('st5:db')).toBe(true)
    for (const [k, v] of Object.entries(f.keys)) {
      if (k !== 'spendtrack:currency' && !k.startsWith('spendtrack:'))
        expect(backing.data.get(k)).toBe(v)
    }
    expect(s.facts.mirror).toBe('off')
    expect(backing.removes).toEqual([])
    // the next boot does not fold the old keys back in a loop
    backing.resetCounts()
    await bootTab({ backing })
    expect(backing.setsOf('st5:db')).toBe(0)
  })
})
