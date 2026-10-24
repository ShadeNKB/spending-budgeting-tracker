// @vitest-environment node
// The per-entity causal floor of §4.2, one row per op: every write passes as `base` the stamp of
// exactly the register it supersedes. The slow device runs 2 days behind and observes the fast
// device's document the way a sync cycle does, so its clock follows at most 24 h ahead: only the
// base can lift its later write above the fast write (D2, judge probe "clock skew −1 day").
import { describe, expect, it } from 'vitest'
import { DAY, T0 } from '../__tests__/support/gen'
import { must } from '../__tests__/support/must'
import { makeRng } from '../__tests__/support/rng'
import { budgetView, displayList, mappingLookup, resolver } from './categories'
import { EMPTY_DOC, digestDoc, maxStampDoc, mergeDoc } from './doc'
import {
  addCategory,
  addExpense,
  applyImport,
  deleteExpenses,
  planImport,
  removeBudget,
  removeCategory,
  renameCategory,
  setBudget,
  setCurrency,
  undo,
  updateExpense,
} from './ops'
import { encodeRecord, maxStampRec } from './record'
import { observe } from './stamp'
import type { Doc, ExpenseRec, Hlc, OpCtx, OpResult, Stamp } from './types'
import { decodeWire } from './wire'

interface Side {
  doc: Doc
  wall: number
  seed: number
  readonly clock: Hlc
}

const side = (wall: number): Side => ({ doc: EMPTY_DOC, wall, seed: 1, clock: { last: 0 } })

/** One user action a minute after the previous one on that device. */
function act(s: Side, f: (doc: Doc, ctx: OpCtx) => OpResult): OpResult {
  s.wall += 60_000
  s.seed++
  const r = f(s.doc, { wall: s.wall, clock: s.clock, dev: 'dev', rng: makeRng(s.seed).next })
  s.doc = r.doc
  return r
}

/** A pull as the sync cycle does it: merge, then observe (the clock follows ≤ 24 h ahead). */
function pull(s: Side, from: Doc): void {
  s.doc = mergeDoc(s.doc, from).doc
  observe(s.clock, s.wall, maxStampDoc(from))
}

const only = (d: Doc): ExpenseRec => must([...d.expenses.values()][0], 'record')
const budget = (d: Doc, name: string): number | undefined => budgetView(d)[name]
const currency = (d: Doc): unknown => d.prefs.get('currency')?.v
const ren = (d: Doc, name: string): Stamp => must(d.renames.get(name), `renames.${name}`).s
const bud = (d: Doc, name: string): { set: Stamp; del: Stamp } =>
  must(d.budgets.get(name), `budgets.${name}`)

/** Fast device: a category with a budget, then the pull of its doc on the slow device. */
function foodBudget(fast: Side, slow: Side, value = 300): void {
  act(fast, (d, c) => addCategory(d, c, 'Food'))
  act(fast, (d, c) => setBudget(d, c, 'Food', value))
  pull(slow, fast.doc)
}

/** Fast device renames Food → Meals; the slow device pulls it. */
function foodToMeals(fast: Side, slow: Side): void {
  act(fast, (d, c) => addCategory(d, c, 'Food'))
  act(fast, (d, c) => renameCategory(d, c, 'Food', 'Meals'))
  pull(slow, fast.doc)
}

/** Fast device adds a kopi at 1.8; the slow device pulls it. */
function kopi(fast: Side, slow: Side): ExpenseRec {
  act(fast, (d, c) => addExpense(d, c, { itemName: 'kopi', amount: 1.8, category: 'Drinks' }))
  pull(slow, fast.doc)
  return only(slow.doc)
}

/** The slow device's op, then the fast device pulls it, then the slow device undoes it. */
function opThenUndo(fast: Side, slow: Side, f: (doc: Doc, ctx: OpCtx) => OpResult): OpResult {
  const r = act(slow, f)
  pull(fast, slow.doc)
  return act(slow, (d, c) => undo(d, c, must(r.undo, 'undo entry')))
}

interface Row {
  readonly name: string
  /** Runs the scenario; returns the stamp of the superseded register and of the slow write. */
  readonly run: (fast: Side, slow: Side) => { readonly superseded: Stamp; readonly wrote: Stamp }
  /** After the two devices exchange, the slow device's later action is what shows. */
  readonly wins: (merged: Doc) => void
}

const ROWS: readonly Row[] = [
  {
    name: 'field edit: base = max stamp of the changed fields',
    run: (fast, slow) => {
      const rec = kopi(fast, slow)
      act(slow, (d, c) => updateExpense(d, c, rec.id, { amount: 2 }))
      return { superseded: rec.a.s, wrote: only(slow.doc).a.s }
    },
    wins: (m) => expect(only(m).a.v).toBe(2),
  },
  {
    name: 'rename: base = max(renames[from].s, renames[to].s)',
    run: (fast, slow) => {
      foodToMeals(fast, slow)
      const superseded = ren(slow.doc, 'Meals')
      act(slow, (d, c) => renameCategory(d, c, 'Meals', 'Dining'))
      return { superseded, wrote: ren(slow.doc, 'Meals') }
    },
    wins: (m) => {
      expect(resolver(m.renames)('Food')).toBe('Dining')
      expect(resolver(m.renames)('Meals')).toBe('Dining')
    },
  },
  {
    name: 'remove category: its budget deletion is stamped above the budget',
    run: (fast, slow) => {
      foodBudget(fast, slow)
      const superseded = bud(slow.doc, 'Food').set
      act(slow, (d, c) => removeCategory(d, c, 'Food'))
      return { superseded, wrote: bud(slow.doc, 'Food').del }
    },
    wins: (m) => expect({ ...budgetView(m) }).toEqual({}),
  },
  {
    name: 'budget remove: base = max(set, del)',
    run: (fast, slow) => {
      foodBudget(fast, slow)
      const superseded = bud(slow.doc, 'Food').set
      act(slow, (d, c) => removeBudget(d, c, 'Food'))
      return { superseded, wrote: bud(slow.doc, 'Food').del }
    },
    wins: (m) => expect(budget(m, 'Food')).toBeUndefined(),
  },
  {
    name: 'budget set: base = max(set, del)',
    run: (fast, slow) => {
      foodBudget(fast, slow)
      const superseded = bud(slow.doc, 'Food').set
      act(slow, (d, c) => setBudget(d, c, 'Food', 250))
      return { superseded, wrote: bud(slow.doc, 'Food').set }
    },
    wins: (m) => expect(budget(m, 'Food')).toBe(250),
  },
  {
    name: 'currency: base = its stamp',
    run: (fast, slow) => {
      act(fast, (d, c) => setCurrency(d, c, 'EUR'))
      pull(slow, fast.doc)
      const superseded = must(slow.doc.prefs.get('currency')).s
      act(slow, (d, c) => setCurrency(d, c, 'SGD'))
      return { superseded, wrote: must(slow.doc.prefs.get('currency')).s }
    },
    wins: (m) => expect(currency(m)).toBe('SGD'),
  },
  {
    name: 'mapping learn: base = mappings[k].s',
    run: (fast, slow) => {
      kopi(fast, slow)
      const superseded = must(slow.doc.mappings.get('kopi')).s
      act(slow, (d, c) => addExpense(d, c, { itemName: 'kopi', amount: 2, category: 'Food' }))
      return { superseded, wrote: must(slow.doc.mappings.get('kopi')).s }
    },
    wins: (m) => expect(mappingLookup(m, 'Kopi ')).toBe('Food'),
  },
  {
    name: 're-add of a renamed-away name: base ≥ renames[n].s',
    run: (fast, slow) => {
      foodToMeals(fast, slow)
      const superseded = ren(slow.doc, 'Food')
      act(slow, (d, c) => addCategory(d, c, 'Food'))
      return { superseded, wrote: ren(slow.doc, 'Food') }
    },
    wins: (m) => {
      expect(resolver(m.renames)('Food')).toBe('Food')
      expect(displayList(m)).toContain('Food')
    },
  },
  {
    name: 'undo of a delete (revive): base = max stamp of the copy',
    run: (fast, slow) => {
      const rec = kopi(fast, slow)
      const del = act(slow, (d, c) => deleteExpenses(d, c, [rec.id]))
      act(slow, (d, c) => undo(d, c, must(del.undo)))
      return { superseded: maxStampRec(rec), wrote: maxStampRec(only(slow.doc)) }
    },
    wins: (m) => expect(only(m).a.v).toBe(1.8),
  },
  {
    name: 'undo of an edit: base = the stamp the edit wrote',
    run: (fast, slow) => {
      const rec = kopi(fast, slow)
      opThenUndo(fast, slow, (d, c) => updateExpense(d, c, rec.id, { amount: 2 }))
      return { superseded: only(fast.doc).a.s, wrote: only(slow.doc).a.s }
    },
    wins: (m) => expect(only(m).a.v).toBe(1.8),
  },
  {
    name: 'undo of a budget set: base = the stamp it wrote',
    run: (fast, slow) => {
      foodBudget(fast, slow)
      opThenUndo(fast, slow, (d, c) => setBudget(d, c, 'Food', 250))
      return { superseded: bud(fast.doc, 'Food').set, wrote: bud(slow.doc, 'Food').set }
    },
    wins: (m) => expect(budget(m, 'Food')).toBe(300),
  },
  {
    name: 'undo of a budget remove: base = the stamp it wrote',
    run: (fast, slow) => {
      foodBudget(fast, slow)
      opThenUndo(fast, slow, (d, c) => removeBudget(d, c, 'Food'))
      return { superseded: bud(fast.doc, 'Food').del, wrote: bud(slow.doc, 'Food').set }
    },
    wins: (m) => expect(budget(m, 'Food')).toBe(300),
  },
  {
    name: 'undo of a currency change: base = the stamp it wrote',
    run: (fast, slow) => {
      act(fast, (d, c) => setCurrency(d, c, 'EUR'))
      pull(slow, fast.doc)
      opThenUndo(fast, slow, (d, c) => setCurrency(d, c, 'SGD'))
      const s = (d: Doc): Stamp => must(d.prefs.get('currency')).s
      return { superseded: s(fast.doc), wrote: s(slow.doc) }
    },
    wins: (m) => expect(currency(m)).toBe('EUR'),
  },
  {
    name: 'undo of a rename to a new name: base = max(wrote, renames[to].s)',
    run: (fast, slow) => {
      foodToMeals(fast, slow)
      opThenUndo(fast, slow, (d, c) => renameCategory(d, c, 'Meals', 'Dining'))
      return { superseded: ren(fast.doc, 'Meals'), wrote: ren(slow.doc, 'Meals') }
    },
    wins: (m) => {
      expect(resolver(m.renames)('Meals')).toBe('Meals')
      expect(resolver(m.renames)('Dining')).toBe('Meals')
      expect(displayList(m)).not.toContain('Dining')
    },
  },
  {
    name: 'undo of a merge-into (recat): base = renames[from].s',
    run: (fast, slow) => {
      act(fast, (d, c) => addCategory(d, c, 'Snacks'))
      act(fast, (d, c) => renameCategory(d, c, 'Snacks', 'Food'))
      act(fast, (d, c) => addCategory(d, c, 'Meals'))
      act(fast, (d, c) => addExpense(d, c, { itemName: 'kopi', amount: 1.8, category: 'Food' }))
      pull(slow, fast.doc)
      opThenUndo(fast, slow, (d, c) => renameCategory(d, c, 'Food', 'Meals'))
      return { superseded: ren(fast.doc, 'Food'), wrote: ren(slow.doc, 'Food') }
    },
    wins: (m) => {
      expect(resolver(m.renames)('Food')).toBe('Food')
      expect(resolver(m.renames)(only(m).c.v)).toBe('Food')
    },
  },
  {
    name: 'replace import: each rewritten field is stamped above the local and the file copy',
    run: (fast, slow) => {
      const rec = kopi(fast, slow)
      const wire = encodeRecord(rec)
      const legacy = {
        id: rec.id,
        itemName: wire.itemName,
        amount: 2.5,
        category: wire.category,
        date: wire.date,
        createdAt: wire.createdAt,
      }
      const file = decodeWire({ version: '4.0', expenses: [legacy] }, 'file')
      act(slow, (d, c) => applyImport(d, c, planImport(d, file), 'replace'))
      return { superseded: rec.a.s, wrote: only(slow.doc).a.s }
    },
    wins: (m) => expect(only(m).a.v).toBe(2.5),
  },
]

describe('causal floor per op (§4.2): a slow device’s later write beats what it superseded', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const fast = side(T0 + 2 * DAY)
      const slow = side(T0)
      const { superseded, wrote } = row.run(fast, slow)
      // the superseded write came from the fast device, beyond what the slow clock follows
      expect(superseded).toBeGreaterThan(slow.wall + DAY)
      expect(wrote).toBeGreaterThan(superseded)
      const a = mergeDoc(fast.doc, slow.doc).doc
      const b = mergeDoc(slow.doc, fast.doc).doc
      expect(digestDoc(a)).toBe(digestDoc(b))
      row.wins(a)
    })
  }
})
