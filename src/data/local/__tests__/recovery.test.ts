// The Recovery centre's data side (DATA-ENGINE-SPEC §15.5, §9.7, §9.8, §8.3; PR-4 track spec §3.1):
// T-014-4 (needs attention: listed per origin with reasons, Fix salvage, markFixed keeps the raw,
// Discard removes exactly one item, memory only writes nothing) and the Recovery API (snapshots
// newest first, the precision rule, pre-v5 and z1 bodies, a snapshot file that Import accepts,
// the journal list and its restores, a held API across a re-boot).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { format } from 'date-fns'
import { must } from '../../__tests__/support/must'
import { b64urlEncode } from '../../core/e2e'
import * as ops from '../../core/ops'
import { isPlainObject, own } from '../../core/sanitize'
import type { Doc, OpCtx, SanitizeResult } from '../../core/types'
import { decodeWire, encodeWire } from '../../core/wire'
import type { ChangeItem, RecoveryApi } from '../types'
import { storedList } from '../json'
import { FakeBacking } from './fakeStorage'
import { bootTab, envelopeDoc, settle, stored, type Tab } from './harness'
import { OWNER_CATS, ownerV4, truncated } from './fixtures/v4Owner'

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

/** The setTimeout(0) after boot (the digest check, the mirror retry) and its flushes. */
async function afterBoot(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
}

const api = (t: Tab): Promise<RecoveryApi> => t.store.getState().recovery()
const port = (t: Tab) => must(t.mod.getSyncPort(), 'port')
const liveIds = (t: Tab): string[] => t.store.getState().expenses.map((e) => e.id)

let wallStep = 0

/** Another device's copy: `edit` applied to this device's doc at a later wall clock. */
function remote(t: Tab, edit: (doc: Doc, ctx: OpCtx) => Doc): SanitizeResult {
  wallStep += 1
  const wall = Date.now() + wallStep * MINUTE
  const ctx: OpCtx = { wall, clock: { last: 0 }, dev: 'zz9999', rng: Math.random, demoBuild: false }
  const doc = edit(port(t).doc(), ctx)
  return decodeWire(
    encodeWire(doc, { dev: 'zz9999', rev: `r${String(wallStep)}`, min: 4 }),
    'remote',
    {
      at: wall,
    },
  )
}

/** This device's changes have all reached the relay (its outbox is empty), as after a sync. */
function synced(t: Tab): void {
  const p = port(t)
  p.ack([...p.outbox()], decodeWire(encodeWire(p.doc()), 'remote', { at: Date.now() }), 'pushed')
  expect(p.outbox().size).toBe(0)
}

/** Another device removed `ids`. */
const removing = (t: Tab, ids: readonly string[]) =>
  remote(t, (doc, ctx) => ops.deleteExpenses(doc, ctx, ids).doc)

/** Another device changed `id`'s amount. */
const amountOn = (t: Tab, id: string, amount: number) =>
  remote(t, (doc, ctx) => ops.updateExpense(doc, ctx, id, { amount }).doc)

/** What the owner sees of an entry: name, amount, category, day, notes. */
const shown = (e: {
  itemName: string
  amount: number
  category: string
  date: string
  notes?: string
}): string => JSON.stringify([e.itemName, e.amount, e.category, e.date.slice(0, 10), e.notes ?? ''])

const shownAll = (t: Tab, ids?: readonly string[]): string[] =>
  t.store
    .getState()
    .expenses.filter((e) => ids === undefined || ids.includes(e.id))
    .map(shown)
    .sort()

/** A v4 owner with rows SpendTrack can't read among the good ones. */
function withBadRows(extra: readonly unknown[], rows = 30): Readonly<Record<string, string>> {
  const f = ownerV4({ rows, tombstones: 0, mappings: 0 })
  return { ...f.keys, expenses: JSON.stringify([...f.rows, ...extra]) }
}

const NOTE = `  ${'n'.repeat(520)}  `

const BAD = {
  amount: {
    id: 'bad-amount-1',
    itemName: '  Chicken rice  ',
    amount: 'abc',
    category: 'Food & Dining',
    date: '2026-10-31T20:30:00.000Z',
    createdAt: '2026-10-31T20:30:00.000Z',
    notes: NOTE,
  },
  name: {
    id: 'bad-name-1',
    itemName: '',
    amount: 7.25,
    category: 'Not a listed one',
    date: '2026-10-02T12:00:00',
    createdAt: '2026-10-02T04:00:00.000Z',
  },
  date: {
    id: 'bad-date-1',
    itemName: 'Taxi',
    amount: 18.4,
    category: 'Transportation',
    date: 'last tuesday',
    createdAt: '2026-10-03T04:00:00.000Z',
  },
  nothing: {
    id: 'bad-nothing-1',
    itemName: '   ',
    amount: -3,
    category: 'Shopping',
    date: '2026-10-04',
    createdAt: '2026-10-04T04:00:00.000Z',
  },
} as const

const BAD_ROWS = [BAD.amount, BAD.name, BAD.date, BAD.nothing, 42]

const byReason = (list: ReturnType<RecoveryApi['attention']>, reason: string) =>
  must(
    list.find((a) => a.reason === reason),
    reason,
  )

/** The stored needs-attention log as JSON text. */
const qText = (b: FakeBacking): string => b.data.get('st5:q') ?? ''

describe('T-014-4: what could not be read, in the Recovery centre', () => {
  it('a torn envelope boots recovered, and its copy is listed with its origin and date', async () => {
    const b = new FakeBacking()
    await bootTab({ backing: b, keys: ownerV4({ rows: 30, noSync: true }).keys })
    await afterBoot()
    const raw = must(b.data.get('st5:db'), 'envelope')
    b.data.set('st5:db', truncated(raw, 40))
    vi.setSystemTime(T0 + MINUTE)

    const t = await bootTab({ backing: b })
    await afterBoot()
    expect(t.store.getState().report?.kind).toBe('recovered')
    const list = (await api(t)).attention()
    const copy = must(
      list.find((a) => a.kind === 'copy'),
      'copy',
    )
    expect(copy).toMatchObject({ origin: 'local-envelope', reason: 'copy', salvage: null })
    expect(copy.at).toBe(T0 + MINUTE)
    expect(copy.id.startsWith('st5:q:st5:db:')).toBe(true)
    const file = (await api(t)).attentionFile(copy.id)
    const rawKeys = isPlainObject(file) ? own(file, 'rawKeys') : null
    expect(isPlainObject(rawKeys) ? own(rawKeys, copy.id) : null).toBe(truncated(raw, 40))
  })

  it('lists every unreadable row with its reason and origin, from storage and from the relay', async () => {
    const t = await bootTab({ keys: withBadRows(BAD_ROWS) })
    await afterBoot()
    const r = await api(t)
    const local = r.attention()
    expect(local.map((a) => a.reason).sort()).toEqual(
      ['bad-amount', 'bad-date', 'bad-name', 'bad-name', 'not-object'].sort(),
    )
    for (const a of local) expect(a).toMatchObject({ kind: 'entry', origin: 'local-v4', at: T0 })

    const fromRelay = { id: 'relay-bad', itemName: 'Kopi', amount: 'two', date: '2026-10-05' }
    port(t).applyRemote(
      decodeWire(
        {
          expenses: [fromRelay],
          categories: ['Other'],
          deletedIds: [],
          version: '4.0',
          exportDate: '2026-10-05T00:00:00.000Z',
        },
        'remote',
        { at: T0 + MINUTE },
      ),
    )
    const after = r.attention()
    expect(after).toHaveLength(6)
    expect(after[0]).toMatchObject({ origin: 'remote', reason: 'bad-amount', at: T0 + MINUTE })
    expect(after[0]?.salvage).toEqual({ itemName: 'Kopi', day: '2026-10-05' })
  })

  it('Fix salvages what each row still holds: the local day of an instant, a listed category, notes', async () => {
    const t = await bootTab({ keys: withBadRows(BAD_ROWS) })
    await afterBoot()
    const list = (await api(t)).attention()
    // an instant is filed on the day it fell on HERE (Honolulu 31 Oct, Singapore 1 Nov)
    expect(byReason(list, 'bad-amount').salvage).toEqual({
      itemName: 'Chicken rice',
      day: format(new Date(BAD.amount.date), 'yyyy-MM-dd'),
      category: 'Food & Dining',
      notes: 'n'.repeat(500),
    })
    const named = list.filter((a) => a.reason === 'bad-name')
    // no name but an amount: the amount and the day (a category no longer listed is left out)
    expect(named.map((a) => a.salvage)).toContainEqual({ amount: 7.25, day: '2026-10-02' })
    // neither a name nor an amount: nothing to fix from
    expect(named.map((a) => a.salvage)).toContainEqual(null)
    expect(byReason(list, 'bad-date').salvage).toEqual({
      itemName: 'Taxi',
      amount: 18.4,
      category: 'Transportation',
    })
    expect(byReason(list, 'not-object').salvage).toBeNull()
    expect(OWNER_CATS).toContain('Transportation')
  })

  it('markFixed drops the row from the list and the count, and keeps the raw on the device', async () => {
    const t = await bootTab({ keys: withBadRows(BAD_ROWS) })
    await afterBoot()
    const r = await api(t)
    const item = byReason(r.attention(), 'bad-date')
    const before = t.store.getState().attention.quarantined
    r.markFixed(item.id)
    expect(r.attention().map((a) => a.id)).not.toContain(item.id)
    expect(t.store.getState().attention.quarantined).toBe(before - 1)
    // the raw download (every stored key) still has the original, byte for byte
    expect(qText(t.backing)).toContain(JSON.stringify(JSON.stringify(BAD.date)).slice(1, -1))
    expect(r.attentionFile(item.id)).toBeNull()
    // fixed twice is still once
    r.markFixed(item.id)
    expect(t.store.getState().attention.quarantined).toBe(before - 1)
  })

  it('Discard removes exactly that row: only the log is written, the data is untouched', async () => {
    const t = await bootTab({ keys: withBadRows(BAD_ROWS) })
    await afterBoot()
    const r = await api(t)
    const item = byReason(r.attention(), 'bad-amount')
    const others = r.attention().filter((a) => a.id !== item.id)
    const doc = JSON.stringify(envelopeDoc(t.backing))
    t.backing.resetCounts()
    r.discard(item.id)
    await settle()
    expect(t.backing.removes).toEqual([])
    // the log, and the envelope's meta (how many the owner has seen), nothing else
    expect(new Set(t.backing.sets).size).toBeLessThanOrEqual(3)
    for (const k of t.backing.sets) expect(['st5:q', 'st5:db', 'st5:gen']).toContain(k)
    expect(JSON.stringify(envelopeDoc(t.backing))).toBe(doc)
    expect(r.attention()).toEqual(others)
    expect(qText(t.backing)).not.toContain('Chicken rice')
    // a second Discard of the same item does nothing
    t.backing.resetCounts()
    r.discard(item.id)
    expect(t.backing.sets).toEqual([])
  })

  it('Discard of a damaged copy removes that one key and nothing else', async () => {
    const b = new FakeBacking()
    await bootTab({ backing: b, keys: ownerV4({ rows: 30, noSync: true }).keys })
    await afterBoot()
    b.data.set('st5:db', truncated(must(b.data.get('st5:db'), 'envelope'), 40))
    const t = await bootTab({ backing: b })
    await afterBoot()
    const r = await api(t)
    const copy = must(
      r.attention().find((a) => a.kind === 'copy'),
      'copy',
    )
    const keys = [...b.data.keys()].filter((k) => k !== copy.id).sort()
    b.resetCounts()
    r.discard(copy.id)
    await settle()
    expect(b.removes).toEqual([copy.id])
    for (const k of b.sets) expect(['st5:db', 'st5:gen']).toContain(k)
    expect([...b.data.keys()].sort()).toEqual(keys)
    expect(t.store.getState().attention.copies).toBe(0)
  })

  it('a copy of the sync code is never listed, downloaded or discarded', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 5 }).keys })
    await afterBoot()
    b.data.set('st5:q:syncId:1', 'secret-code')
    const r = await api(t)
    expect(r.attention().map((a) => a.id)).not.toContain('st5:q:syncId:1')
    expect(r.attentionFile('st5:q:syncId:1')).toBeNull()
    r.discard('st5:q:syncId:1')
    expect(b.data.get('st5:q:syncId:1')).toBe('secret-code')
  })

  it('after a Discard, a row that arrives later still counts as unseen (the toast comes again)', async () => {
    const t = await bootTab({ keys: withBadRows(BAD_ROWS) })
    await afterBoot()
    t.store.getState().markAttentionSeen()
    expect(t.store.getState().attention.unseen).toBe(0)
    const r = await api(t)
    r.discard(byReason(r.attention(), 'bad-date').id)
    r.discard(byReason(r.attention(), 'not-object').id)
    expect(t.store.getState().attention.unseen).toBe(0)
    port(t).applyRemote(
      decodeWire(
        {
          expenses: [{ id: 'later', itemName: 'Teh', amount: 'x', date: '2026-10-06' }],
          categories: ['Other'],
          deletedIds: [],
          version: '4.0',
          exportDate: '2026-10-06T00:00:00.000Z',
        },
        'remote',
        { at: T0 + MINUTE },
      ),
    )
    expect(t.store.getState().attention.unseen).toBe(1)
  })

  it('in memory only, the lists still read and no action writes anything', async () => {
    const b = new FakeBacking()
    await bootTab({ backing: b, keys: withBadRows(BAD_ROWS, 20) })
    await afterBoot()
    b.data.set('st5:db', truncated(must(b.data.get('st5:db'), 'envelope'), 40))
    // no room for the damaged envelope's copy: the boot runs in memory only
    b.quota = b.used() + 10
    const t = await bootTab({ backing: b })
    await afterBoot()
    expect(t.store.getState().local).toBe('memory-only')
    const r = await api(t)
    expect(r.summary().canWrite).toBe(false)
    const list = r.attention()
    expect(list.length).toBeGreaterThan(0)
    b.resetCounts()
    const first = must(list[0], 'item')
    expect(() => {
      r.markFixed(first.id)
    }).toThrow("This device isn't saving")
    expect(() => {
      r.discard(first.id)
    }).toThrow("This device isn't saving")
    r.markAllSeen()
    await settle()
    expect(b.sets).toEqual([])
    expect(b.removes).toEqual([])
    expect(r.attention()).toEqual(list)
  })
})

// ── snapshots ──────────────────────────────────────────────────────────────────────────────────

/** Replaces a stored z0 snapshot with its gzip (z1) form, as the background compression does. */
async function compress(b: FakeBacking, id: string): Promise<void> {
  const text = must(b.data.get(`st5:snap:${id}`), 'snapshot')
  const source = must(new Response(text.slice(3)).body, 'stream')
  const zipped = new Response(source.pipeThrough(new CompressionStream('gzip')))
  const bytes = new Uint8Array(await zipped.arrayBuffer())
  b.data.set(`st5:snap:${id}`, `z1|${b64urlEncode(bytes)}`)
  const index = stored(b, 'st5:snaps')
  if (!Array.isArray(index)) throw new Error('no index')
  b.data.set(
    'st5:snaps',
    JSON.stringify(
      index.map((s: unknown) => (isPlainObject(s) && own(s, 'id') === id ? { ...s, z: 1 } : s)),
    ),
  )
}

describe('Recovery API: snapshots', () => {
  it('lists them newest first from the index, with their reasons and row counts', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40 }).keys })
    await afterBoot()
    vi.setSystemTime(T0 + MINUTE)
    t.store.getState().deleteAllEverywhere()
    const list = (await api(t)).snapshots()
    // the migration's copy and the day's first copy were both taken at the first boot
    expect(list).toHaveLength(3)
    expect(list[0]).toMatchObject({ reason: 'delete-all', at: T0 + MINUTE, rows: 40 })
    expect(
      list
        .slice(1)
        .map((s) => s.reason)
        .sort(),
    ).toEqual(['daily', 'pre-v5'])
    for (let i = 1; i < list.length; i++) {
      expect(must(list[i - 1], 'prev').at).toBeGreaterThanOrEqual(must(list[i], 'this').at)
    }
  })

  it('taken in the same millisecond, the later copy is listed first', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 12 }).keys })
    await afterBoot()
    // no time passes: the migration's copies and Delete all's share their `at`
    t.store.getState().deleteAllEverywhere()
    const list = (await api(t)).snapshots()
    expect(new Set(list.map((s) => s.at)).size).toBe(1)
    expect(list[0]?.reason).toBe('delete-all')
  })

  it('"Before Delete all" restores exactly those entries, under new ids, with an Undo and a safety copy', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40 }).keys })
    await afterBoot()
    const before = shownAll(t)
    vi.setSystemTime(T0 + MINUTE)
    t.store.getState().deleteAllEverywhere()
    expect(t.store.getState().expenses).toHaveLength(0)
    vi.setSystemTime(T0 + 2 * MINUTE)

    const r = await api(t)
    const snap = must(
      r.snapshots().find((s) => s.reason === 'delete-all'),
      'delete-all',
    )
    const preview = await r.previewSnapshot(snap.id)
    expect(preview.counts).toMatchObject({ inFile: 40, restored: 40, added: 0, updated: 0 })
    const outcome = t.store.getState().applyImport(preview, 'restore')
    expect(outcome).toMatchObject({ restored: 40, removed: 0 })
    expect(shownAll(t)).toEqual(before)
    expect(r.snapshots()[0]?.reason).toBe('import')
    expect(t.store.getState().undoStack.at(-1)?.id.startsWith('imp-')).toBe(true)
    // the same preview twice changes nothing more
    expect(t.store.getState().applyImport(preview, 'restore').applied).toBe(0)
    // and a restore never touches the "Last backup" line
    expect(t.store.getState().facts.lastBackupAt).toBeNull()
  })

  it("the precision rule: a mass removal's copy brings back only what that removal took", async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    const ids = liveIds(t)
    const took = ids.slice(0, 20)
    const out = port(t).applyRemote(removing(t, took))
    expect(out.mass?.count).toBe(20)
    // later, separately, another entry is deleted (here); it must stay deleted
    const later = must(ids[30], 'later')
    t.store.getState().deleteExpense(later)
    const r = await api(t)
    const snap = must(
      r.snapshots().find((s) => s.reason === 'mass'),
      'mass snapshot',
    )
    expect(snap.rows).toBe(40)
    const preview = await r.previewSnapshot(snap.id)
    expect(preview.counts).toMatchObject({ inFile: 20, restored: 20 })
    t.store.getState().applyImport(preview, 'restore')
    expect(t.store.getState().expenses).toHaveLength(39)
    expect(liveIds(t)).not.toContain(later)
    expect(liveIds(t).some((id) => id.startsWith(`${later}~r`))).toBe(false)
  })

  it('a daily copy restores everything in it that is missing now, and leaves live entries alone', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 30, tombstones: 0 }).keys })
    await afterBoot()
    const [a, b] = liveIds(t)
    t.store.getState().updateExpense(must(a, 'a'), { amount: 999 })
    t.store.getState().deleteExpense(must(b, 'b'))
    const r = await api(t)
    const daily = must(
      r.snapshots().find((s) => s.reason === 'daily'),
      'daily',
    )
    const preview = await r.previewSnapshot(daily.id)
    expect(preview.counts).toMatchObject({ inFile: 30, restored: 1, alreadyHere: 29, updated: 0 })
    t.store.getState().applyImport(preview, 'restore')
    expect(t.store.getState().expenses.find((e) => e.id === a)?.amount).toBe(999)
    expect(t.store.getState().expenses).toHaveLength(30)
  })

  it('reads the pre-v5 copy (raw v4 strings) and a compressed (z1) copy', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 25, tombstones: 0 }).keys })
    await afterBoot()
    const r = await api(t)
    const pre = must(
      r.snapshots().find((s) => s.reason === 'pre-v5'),
      'pre-v5',
    )
    expect((await r.previewSnapshot(pre.id)).counts).toMatchObject({ inFile: 25, alreadyHere: 25 })
    await compress(t.backing, pre.id)
    expect((await r.previewSnapshot(pre.id)).counts).toMatchObject({ inFile: 25, alreadyHere: 25 })
    const daily = must(
      r.snapshots().find((s) => s.reason === 'daily'),
      'daily',
    )
    await compress(t.backing, daily.id)
    expect((await r.previewSnapshot(daily.id)).counts).toMatchObject({
      inFile: 25,
      alreadyHere: 25,
    })
  })

  it('a copy that no longer reads says so and changes nothing', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 12 }).keys })
    await afterBoot()
    t.store.getState().deleteAllEverywhere()
    const r = await api(t)
    const snap = must(r.snapshots()[0], 'snapshot')
    t.backing.data.set(`st5:snap:${snap.id}`, 'z0|{"expenses":[{"id"')
    await expect(r.previewSnapshot(snap.id)).rejects.toThrow("This copy can't be read any more.")
    await expect(r.snapshotFile(snap.id)).resolves.toBeNull()
    t.backing.data.set(`st5:snap:${snap.id}`, 'z1|not-base64-gzip')
    await expect(r.previewSnapshot(snap.id)).rejects.toThrow("This copy can't be read any more.")
    await expect(r.previewSnapshot('no-such-id')).rejects.toThrow(
      "This copy can't be read any more.",
    )
    expect(t.store.getState().expenses).toHaveLength(0)
  })

  it('Download gives a backup file that Import accepts and restores, and records no backup', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 30 }).keys })
    await afterBoot()
    const before = shownAll(t)
    t.store.getState().deleteAllEverywhere()
    const r = await api(t)
    const snap = must(r.snapshots()[0], 'snapshot')
    const file = must(await r.snapshotFile(snap.id), 'file')
    expect(t.store.getState().facts.lastBackupAt).toBeNull()
    const preview = await t.store
      .getState()
      .previewImport(new Blob([JSON.stringify(file)], { type: 'application/json' }))
    expect(preview.counts).toEqual((await r.previewSnapshot(snap.id)).counts)
    t.store.getState().applyImport(preview, 'restore')
    expect(shownAll(t)).toEqual(before)
  })
})

// ── the journal ────────────────────────────────────────────────────────────────────────────────

const kinds = (list: readonly ChangeItem[]): string[] => list.map((c) => c.kind)

describe('Recovery API: changes from the other device', () => {
  it("lists a remote mass removal (pinned, new) and never this device's own Delete all", async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const out = port(t).applyRemote(removing(t, liveIds(t).slice(0, 20)))
    t.store.getState().deleteAllEverywhere()
    const r = await api(t)
    const list = r.changes()
    expect(kinds(list)).toEqual(['mass'])
    expect(list[0]).toMatchObject({
      id: out.mass?.entryId,
      pinned: true,
      seen: false,
      count: 20,
      before: null,
      after: null,
    })
    expect(r.summary()).toMatchObject({ newChanges: 1, canWrite: true })
    r.markAllSeen()
    expect(r.summary().newChanges).toBe(0)
    expect(r.changes()[0]?.seen).toBe(true)
  })

  it('hides a mass removal with nothing left to restore it from', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    port(t).applyRemote(removing(t, liveIds(t).slice(0, 20)))
    const snap = must(
      (await api(t)).snapshots().find((s) => s.reason === 'mass'),
      'mass',
    )
    // the snapshot was evicted since
    b.data.delete(`st5:snap:${snap.id}`)
    const index = stored(b, 'st5:snaps')
    if (!Array.isArray(index)) throw new Error('no index')
    b.data.set(
      'st5:snaps',
      JSON.stringify(index.filter((s: unknown) => !(isPlainObject(s) && own(s, 'id') === snap.id))),
    )
    const next = await bootTab({ backing: b })
    await afterBoot()
    expect((await api(next)).changes()).toEqual([])
  })

  it('a removal below the guard lists one row per entry; Restore brings back just that one', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const [a, b] = liveIds(t)
    const shownA = shownAll(t, [must(a, 'a')])
    const nameA = must(
      t.store.getState().expenses.find((e) => e.id === a),
      'entry a',
    ).itemName
    const out = port(t).applyRemote(removing(t, [must(a, 'a'), must(b, 'b')]))
    expect(out).toMatchObject({ removed: 2, mass: null, conflicts: 0 })
    const r = await api(t)
    const rows = r.changes()
    expect(kinds(rows)).toEqual(['removed', 'removed'])
    expect(rows.every((c) => !c.pinned)).toBe(true)
    expect(r.summary().newChanges).toBe(0)
    const rowA = must(
      rows.find((c) => c.before?.itemName === nameA),
      'row a',
    )
    const res = await r.restoreChange(rowA.id)
    expect(res).toMatchObject({ applied: 1, skipped: 0, why: null })
    expect(res.undoId?.startsWith('rec-')).toBe(true)
    const back = t.store.getState().expenses.filter((e) => e.id.startsWith(`${must(a, 'a')}~r`))
    expect(back.map(shown)).toEqual(shownA)
    expect(liveIds(t)).not.toContain(b)
    expect(t.store.getState().expenses).toHaveLength(39)
    expect(r.changes().find((c) => c.id === rowA.id)?.seen).toBe(true)

    // twice: it's already back
    expect(await r.restoreChange(rowA.id)).toMatchObject({ applied: 0, why: 'already' })
    // deleted since (on either device): it stays deleted
    t.store.getState().deleteExpense(must(back[0], 'revived').id)
    expect(await r.restoreChange(rowA.id)).toMatchObject({ applied: 0, why: 'deleted-since' })
    expect(t.store.getState().expenses).toHaveLength(38)
  })

  it('Undo of a restore takes it away again within 30 s', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const [a] = liveIds(t)
    port(t).applyRemote(removing(t, [must(a, 'a')]))
    const r = await api(t)
    const res = await r.restoreChange(must(r.changes()[0], 'row').id)
    expect(t.store.getState().expenses).toHaveLength(20)
    expect(t.store.getState().undoStack.at(-1)).toMatchObject({ id: res.undoId })
    expect(t.store.getState().consumeUndo(must(res.undoId, 'undo'))).toEqual({
      applied: 1,
      skipped: 0,
    })
    expect(t.store.getState().expenses).toHaveLength(19)
  })

  it("a remote edit over a pending edit here is a conflict; Restore puts this device's value back", async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { amount: 12.5 })
    const out = port(t).applyRemote(amountOn(t, id, 99))
    expect(out.conflicts).toBe(1)
    expect(t.store.getState().expenses.find((e) => e.id === id)?.amount).toBe(99)
    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c).toMatchObject({ kind: 'conflict', pinned: true, seen: false })
    expect(c.before?.amount).toBe(12.5)
    expect(c.after?.amount).toBe(99)
    expect(r.summary().newChanges).toBe(1)
    const res = await r.restoreChange(c.id)
    expect(res).toMatchObject({ applied: 1, why: null })
    expect(t.store.getState().expenses.find((e) => e.id === id)?.amount).toBe(12.5)
    expect(r.summary().newChanges).toBe(0)
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'already' })
  })

  it('a conflict changed again since, or deleted since, is refused and nothing changes', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const [x, y] = liveIds(t)
    const idX = must(x, 'x')
    const idY = must(y, 'y')
    t.store.getState().updateExpense(idX, { amount: 12.5 })
    t.store.getState().updateExpense(idY, { amount: 3 })
    port(t).applyRemote(amountOn(t, idX, 99))
    port(t).applyRemote(amountOn(t, idY, 4))
    const r = await api(t)
    const cx = must(
      r.changes().find((c) => c.after?.amount === 99),
      'x',
    )
    const cy = must(
      r.changes().find((c) => c.after?.amount === 4),
      'y',
    )
    t.store.getState().updateExpense(idX, { amount: 50 })
    t.store.getState().deleteExpense(idY)
    expect(await r.restoreChange(cx.id)).toMatchObject({ applied: 0, why: 'changed-since' })
    expect(await r.restoreChange(cy.id)).toMatchObject({ applied: 0, why: 'deleted-since' })
    expect(t.store.getState().expenses.find((e) => e.id === idX)?.amount).toBe(50)
    expect(liveIds(t)).not.toContain(idY)
    expect(liveIds(t).some((v) => v.startsWith(`${idY}~r`))).toBe(false)
  })

  it('a remote delete of an entry edited here (conflict without after) restores the edited entry', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { notes: 'kept here' })
    const out = port(t).applyRemote(removing(t, [id]))
    expect(out.conflicts).toBe(1)
    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    expect(c).toMatchObject({ kind: 'conflict', after: null })
    expect(c.before?.notes).toBe('kept here')
    await r.restoreChange(c.id)
    const back = must(
      t.store.getState().expenses.find((e) => e.id.startsWith(`${id}~r`)),
      'revived',
    )
    expect(back.notes).toBe('kept here')
  })

  it('an edit made on the other device after a delete here restores that edited copy', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    // the other device edits it (and adds one) before it hears of the delete made here
    const theirs = remote(t, (doc, ctx) => {
      const edited = ops.updateExpense(doc, ctx, id, { amount: 77 }).doc
      return ops.addExpense(edited, ctx, { itemName: 'Teh tarik', amount: 1.8 }).doc
    })
    t.store.getState().deleteExpense(id)
    port(t).applyRemote(theirs)
    const r = await api(t)
    const c = must(
      r.changes().find((x) => x.kind === 'edit-after-delete'),
      'edit-after-delete',
    )
    expect(c.after?.amount).toBe(77)
    await r.restoreChange(c.id)
    expect(t.store.getState().expenses.find((e) => e.id.startsWith(`${id}~r`))?.amount).toBe(77)
  })

  it('a merge that trips the mass guard reports no conflicts (its Undo toast says it all)', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const ids = liveIds(t)
    t.store.getState().updateExpense(must(ids[0], 'first'), { amount: 5 })
    const out = port(t).applyRemote(removing(t, ids.slice(0, 20)))
    expect(out.mass?.count).toBe(20)
    expect(out.conflicts).toBe(0)
    // the pending edit the removal took is listed on its own as well (§9.8)
    expect(kinds((await api(t)).changes()).sort()).toEqual(['conflict', 'mass'])
  })

  it('the session Undo of a mass removal (its toast) restores every entry it took', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    const out = port(t).applyRemote(removing(t, liveIds(t).slice(0, 20)))
    const id = must(out.mass, 'mass').entryId
    await expect(t.store.getState().restoreJournal(id)).resolves.toMatchObject({
      applied: 20,
      skipped: 0,
    })
    expect(t.store.getState().expenses).toHaveLength(40)
  })
})

describe('Recovery API across a re-boot', () => {
  it('an API object held over a re-boot reads the new boot, never the old one', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 30, tombstones: 0 }).keys })
    await afterBoot()
    const r = await api(t)
    expect(r.snapshots().map((s) => s.reason)).not.toContain('delete-all')
    vi.setSystemTime(T0 + MINUTE)
    t.store.getState().deleteAllEverywhere()
    await t.store.getState().hydrate()
    await afterBoot()
    expect(r.snapshots()[0]?.reason).toBe('delete-all')
    const preview = await r.previewSnapshot(must(r.snapshots()[0], 'snapshot').id)
    t.store.getState().applyImport(preview, 'restore')
    expect(t.store.getState().expenses).toHaveLength(30)
  })
})

// ── repair round (data-safety review): a second restore, and precision without the journal ──────

/** Sum of the live amounts, in cents (a duplicate shows up here as money counted twice). */
const cents = (t: Tab): number =>
  t.store.getState().expenses.reduce((n, e) => n + Math.round(e.amount * 100), 0)

/** Live ids that a restore suffixed (`…~r<hash>.2`): a revive id that was taken already. */
const suffixed = (t: Tab): string[] => liveIds(t).filter((id) => /~r[0-9a-z]+\.\d+$/.test(id))

describe('a second restore never brings back a later delete, nor a second copy (review B1)', () => {
  it('"Restore all" again after two of them were deleted since: those two stay deleted', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    const out = port(t).applyRemote(removing(t, liveIds(t).slice(0, 20)))
    const id = must(out.mass, 'mass').entryId
    const r = await api(t)
    expect(await r.restoreChange(id)).toMatchObject({ applied: 20, why: null })
    const revived = liveIds(t).filter((x) => x.includes('~r'))
    expect(revived).toHaveLength(20)
    t.store.getState().deleteExpense(must(revived[0], 'a'))
    t.store.getState().deleteExpense(must(revived[1], 'b'))
    // the session cache is gone: this one reads the snapshot
    expect(await r.restoreChange(id)).toMatchObject({ applied: 0, why: 'deleted-since' })
    expect(t.store.getState().expenses).toHaveLength(38)
    expect(suffixed(t)).toEqual([])
  })

  it('"Restore all" again after one restored entry was edited: no second copy', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    const out = port(t).applyRemote(removing(t, liveIds(t).slice(0, 20)))
    const id = must(out.mass, 'mass').entryId
    const r = await api(t)
    await r.restoreChange(id)
    const edited = must(
      liveIds(t).find((x) => x.includes('~r')),
      'revived',
    )
    const was = must(
      t.store.getState().expenses.find((e) => e.id === edited),
      'entry',
    ).amount
    t.store.getState().updateExpense(edited, { amount: was + 5.55 })
    const total = cents(t)
    expect(await r.restoreChange(id)).toMatchObject({ applied: 0, why: 'already' })
    expect(t.store.getState().expenses).toHaveLength(40)
    expect(cents(t)).toBe(total)
    expect(suffixed(t)).toEqual([])
  })

  it('one quiet removal restored, edited, restored again: already back, no second copy (M1)', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const a = must(liveIds(t)[0], 'a')
    port(t).applyRemote(removing(t, [a]))
    const r = await api(t)
    const row = must(r.changes()[0], 'removed')
    expect(await r.restoreChange(row.id)).toMatchObject({ applied: 1, why: null })
    const back = must(
      liveIds(t).find((x) => x.startsWith(`${a}~r`)),
      'back',
    )
    t.store.getState().updateExpense(back, { amount: 77 })
    expect(await r.restoreChange(row.id)).toMatchObject({ applied: 0, why: 'already' })
    expect(t.store.getState().expenses).toHaveLength(20)
    expect(suffixed(t)).toEqual([])
  })

  it('"Before Delete all" restored, one deleted, restored again: it stays deleted', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 30 }).keys })
    await afterBoot()
    vi.setSystemTime(T0 + MINUTE)
    t.store.getState().deleteAllEverywhere()
    const r = await api(t)
    const snap = must(
      r.snapshots().find((s) => s.reason === 'delete-all'),
      'delete-all',
    )
    t.store.getState().applyImport(await r.previewSnapshot(snap.id), 'restore')
    expect(t.store.getState().expenses).toHaveLength(30)
    const gone = must(liveIds(t)[3], 'gone')
    t.store.getState().deleteExpense(gone)
    const again = await r.previewSnapshot(snap.id)
    expect(again.counts).toMatchObject({ restored: 0, added: 0 })
    expect(r.snapshotSkips(again)).toEqual({ back: 29, deletedSince: 1 })
    expect(t.store.getState().applyImport(again, 'restore').applied).toBe(0)
    expect(t.store.getState().expenses).toHaveLength(29)
    expect(liveIds(t)).not.toContain(gone)
    expect(suffixed(t)).toEqual([])
  })

  it('a snapshot preview, then a restore and a delete elsewhere, then Restore: the delete stays', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 30 }).keys })
    await afterBoot()
    vi.setSystemTime(T0 + MINUTE)
    t.store.getState().deleteAllEverywhere()
    const r = await api(t)
    const snap = must(
      r.snapshots().find((s) => s.reason === 'delete-all'),
      'delete-all',
    )
    // the owner opens the preview; meanwhile the copy is restored (here, or by the other device,
    // whose revive ids are the same) and one of those entries is deleted again
    const held = await r.previewSnapshot(snap.id)
    expect(held.counts.restored).toBe(30)
    t.store.getState().applyImport(await r.previewSnapshot(snap.id), 'restore')
    const gone = must(liveIds(t)[7], 'gone')
    t.store.getState().deleteExpense(gone)
    // Restore on the preview held all along: planned again now, so nothing comes back twice
    expect(t.store.getState().applyImport(held, 'restore').applied).toBe(0)
    expect(t.store.getState().expenses).toHaveLength(29)
    expect(liveIds(t)).not.toContain(gone)
    expect(suffixed(t)).toEqual([])
  })

  it('a mass restore from Changes after a re-boot reads only what that removal took (M13)', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    const ids = liveIds(t)
    const out = port(t).applyRemote(removing(t, ids.slice(0, 20)))
    const entry = must(out.mass, 'mass').entryId
    // separately, later: one of the entries the removal left is deleted here
    const later = must(ids[25], 'later')
    t.store.getState().deleteExpense(later)
    await t.store.getState().hydrate()
    await afterBoot()
    const r = await api(t)
    expect(await r.restoreChange(entry)).toMatchObject({ applied: 20, why: null })
    expect(t.store.getState().expenses).toHaveLength(39)
    expect(liveIds(t).some((x) => x === later || x.startsWith(`${later}~r`))).toBe(false)
  })
})

describe('the precision rule holds without the journal (review M2)', () => {
  /** A remote mass removal of 20 of 40, its change marked seen, then another entry deleted. */
  async function seenMass() {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 40, tombstones: 0 }).keys })
    await afterBoot()
    const ids = liveIds(t)
    port(t).applyRemote(removing(t, ids.slice(0, 20)))
    const later = must(ids[30], 'later')
    t.store.getState().deleteExpense(later)
    const r = await api(t)
    r.markAllSeen()
    return { t, b, r, later }
  }

  it('once the seen journal entry is evicted, the copy still brings back only what was taken', async () => {
    const { t, b, r, later } = await seenMass()
    // the journal bound (or quota shedding) drops seen entries: here, all of them
    b.data.set('st5:journal', '[]')
    const snap = must(
      r.snapshots().find((s) => s.reason === 'mass'),
      'mass',
    )
    expect(snap.restorable).toBe(true)
    const preview = await r.previewSnapshot(snap.id)
    expect(preview.counts).toMatchObject({ inFile: 20, restored: 20 })
    t.store.getState().applyImport(preview, 'restore')
    expect(t.store.getState().expenses).toHaveLength(39)
    expect(liveIds(t).some((x) => x === later || x.startsWith(`${later}~r`))).toBe(false)
  })

  it('the removed ids outlive the engine rewriting the snapshot index', async () => {
    const { t, b, r } = await seenMass()
    b.data.set('st5:journal', '[]')
    // a later pre-destructive snapshot rewrites the index (and evicts by its rules)
    vi.setSystemTime(T0 + 5 * MINUTE)
    t.store.getState().deleteAllEverywhere()
    const snap = must(
      r.snapshots().find((s) => s.reason === 'mass'),
      'mass',
    )
    expect(snap.restorable).toBe(true)
    expect((await r.previewSnapshot(snap.id)).counts.inFile).toBe(20)
  })

  it('an older removal copy with no ids and no journal entry: Download only, never Restore', async () => {
    const { r, b } = await seenMass()
    b.data.set('st5:journal', '[]')
    const index = stored(b, 'st5:snaps')
    if (!Array.isArray(index)) throw new Error('no index')
    // as 0.11.0 left it: no ids in the index
    b.data.set(
      'st5:snaps',
      JSON.stringify(
        index.map((s: unknown) => {
          if (!isPlainObject(s)) return s
          const { ids: _ids, ...rest } = s
          return rest
        }),
      ),
    )
    const snap = must(
      r.snapshots().find((s) => s.reason === 'mass'),
      'mass',
    )
    expect(snap.restorable).toBe(false)
    await expect(r.previewSnapshot(snap.id)).rejects.toThrow(/can only be downloaded/)
    expect(await r.snapshotFile(snap.id)).not.toBeNull()
  })
})

describe('more restores that must stay exact (review mutants M3, M5)', () => {
  it('a conflict whose value came back by a later edit is changed since: nothing is put back (M3)', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    synced(t)
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { amount: 12.5 })
    port(t).applyRemote(amountOn(t, id, 99))
    const r = await api(t)
    const c = must(r.changes()[0], 'conflict')
    // edited again since, to the same value: a later write, which wins
    t.store.getState().updateExpense(id, { amount: 50 })
    t.store.getState().updateExpense(id, { amount: 99 })
    expect(await r.restoreChange(c.id)).toMatchObject({ applied: 0, why: 'changed-since' })
    expect(t.store.getState().expenses.find((e) => e.id === id)?.amount).toBe(99)
  })

  it('a conflict that could not be journaled is not counted: Review never opens an empty list (4b)', async () => {
    const b = new FakeBacking()
    await bootTab({ backing: b, keys: ownerV4({ rows: 20, tombstones: 0 }).keys })
    await afterBoot()
    b.data.set('st5:db', truncated(must(b.data.get('st5:db'), 'envelope'), 40))
    // no room for the damaged envelope's copy: the boot runs in memory only (nothing written)
    b.quota = b.used() + 10
    const t = await bootTab({ backing: b })
    await afterBoot()
    expect(t.store.getState().local).toBe('memory-only')
    const id = must(liveIds(t)[0], 'id')
    t.store.getState().updateExpense(id, { amount: 12.5 })
    expect(port(t).outbox().has(`ex:${id}`)).toBe(true)
    const out = port(t).applyRemote(amountOn(t, id, 99))
    expect(t.store.getState().expenses.find((e) => e.id === id)?.amount).toBe(99)
    expect(out.conflicts).toBe(0)
    expect((await api(t)).changes()).toEqual([])
  })

  it('Discard of one of two identical stored rows removes only that one (M5)', async () => {
    const t = await bootTab({ keys: withBadRows([BAD.date]) })
    await afterBoot()
    const list = storedList(t.backing.data.get('st5:q') ?? null)
    const row = list.find((x: unknown) => isPlainObject(x) && own(x, 'reason') === 'bad-date')
    // the same row kept twice (as an older build could leave it)
    t.backing.data.set('st5:q', JSON.stringify([...list, row]))
    const r = await api(t)
    const item = byReason(r.attention(), 'bad-date')
    r.discard(item.id)
    expect(r.attention().filter((a) => a.id === item.id)).toHaveLength(1)
    r.discard(item.id)
    expect(r.attention().filter((a) => a.id === item.id)).toHaveLength(0)
  })
})
