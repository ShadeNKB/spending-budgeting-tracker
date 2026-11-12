// What counts as spending (T8a, F-057): the set-aside categories and the whole-month budget, two
// synced preferences. Their rules on the doc, then the same through a real store and engine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { T0, docOf } from '../../__tests__/support/gen'
import { must, parseJson } from '../../__tests__/support/must'
import { HEAVY, makeRng } from '../../__tests__/support/rng'
import { displayList } from '../../core/categories'
import { mergeDoc } from '../../core/doc'
import * as ops from '../../core/ops'
import type { Doc, Hlc, Json, OpCtx, OpResult } from '../../core/types'
import { decodeWire, wireString } from '../../core/wire'
import {
  ASIDE_KEY,
  MONTH_CAP_KEY,
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

const pref = (doc: Doc, key: string): Json | undefined => doc.prefs.get(key)?.v

describe('set-aside categories on the doc', () => {
  it('sets a category aside and counts it again; the view follows the display order', () => {
    const c: Hlc = { last: 0 }
    let d = setAside(base(), mk(T0, c), 'Savings', true).doc
    d = setAside(d, mk(T0 + 1, c), 'Investment', true).doc
    expect(asideView(d)).toEqual(['Investment', 'Savings'])
    expect(pref(d, ASIDE_KEY)).toEqual(['Investment', 'Savings'])
    const back = setAside(d, mk(T0 + 2, c), 'Investment', false)
    expect(asideView(back.doc)).toEqual(['Savings'])
    expect(back.undo?.label).toBe('"Investment" counted as spending')
    // the last one out leaves the preference unset, not an empty list
    expect(pref(setAside(back.doc, mk(T0 + 3, c), 'Savings', false).doc, ASIDE_KEY)).toBeNull()
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

  it('reads anything but a list of names as none', () => {
    for (const v of ['Investment', 5, true, { Investment: true }, [1], ['Investment', 2], [[]]]) {
      const d = docOf({ categories: [...CATS], prefs: [[ASIDE_KEY, { v, s: T0 }]] })
      expect(asideView(d), JSON.stringify(v)).toEqual([])
    }
  })

  it('a stored name counts only while it is a category on screen; Other never', () => {
    const d = docOf({
      categories: [...CATS],
      prefs: [[ASIDE_KEY, { v: ['Ghost', 'Other', 'Travel'], s: T0 }]],
    })
    expect(displayList(d)).toContain('Other')
    expect(asideView(d)).toEqual(['Travel'])
    // the next change writes the list without the names that no longer show
    expect(pref(setAside(d, mk(T0 + 1), 'Food', true).doc, ASIDE_KEY)).toEqual(['Food', 'Travel'])
  })

  it('refuses a list too long to sync, and keeps what it had', () => {
    const c: Hlc = { last: 0 }
    let d = base()
    const long = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(2, '0')}${'n'.repeat(58)}`,
    )
    long.forEach((name, i) => {
      d = ops.addCategory(d, mk(T0 + i, c), name).doc
    })
    let refusedAt = -1
    for (let i = 0; i < long.length; i++) {
      const name = must(long[i])
      const before = d
      const res = code(() => {
        d = setAside(d, mk(T0 + 100 + i, c), name, true).doc
      })
      if (res === 'pref') {
        refusedAt = i
        expect(d).toBe(before)
        break
      }
    }
    // 60-character names: 2,048 characters of JSON hold 32 of them
    expect(refusedAt).toBe(32)
    expect(asideView(d)).toHaveLength(32)
    expect(decodeWire(parseJson(wireString(d)), 'remote').doc.prefs.get(ASIDE_KEY)).toEqual(
      d.prefs.get(ASIDE_KEY),
    )
  })

  it('two devices: the later list wins whole', () => {
    const a = setAside(base(), mk(T0, { last: 0 }), 'Investment', true).doc
    const b = setAside(base(), mk(T0 + 9, { last: 0 }), 'Savings', true).doc
    expect(asideView(mergeDoc(a, b).doc)).toEqual(['Savings'])
    expect(asideView(mergeDoc(b, a).doc)).toEqual(['Savings'])
  })
})

describe('a set-aside category that is renamed, merged or deleted', () => {
  const aside = (cats: readonly string[]): Doc => {
    const c: Hlc = { last: T0 + 50 }
    let d = withRows(['Food', 'Investment'])
    for (const name of cats) d = setAside(d, mk(T0 + 60, c), name, true).doc
    return d
  }

  const undoOf = (res: OpResult, at = T0 + 500): OpResult =>
    ops.undo(res.doc, mk(at, { last: T0 + 400 }), must(res.undo))

  it('stays set aside under a new name, in one undo entry that takes both back', () => {
    const d = aside(['Investment'])
    const res = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment', ' Brokerage ')
    expect(asideView(res.doc)).toEqual(['Brokerage'])
    expect(pref(res.doc, ASIDE_KEY)).toEqual(['Brokerage'])
    expect(res.undo?.label).toBe('Renamed "Investment" to "Brokerage"')
    expect(res.touched.map(([k]) => k)).toContain(`pref:${ASIDE_KEY}`)
    const back = undoOf(res)
    expect(back.report?.skipped).toBe(0)
    expect(displayList(back.doc)).toContain('Investment')
    expect(displayList(back.doc)).not.toContain('Brokerage')
    expect(asideView(back.doc)).toEqual(['Investment'])
  })

  it('is not passed on by a merge: the category merged into keeps its own answer', () => {
    const d = aside(['Investment'])
    const res = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment', 'Food')
    expect(displayList(res.doc)).not.toContain('Investment')
    expect(asideView(res.doc)).toEqual([])
    expect(pref(res.doc, ASIDE_KEY)).toBeNull()
    const back = undoOf(res)
    expect(asideView(back.doc)).toEqual(['Investment'])
  })

  it('a counted category merged into a set-aside one joins it, as its rows do', () => {
    const d = aside(['Investment'])
    const res = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Food', 'Investment')
    expect(asideView(res.doc)).toEqual(['Investment'])
    expect(res.touched.map(([k]) => k)).not.toContain(`pref:${ASIDE_KEY}`)
  })

  it('leaves the list when its category is deleted, so the name starts counted if added again', () => {
    const d = aside(['Investment', 'Food'])
    const res = removeCategory(d, mk(T0 + 100, { last: T0 + 90 }), 'Investment')
    expect(asideView(res.doc)).toEqual(['Food'])
    expect(pref(res.doc, ASIDE_KEY)).toEqual(['Food'])
    const again = ops.addCategory(res.doc, mk(T0 + 200, { last: T0 + 190 }), 'Investment').doc
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

  it('a category that was not set aside renames as the core does it', () => {
    const d = aside(['Investment'])
    const ours = renameCategory(d, mk(T0 + 100, { last: T0 + 90 }, 7), 'Food', 'Meals')
    const core = ops.renameCategory(d, mk(T0 + 100, { last: T0 + 90 }, 7), 'Food', 'Meals')
    expect(ours).toEqual(core)
    expect(asideView(ours.doc)).toEqual(['Investment'])
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
                next = ops.addCategory(doc, ctx, rng.pick(names)).doc
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
          // every name set aside is on screen, and Other never is
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
    expect(set.undo?.label).toBe('Monthly budget set')
    expect(setMonthCap(set.doc, mk(T0 + 1, c), 1200).doc).toBe(set.doc)
    const removed = setMonthCap(set.doc, mk(T0 + 2, c), null)
    expect(monthCapView(removed.doc)).toBeNull()
    expect(removed.undo?.label).toBe('Monthly budget removed')
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

  it('a rename in the app carries it, and its one Undo takes the rename and the list back', async () => {
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
    expect(s().consumeUndo(undoId)).toEqual({ applied: 2, skipped: 0 })
    expect(s().categories).toContain('Investment')
    expect(s().asideCategories).toEqual(['Investment'])
  })

  it('a delete in the app takes it off the list; Undo puts both back', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().addExpense({ itemName: 'etf', amount: 300, category: 'Investment' })
    s().setCategoryAside('Investment', true)
    s().removeCategory('Investment')
    expect(s().asideCategories).toEqual([])
    expect(s().consumeUndo(must(s().undoStack.at(-1)).id)?.skipped).toBe(0)
    expect(s().asideCategories).toEqual(['Investment'])
  })

  it('the settings ride in the backup file', async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().setCategoryAside('Investment', true)
    s().setMonthBudget(900)
    const file = s().exportBackup()
    expect(must(file.x5.pref[ASIDE_KEY])[1]).toEqual(['Investment'])
    expect(must(file.x5.pref[MONTH_CAP_KEY])[1]).toBe(900)
  })

  it("a toggle's Undo is on the stack under its own id", async () => {
    const t = await bootTab()
    const s = () => t.store.getState()
    s().setCategoryAside('Travel', true)
    const entry = must(s().undoStack.at(-1))
    expect(entry.id.startsWith('set-')).toBe(true)
    expect(entry.label).toBe('"Travel" set aside')
    expect(s().consumeUndo(entry.id)).toEqual({ applied: 1, skipped: 0 })
    expect(s().asideCategories).toEqual([])
  })
})
