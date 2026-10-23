// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DAY, T0, docOf } from '../__tests__/support/gen'
import { must, parseJson, protoProbe } from '../__tests__/support/must'
import { makeRng } from '../__tests__/support/rng'
import { budgetView, displayList, mappingLookup, totalBudget } from './categories'
import { dayOf, localNoonIso, todayDay } from './dates'
import { EMPTY_DOC, mergeDoc } from './doc'
import {
  OpError,
  addCategory,
  addExpense,
  deleteAllEverywhere,
  deleteExpenses,
  removeBudget,
  removeCategory,
  renameCategory,
  setBudget,
  setCurrency,
  updateExpense,
} from './ops'
import { maxStampRec } from './record'
import type { Doc, Hlc, OpCtx, OpResult } from './types'
import { decodeWire, fromV4Keys, wireString } from './wire'

const mk = (wall = T0, clock: Hlc = { last: 0 }, seed = 1, demoBuild = false): OpCtx => ({
  wall,
  clock,
  dev: 'dev-a',
  rng: makeRng(seed).next,
  demoBuild,
})

function addOne(
  doc: Doc = EMPTY_DOC,
  ctx: OpCtx = mk(),
  name = 'chicken rice',
  amount = 4.5,
  category?: string,
): Doc {
  return addExpense(doc, ctx, {
    itemName: name,
    amount,
    ...(category === undefined ? {} : { category }),
  }).doc
}

const code = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof OpError) return e.code
    throw e
  }
  return 'no-throw'
}

describe('addExpense (§7.1, T-049-1, T-096-1 core half)', () => {
  it('validates name, amount, category, day and notes with OpError codes', () => {
    const add = (input: Parameters<typeof addExpense>[2]): string =>
      code(() => addExpense(EMPTY_DOC, mk(), input))
    for (const amount of [NaN, Infinity, -Infinity, 0, -1, 1e7 + 1, 1e9]) {
      expect(add({ itemName: 'x', amount }), String(amount)).toBe('amount')
    }
    expect(add({ itemName: 'x', amount: 1e7 })).toBe('no-throw')
    expect(add({ itemName: '  ', amount: 1 })).toBe('name')
    expect(add({ itemName: 'x'.repeat(201), amount: 1 })).toBe('name')
    expect(add({ itemName: 'x', amount: 1, category: 'constructor' })).toBe('reserved')
    expect(add({ itemName: 'x', amount: 1, category: ' ' })).toBe('category')
    expect(add({ itemName: 'x', amount: 1, category: 'x'.repeat(61) })).toBe('category')
    expect(add({ itemName: 'x', amount: 1, day: '2026-02-30' })).toBe('day')
    expect(add({ itemName: 'x', amount: 1, day: '18/10/2026' })).toBe('day')
    expect(add({ itemName: 'x', amount: 1, notes: 'n'.repeat(501) })).toBe('notes')
    expect(new OpError('amount', 'm')).toBeInstanceOf(Error)
  })

  it('a quick add without a day stores today and local noon (byte-identical T12:00:00 form)', () => {
    const wall = new Date(2026, 9, 18, 21, 40, 20).getTime()
    const r = addExpense(EMPTY_DOC, mk(wall), { itemName: 'novena clinic', amount: 25 })
    const rec = must(r.created)
    expect(rec.d.v.day).toBe(todayDay(wall))
    expect(rec.d.v.day).toBe('2026-10-18')
    expect(rec.d.v.date).toBe(localNoonIso('2026-10-18'))
    expect(rec.d.v.date).toBe(new Date('2026-10-18T12:00:00').toISOString())
    expect(r.touched).toContainEqual([`ex:${rec.id}`, rec.C])
    expect(r.undo?.label).toBe('Added "novena clinic"')
    expect(r.undo?.expiresAt).toBe(wall + 5000)
  })

  it('defaults the category through an exact live mapping, else Other; lists a new name; learns the mapping', () => {
    const c: Hlc = { last: 0 }
    let d = addExpense(EMPTY_DOC, mk(T0, c), {
      itemName: 'Kopi O',
      amount: 1.8,
      category: 'Drinks',
    }).doc
    expect(d.categories).toContain('Drinks')
    expect(mappingLookup(d, 'kopi o')).toBe('Drinks')
    const second = addExpense(d, mk(T0 + 1, c, 2), { itemName: ' KOPI O ', amount: 1.8 })
    expect(must(second.created).c.v).toBe('Drinks')
    expect(second.touched.some(([k]) => k.startsWith('map:'))).toBe(false)
    d = renameCategory(second.doc, mk(T0 + 2, c), 'Drinks', 'Beverages').doc
    expect(
      must(addExpense(d, mk(T0 + 3, c, 3), { itemName: 'kopi o', amount: 2 }).created).c.v,
    ).toBe('Beverages')
    expect(
      must(addExpense(d, mk(T0 + 3, c, 3), { itemName: 'never seen', amount: 2 }).created).c.v,
    ).toBe('Other')
    // a stale category name from an old UI list files into the live name
    expect(
      must(
        addExpense(d, mk(T0 + 4, c, 4), { itemName: 'x', amount: 2, category: 'Drinks' }).created,
      ).c.v,
    ).toBe('Beverages')
  })

  it('two identical adds create two records with distinct ids (double submit is the UI’s job)', () => {
    const c: Hlc = { last: 0 }
    const a = addOne(EMPTY_DOC, mk(T0, c, 7))
    const b = addOne(a, mk(T0, c, 8))
    expect(b.expenses.size).toBe(2)
  })

  it('prototype words are plain data everywhere (T-010-1 core half)', () => {
    const c: Hlc = { last: 0 }
    let d: Doc = EMPTY_DOC
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      d = addExpense(d, mk(T0, c, name.length), {
        itemName: name,
        amount: 5,
        notes: name,
        category: 'Food',
      }).doc
    }
    expect(d.expenses.size).toBe(4)
    expect(mappingLookup(d, 'constructor')).toBeNull()
    expect(displayList(d)).toEqual(['Food', 'Other'])
    expect(code(() => addCategory(d, mk(T0, c), '__proto__'))).toBe('reserved')
    expect(code(() => renameCategory(d, mk(T0, c), 'Food', 'toString'))).toBe('reserved')
    expect(code(() => setBudget(d, mk(T0, c), 'constructor', 5))).toBe('not-found')
    expect(protoProbe('polluted')).toBeUndefined()
  })
})

describe('the stored instant of a day stays inside 1970–2099 in every zone (§7.10, §8.1)', () => {
  /** Runs `f` with the process time zone switched to `zone` (Node re-reads TZ when it is set). */
  function inZone(zone: string, f: () => void): void {
    const proc: unknown = Reflect.get(globalThis, 'process')
    const env: unknown =
      typeof proc === 'object' && proc !== null ? Reflect.get(proc, 'env') : undefined
    if (typeof env !== 'object' || env === null) throw new Error('needs the Node test process')
    const was: unknown = Reflect.get(env, 'TZ')
    Reflect.set(env, 'TZ', zone)
    try {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone)
      f()
    } finally {
      if (typeof was === 'string') Reflect.set(env, 'TZ', was)
      else Reflect.deleteProperty(env, 'TZ')
    }
  }

  const EDGES = ['1970-01-01', '1970-01-02', '2099-12-30', '2099-12-31']

  /** Each edge day is refused (OpError 'day') or stored readable: never quarantined later. */
  function refusedEdges(): string[] {
    const refused: string[] = []
    for (const day of EDGES) {
      let r: OpResult
      try {
        r = addExpense(EMPTY_DOC, mk(), { itemName: 'old receipt', amount: 30, day })
      } catch (e) {
        expect(e instanceof OpError ? e.code : e).toBe('day')
        refused.push(day)
        continue
      }
      const back = decodeWire(parseJson(wireString(r.doc)), 'remote')
      expect(back.report.quarantined, day).toEqual([])
      expect(back.doc.expenses.size, day).toBe(1)
    }
    return refused
  }

  it('in the process zone: a day at the edge is refused or round-trips readable', () => {
    expect(refusedEdges().length).toBeLessThanOrEqual(2)
  })

  it('in the zones farthest from UTC: exactly the days whose local noon leaves the window', () => {
    inZone('Etc/GMT+12', () => {
      expect(localNoonIso('2099-12-31')).toBe('2100-01-01T00:00:00.000Z')
      expect(refusedEdges()).toEqual(['2099-12-31'])
    })
    inZone('Pacific/Tongatapu', () => {
      expect(localNoonIso('1970-01-01').startsWith('1969-12-31')).toBe(true)
      expect(refusedEdges()).toEqual(['1970-01-01'])
    })
    inZone('Pacific/Kiritimati', () => {
      expect(refusedEdges()).toEqual([])
    })
  })

  it('a device clock outside the window cannot add a record for "today" (it would be unreadable)', () => {
    const wall = Date.UTC(1969, 11, 30, 12)
    expect(code(() => addExpense(EMPTY_DOC, mk(wall), { itemName: 'kopi', amount: 1 }))).toBe('day')
    // with a day picked, the add works (stamps are clamped into the window)
    const r = addExpense(EMPTY_DOC, mk(wall), { itemName: 'kopi', amount: 1, day: '2026-10-19' })
    expect(must(r.created).d.v.day).toBe('2026-10-19')
  })
})

describe('updateExpense', () => {
  it('stamps only changed fields; a no-op returns the same doc and no stamp', () => {
    const c: Hlc = { last: 0 }
    const d = addOne(EMPTY_DOC, mk(T0, c))
    const id = must([...d.expenses.keys()][0])
    const same = updateExpense(d, mk(T0 + 5, c), id, { amount: 4.5, itemName: 'chicken rice' })
    expect(same.doc).toBe(d)
    expect(same.touched).toEqual([])
    expect(c.last).toBe(T0)
    const r = updateExpense(d, mk(T0 + 5, c), id, { amount: 45, notes: '' })
    const rec = must(r.doc.expenses.get(id))
    expect(rec.a).toEqual({ v: 45, s: T0 + 5, r: 2 })
    expect(rec.o.s).toBe(T0) // '' on an empty note is no change
    expect(r.undo?.items).toEqual([
      { k: 'edit', id, fields: [{ f: 'a', prev: must(d.expenses.get(id)).a, wrote: T0 + 5 }] },
    ])
    expect(r.undo?.label).toBe('Updated expense')
  })

  it('validates the patch and rejects unknown ids', () => {
    const d = addOne()
    const id = must([...d.expenses.keys()][0])
    for (const amount of [NaN, Infinity, -Infinity, 0, -3, 1e7 + 1]) {
      expect(code(() => updateExpense(d, mk(), id, { amount }))).toBe('amount')
    }
    expect(code(() => updateExpense(d, mk(), id, { day: 'yesterday' }))).toBe('day')
    expect(code(() => updateExpense(d, mk(), 'nope', { amount: 1 }))).toBe('not-found')
    expect(code(() => updateExpense(d, mk(), id, { category: '__proto__' }))).toBe('reserved')
  })

  it('a day-preserving edit keeps the time; a moved day writes local noon of the new day', () => {
    const c: Hlc = { last: 0 }
    const d = addOne(EMPTY_DOC, mk(T0, c))
    const id = must([...d.expenses.keys()][0])
    const rec = must(d.expenses.get(id))
    expect(updateExpense(d, mk(T0 + 1, c), id, { day: must(rec.d.v.day) }).doc).toBe(d)
    const moved = must(
      updateExpense(d, mk(T0 + 1, c), id, { day: '2026-01-31' }).doc.expenses.get(id),
    )
    expect(moved.d.v).toEqual({ date: localNoonIso('2026-01-31'), day: '2026-01-31' })
  })

  it('a longer v0.8 name, category or note sent back unchanged never blocks an edit of another field', () => {
    const item = `Receipt ${'line '.repeat(60)}`.trim()
    const note = 'n'.repeat(900)
    const long = 'Presents for the family at Chinese New Year and birthdays (2026)'
    const d = decodeWire(
      fromV4Keys({
        expenses: [
          {
            id: 'e1',
            itemName: item,
            amount: 5,
            category: long,
            notes: note,
            date: '2026-10-18T04:00:00.000Z',
            createdAt: '2026-10-18T04:00:00.000Z',
          },
        ],
        categories: [long],
      }),
      'local-v4',
    ).doc
    const rec = must(d.expenses.get('e1'))
    const r = updateExpense(d, mk(T0), 'e1', {
      itemName: item,
      amount: 6,
      category: long,
      day: dayOf(rec),
      notes: note,
    })
    const after = must(r.doc.expenses.get('e1'))
    expect([after.n.v, after.a.v, after.c.v, after.o.v]).toEqual([item, 6, long, note])
    expect(r.touched).toEqual([['ex:e1', after.a.s]])
    // new over-long input is still refused
    expect(code(() => updateExpense(d, mk(), 'e1', { itemName: 'y'.repeat(201) }))).toBe('name')
    expect(code(() => updateExpense(d, mk(), 'e1', { notes: 'y'.repeat(501) }))).toBe('notes')
  })

  it('a category patch naming a renamed-away name is written resolved (§7.1)', () => {
    const c: Hlc = { last: 0 }
    let d = addOne(EMPTY_DOC, mk(T0, c), 'kopi', 1.8, 'Food')
    const id = must([...d.expenses.keys()][0])
    d = renameCategory(d, mk(T0 + 1, c), 'Food', 'Meals').doc
    d = updateExpense(d, mk(T0 + 2, c), id, { category: 'Drinks' }).doc
    const r = updateExpense(d, mk(T0 + 3, c), id, { category: 'Food' })
    const rec = must(r.doc.expenses.get(id))
    expect([rec.c.v, rec.c.r]).toEqual(['Meals', 2])
    // the dead name is not listed again
    expect(r.doc.categories).toBe(d.categories)
    expect(r.touched).toEqual([[`ex:${id}`, rec.c.s]])
  })
})

describe('deleteExpenses / deleteAllEverywhere (§7.1, §7.3, P-9)', () => {
  it('tombstones live ids at one tick; unknown ids are skipped; nothing to do → same doc', () => {
    const c: Hlc = { last: 0 }
    let d = addOne(EMPTY_DOC, mk(T0, c, 1))
    d = addOne(d, mk(T0 + 1, c, 2), 'grab', 12)
    const ids = [...d.expenses.keys()]
    const r = deleteExpenses(d, mk(T0 + 10, c), [...ids, 'ghost'])
    expect(r.doc.expenses.size).toBe(0)
    expect([...r.doc.tombs.values()]).toEqual([T0 + 10, T0 + 10])
    expect(r.touched.map(([k]) => k).sort()).toEqual(ids.map((id) => `del:${id}`).sort())
    expect(r.undo?.label).toBe('Deleted 2 entries')
    expect(deleteExpenses(d, mk(), ['ghost']).doc).toBe(d)
    expect(deleteAllEverywhere(d, mk(T0 + 20, c)).doc.expenses.size).toBe(0)
    expect(deleteAllEverywhere(EMPTY_DOC, mk()).doc).toBe(EMPTY_DOC)
  })

  it('demo rows on a demo build are hard-deleted (no tombstone); elsewhere they are ordinary data', () => {
    const c: Hlc = { last: 0 }
    const base = addOne(EMPTY_DOC, mk(T0, c, 3))
    const real = must([...base.expenses.values()][0])
    const demo = { ...real, id: 'demo-1' }
    const d = docOf({ expenses: [real, demo] })
    const demoBuild = deleteAllEverywhere(d, mk(T0 + 1, c, 1, true))
    expect(demoBuild.doc.tombs.has('demo-1')).toBe(false)
    expect(demoBuild.doc.tombs.has(real.id)).toBe(true)
    expect(demoBuild.touched.map(([k]) => k)).toEqual([`del:${real.id}`])
    const normal = deleteExpenses(d, mk(T0 + 1, c), ['demo-1'])
    expect(normal.doc.tombs.has('demo-1')).toBe(true)
  })
})

describe('categories (§7.4, T-012-1..4)', () => {
  it('rename: never re-stamps rows, writes no budget, lists the target; Other is locked', () => {
    const c: Hlc = { last: 0 }
    let d = addOne(EMPTY_DOC, mk(T0, c), 'chicken rice', 4.5, 'Food')
    d = setBudget(d, mk(T0 + 1, c), 'Food', 300).doc
    const before = must([...d.expenses.values()][0])
    const r = renameCategory(d, mk(T0 + DAY, c), 'Food', 'Meals')
    const after = must(r.doc.expenses.get(before.id))
    expect(after.c).toEqual({ v: 'Meals', s: before.c.s, r: before.c.r })
    expect(maxStampRec(after)).toBe(maxStampRec(before))
    expect(r.doc.budgets).toBe(d.budgets)
    expect(displayList(r.doc)).toEqual(['Meals', 'Other'])
    expect({ ...budgetView(r.doc) }).toEqual({ Meals: 300 })
    expect(r.touched.map(([k]) => k).sort()).toEqual(['cat:Meals', 'ren:Food', 'ren:Meals'])
    expect(code(() => renameCategory(d, mk(), 'Other', 'X'))).toBe('other-locked')
    expect(code(() => removeCategory(d, mk(), 'Other'))).toBe('other-locked')
    expect(code(() => renameCategory(d, mk(), 'Food', 'Food'))).toBe('same-name')
    expect(code(() => renameCategory(d, mk(), 'Nope', 'X'))).toBe('not-found')
  })

  it('merge-into an existing name never doubles budgets (T-012-3)', () => {
    const c: Hlc = { last: 0 }
    let d = addOne(EMPTY_DOC, mk(T0, c, 1), 'a', 1, 'Food')
    d = addOne(d, mk(T0 + 1, c, 2), 'b', 1, 'Meals')
    d = setBudget(d, mk(T0 + 2, c), 'Food', 300).doc
    d = setBudget(d, mk(T0 + 3, c), 'Meals', 200).doc
    expect(totalBudget(d)).toBe(500)
    const merged = renameCategory(d, mk(T0 + 4, c), 'Food', 'Meals')
    expect({ ...budgetView(merged.doc) }).toEqual({ Meals: 200 })
    expect(totalBudget(merged.doc)).toBe(200)
    expect(merged.undo?.items[0]?.k).toBe('recat')
  })

  it('remove = rename to Other plus a budget delete; a stale mapping then files into Other (T-012-4)', () => {
    const c: Hlc = { last: 0 }
    let d = addOne(EMPTY_DOC, mk(T0, c), 'gym pass', 30, 'Gym')
    d = setBudget(d, mk(T0 + 1, c), 'Gym', 50).doc
    const r = removeCategory(d, mk(T0 + 2, c), 'Gym')
    expect(displayList(r.doc)).toEqual(['Other'])
    expect({ ...budgetView(r.doc) }).toEqual({})
    expect(mappingLookup(r.doc, 'gym pass')).toBe('Other')
    expect(
      must(addExpense(r.doc, mk(T0 + 3, c, 9), { itemName: 'gym pass', amount: 30 }).created).c.v,
    ).toBe('Other')
  })

  it('a NEW category name is capped at 60; a longer v0.8 name already here stays usable', () => {
    const long = 'Presents for the family at Chinese New Year and birthdays (2026)'
    const c: Hlc = { last: 0 }
    expect(code(() => addCategory(EMPTY_DOC, mk(), long))).toBe('category')
    expect(
      code(() => addExpense(EMPTY_DOC, mk(), { itemName: 'x', amount: 1, category: long })),
    ).toBe('category')
    let d = decodeWire(
      fromV4Keys({
        expenses: [
          {
            id: 'g1',
            itemName: 'Gift',
            amount: 30,
            category: long,
            date: '2026-10-18T04:00:00.000Z',
            createdAt: '2026-10-18T04:00:00.000Z',
          },
        ],
        categories: [long],
      }),
      'local-v4',
    ).doc
    expect(addCategory(d, mk(), long).doc).toBe(d)
    const added = addExpense(d, mk(T0, c, 2), { itemName: 'Angpao', amount: 88, category: long })
    expect(must(added.created).c.v).toBe(long)
    d = addOne(added.doc, mk(T0 + 1, c, 3), 'cake', 20, 'Food')
    d = setBudget(d, mk(T0 + 2, c), long, 150).doc
    const merged = renameCategory(d, mk(T0 + 3, c), 'Food', long)
    expect(displayList(merged.doc)).toEqual([long, 'Other'])
    expect({ ...budgetView(merged.doc) }).toEqual({ [long]: 150 })
  })

  it('re-adding a name in the middle of a rename chain never doubles a budget (acceptance 13)', () => {
    const c: Hlc = { last: 0 }
    let d = addCategory(EMPTY_DOC, mk(T0, c), 'Snacks').doc
    d = setBudget(d, mk(T0 + 1, c), 'Snacks', 300).doc
    d = addOne(d, mk(T0 + 2, c, 3), 'chips', 3, 'Snacks')
    d = renameCategory(d, mk(T0 + 3, c), 'Snacks', 'Treats').doc
    d = renameCategory(d, mk(T0 + 4, c), 'Treats', 'Food').doc
    expect({ ...budgetView(d) }).toEqual({ Food: 300 })
    const r = addCategory(d, mk(T0 + 5, c), 'Treats')
    expect(displayList(r.doc)).toEqual(['Treats', 'Food', 'Other'])
    // the budget stays where it showed; the re-added name starts with none
    expect({ ...budgetView(r.doc) }).toEqual({ Food: 300 })
    expect(totalBudget(r.doc)).toBe(300)
    // a device that has not seen the re-add merges to the same single budget, both ways
    expect(totalBudget(mergeDoc(r.doc, d).doc)).toBe(300)
    expect(totalBudget(mergeDoc(d, r.doc).doc)).toBe(300)
    // a target with its own budget keeps it; a shadowed upstream budget does not resurface
    const own = setBudget(d, mk(T0 + 6, c), 'Food', 500).doc
    const again = addCategory(own, mk(T0 + 7, c), 'Treats')
    expect({ ...budgetView(again.doc) }).toEqual({ Food: 500 })
    expect(totalBudget(again.doc)).toBe(500)
  })

  it('re-add of a renamed-away name: its budget moves forward explicitly, rows stay put (§7.4)', () => {
    const c: Hlc = { last: 0 }
    let d = addOne(EMPTY_DOC, mk(T0, c), 'kopi', 2, 'Food')
    d = setBudget(d, mk(T0 + 1, c), 'Food', 300).doc
    d = renameCategory(d, mk(T0 + 2, c), 'Food', 'Meals').doc
    expect({ ...budgetView(d) }).toEqual({ Meals: 300 })
    const r = addCategory(d, mk(T0 + 3, c), 'Food')
    expect(displayList(r.doc)).toEqual(['Food', 'Meals', 'Other'])
    expect({ ...budgetView(r.doc) }).toEqual({ Meals: 300 })
    expect(must([...r.doc.expenses.values()][0]).c.v).toBe('Meals')
    // a later row filed under the old name shows under it
    const later = addExpense(r.doc, mk(T0 + 4, c, 5), {
      itemName: 'x',
      amount: 1,
      category: 'Food',
    })
    expect(must(later.created).c.v).toBe('Food')
    // listing a live listed name again is a no-op
    expect(addCategory(r.doc, mk(), 'Food').doc).toBe(r.doc)
  })
})

describe('budgets and currency (§7.5, §7.12)', () => {
  it('setBudget validates and writes above max(set, del); removeBudget hides every source', () => {
    const c: Hlc = { last: 0 }
    const d = addOne(EMPTY_DOC, mk(T0, c), 'a', 1, 'Food')
    for (const v of [NaN, Infinity, -Infinity, 0, -5, 1e7 + 1])
      expect(code(() => setBudget(d, mk(), 'Food', v))).toBe('budget')
    expect(code(() => setBudget(d, mk(), 'Ghost', 5))).toBe('not-found')
    const s = setBudget(d, mk(T0 + 1, c), 'Food', 300)
    expect(must(s.doc.budgets.get('Food'))).toEqual({ value: 300, set: T0 + 2, del: 0 }) // the add also ticked a mapping stamp
    expect(setBudget(s.doc, mk(T0 + 2, c), 'Food', 300).doc).toBe(s.doc)
    const rm = removeBudget(s.doc, mk(T0 + 3, c), 'Food')
    expect({ ...budgetView(rm.doc) }).toEqual({})
    expect(removeBudget(rm.doc, mk(), 'Food').doc).toBe(rm.doc)
  })

  it('setCurrency writes the synced register; bad codes are rejected', () => {
    const c: Hlc = { last: 0 }
    const r = setCurrency(EMPTY_DOC, mk(T0, c), 'EUR')
    expect(r.doc.prefs.get('currency')).toEqual({ v: 'EUR', s: T0 })
    expect(setCurrency(r.doc, mk(T0 + 1, c), 'EUR').doc).toBe(r.doc)
    expect(code(() => setCurrency(EMPTY_DOC, mk(), 'eur'))).toBe('currency')
  })
})

describe('ops are pure: inputs never change and a merge with the input converges', () => {
  it('the input doc is untouched by every op', () => {
    const c: Hlc = { last: 0 }
    const d = addOne(EMPTY_DOC, mk(T0, c), 'a', 1, 'Food')
    const snapshot = JSON.stringify([...d.expenses.values()])
    const id = must([...d.expenses.keys()][0])
    updateExpense(d, mk(T0 + 1, c), id, { amount: 2 })
    deleteExpenses(d, mk(T0 + 2, c), [id])
    renameCategory(d, mk(T0 + 3, c), 'Food', 'Meals')
    expect(JSON.stringify([...d.expenses.values()])).toBe(snapshot)
    expect(
      mergeDoc(updateExpense(d, mk(T0 + 4, c), id, { amount: 3 }).doc, d).doc.expenses.get(id)?.a.v,
    ).toBe(3)
  })
})
