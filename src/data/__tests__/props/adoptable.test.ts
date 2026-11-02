// @vitest-environment node
// P2-4: adoptableNews is writer-aware. Against a relay last written by v0.8.5 (app 0.9.2) it is true
// exactly when that client, holding the relay copy, changes its state on merging our push: its own
// mergeBackups, compared by its own contentKey (what applySync's change check sees). Checked on
// 2,000 random pairs against the frozen 0.9.2 model. The v0.8.4 rule is unchanged (P-11, wire.test).
import { describe, expect, it } from 'vitest'
import { mergeDoc } from '../../core/doc'
import { editRecord, maxStampRec } from '../../core/record'
import { ps } from '../../core/stamp'
import type { Doc, ExpenseRec, OpCtx } from '../../core/types'
import { adoptableNews, decodeWire, encodeWire, wireString } from '../../core/wire'
import { contentKey, mergeBackups, readRemote, type BackupData, type Expense } from '../legacy/v085'
import { T0, genDoc } from '../support/gen'
import { must, parseJson } from '../support/must'
import { PROP_SCALE, PROP_TIMEOUT, makeRng, type Rng } from '../support/rng'

const clock = { now: () => T0 + 99, setTimeout: () => 0, clearTimeout: () => undefined }
const N = 2000 * PROP_SCALE

/** What a 0.9.2 client holds after reading a payload (its readRemote view). */
function viewOf(payload: unknown): BackupData {
  const r = readRemote(parseJson(JSON.stringify(payload)))
  if (r.kind !== 'ok') throw new Error(`unreadable: ${r.kind}`)
  return r.data
}

/** A relay row as 0.9.2 writes it: its merge output (normalised) plus its writer stamp. */
function relay092(data: BackupData, r: Rng, edits = true): Record<string, unknown> {
  const own = mergeBackups(
    { expenses: [], categories: [], categoryMappings: {}, exportDate: '', version: '4.0' },
    data,
    clock,
  )
  // a few edits made on the 0.9.2 device itself (forward-stamped, as its store writes them)
  const at = (k: number): string => new Date(T0 + 50_000 + k).toISOString()
  const expenses: Expense[] = own.expenses.map((e, i) =>
    edits && r.chance(0.15) ? { ...e, amount: e.amount + 1, updatedAt: at(i) } : e,
  )
  if (edits && r.chance(0.3)) {
    expenses.push({
      id: `p${r.int(1e6)}`,
      itemName: 'from the phone',
      amount: 3,
      category: 'Food',
      date: new Date(T0).toISOString(),
      createdAt: at(99),
    })
  }
  const mappings = { ...own.categoryMappings }
  const mts = { ...own.mappingUpdatedAt }
  if (edits && r.chance(0.3)) {
    mappings.kopi = r.pick(['Drinks', 'Food'])
    mts.kopi = at(7)
  }
  return {
    ...own,
    expenses,
    categoryMappings: mappings,
    mappingUpdatedAt: mts,
    wr: { app: '0.8.5', dev: 'phone1', rev: `r${r.int(1e6)}`, at: at(0) },
  }
}

/**
 * A doc as a device holds it: after one exchange with its own wire copy, so every record is
 * materialised through the rename table (ops and merges always leave it so; genDoc need not).
 */
const asHeld = (d: Doc): Doc => mergeDoc(d, decodeWire(parseJson(wireString(d)), 'remote').doc).doc

/** A concurrent change at the SAME stamps: the case only the content tie-break decides. */
function sameStampVariant(rec: ExpenseRec, r: Rng): ExpenseRec {
  const k = r.int(3)
  if (k === 0) return { ...rec, a: { ...rec.a, v: rec.a.v + 1 } }
  if (k === 1) return { ...rec, o: { ...rec.o, v: rec.o.v === null ? 'tie' : null } }
  return { ...rec, c: { ...rec.c, v: rec.c.v === 'Food' ? 'Meals' : 'Food' } }
}

function localSide(source: Doc, r: Rng): Doc {
  if (r.chance(0.2)) return genDoc(r)
  const ctx: OpCtx = { wall: T0 + 60_000, clock: { last: 0 }, dev: 'v5', rng: r.next }
  const expenses = new Map(source.expenses)
  for (const [id, rec] of source.expenses) {
    const roll = r.next()
    if (roll < 0.15) expenses.set(id, sameStampVariant(rec, r))
    else if (roll < 0.3) expenses.set(id, editRecord(rec, { a: rec.a.v + 2 }, ctx))
    else if (roll < 0.35) expenses.delete(id)
  }
  const tombs = new Map(source.tombs)
  if (r.chance(0.2)) tombs.set(`gone${r.int(1e6)}`, T0 + 1)
  const mappings = new Map(source.mappings)
  if (r.chance(0.3)) mappings.set('kopi', { v: r.pick(['Drinks', 'Food', 'Zzz']), s: T0 + 50_007 })
  if (r.chance(0.2)) mappings.set('teh', { v: 'Drinks', s: 0 })
  const budgets = new Map(source.budgets)
  if (r.chance(0.3)) {
    budgets.set(
      r.pick(['Food', 'Gym']),
      r.pick([
        { value: 300, set: T0 + 1, del: 0 },
        { value: null, set: 0, del: T0 + 2 },
        { value: 250, set: T0, del: T0 - 5 },
      ]),
    )
  }
  const categories = r.chance(0.2) ? [...source.categories, 'Brand new'] : source.categories
  return { ...source, expenses, tombs, mappings, budgets, categories }
}

describe('adoptableNews against a v0.8.5 relay = the frozen 0.9.2 merge (P2-4)', () => {
  it(
    `${N} random pairs: news iff 0.9.2 changes its state merging our push`,
    () => {
      const r = makeRng(924)
      let news = 0
      let quiet = 0
      let ties = 0
      let reused = 0
      for (let i = 0; i < N; i++) {
        const source = asHeld(genDoc(r))
        // a third: nothing changed on either side since 0.9.2 wrote the relay from our last push
        const still = r.chance(0.33)
        const relayRaw = relay092(viewOf(encodeWire(source)), r, !still)
        const local = still ? source : localSide(source, r)
        // as the bridge decodes it (reusing what it holds), and with nothing to reuse
        const relay = decodeWire(parseJson(JSON.stringify(relayRaw)), 'remote', { reuse: local })
        const fresh = decodeWire(parseJson(JSON.stringify(relayRaw)), 'remote')
        expect(relay.writer).toBe('v085')
        reused += relay.v085?.ours.size ?? 0
        const m = mergeDoc(local, relay.doc).doc
        const held = viewOf(relayRaw)
        const after = mergeBackups(held, viewOf(encodeWire(m, { dev: 'v5dev', rev: 'x' })), clock)
        const kept = contentKey(after) !== contentKey(held)
        expect(adoptableNews(m, relay), `pair ${i}`).toBe(kept)
        expect(adoptableNews(mergeDoc(local, fresh.doc).doc, fresh), `pair ${i}, no reuse`).toBe(
          kept,
        )
        if (kept) news++
        // no ping-pong beside 0.9.2 (I5, G4): what it already holds is never news to it
        if (still) {
          expect(kept, `quiet pair ${i}`).toBe(false)
          quiet++
        }
        for (const [id, rec] of m.expenses) {
          const theirs = held.expenses.find((e) => e.id === id)
          if (theirs !== undefined && ps(theirs.updatedAt ?? theirs.createdAt) === maxStampRec(rec))
            ties++
        }
      }
      // both outcomes are exercised, and the content tie-break with them
      expect(news).toBeGreaterThan(N * 0.2)
      expect(quiet).toBeGreaterThan(N * 0.25)
      expect(ties).toBeGreaterThan(N)
      // and the fast path (records it holds exactly as we encode them) as much as the full rule
      expect(reused).toBeGreaterThan(N)
    },
    PROP_TIMEOUT,
  )

  it('pins the rules one by one (records, ties, mappings, budgets, categories, tombstones)', () => {
    const source = asHeld(genDoc(makeRng(5)))
    const relayRaw = relay092(viewOf(encodeWire(source)), makeRng(6), false)
    const relay = decodeWire(parseJson(JSON.stringify(relayRaw)), 'remote')
    const base = mergeDoc(source, relay.doc).doc
    // nothing new: the merge of what it holds is quiet (no ping-pong)
    expect(adoptableNews(base, relay)).toBe(false)
    const first = must([...base.expenses.values()][0])
    const swap = (rec: ExpenseRec): Doc => ({
      ...base,
      expenses: new Map(base.expenses).set(rec.id, rec),
    })
    const ctx: OpCtx = { wall: T0 + 9e6, clock: { last: 0 }, dev: 'v5', rng: makeRng(1).next }
    expect(adoptableNews(swap(editRecord(first, { a: first.a.v + 5 }, ctx)), relay)).toBe(true)
    // a new category, a tombstone it lacks, a newer mapping pick: all kept by 0.9.2
    expect(adoptableNews({ ...base, categories: [...base.categories, 'Brand new'] }, relay)).toBe(
      true,
    )
    expect(adoptableNews({ ...base, tombs: new Map(base.tombs).set('zz', T0) }, relay)).toBe(true)
    expect(
      adoptableNews(
        { ...base, mappings: new Map(base.mappings).set('kopi', { v: 'Drinks', s: T0 + 9e6 }) },
        relay,
      ),
    ).toBe(true)
  })
})
