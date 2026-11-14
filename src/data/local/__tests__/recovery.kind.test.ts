// The Recovery centre and an entry's kind (T8c). A kind another device changed is a change like
// any other field's: listed with what it was and what it is, and put back by the same rule (only
// while the entry still holds what that edit wrote). A Fix of an unreadable income opens on Income,
// a refund's on Refund.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { must } from '../../__tests__/support/must'
import { KIND_KEY } from '../../core/constants'
import * as ops from '../../core/ops'
import type { Doc, EntryKind, OpCtx, SanitizeResult } from '../../core/types'
import { decodeWire, encodeWire } from '../../core/wire'
import type { RecoveryApi } from '../types'
import { bootTab, settle, type Tab } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)
const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function afterBoot(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
}

const api = (t: Tab): Promise<RecoveryApi> => t.store.getState().recovery()
const port = (t: Tab) => must(t.mod.getSyncPort(), 'port')
const liveIds = (t: Tab): string[] => t.store.getState().expenses.map((e) => e.id)
const kindHere = (t: Tab, id: string): unknown =>
  must(
    t.store.getState().expenses.find((e) => e.id === id),
    'entry',
  ).ext[KIND_KEY]

let wallStep = 0

/** Another device's copy: `edit` applied to this device's doc at a later wall clock. */
function remote(t: Tab, edit: (doc: Doc, ctx: OpCtx) => Doc): SanitizeResult {
  wallStep += 1
  const wall = Date.now() + wallStep * MINUTE
  const ctx: OpCtx = { wall, clock: { last: 0 }, dev: 'zz9999', rng: Math.random, demoBuild: false }
  return decodeWire(
    encodeWire(edit(port(t).doc(), ctx), { dev: 'zz9999', rev: `k${String(wallStep)}`, min: 4 }),
    'remote',
    { at: wall },
  )
}

/** This device's changes have all reached the relay, as after a sync. */
function synced(t: Tab): void {
  const p = port(t)
  p.ack([...p.outbox()], decodeWire(encodeWire(p.doc()), 'remote', { at: Date.now() }), 'pushed')
  expect(p.outbox().size).toBe(0)
}

/** Another device changed `id`'s kind. */
const kindOn = (t: Tab, id: string, kind: EntryKind) =>
  remote(t, (doc, ctx) => ops.updateExpense(doc, ctx, id, { kind }).doc)

describe('a kind another device changed (T8c)', () => {
  it('over a pending kind here it is a conflict that says both kinds; Restore puts this one back', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { kind: 'income' })
    expect(kindHere(t, id)).toBe('income')

    const out = port(t).applyRemote(kindOn(t, id, 'expense'))
    expect(out.conflicts).toBe(1)
    expect(kindHere(t, id)).toBeUndefined()
    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c).toMatchObject({ kind: 'conflict', pinned: true })
    // what the row can show: this device's kind, and none (an expense) after the other's edit
    expect(c.before?.kind).toBe('income')
    expect(c.after?.kind).toBeUndefined()

    const res = await r.restoreChange(c.id)
    expect(res).toMatchObject({ applied: 1, why: null })
    expect(kindHere(t, id)).toBe('income')
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'already' })
  })

  it('an expense made an income elsewhere over a pending edit here goes back to an expense, and nothing else moves', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    const before = must(
      t.store.getState().expenses.find((e) => e.id === id),
      'entry',
    )
    // a pending edit of the same register here: this device says "an expense" (after a detour)
    t.store.getState().updateExpense(id, { kind: 'income' })
    t.store.getState().updateExpense(id, { kind: 'expense' })
    port(t).applyRemote(kindOn(t, id, 'income'))
    expect(kindHere(t, id)).toBe('income')

    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c.before?.kind).toBeUndefined()
    expect(c.after?.kind).toBe('income')
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 1, why: null })
    const after = must(
      t.store.getState().expenses.find((e) => e.id === id),
      'entry',
    )
    expect(after.ext).toEqual({})
    expect(after).toMatchObject({
      itemName: before.itemName,
      amount: before.amount,
      category: before.category,
      day: before.day,
    })
  })

  it('a kind changed again since is refused: nothing is put back', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { kind: 'income' })
    port(t).applyRemote(kindOn(t, id, 'expense'))
    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    // the owner sets it again by hand, to what this device had: it is already back
    t.store.getState().updateExpense(id, { kind: 'income' })
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'already' })
    expect(kindHere(t, id)).toBe('income')
  })

  it('a refund made here and undone elsewhere is listed as one, and Restore makes it a refund again', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    const category = must(
      t.store.getState().expenses.find((e) => e.id === id),
      'entry',
    ).category
    t.store.getState().updateExpense(id, { kind: 'refund' })
    port(t).applyRemote(kindOn(t, id, 'expense'))
    expect(kindHere(t, id)).toBeUndefined()

    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c.before?.kind).toBe('refund')
    // a refund has a category to show beside its kind
    expect(c.before?.category).toBe(category)
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 1, why: null })
    expect(kindHere(t, id)).toBe('refund')
  })

  it('an income here made a refund elsewhere goes back to an income', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { kind: 'income' })
    port(t).applyRemote(kindOn(t, id, 'refund'))
    expect(kindHere(t, id)).toBe('refund')
    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c.after?.kind).toBe('refund')
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 1, why: null })
    expect(kindHere(t, id)).toBe('income')
  })

  it('made a refund and given a category elsewhere, in one edit: Restore puts both back together', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    const entry = () =>
      must(
        t.store.getState().expenses.find((e) => e.id === id),
        'entry',
      )
    const mine = entry().category
    const other = must(
      t.store.getState().categories.find((c) => c !== mine),
      'another category',
    )
    // pending here on both registers: an income, in its own category
    t.store.getState().updateExpense(id, { kind: 'income' })
    t.store.getState().updateExpense(id, { category: mine === 'Other' ? other : 'Other' })
    const here = entry().category
    const there = must(
      t.store.getState().categories.find((c) => c !== here),
      'a third',
    )
    port(t).applyRemote(
      remote(
        t,
        (doc, ctx) => ops.updateExpense(doc, ctx, id, { kind: 'refund', category: there }).doc,
      ),
    )
    expect(kindHere(t, id)).toBe('refund')
    expect(entry().category).toBe(there)

    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c.before).toMatchObject({ kind: 'income', category: here })
    expect(c.after).toMatchObject({ kind: 'refund', category: there })
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 1, why: null })
    expect(kindHere(t, id)).toBe('income')
    expect(entry().category).toBe(here)
  })
})

describe('an unreadable income that needs attention (T8c)', () => {
  it('its Fix is prefilled as an income; an unreadable expense, or another kind, is not', async () => {
    const keys = { ...ownerV4({ rows: 12, tombstones: 0 }).keys }
    const rows = JSON.parse(must(keys.expenses, 'expenses')) as Record<string, unknown>[]
    const bad = (id: string, extra: Record<string, unknown>) => ({
      ...must(rows[0], 'row'),
      id,
      itemName: `bad ${id}`,
      amount: -5,
      ...extra,
    })
    rows.push(
      bad('q-income', { kind: 'income' }),
      bad('q-plain', {}),
      bad('q-newer', { kind: 'transfer' }),
      bad('q-refund', { kind: 'refund' }),
    )
    keys.expenses = JSON.stringify(rows)
    const t = await bootTab({ keys })
    await afterBoot()
    const r = await api(t)
    const salvage = (name: string) =>
      must(
        r.attention().find((a) => a.salvage?.itemName === name),
        name,
      ).salvage
    expect(salvage('bad q-income')?.kind).toBe('income')
    expect(salvage('bad q-plain')).not.toHaveProperty('kind')
    expect(salvage('bad q-newer')).not.toHaveProperty('kind')
    // a refund's Fix opens on Refund, with the category it was filed under
    expect(salvage('bad q-refund')?.kind).toBe('refund')
    expect(salvage('bad q-refund')?.category).toBe(must(rows[0], 'row').category)
  })
})
