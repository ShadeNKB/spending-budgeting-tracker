// useExpenseStore as an adapter on the core ops (track spec §6.1, §8.10): same selector and action
// names, validation surfaced as readable errors (F-049, P2-13), null-prototype views (F-010),
// forward guarded undo (F-011, P2-12), sync-safe categories (F-012), dedupe (F-047), import
// Restore/Replace and the two clear actions (F-004), demo rules (F-027, P2-22), durable storage
// facts (F-050) and the synced currency (P2-11). Every test runs a real engine (P2-14).
import { format } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { B3, T2, T3 } from '../../data/__tests__/fixtures/auditor'
import { must, protoProbe } from '../../data/__tests__/support/must'
import { decodeWire } from '../../data/core/wire'
import { FakeBacking } from '../../data/local/__tests__/fakeStorage'
import { bootTab, settle, stored } from '../../data/local/__tests__/harness'
import { ownerV4 } from '../../data/local/__tests__/fixtures/v4Owner'

const reload = vi.hoisted(() => ({ calls: 0 }))
const downloads = vi.hoisted((): { files: string[] } => ({ files: [] }))

vi.mock('../../lib/chunkReload', async (load) => {
  const real = await load<typeof import('../../lib/chunkReload')>()
  return {
    ...real,
    reloadPage: () => {
      reload.calls++
    },
  }
})

vi.mock('../../lib/download', () => ({
  downloadJSON: (name: string) => {
    downloads.files.push(name)
  },
  downloadCSV: () => undefined,
}))

const T0 = Date.UTC(2026, 9, 19, 4)

const fileOf = (value: unknown, name = 'spendtrack-backup.json'): File =>
  new File([JSON.stringify(value)], name, { type: 'application/json' })

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  vi.setSystemTime(T0)
  reload.calls = 0
  downloads.files.length = 0
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('the facade before and after hydration', () => {
  it('keeps the selector names, and hydrate is re-runnable (P2-14)', async () => {
    const { store, backing, mod } = await bootTab()
    const s = store.getState()
    expect(s.hydrated).toBe(true)
    expect(Array.isArray(s.expenses)).toBe(true)
    expect(mod.getSyncPort()).not.toBeNull()
    s.addExpense({ itemName: 'Kopi', amount: 1.4 })
    await settle()
    backing.data.set('categories', '["Seeded later"]')
    await store.getState().hydrate()
    expect(store.getState().expenses.map((e) => e.itemName)).toEqual(['Kopi'])
    await expect(mod.whenHydrated()).resolves.toBeUndefined()
  })

  it('says "still loading" instead of losing an action before the engine has booted', async () => {
    vi.resetModules()
    const mod = await import('../useExpenseStore')
    expect(() => mod.useExpenseStore.getState().addExpense({ itemName: 'x', amount: 1 })).toThrow(
      'still loading',
    )
    expect(mod.useExpenseStore.getState().consumeUndo('nope')).toBeNull()
    expect(mod.getSyncPort()).toBeNull()
  })
})

describe('the day contract (P2-2)', () => {
  it('stores day and date = day + "T12:00:00" (no Z); a quick add without a day is today', async () => {
    const { store } = await bootTab()
    const a = store.getState().addExpense({ itemName: 'Lunch', amount: 5, day: '2026-10-11' })
    expect(a.day).toBe('2026-10-11')
    expect(a.date).toBe('2026-10-11T12:00:00')
    const b = store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    const now = new Date(T0)
    const today = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    expect(b.day).toBe(today)
    expect(b.date).toBe(`${today}T12:00:00`)
  })

  it('a quick add files under the local day at the edges (00:30 in UTC+14, 23:59 on 31 Dec in UTC−10)', async () => {
    const { store } = await bootTab()
    // 10:30Z is 00:30 the next day in Kiritimati; 09:59Z on 1 Jan is 23:59 on 31 Dec in Honolulu
    for (const wall of [Date.UTC(2026, 9, 19, 10, 30), Date.UTC(2027, 0, 1, 9, 59)]) {
      vi.setSystemTime(wall)
      const v = store.getState().addExpense({ itemName: 'Edge', amount: 1 })
      expect(v.day).toBe(format(new Date(wall), 'yyyy-MM-dd'))
      expect(v.date).toBe(`${v.day}T12:00:00`)
    }
  })

  it('the backup file and the mirror carry the same day and date as the view', async () => {
    const { store, backing } = await bootTab({ install: true })
    const v = store.getState().addExpense({ itemName: 'Lunch', amount: 5, day: '2026-02-28' })
    const file = store.getState().exportBackup()
    expect(file.expenses[0]).toMatchObject({
      id: v.id,
      day: '2026-02-28',
      date: '2026-02-28T12:00:00',
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(stored(backing, 'expenses')).toEqual([
      expect.objectContaining({ id: v.id, day: '2026-02-28', date: '2026-02-28T12:00:00' }),
    ])
  })

  it('an amount-only edit leaves the stored date byte-identical, also for an old Z-form row', async () => {
    const f = ownerV4({ rows: 5, tombstones: 0, noSync: true })
    const { store } = await bootTab({ keys: f.keys })
    for (const row of f.rows) {
      store.getState().updateExpense(row.id, { amount: row.amount + 1 })
      const v = must(store.getState().expenses.find((e) => e.id === row.id))
      expect(v.date).toBe(row.date)
      expect(v.amount).toBe(row.amount + 1)
    }
  })
})

describe('validation (F-049, P2-13)', () => {
  it('rejects bad amounts, budgets and names with a readable message', async () => {
    const { store } = await bootTab()
    const s = store.getState()
    for (const amount of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -3,
      10_000_001,
    ]) {
      expect(() => s.addExpense({ itemName: 'Bad', amount })).toThrow(/Amount must be/)
    }
    expect(() => s.addExpense({ itemName: '   ', amount: 1 })).toThrow(/Item name/)
    expect(() => s.addExpense({ itemName: 'x'.repeat(201), amount: 1 })).toThrow(/Item name/)
    expect(() => s.addCategory('x'.repeat(61))).toThrow(/1 to 60/)
    expect(() => s.addCategory('__proto__')).toThrow(/reserved/)
    expect(() => s.setBudget('Gaming', Number.NaN)).toThrow(/Amount must be/)
    expect(store.getState().expenses).toEqual([])
  })

  it('never throws for a no-op', async () => {
    const { store } = await bootTab()
    const v = store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    const s = store.getState()
    expect(() => {
      s.updateExpense(v.id, { amount: 1.4 })
      s.deleteExpense('no-such-id')
      s.addCategory('Gaming')
      s.removeBudget('Gaming')
      s.clearUndo('nothing')
      s.clearSampleData()
    }).not.toThrow()
    expect(s.consumeUndo('nothing')).toBeNull()
  })
})

describe('prototype keys are plain keys (F-010)', () => {
  it('constructor, __proto__ and toString as item names never crash or leak', async () => {
    const { store } = await bootTab()
    const s = store.getState()
    expect(s.getSmartCategory('constructor')).toBeNull()
    expect(s.getSmartCategory('__proto__')).toBeNull()
    for (const name of ['constructor', '__proto__', 'toString']) {
      s.addExpense({ itemName: name, amount: 2, category: 'Gaming' })
    }
    const v = store.getState()
    expect(v.expenses.map((e) => e.itemName).sort()).toEqual([
      '__proto__',
      'constructor',
      'toString',
    ])
    // a reserved key is never learned, and a lookup never finds Object.prototype
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(Object.hasOwn(v.categoryMappings, name)).toBe(false)
    }
    expect(v.categoryMappings.constructor).toBeUndefined()
    expect(Object.getPrototypeOf(v.categoryMappings)).toBeNull()
    expect(Object.getPrototypeOf(v.budgets)).toBeNull()
    expect(v.budgets.constructor).toBeUndefined()
    expect(v.getSmartCategory('constructor')).toBeNull()
    expect(protoProbe('polluted')).toBeUndefined()
  })

  it('refuses a reserved category or budget key with a readable message', async () => {
    const { store } = await bootTab()
    for (const name of ['constructor', '__proto__', 'toString']) {
      expect(() => {
        store.getState().addCategory(name)
      }).toThrow('That name is reserved. Choose another.')
      expect(() => {
        store.getState().setBudget(name, 25)
      }).toThrow(/no longer exists|reserved/)
    }
    expect({ ...store.getState().budgets }).toEqual({})
  })
})

describe('the smart category', () => {
  it('learns a pick, files the next add by it, and finds near spellings', async () => {
    const { store } = await bootTab()
    store
      .getState()
      .addExpense({ itemName: 'Chicken rice', amount: 4.5, category: 'Food & Dining' })
    const next = store.getState().addExpense({ itemName: 'chicken rice', amount: 5 })
    expect(next.category).toBe('Food & Dining')
    expect(store.getState().getSmartCategory('chiken rice')).toBe('Food & Dining')
  })

  it('never files into a dead category (F-012)', async () => {
    const { store } = await bootTab()
    store.getState().addCategory('Snacks')
    store.getState().addExpense({ itemName: 'Chips', amount: 2, category: 'Snacks' })
    store.getState().renameCategory('Snacks', 'Treats')
    expect(store.getState().getSmartCategory('Chips')).toBe('Treats')
    store.getState().removeCategory('Treats')
    expect(store.getState().getSmartCategory('Chips')).toBe('Other')
    const v = store.getState().addExpense({ itemName: 'Chips', amount: 2 })
    expect(store.getState().categories).toContain(v.category)
  })
})

describe('undo is a guarded forward write (F-011, P2-12)', () => {
  it('uses today’s id scheme and undoes an add, an edit and a delete', async () => {
    const { store } = await bootTab()
    const a = store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    expect(store.getState().undoStack.map((u) => u.id)).toEqual([`add-${a.id}`])
    store.getState().updateExpense(a.id, { amount: 2 })
    const upd = must(store.getState().undoStack.at(-1))
    expect(upd.id).toMatch(new RegExp(`^update-${a.id}-\\d+$`))
    expect(store.getState().consumeUndo(upd.id)).toEqual({ applied: 1, skipped: 0 })
    expect(store.getState().expenses[0]?.amount).toBe(1.4)
    store.getState().deleteExpense(a.id)
    const del = must(store.getState().undoStack.find((u) => u.id.startsWith(`del-${a.id}-`)))
    expect(store.getState().consumeUndo(del.id)).toEqual({ applied: 1, skipped: 0 })
    // the entry comes back under a new id; the old id stays dead, so old clients agree
    expect(store.getState().expenses).toHaveLength(1)
    expect(store.getState().expenses[0]?.id).not.toBe(a.id)
  })

  it('skips what changed since and says so', async () => {
    const { store, mod } = await bootTab()
    const a = store.getState().addExpense({ itemName: 'Kopi', amount: 1.4 })
    store.getState().updateExpense(a.id, { amount: 2 })
    const upd = must(store.getState().undoStack.at(-1))
    store.getState().updateExpense(a.id, { amount: 3 })
    const out = must(store.getState().consumeUndo(upd.id))
    expect(out).toEqual({ applied: 0, skipped: 1 })
    expect(store.getState().expenses[0]?.amount).toBe(3)
    // nothing was undone: it says so, rather than "Undone, except…"
    expect(mod.undoOutcomeMessage(out)).toBe('Nothing to undo: 1 entry changed on another device')
    expect(mod.undoOutcomeMessage({ applied: 2, skipped: 1 })).toBe(
      'Undone, except 1 entry changed on another device',
    )
    expect(mod.undoOutcomeMessage({ applied: 2, skipped: 0 })).toBe('Undone')
  })

  it('expires after 5 s (30 s for delete-all and import) and keeps at most five', async () => {
    const { store } = await bootTab()
    const a = store.getState().addExpense({ itemName: 'One', amount: 1 })
    vi.advanceTimersByTime(5001)
    expect(store.getState().consumeUndo(`add-${a.id}`)).toBeNull()
    for (let i = 0; i < 7; i++)
      store.getState().addExpense({ itemName: `n${String(i)}`, amount: 1 })
    expect(store.getState().undoStack).toHaveLength(5)
    store.getState().deleteAllEverywhere()
    const all = must(store.getState().undoStack.at(-1))
    expect(all.id).toMatch(/^all-/)
    expect(all.expiresAt).toBe(Date.now() + 30_000)
  })
})

describe('delete everywhere vs remove from this device (F-004, §7.8)', () => {
  it('delete all takes a snapshot, tombstones every entry and undoes for 30 s', async () => {
    const { store, backing } = await bootTab({ keys: ownerV4({ rows: 40, noSync: true }).keys })
    const n = store.getState().expenses.length
    store.getState().deleteAllEverywhere()
    await settle()
    expect(store.getState().expenses).toEqual([])
    const snaps = stored(backing, 'st5:snaps')
    expect(JSON.stringify(snaps)).toContain('delete-all')
    vi.advanceTimersByTime(20_000)
    const id = must(store.getState().undoStack.at(-1)).id
    expect(store.getState().consumeUndo(id)).toEqual({ applied: n, skipped: 0 })
    expect(store.getState().expenses).toHaveLength(n)
  })

  it('refuses delete-all when no safety copy can be stored', async () => {
    const backing = new FakeBacking()
    const { store } = await bootTab({ backing, keys: ownerV4({ rows: 20, noSync: true }).keys })
    backing.prefixFailures.set('st5:snap', 'quota')
    expect(() => {
      store.getState().deleteAllEverywhere()
    }).toThrow(/Download a backup first/)
    expect(store.getState().expenses).toHaveLength(20)
  })

  it('remove from this device wipes every SpendTrack key, writes no tombstone and reloads', async () => {
    const f = ownerV4({ rows: 25 })
    const backing = new FakeBacking()
    backing.data.set('someone-else', 'kept')
    const { store } = await bootTab({ backing, keys: f.keys })
    await settle()
    await store.getState().removeDataFromThisDevice()
    // the backup is the dialog's own step, a tap before this one (WebKit drops a download the
    // reload lands on): the wipe itself downloads nothing
    expect(downloads.files).toHaveLength(0)
    expect(reload.calls).toBe(1)
    expect([...backing.data.keys()]).toEqual(['someone-else'])
    // nothing is written after the wipe, not even on the way out
    window.dispatchEvent(new Event('pagehide'))
    expect([...backing.data.keys()]).toEqual(['someone-else'])
  })
})

describe('import: preview, Restore and Replace (F-004, F-047, §7.7)', () => {
  it('previews exact counts; Restore revives deleted rows and never deletes', async () => {
    const { store } = await bootTab()
    const s = store.getState()
    const keep = s.addExpense({ itemName: 'Here only', amount: 3 })
    const gone = s.addExpense({ itemName: 'Deleted here', amount: 4 })
    const file = s.exportBackup()
    s.deleteExpense(gone.id)
    const preview = await store.getState().previewImport(fileOf(file, 'week.json'))
    expect(preview.fileName).toBe('week.json')
    expect(preview.counts).toMatchObject({ inFile: 2, added: 0, restored: 1, alreadyHere: 1 })
    const out = store.getState().applyImport(preview, 'restore')
    expect(out).toMatchObject({ added: 0, restored: 1 })
    expect(
      store
        .getState()
        .expenses.map((e) => e.itemName)
        .sort(),
    ).toEqual(['Deleted here', 'Here only'])
    expect(store.getState().expenses.some((e) => e.id === keep.id)).toBe(true)
    // a second apply of the same preview is a no-op
    expect(store.getState().applyImport(preview, 'restore')).toMatchObject({ applied: 0 })
    const undo = must(store.getState().undoStack.at(-1))
    expect(undo.id).toMatch(/^imp-/)
    expect(undo.expiresAt).toBe(Date.now() + 30_000)
  })

  it('Replace deletes the entries not in the file, after a snapshot, with an Undo', async () => {
    const { store, backing } = await bootTab()
    const s = store.getState()
    s.addExpense({ itemName: 'In file', amount: 3 })
    const file = s.exportBackup()
    s.addExpense({ itemName: 'Not in file', amount: 4 })
    const preview = await store.getState().previewImport(fileOf(file))
    expect(preview.replaceDeletes).toBe(1)
    store.getState().applyImport(preview, 'replace')
    expect(store.getState().expenses.map((e) => e.itemName)).toEqual(['In file'])
    expect(JSON.stringify(stored(backing, 'st5:snaps'))).toContain('replace')
    const undo = must(store.getState().undoStack.at(-1))
    store.getState().consumeUndo(undo.id)
    expect(
      store
        .getState()
        .expenses.map((e) => e.itemName)
        .sort(),
    ).toEqual(['In file', 'Not in file'])
  })

  it('refuses a newer-version file and a file that is not a backup, with readable messages', async () => {
    const { store } = await bootTab()
    const newer = {
      ...store.getState().exportBackup(),
      x5: { schema: 6, minor: 0, min: 6, dig: '', dts: [], ren: {}, mts: {}, pref: {} },
    }
    await expect(store.getState().previewImport(fileOf(newer))).rejects.toThrow(
      'This backup is from a newer SpendTrack.',
    )
    await expect(store.getState().previewImport(fileOf({ hello: 1 }))).rejects.toThrow(
      /isn't a SpendTrack backup/,
    )
    await expect(store.getState().previewImport(new File(['{not json'], 'x.json'))).rejects.toThrow(
      /isn't a SpendTrack backup/,
    )
  })

  it('reads a raw browser export (lib/rescue) through its v4 keys', async () => {
    const f = ownerV4({ rows: 12, tombstones: 0 })
    const { store } = await bootTab()
    const raw = { app: 'SpendTrack', kind: 'raw-browser-backup', version: 1, keys: f.keys }
    const preview = await store.getState().previewImport(fileOf(raw))
    expect(preview.counts.added).toBe(12)
  })

  it('takes the auditors’ poison files without crashing: bad rows unreadable, the rest restored (F-005)', async () => {
    const { store } = await bootTab()
    for (const [name, payload] of [...Object.entries(T2), ...Object.entries(B3)]) {
      const preview = await store.getState().previewImport(fileOf(payload, `${name}.json`))
      expect(preview.counts.inFile + preview.counts.unreadable).toBeGreaterThan(0)
      store.getState().applyImport(preview, 'restore')
    }
    expect(protoProbe('polluted')).toBeUndefined()
    expect(protoProbe('polluted2')).toBeUndefined()
    for (const e of store.getState().expenses) {
      expect(Number.isFinite(e.amount) && e.amount > 0 && e.amount <= 10_000_000).toBe(true)
    }
  })

  it('keeps both copies of a duplicated id, and deleting one leaves the other (F-047)', async () => {
    const { store } = await bootTab()
    const preview = await store.getState().previewImport(fileOf(B3['duplicate-ids']))
    store.getState().applyImport(preview, 'restore')
    const rows = store.getState().expenses.filter((e) => e.itemName.startsWith('Lunch'))
    expect(rows).toHaveLength(2)
    store.getState().deleteExpense(must(rows[0]).id)
    const left = store.getState().expenses.filter((e) => e.itemName.startsWith('Lunch'))
    expect(left.map((e) => e.id)).toEqual([must(rows[1]).id])
  })
})

describe('categories are sync-safe (F-012)', () => {
  it('rename, merge and remove never double a budget and keep every row in a live category', async () => {
    const { store } = await bootTab()
    const s = store.getState()
    s.addCategory('Snacks')
    s.addCategory('Treats')
    s.setBudget('Snacks', 50)
    s.setBudget('Treats', 30)
    s.addExpense({ itemName: 'Chips', amount: 2, category: 'Snacks' })
    s.renameCategory('Snacks', 'Treats')
    const v = store.getState()
    expect(v.categories).not.toContain('Snacks')
    expect(v.expenses[0]?.category).toBe('Treats')
    expect(v.budgets.Treats).toBe(30)
    expect(Object.values(v.budgets).reduce((a, b) => a + b, 0)).toBe(30)
    v.removeCategory('Treats')
    const w = store.getState()
    expect(w.expenses[0]?.category).toBe('Other')
    expect(w.budgets.Treats).toBeUndefined()
    expect(w.categories).toContain('Other')
    const undo = must(w.undoStack.at(-1))
    expect(undo.id).toMatch(/^cat-/)
    w.consumeUndo(undo.id)
    expect(store.getState().expenses[0]?.category).toBe('Treats')
  })
})

describe('the sync port', () => {
  it('a no-op merge of our own doc notifies no one and writes nothing (F-002)', async () => {
    const { store, mod, backing } = await bootTab({ keys: ownerV4({ rows: 30 }).keys })
    await settle()
    const port = must(mod.getSyncPort())
    const dec = decodeWire(JSON.parse(JSON.stringify(store.getState().exportBackup())), 'remote', {
      reuse: port.doc(),
    })
    await settle()
    const spy = vi.fn()
    const off = store.subscribe(spy)
    backing.resetCounts()
    const out = port.applyRemote(dec)
    expect(out).toEqual({ changedLocal: false, removed: 0, mass: null, quarantined: 0 })
    await settle()
    expect(spy).not.toHaveBeenCalled()
    expect(backing.setsOf('st5:db')).toBe(0)
    off()
  })

  it('a remote mass removal is snapshotted, applied, journaled and undone by restoreJournal (P2-20)', async () => {
    const { store, mod, backing } = await bootTab({ keys: ownerV4({ rows: 60 }).keys })
    const port = must(mod.getSyncPort())
    const ids = store.getState().expenses.map((e) => e.id)
    const local = store.getState().exportBackup()
    const remote = {
      ...local,
      expenses: [],
      deletedIds: [...local.deletedIds, ...ids],
      x5: undefined,
    }
    const out = port.applyRemote(decodeWire(remote, 'remote', { at: Date.now() }))
    expect(out.removed).toBe(60)
    const mass = must(out.mass)
    expect(mass.count).toBe(60)
    expect(store.getState().expenses).toEqual([])
    expect(JSON.stringify(stored(backing, 'st5:snaps'))).toContain('mass')
    expect(JSON.stringify(stored(backing, 'st5:journal'))).toContain('"kind":"mass"')
    await expect(store.getState().restoreJournal(mass.entryId)).resolves.toEqual({
      applied: 60,
      skipped: 0,
    })
    expect(store.getState().expenses).toHaveLength(60)
  })

  it('a removal below the guard is applied quietly (no snapshot, no mass entry)', async () => {
    const { store, mod } = await bootTab({ keys: ownerV4({ rows: 200, tombstones: 0 }).keys })
    const port = must(mod.getSyncPort())
    const ids = store
      .getState()
      .expenses.slice(0, 9)
      .map((e) => e.id)
    const local = store.getState().exportBackup()
    const remote = {
      ...local,
      expenses: local.expenses.filter((e) => !ids.includes(String(e.id))),
      deletedIds: [...local.deletedIds, ...ids],
    }
    const out = port.applyRemote(decodeWire(remote, 'remote', { at: Date.now() }))
    expect(out).toMatchObject({ changedLocal: true, removed: 9, mass: null })
    expect(store.getState().expenses).toHaveLength(191)
  })

  it('a pending outbox survives a reload (the bridge syncs it at boot)', async () => {
    const f = ownerV4({ rows: 5, tombstones: 0 })
    const a = await bootTab({ keys: f.keys })
    const port = must(a.mod.getSyncPort())
    port.ack([...port.outbox()], decodeWire(null, 'remote'), 'pushed')
    const v = a.store.getState().addExpense({ itemName: 'Offline add', amount: 3 })
    await settle()
    const b = await bootTab({ backing: a.backing })
    expect([...must(b.mod.getSyncPort()).outbox().keys()]).toContain(`ex:${v.id}`)
  })

  it('quarantines a poisoned relay copy instead of crashing (F-005, T3)', async () => {
    const { store, mod } = await bootTab()
    const port = must(mod.getSyncPort())
    for (const payload of Object.values(T3)) {
      const dec = decodeWire(payload, 'remote', { at: Date.now() })
      if (dec.writer === 'v084' || dec.writer === 'v085' || dec.writer === 'v5')
        port.applyRemote(dec)
      else port.quarantine(dec.report.quarantined)
    }
    for (const e of store.getState().expenses) expect(e.amount).toBeLessThanOrEqual(10_000_000)
    expect(store.getState().attention.quarantined).toBeGreaterThan(0)
  })

  it('outbox, ack, meta and localRev behave as the bridge expects', async () => {
    const { store, mod } = await bootTab({ keys: ownerV4({ rows: 3, tombstones: 0 }).keys })
    const port = must(mod.getSyncPort())
    const rev = port.localRev()
    store.getState().addExpense({ itemName: 'Pending', amount: 1 })
    expect(port.localRev()).toBe(rev + 1)
    const sent = [...port.outbox()]
    expect(sent.length).toBeGreaterThan(0)
    const dec = decodeWire(null, 'remote')
    expect(port.ack(sent, dec, 'pushed')).toBe(0)
    expect(port.outbox().size).toBe(0)
    port.setMeta({ lastRev: 'abc', repairAt: 5 })
    expect(port.meta()).toMatchObject({ lastRev: 'abc', repairAt: 5 })
    expect(port.deviceId()).toMatch(/^[0-9a-z]{6}$/)
    expect(port.omitIds()).toBeUndefined()
  })

  it('emits onCommit with the source of each commit', async () => {
    const { store, mod } = await bootTab()
    const port = must(mod.getSyncPort())
    const seen: string[] = []
    const off = port.onCommit((s) => seen.push(s))
    store.getState().addExpense({ itemName: 'x', amount: 1 })
    off()
    store.getState().addExpense({ itemName: 'y', amount: 1 })
    expect(seen).toEqual(['local'])
  })
})

describe('views are identity-stable', () => {
  it('an add keeps every other ExpenseView object and the unchanged collections', async () => {
    const { store } = await bootTab({ keys: ownerV4({ rows: 50, noSync: true }).keys })
    const before = store.getState()
    store.getState().addExpense({ itemName: 'New', amount: 1, category: 'Gaming' })
    const after = store.getState()
    const old = new Map(before.expenses.map((e) => [e.id, e]))
    for (const e of after.expenses) if (old.has(e.id)) expect(e).toBe(old.get(e.id))
    expect(after.budgets).toBe(before.budgets)
  })
})

describe('demo builds (F-027, P2-22)', () => {
  it('seed once, keep sample rows off the mirror, and Clear sample data removes them for good', async () => {
    vi.stubEnv('VITE_DEMO_MODE', 'true')
    const a = await bootTab({ install: true })
    expect(a.store.getState().demo).toBe('sample')
    expect(a.store.getState().expenses.length).toBeGreaterThan(20)
    expect(a.backing.data.get('st5:demo')).toBe('seeded')
    a.store.getState().addExpense({ itemName: 'Mine', amount: 2 })
    window.dispatchEvent(new Event('pagehide'))
    expect(String(a.backing.data.get('expenses'))).not.toContain('demo-')
    expect(String(a.backing.data.get('expenses'))).toContain('Mine')
    const port = must(a.mod.getSyncPort())
    expect(port.omitIds()?.('demo-1')).toBe(true)
    expect(port.omitIds()?.('mine')).toBe(false)
    a.store.getState().clearSampleData()
    expect(a.store.getState().demo).toBe('none')
    expect(a.store.getState().expenses.map((e) => e.itemName)).toEqual(['Mine'])
    expect(a.backing.data.get('st5:demo')).toBe('dismissed')
    const b = await bootTab({ backing: a.backing })
    expect(b.store.getState().expenses.map((e) => e.itemName)).toEqual(['Mine'])
  })

  it('on a non-demo build, demo-* rows are ordinary data', async () => {
    const f = ownerV4({ rows: 2, tombstones: 0, noSync: true })
    const rows = [...f.rows, { ...f.rows[0], id: 'demo-7', itemName: 'Kept' }]
    const { store } = await bootTab({ keys: { ...f.keys, expenses: JSON.stringify(rows) } })
    expect(store.getState().demo).toBe('none')
    expect(store.getState().expenses.some((e) => e.id === 'demo-7')).toBe(true)
  })
})

describe('durable storage facts (F-050)', () => {
  it('asks for persistence once after the first data, and an export records the backup', async () => {
    const persist = vi.fn(() => Promise.resolve(true))
    const persisted = vi.fn(() => Promise.resolve(true))
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist, persisted },
    })
    try {
      const { store, backing } = await bootTab()
      expect(persist).not.toHaveBeenCalled()
      store.getState().addExpense({ itemName: 'First', amount: 1 })
      await settle()
      expect(persist).toHaveBeenCalledTimes(1)
      expect(store.getState().facts.persisted).toBe(true)
      store.getState().addExpense({ itemName: 'Second', amount: 1 })
      await bootTab({ backing })
      expect(persist).toHaveBeenCalledTimes(1)
      expect(store.getState().facts.lastBackupAt).toBeNull()
      // the file alone is no backup yet: a download that fails after it must not read as one
      store.getState().exportBackup()
      expect(store.getState().facts.lastBackupAt).toBeNull()
      store.getState().markBackedUp()
      expect(store.getState().facts.lastBackupAt).toBe(T0)
      expect(store.getState().facts.mirror).toBe('on')
    } finally {
      Reflect.deleteProperty(navigator, 'storage')
    }
  })
})

describe('currency is a synced register (P2-11)', () => {
  it('a pick writes the register and the device key and shows in the UI store', async () => {
    const { store, backing } = await bootTab()
    const { useUIStore } = await import('../useUIStore')
    useUIStore.getState().setCurrency('JPY')
    expect(useUIStore.getState().currency).toBe('JPY')
    expect(backing.data.get('spendtrack:currency')).toBe('JPY')
    await settle()
    expect(JSON.stringify(store.getState().exportBackup())).toContain('JPY')
    expect(() => {
      store.getState().setCurrency('nope')
    }).toThrow(/3-letter/)
  })

  it('a device that never picked keeps its own until a synced pick arrives', async () => {
    const { mod } = await bootTab({ keys: { 'spendtrack:currency': 'MYR' } })
    const { useUIStore } = await import('../useUIStore')
    expect(useUIStore.getState().currency).toBe('MYR')
    const port = must(mod.getSyncPort())
    const other = await bootTab({ backing: new FakeBacking() })
    other.store.getState().setCurrency('EUR')
    const wire = other.store.getState().exportBackup()
    const { useUIStore: ui2 } = await import('../useUIStore')
    expect(ui2.getState().currency).toBe('EUR')
    port.applyRemote(decodeWire(JSON.parse(JSON.stringify(wire)), 'remote'))
    expect(useUIStore.getState().currency).toBe('EUR')
  })
})
