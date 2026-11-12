// What counts as spending (T8a, F-057): the not-spending categories and the whole-month budget,
// synced preferences. Their rules on the doc, then the same through a real store and engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { T0, docOf } from '../../__tests__/support/gen'
import { must, parseJson } from '../../__tests__/support/must'
import { HEAVY, makeRng } from '../../__tests__/support/rng'
import { displayList } from '../../core/categories'
import { EXTRA_KEY_RE } from '../../core/constants'
import { mergeDoc } from '../../core/doc'
import * as ops from '../../core/ops'
import type { Doc, Hlc, Json, OpCtx, OpResult } from '../../core/types'
import { decodeWire, wireString } from '../../core/wire'
import {
  ASIDE_PREFIX,
  MONTH_CAP_KEY,
  addCategory,
  asideKey,
  asideView,
  monthCapView,
  removeCategory,
  renameCategory,
  setAside,
  setMonthCap,
} from '../spending'
import { buildViews } from '../views'
import { FakeBacking } from './fakeStorage'
import { bootTab, settle } from './harness'

const mk = (wall = T0, clock: Hlc = { last: 0 }, seed = 1): OpCtx => ({
  wall,
  clock,
  dev: 'dev-a',
  rng: makeRng(seed).next,
})

const code = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof ops.OpError) return e.code
    throw e
  }
  return 'no-throw'
}

const CATS = ['Food', 'Investment', 'Savings', 'Travel'] as const
const base = (): Doc => docOf({ categories: [...CATS] })

/** A doc with one expense in each of `cats`, so a rename has rows to move. */
function withRows(cats: readonly string[]): Doc {
  const c: Hlc = { last: 0 }
  let d = base()
  cats.forEach((category, i) => {
    d = ops.addExpense(d, mk(T0 + i, c, i + 1), {
      itemName: `item ${category}`,
      amount: 10,
      category,
    }).doc
  })
  return d
}

/** What the register of `category` holds: its name, null once counted again, undefined if never set. */
const answer = (doc: Doc, category: string): Json | undefined =>
  doc.prefs.get(asideKey(category))?.v

describe('the register of a category', () => {
  it('is a preference key for any name, and its own for each', () => {
    const names = [
      'Investment',
      'Savings',
      'investment',
      'Investment ',
      '投资',
      'a'.repeat(200),
      'constructor',
      '__proto__',
      '',
    ]
    const keys = names.map(asideKey)
    for (const key of keys) {
      expect(key.startsWith(ASIDE_PREFIX)).toBe(true)
      expect(EXTRA_KEY_RE.test(key), key).toBe(true)
    }
    expect(new Set(keys).size).toBe(names.length)
  })
})

describe('not-spending categories on the doc', () => {
  it('marks a category and counts it again; the view follows the display order', () => {
    const c: Hlc = { last: 0 }
    let d = setAside(base(), mk(T0, c), 'Savings', true).doc
    d = setAside(d, mk(T0 + 1, c), 'Investment', true).doc
    expect(asideView(d)).toEqual(['Investment', 'Savings'])
    expect(answer(d, 'Investment')).toBe('Investment')
    const back = setAside(d, mk(T0 + 2, c), 'Investment', false)
    expect(asideView(back.doc)).toEqual(['Savings'])
    expect(answer(back.doc, 'Investment')).toBeNull()
    expect(back.undo?.label).toBe('"Investment" counts as spending again')
    // only its own register was written
    expect(back.touched.map(([k]) => k)).toEqual([`pref:${asideKey('Investment')}`])
  })

  it('changes nothing when the answer is already the one asked for', () => {
    const d = setAside(base(), mk(), 'Savings', true).doc
    expect(setAside(d, mk(T0 + 1), 'Savings', true).doc).toBe(d)
    expect(setAside(d, mk(T0 + 1), 'Food', false).doc).toBe(d)
  })

  it('refuses Other, and a category that is not on screen', () => {
    expect(code(() => setAside(base(), mk(), 'Other', true))).toBe('other-locked')
    expect(code(() => setAside(base(), mk(), 'Nope', true))).toBe('not-found')
  })

  it('reads only a register that holds the very name its key is made of', () => {
    const key = asideKey('Investment')
    for (const v of [5, true, null, ['Investment'], { name: 'Investment' }, 'Savings', '']) {
      const d = docOf({ categories: [...CATS], prefs: [[key, { v, s: T0 }]] })
      expect(asideView(d), JSON.stringify(v)).toEqual([])
    }
    // a key under the prefix that is no name's register
    const odd = docOf({
      categories: [...CATS],
      prefs: [[`${ASIDE_PREFIX}zzz`, { v: 'Investment', s: T0 }]],
    })
    expect(asideView(odd)).toEqual([])
    const good = docOf({ categories: [...CATS], prefs: [[key, { v: 'Investment', s: T0 }]] })
    expect(asideView(good)).toEqual(['Investment'])
  })

  it('a stored name counts only while it is a category on screen; Other never', () => {
    const d = docOf({
      categories: [...CATS],
      prefs: ['Ghost', 'Other', 'Travel'].map((n) => [asideKey(n), { v: n, s: T0 }] as const),
    })
    expect(displayList(d)).toContain('Other')
    expect(asideView(d)).toEqual(['Travel'])
  })

  it('has no limit on how many: forty long names all sync', () => {
    const c: Hlc = { last: 0 }
    let d = base()
    const long = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(2, '0')}${'n'.repeat(58)}`,
    )
    long.forEach((name, i) => {
      d = ops.addCategory(d, mk(T0 + i, c), name).doc
      d = setAside(d, mk(T0 + 100 + i, c), name, true).doc
    })
    expect(asideView(d)).toHaveLength(40)
    const back = decodeWire(parseJson(wireString(d)), 'remote').doc
    expect(asideView(back)).toEqual(asideView(d))
  })

  it('two devices that each change a different category keep both changes', () => {
    const shared = setAside(base(), mk(T0, { last: 0 }), 'Investment', true).doc
    const a = setAside(shared, mk(T0 + 5, { last: T0 }), 'Savings', true).doc
    const b = setAside(shared, mk(T0 + 9, { last: T0 }), 'Travel', true).doc
    expect(asideView(mergeDoc(a, b).doc)).toEqual(['Investment', 'Savings', 'Travel'])
    expect(asideView(mergeDoc(b, a).doc)).toEqual(['Investment', 'Savings', 'Travel'])
  })

  it('two devices changing the same category: the later answer wins on both', () => {
    const shared = setAside(base(), mk(T0, { last: 0 }), 'Investment', true).doc
    const a = setAside(shared, mk(T0 + 5, { last: T0 }), 'Investment', false).doc
    const b = setAside(shared, mk(T0 + 9, { last: T0 }), 'Savings', true).doc
    expect(asideView(mergeDoc(a, b).doc)).toEqual(['Savings'])
    expect(asideView(mergeDoc(b, a).doc)).toEqual(['Savings'])
  })
})

describe('a not-spending category that is renamed, merged or deleted', () => {
  const aside = (cats: readonly string[]): Doc => {
    const c: Hlc = { last: T0 + 50 }
    let d = withRows(['Food', 'Investment'])
    for (const name of cats) d = setAside(d, mk(T0 + 60, c), name, true).doc
    return d
  }

  const undoOf = (res: OpResult, at = T0 + 500): OpResult =>
    ops.undo(res.doc, mk(at, { last: T0 + 400 }), must(res.undo))

  it('stays not spending under a new name, in one undo entry that takes both back', () => {
    const d = aside(['Investment'])
    const res = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment', ' Brokerage ')
    expect(asideView(res.doc)).toEqual(['Brokerage'])
    expect(answer(res.doc, 'Brokerage')).toBe('Brokerage')
    expect(answer(res.doc, 'Investment')).toBeNull()
    expect(res.undo?.label).toBe('Renamed "Investment" to "Brokerage"')
    const back = undoOf(res)
    expect(back.report?.skipped).toBe(0)
    expect(displayList(back.doc)).toContain('Investment')
    expect(displayList(back.doc)).not.toContain('Brokerage')
    expect(asideView(back.doc)).toEqual(['Investment'])
  })

  it('a rename here and another category marked on the other device: both stand', () => {
    // The data-safety review's case: kept as one list, the later device's copy of it dropped the
    // renamed name, and its entries counted as spending again on both devices.
    const shared = aside(['Investment'])
    const a = renameCategory(shared, mk(T0 + 100, { last: T0 + 90 }), 'Investment', 'Brokerage').doc
    const b = setAside(shared, mk(T0 + 200, { last: T0 + 190 }), 'Savings', true).doc
    for (const merged of [mergeDoc(a, b).doc, mergeDoc(b, a).doc]) {
      expect(displayList(merged)).toContain('Brokerage')
      expect([...asideView(merged)].sort()).toEqual(['Brokerage', 'Savings'])
    }
  })

  it('a rename, then another category marked, then the rename undone: each keeps its own', () => {
    const d = aside(['Investment'])
    const renamed = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment', 'Brokerage')
    const marked = setAside(renamed.doc, mk(T0 + 120, { last: T0 + 110 }), 'Food', true)
    const back = ops.undo(marked.doc, mk(T0 + 500, { last: T0 + 400 }), must(renamed.undo))
    expect(back.report?.skipped).toBe(0)
    expect(asideView(back.doc)).toEqual(['Food', 'Investment'])
  })

  it('is not passed on by a merge: the category merged into keeps its own answer', () => {
    const d = aside(['Investment'])
    const res = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment', 'Food')
    expect(displayList(res.doc)).not.toContain('Investment')
    expect(asideView(res.doc)).toEqual([])
    expect(answer(res.doc, 'Investment')).toBeNull()
    expect(answer(res.doc, 'Food')).toBeUndefined()
    const back = undoOf(res)
    expect(asideView(back.doc)).toEqual(['Investment'])
  })

  it('a counted category merged into a not-spending one joins it, as its rows do', () => {
    const d = aside(['Investment'])
    const res = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Food', 'Investment')
    expect(asideView(res.doc)).toEqual(['Investment'])
    expect(res.touched.some(([k]) => k.startsWith(`pref:${ASIDE_PREFIX}`))).toBe(false)
  })

  it('goes with its category when that is deleted, so the name starts counted if added again', () => {
    const d = aside(['Investment', 'Food'])
    const res = removeCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment')
    expect(asideView(res.doc)).toEqual(['Food'])
    expect(answer(res.doc, 'Investment')).toBeNull()
    const again = addCategory(res.doc, mk(T0 + 200, { last: T0 + 190 }), 'Investment').doc
    expect(displayList(again)).toContain('Investment')
    expect(asideView(again)).toEqual(['Food'])
    const back = undoOf(res)
    expect(asideView(back.doc)).toEqual(['Food', 'Investment'])
  })

  it('never falls to Other when its category is deleted', () => {
    const res = removeCategory(aside(['Investment']), mk(T0 + 100, { last: T0 + 90 }), 'Investment')
    expect(asideView(res.doc)).toEqual([])
    expect(displayList(res.doc)).toContain('Other')
  })

  it('a rename this module did not make (an older version) counts the entries again', () => {
    const d = aside(['Investment'])
    const renamed = ops.renameCategory(
      d,
      mk(T0 + 100, { last: T0 + 90 }),
      'Investment',
      'Brokerage',
    )
    expect(asideView(renamed.doc)).toEqual([])
    const merged = ops.renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment', 'Food')
    expect(asideView(merged.doc)).toEqual([])
  })

  it('an answer left behind by such a delete does not come back with the name', () => {
    // An older version deleted the category: its register still holds the name.
    const left = ops.removeCategory(
      aside(['Investment']),
      mk(T0 + 100, { last: T0 + 90 }),
      'Investment',
    ).doc
    expect(answer(left, 'Investment')).toBe('Investment')
    expect(asideView(left)).toEqual([])
    // added again here: it starts counted, and the old answer is cleared in the same commit
    const added = addCategory(left, mk(T0 + 200, { last: T0 + 190 }), 'Investment')
    expect(asideView(added.doc)).toEqual([])
    expect(answer(added.doc, 'Investment')).toBeNull()
    // a counted category renamed onto that name keeps counting
    const renamed = renameCategory(left, mk(T0 + 200, { last: T0 + 190 }), 'Food', 'Investment')
    expect(displayList(renamed.doc)).toContain('Investment')
    expect(asideView(renamed.doc)).toEqual([])
    const back = undoOf(renamed)
    expect(back.report?.skipped).toBe(0)
    expect(asideView(back.doc)).toEqual([])
  })

  it('a counted category renames as the core does it', () => {
    const d = aside(['Investment'])
    const ours = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }, 7), 'Food', 'Meals')
    const core = ops.renameCategory(d, mk(T0 + 100, { last: T0 + 90 }, 7), 'Food', 'Meals')
    expect(ours).toEqual(core)
    expect(asideView(ours.doc)).toEqual(['Investment'])
  })

  it('a new name adds as the core does it', () => {
    const d = aside(['Investment'])
    const ours = addCategory(d, mk(T0 + 100, { last: T0 + 90 }, 7), ' Gifts ')
    const core = ops.addCategory(d, mk(T0 + 100, { last: T0 + 90 }, 7), ' Gifts ')
    expect(ours).toEqual(core)
  })

  it(
    'the views follow every change, as a cold rebuild has them (30 seeds × 40 steps)',
    HEAVY,
    () => {
      const names = [...CATS, 'Meals', 'Brokerage']
      for (let seed = 1; seed <= 30; seed++) {
        const rng = makeRng(seed)
        const clock: Hlc = { last: 0 }
        let doc = withRows(['Food', 'Investment', 'Savings'])
        let views = buildViews(doc, null, null, false)
        for (let i = 0; i < 40; i++) {
          const ctx = { wall: T0 + 1000 + i * 1000, clock, dev: 'views3', rng: rng.next }
          let next = doc
          try {
            switch (rng.int(6)) {
              case 0:
              case 1:
                next = setAside(doc, ctx, rng.pick(names), rng.int(2) === 0).doc
                break
              case 2:
                next = renameCategory(doc, ctx, rng.pick(names), rng.pick(names)).doc
                break
              case 3:
                next = removeCategory(doc, ctx, rng.pick(names)).doc
                break
              case 4:
                next = addCategory(doc, ctx, rng.pick(names)).doc
                break
              default:
                next = setMonthCap(doc, ctx, rng.int(3) === 0 ? null : rng.between(50, 900)).doc
            }
          } catch (e) {
            if (!(e instanceof ops.OpError)) throw e
          }
          const after = buildViews(next, doc, views, false)
          const cold = buildViews(next, null, null, false)
          const at = `seed ${String(seed)} step ${String(i)}`
          expect(after.asideCategories, at).toEqual(cold.asideCategories)
          expect(after.monthBudget, at).toBe(cold.monthBudget)
          // every not-spending name is on screen, and Other never is
          for (const n of after.asideCategories) expect(after.categories, at).toContain(n)
          expect(after.asideCategories, at).not.toContain('Other')
          if (JSON.stringify(after.asideCategories) === JSON.stringify(views.asideCategories)) {
            expect(after.asideCategories, at).toBe(views.asideCategories)
          }
          doc = next
          views = after
        }
      }
    },
  )
})

describe('the whole-month budget on the doc', () => {
  it('sets, changes and removes it', () => {
    const c: Hlc = { last: 0 }
    const set = setMonthCap(base(), mk(T0, c), 1200)
    expect(monthCapView(set.doc)).toBe(1200)
    expect(set.undo?.label).toBe('Whole month budget set')
    expect(setMonthCap(set.doc, mk(T0 + 1, c), 1200).doc).toBe(set.doc)
    const removed = setMonthCap(set.doc, mk(T0 + 2, c), null)
    expect(monthCapView(removed.doc)).toBeNull()
    expect(removed.undo?.label).toBe('Whole month budget removed')
    expect(monthCapView(ops.undo(removed.doc, mk(T0 + 3, c), must(removed.undo)).doc)).toBe(1200)
  })

  it('refuses what a budget may not be', () => {
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e7 + 1]) {
      expect(
        code(() => setMonthCap(base(), mk(), amount)),
        String(amount),
      ).toBe('budget')
    }
    expect(code(() => setMonthCap(base(), mk(), 1e7))).toBe('no-throw')
    expect(code(() => setMonthCap(base(), mk(), 0.01))).toBe('no-throw')
  })

  it('reads anything but such an amount as none', () => {
    for (const v of ['500', -5, 0, 1e9, true, [500], { v: 500 }, null]) {
      const d = docOf({ prefs: [[MONTH_CAP_KEY, { v, s: T0 }]] })
      expect(monthCapView(d), JSON.stringify(v)).toBeNull()
    }
  })

  it('two devices: the later budget wins on both', () => {
    const a = setMonthCap(base(), mk(T0, { last: 0 }), 900).doc
    const b = setMonthCap(base(), mk(T0 + 5, { last: 0 }), 1200).doc
    expect(monthCapView(mergeDoc(a, b).doc)).toBe(1200)
    expect(monthCapView(mergeDoc(b, a).doc)).toBe(1200)
  })
})

describe('through the store and the engine', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 12, 4))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('publishes both settings, keeps their objects through an unrelated change, and stores them', async () => {
    const backing = new FakeBacking()
    const t = await bootTab({ backing })
    const s = () => t.store.getState()
    expect(s().asideCategories).toEqual([])
    expect(s().monthBudget).toBeNull()

    s().setCategoryAside('Investment', true)
    s().setMonthBudget(1500)
    expect(s().asideCategories).toEqual(['Investment'])
    expect(s().monthBudget).toBe(1500)

    const list = s().asideCategories
    s().addExpense({ itemName: 'kopi', amount: 1.8, category: 'Food & Dining' })
    expect(s().asideCategories).toBe(list)

    await settle()
    const next = await bootTab({ backing })
    expect(next.store.getState().asideCategories).toEqual(['Investment'])
    expect(next.store.getState().monthBudget).toBe(1500)
  })

  it('a rename in the app carries it, and its one Undo takes the rename and the answer back', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().addExpense({ itemName: 'etf', amount: 300, category: 'Investment' })
    s().setCategoryAside('Investment', true)
    const stack = s().undoStack.length
    s().renameCategory('Investment', 'Brokerage')
    expect(s().asideCategories).toEqual(['Brokerage'])
    expect(s().undoStack.length).toBe(stack + 1)
    const undoId = must(s().undoStack.at(-1)).id
    expect(undoId.startsWith('cat-')).toBe(true)
    expect(s().consumeUndo(undoId)?.skipped).toBe(0)
    expect(s().categories).toContain('Investment')
    expect(s().asideCategories).toEqual(['Investment'])
  })

  it('a delete in the app takes its answer with it; Undo puts both back', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().addExpense({ itemName: 'etf', amount: 300, category: 'Investment' })
    s().setCategoryAside('Investment', true)
    s().removeCategory('Investment')
    expect(s().asideCategories).toEqual([])
    expect(s().consumeUndo(must(s().undoStack.at(-1)).id)?.skipped).toBe(0)
    expect(s().asideCategories).toEqual(['Investment'])
  })

  it('a category deleted and added again in the app starts counted', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().setCategoryAside('Travel', true)
    s().removeCategory('Travel')
    s().addCategory('Travel')
    expect(s().categories).toContain('Travel')
    expect(s().asideCategories).toEqual([])
  })

  it('the settings ride in the backup file', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().setCategoryAside('Investment', true)
    s().setMonthBudget(900)
    const file = s().exportBackup()
    expect(must(file.x5.pref[asideKey('Investment')])[1]).toBe('Investment')
    expect(must(file.x5.pref[MONTH_CAP_KEY])[1]).toBe(900)
  })

  it("a toggle's Undo is on the stack under its own id", async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().setCategoryAside('Travel', true)
    const entry = must(s().undoStack.at(-1))
    expect(entry.id.startsWith('set-')).toBe(true)
    expect(entry.label).toBe('"Travel" no longer counts as spending')
    expect(s().consumeUndo(entry.id)).toEqual({ applied: 1, skipped: 0 })
    expect(s().asideCategories).toEqual([])
  })

  it('two toggles, the first undone: each has its own register, nothing is skipped', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().setCategoryAside('Travel', true)
    const first = must(s().undoStack.at(-1)).id
    s().setCategoryAside('Gaming', true)
    expect(s().consumeUndo(first)).toEqual({ applied: 1, skipped: 0 })
    expect(s().asideCategories).toEqual(['Gaming'])
  })
})
