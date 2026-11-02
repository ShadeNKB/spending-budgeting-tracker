// The durable outbox (DATA-ENGINE-SPEC §11.5): the keys this device still has to get onto the
// relay, each at the highest stamp written. It lives in the envelope, so a push the OS strands is
// sent at the next launch.
import { maxStampRec } from '../core/record'
import type { BudgetReg, Doc, OutboxKey, Stamp } from '../core/types'

export type Touched = readonly (readonly [OutboxKey, Stamp])[]

/** The outbox with `touched` added, each key at its maximum stamp. */
export function addTouched(
  outbox: ReadonlyMap<OutboxKey, Stamp>,
  touched: Touched,
): ReadonlyMap<OutboxKey, Stamp> {
  if (touched.length === 0) return outbox
  const next = new Map(outbox)
  for (const [k, s] of touched) next.set(k, Math.max(next.get(k) ?? -1, s))
  return next
}

/** Two outboxes joined by key (max stamp): what two tabs both still have to send. */
export function joinOutbox(
  a: ReadonlyMap<OutboxKey, Stamp>,
  b: Touched,
): ReadonlyMap<OutboxKey, Stamp> {
  const missing = b.filter(([k, s]) => (a.get(k) ?? -1) < s)
  return missing.length === 0 ? a : addTouched(a, missing)
}

const budgetStamp = (g: BudgetReg): Stamp => Math.max(g.set, g.del)

/** Every record and register of the doc (migration with a sync code, recovery). */
export function everyKey(doc: Doc): Touched {
  return diffTouched(null, doc)
}

/** The keys whose value differs from `prev` (all of them without one): a fold's news. */
export function diffTouched(prev: Doc | null, next: Doc): Touched {
  const out: (readonly [OutboxKey, Stamp])[] = []
  for (const [id, rec] of next.expenses) {
    if (prev?.expenses.get(id) !== rec) out.push([`ex:${id}`, maxStampRec(rec)])
  }
  for (const [id, s] of next.tombs) if (prev?.tombs.has(id) !== true) out.push([`del:${id}`, s])
  for (const n of next.categories)
    if (prev?.categories.includes(n) !== true) out.push([`cat:${n}`, 0])
  for (const [k, g] of next.renames) if (prev?.renames.get(k) !== g) out.push([`ren:${k}`, g.s])
  for (const [k, g] of next.mappings) if (prev?.mappings.get(k) !== g) out.push([`map:${k}`, g.s])
  for (const [k, g] of next.budgets) {
    if (prev?.budgets.get(k) !== g) out.push([`bud:${k}`, budgetStamp(g)])
  }
  for (const [k, g] of next.prefs) if (prev?.prefs.get(k) !== g) out.push([`pref:${k}`, g.s])
  return out
}
