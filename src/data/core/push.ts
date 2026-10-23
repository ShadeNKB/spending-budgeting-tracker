// Push only news (DATA-ENGINE-SPEC §11.4, §11.5, §11.9; P-10, P-31; F-002). Pure decisions the
// sync engine's synchronous section calls; the memo is committed only after a push lands.
import { GUARD_ABS, GUARD_FRAC, GUARD_MIN, MEMO_WINDOW } from './constants'
import { digestDoc } from './doc'
import { maxStampRec } from './record'
import type {
  CycleReason,
  Doc,
  ExpenseRec,
  MemoState,
  OutboxKey,
  PulledRow,
  PushDecision,
  SanitizeResult,
  Stamp,
} from './types'
import { adoptableNews } from './wire'

export const NEW_MEMO: MemoState = Object.freeze({ memo: Object.freeze([]), extRefreshAt: 0 })

const decision = (
  kind: PushDecision['kind'],
  why: PushDecision['why'],
  memoKey: string | null = null,
): PushDecision => ({
  kind,
  why,
  memoKey,
})

/** Reasons that may re-publish v5-only facts to an old-written relay; never a remote event. */
const REFRESH_REASONS: ReadonlySet<CycleReason> = new Set(['boot', 'resume', 'local-change'])

/**
 * Should this cycle push `m` (the merged doc) over the pulled relay `dec`? Total over writer
 * classes: create, repair an invalid copy, digest compare against a v5 writer, and against an old
 * writer only what it will keep (memo-bounded) plus a 10-minute refresh of v5-only facts.
 */
export function decidePush(
  m: Doc,
  dec: SanitizeResult,
  pulled: PulledRow | null,
  reason: CycleReason,
  memo: MemoState,
  now: number,
): PushDecision {
  if (pulled === null) return decision('push', 'create')
  switch (dec.writer) {
    case 'moved':
      return decision('none', 'moved')
    case 'newer':
      return decision('none', 'newer')
    case 'e2e':
      return decision('none', 'e2e-unopened')
    case 'invalid':
      return decision('push', 'repair')
    case 'v5':
      return digestDoc(m) === digestDoc(dec.doc)
        ? decision('none', 'equal')
        : decision('push', 'v5-diff')
    case 'v084':
    case 'v085':
      break
  }
  if (adoptableNews(m, dec)) {
    const key = digestDoc(dec.doc)
    const seen = memo.memo.find(([k]) => k === key)
    return seen !== undefined && seen[1] > now - MEMO_WINDOW
      ? decision('suppressed', 'memo', key)
      : decision('push', 'adoptable', key)
  }
  if (
    REFRESH_REASONS.has(reason) &&
    now - memo.extRefreshAt > MEMO_WINDOW &&
    digestDoc(m) !== digestDoc(dec.doc)
  ) {
    return decision('push', 'ext-refresh')
  }
  return decision('none', 'old-quiet')
}

/** Called only after a push LANDS (mutation M4 moves it before the await). Prunes old entries. */
export function commitPush(memo: MemoState, d: PushDecision, now: number): MemoState {
  const key = d.why === 'adoptable' ? d.memoKey : null
  const memoEntries = memo.memo.filter(([k, t]) => t > now - MEMO_WINDOW && k !== key)
  return {
    memo: key === null ? memoEntries : [...memoEntries, [key, now] as const],
    extRefreshAt: d.why === 'ext-refresh' ? now : memo.extRefreshAt,
  }
}

const recordAt = (rec: ExpenseRec | undefined, s: Stamp): boolean =>
  rec !== undefined && maxStampRec(rec) >= s

/** P-31: does the relay doc hold this outbox key at a stamp ≥ s? */
function holds(doc: Doc, key: OutboxKey, s: Stamp): boolean {
  const at = key.indexOf(':')
  const kind = key.slice(0, at)
  const name = key.slice(at + 1)
  switch (kind) {
    case 'ex':
      return recordAt(doc.expenses.get(name), s) || doc.tombs.has(name)
    case 'del':
      return doc.tombs.has(name)
    case 'cat':
      return doc.categories.includes(name)
    case 'ren':
      return (doc.renames.get(name)?.s ?? -1) >= s
    case 'map':
      return (doc.mappings.get(name)?.s ?? -1) >= s
    case 'bud': {
      const g = doc.budgets.get(name)
      return g !== undefined && Math.max(g.set, g.del) >= s
    }
    default:
      return (doc.prefs.get(name)?.s ?? -1) >= s
  }
}

/**
 * Removes `[k, s]` from the outbox only if k still has stamp s and: the push landed; or the relay
 * is v5 and equal; or (old relay) the relay holds k at ≥ s. Kept old-relay keys are counted as
 * waiting for the other device to update (the pill never says "Synced" while any key remains).
 */
export function ackOutbox(
  outbox: ReadonlyMap<OutboxKey, Stamp>,
  sent: readonly (readonly [OutboxKey, Stamp])[],
  dec: SanitizeResult,
  outcome: 'pushed' | PushDecision,
): { readonly outbox: ReadonlyMap<OutboxKey, Stamp>; readonly waitingForOld: number } {
  const old = dec.writer === 'v084' || dec.writer === 'v085'
  const everything = outcome === 'pushed' || (dec.writer === 'v5' && outcome.why === 'equal')
  let next: Map<OutboxKey, Stamp> | null = null
  let waitingForOld = 0
  for (const [k, s] of sent) {
    if (outbox.get(k) !== s) continue
    if (everything || (old && holds(dec.doc, k, s))) {
      next ??= new Map(outbox)
      next.delete(k)
    } else if (old) waitingForOld++
  }
  return { outbox: next ?? outbox, waitingForOld }
}

/** Mass-removal guard (§11.9): removed ≥ 10 and (≥ 50 or ≥ 10 % of live). Never blocks. */
export function guardTrips(removed: number | readonly ExpenseRec[], local: Doc): boolean {
  const n = typeof removed === 'number' ? removed : removed.length
  return n >= GUARD_MIN && (n >= GUARD_ABS || n >= GUARD_FRAC * local.expenses.size)
}
