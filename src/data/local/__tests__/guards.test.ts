// The guards that keep data when something else goes wrong at the same moment (track spec §8,
// P2-14, P2-16, P2-20): each test here fails if its guard is deleted. A remote mass removal is
// never stored before what it took is restorable; another tab's envelope that does not read is
// never written over without a copy of it; a re-boot keeps what storage still refuses; a stale
// Replace preview deletes nothing twice; a tab hears that another removed SpendTrack; an old
// tab's writes fold in at their real rank; the outbox of another tab survives this one's write;
// nothing is written after Remove from this device, not even by a compression in flight; and an
// add's confirmation reads the save it just made.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { must, parseJson } from '../../__tests__/support/must'
import { EMPTY_DOC } from '../../core/doc'
import { isPlainObject, own } from '../../core/sanitize'
import * as ops from '../../core/ops'
import { decodeWire, encodeWire, wireString } from '../../core/wire'
import { isSpendTrackKey, V4_DATA_KEYS } from '../keys'
import { RAW_COPIES_PER_KEY } from '../quarantine'
import { REMOTE_SAFETY_COPY_ERROR } from '../refusal'
import { RESUME_DELAY } from '../snapshots'
import { unsavedNote } from '../../../features/entry/expenseForm'
import { FakeBacking, seed } from './fakeStorage'
import { bootTab, hidePage, settle, type Tab } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)

const reload = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../lib/chunkReload', async (load) => {
  const real = await load<typeof import('../../../lib/chunkReload')>()
  return {
    ...real,
    reloadPage: () => {
      reload.calls++
    },
  }
})

beforeEach(() => {
  reload.calls = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A relay copy with `ids` deleted by another device. */
function remoteWithout(t: Tab, ids: readonly string[]) {
  const port = must(t.mod.getSyncPort(), 'port')
  const ctx = {
    wall: T0 + 60_000,
    clock: { last: 0 },
    dev: 'zz9999',
    rng: Math.random,
    demoBuild: false,
  }
  const remote = ops.deleteExpenses(port.doc(), ctx, ids).doc
  return decodeWire(encodeWire(remote, { dev: 'zz9999', rev: 'r1', min: 4 }), 'remote', {
    at: T0 + 60_000,
  })
}

/** One real task later (timers are faked here; a message is not). */
const nextTurn = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

const liveIds = (t: Tab): string[] =>
  t.store
    .getState()
    .expenses.map((e) => e.id)
    .sort()

const v4Size = (b: FakeBacking): number =>
  V4_DATA_KEYS.reduce((n, k) => n + k.length + (b.data.get(k)?.length ?? 0), 0)

describe('a remote mass removal is never stored before what it took is restorable (§11.9)', () => {
  it('no room for the snapshot nor the journal entry: refused, nothing removed, then or after a reload', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 60 }).keys, install: true })
    hidePage()
    await settle()
    const ids = liveIds(t)
    b.prefixFailures.set('st5:snap', 'quota')
    b.failures.set('st5:journal', 'quota')
    const port = must(t.mod.getSyncPort(), 'port')
    // (each tab's modules are its own: the message names the refusal)
    expect(() => port.applyRemote(remoteWithout(t, ids))).toThrow(REMOTE_SAFETY_COPY_ERROR)
    await settle()
    expect(liveIds(t)).toEqual(ids)
    b.prefixFailures.clear()
    b.failures.clear()
    const next = await bootTab({ backing: b })
    await settle()
    expect(liveIds(next)).toEqual(ids)
  })

  it('no room for the snapshot: the rollback copy makes room for the journal entry first', async () => {
    const b = new FakeBacking()
    const t = await bootTab({
      backing: b,
      keys: ownerV4({ rows: 60, noSync: true }).keys,
      install: true,
    })
    hidePage()
    await settle()
    const ids = liveIds(t)
    const port = must(t.mod.getSyncPort(), 'port')
    // the entry holds the removed records; it fits only once the v4 mirror is shed
    const body = wireString({ ...EMPTY_DOC, expenses: port.doc().expenses }).length
    expect(body).toBeLessThan(v4Size(b))
    b.prefixFailures.set('st5:snap', 'quota')
    b.quota = b.used() + Math.round(body / 2)
    const out = port.applyRemote(remoteWithout(t, ids))
    const mass = must(out.mass, 'mass')
    await settle()
    expect(t.store.getState().expenses).toHaveLength(0)
    expect(t.store.getState().facts.mirror).toBe('off')
    b.prefixFailures.clear()
    b.quota = Number.POSITIVE_INFINITY
    const next = await bootTab({ backing: b })
    await settle()
    await expect(next.store.getState().restoreJournal(mass.entryId)).resolves.toMatchObject({
      applied: 60,
      skipped: 0,
    })
    // revived under new ids (P2-20), every one of them
    expect(next.store.getState().expenses).toHaveLength(ids.length)
  })
})

describe('another tab’s envelope that does not read (P2-16)', () => {
  const FOREIGN = '5|00000000|{"f":2,"doc":{"x":1}}'

  it('is never written over while no copy of it can be kept; it is once one can', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 10, noSync: true }).keys })
    await settle()
    b.data.set('st5:db', FOREIGN)
    b.data.set('st5:gen', 'other:9')
    b.prefixFailures.set('st5:q', 'quota')
    t.store.getState().addExpense({ itemName: 'Mine', amount: 1 })
    await settle()
    expect(b.data.get('st5:db')).toBe(FOREIGN)
    expect(t.store.getState().local).toBe('error-storage')
    // room again: the next write keeps the copy, then writes, with the new entry
    b.prefixFailures.clear()
    t.store.getState().addExpense({ itemName: 'Mine too', amount: 2 })
    await settle()
    const copies = [...b.data].filter(([k]) => k.startsWith('st5:q:st5:db:'))
    expect(copies.map(([, v]) => v)).toEqual([FOREIGN])
    expect(b.data.get('st5:db')).not.toBe(FOREIGN)
    expect(t.store.getState().local).toBe('saved')
    const next = await bootTab({ backing: b })
    await settle()
    const names = next.store.getState().expenses.map((e) => e.itemName)
    expect(names).toContain('Mine')
    expect(names).toContain('Mine too')
    expect(next.store.getState().attention.copies).toBe(1)
  })

  it('joins what still reads of it before writing (a digest that no longer matches)', async () => {
    const backing = new FakeBacking()
    const a = await bootTab({ backing, keys: ownerV4({ rows: 10, noSync: true }).keys })
    await settle()
    const b = await bootTab({ backing })
    await settle()
    const x = b.store.getState().addExpense({ itemName: 'From the other tab', amount: 6 })
    await settle()
    // B's envelope is damaged after it wrote it: its body reads, its digest no longer matches
    const stored = must(backing.data.get('st5:db'), 'st5:db')
    backing.data.set('st5:db', stored.replace(/^5\|[^|]*\|/, '5|00000000|'))
    a.store.getState().addExpense({ itemName: 'From this tab', amount: 1 })
    await settle()
    expect(a.store.getState().local).toBe('saved')
    const next = await bootTab({ backing })
    await settle()
    const names = next.store.getState().expenses.map((e) => e.itemName)
    expect(names).toContain('From this tab')
    expect(next.store.getState().expenses.some((e) => e.id === x.id)).toBe(true)
  })

  it(`keeps at most ${String(RAW_COPIES_PER_KEY)} copies of it, then stops writing over it`, async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 5, noSync: true }).keys })
    await settle()
    for (let i = 0; i <= RAW_COPIES_PER_KEY; i++) {
      const foreign = `5|00000000|{"f":2,"doc":{"n":${String(i)}}}`
      b.data.set('st5:db', foreign)
      b.data.set('st5:gen', `other:${String(i)}`)
      t.store.getState().addExpense({ itemName: `Add ${String(i)}`, amount: 1 })
      await settle()
      const kept = [...b.data.keys()].filter((k) => k.startsWith('st5:q:st5:db:')).length
      expect(kept).toBe(Math.min(i + 1, RAW_COPIES_PER_KEY))
      if (i < RAW_COPIES_PER_KEY) expect(b.data.get('st5:db')).not.toBe(foreign)
      else expect(b.data.get('st5:db')).toBe(foreign)
    }
  })
})

describe('needs attention counts what the owner can download', () => {
  it('never counts a set-aside copy of the sync code (it is left out of the download)', async () => {
    const b = new FakeBacking()
    seed(b, {
      ...ownerV4({ rows: 5, noSync: true }).keys,
      'st5:q:st5:sync:1793500000000': '{"kind":"pla',
      'st5:q:syncId:1793500000001': '   ',
    })
    const t = await bootTab({ backing: b })
    await settle()
    expect(t.store.getState().attention).toMatchObject({ quarantined: 0, copies: 0, unseen: 0 })
  })
})

describe('a re-boot while storage still refuses the envelope (P2-14)', () => {
  it('keeps the unsaved entry: the earlier boot’s doc joins the new one', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 30, noSync: true }).keys })
    await settle()
    b.failures.set('st5:db', 'quota')
    t.store.getState().addExpense({ itemName: 'Unsaved lunch', amount: 7.5 })
    await settle()
    expect(t.store.getState().local).toBe('error-quota')
    // still refused at the re-boot: the carry is the only copy of it
    await t.store.getState().hydrate()
    await settle()
    expect(t.store.getState().expenses.map((e) => e.itemName)).toContain('Unsaved lunch')
    expect(t.store.getState().local).toBe('error-quota')
    b.failures.clear()
    await t.store.getState().hydrate()
    await settle()
    const again = await bootTab({ backing: b })
    expect(again.store.getState().expenses.map((e) => e.itemName)).toContain('Unsaved lunch')
  })
})

describe('an import preview applies once (P2-12)', () => {
  it('a second Replace of the same, now stale, preview deletes nothing', async () => {
    const t = await bootTab({ keys: ownerV4({ rows: 20, tombstones: 0, noSync: true }).keys })
    await settle()
    const file = t.store.getState().exportBackup()
    const smaller = { ...file, expenses: file.expenses.slice(0, 10) }
    const preview = await t.store
      .getState()
      .previewImport(new Blob([JSON.stringify(smaller)], { type: 'application/json' }))
    t.store.getState().applyImport(preview, 'replace')
    expect(t.store.getState().expenses).toHaveLength(10)
    t.store.getState().addExpense({ itemName: 'After replace', amount: 3 })
    expect(t.store.getState().applyImport(preview, 'replace').applied).toBe(0)
    expect(t.store.getState().expenses).toHaveLength(11)
    expect(t.store.getState().expenses.map((e) => e.itemName)).toContain('After replace')
  })
})

describe('another tab removes SpendTrack from this device', () => {
  it('this tab reloads as it hears of it, and writes nothing back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const backing = new FakeBacking()
    const a = await bootTab({ backing, keys: ownerV4({ rows: 10, noSync: true }).keys })
    await settle()
    a.store.getState().addExpense({ itemName: 'Written', amount: 1 })
    await settle()
    const b = await bootTab({ backing, install: true })
    await settle()
    // tab A wipes (Remove from this device)
    for (const k of [...backing.data.keys()]) backing.data.delete(k)
    backing.notify(a.view, 'st5:db', 'x', null)
    backing.deliver()
    vi.advanceTimersByTime(300)
    await settle()
    expect(reload.calls).toBeGreaterThan(0)
    // a change made before the reload lands is never written over the removal
    b.store.getState().addExpense({ itemName: 'Too late', amount: 2 })
    await settle()
    vi.advanceTimersByTime(2000)
    expect([...backing.data.keys()].filter((k) => k.startsWith('st5:'))).toEqual([])
    for (const k of V4_DATA_KEYS) expect(backing.data.has(k), k).toBe(false)
  })
})

describe('an old 0.9.2 tab’s whole-array write folds in at its real rank (P2-6)', () => {
  it('its edit at the same stamp beats a value migrated from an older build', async () => {
    const f = ownerV4({ rows: 10, noSync: true })
    // migrated from a build older than 0.8.5: the rows are rank 0
    const { 'spendtrack:app': _app, ...older } = f.keys
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: older, install: true })
    hidePage()
    await settle()
    const row = must(f.rows[0], 'row')
    const shown = must(
      t.store.getState().expenses.find((e) => e.id === row.id),
      'shown',
    )
    // 0.9.2 (marker 0.8.5, rank 1) saves the row with the same stamp and 0.01: by value alone
    // ours would win the tie (canon "0.01" sorts below any other amount); by rank, theirs does
    const lower = 0.01
    expect(shown.amount).not.toBe(lower)
    const rows = parseJson(must(b.data.get('expenses'), 'expenses'))
    if (!Array.isArray(rows)) throw new Error('expenses is not an array')
    // as 0.9.2 writes a row it built itself: no v5 seal or field stamps, one stamp for the row
    const edited = rows.map((r: unknown) =>
      isPlainObject(r) && own(r, 'id') === row.id
        ? {
            ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'h' && k !== 'fs')),
            amount: lower,
          }
        : r,
    )
    b.data.set('expenses', JSON.stringify(edited))
    b.data.set('spendtrack:app', '0.8.5')
    const next = await bootTab({ backing: b })
    await settle()
    expect(next.store.getState().expenses.find((e) => e.id === row.id)?.amount).toBe(lower)
  })
})

describe('two 0.10.0 tabs with sync on', () => {
  it('a change waiting to sync in one tab survives the other tab’s write (the outbox joins)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const backing = new FakeBacking()
    seed(backing, { syncId: 'invented-sync-code-0000-test' })
    const a = await bootTab({ backing, install: true })
    const b = await bootTab({ backing, install: true })
    const fromA = a.store.getState().addExpense({ itemName: 'From A', amount: 1 })
    await settle()
    // B writes before it heard A's storage event: its flush reads A's envelope first
    b.store.getState().addExpense({ itemName: 'From B', amount: 2 })
    await settle()
    const c = await bootTab({ backing })
    const outbox = must(c.mod.getSyncPort(), 'port').outbox()
    expect(outbox.has(`ex:${fromA.id}`)).toBe(true)
  })
})

describe('Remove from this device', () => {
  it('writes nothing again, not even a snapshot compression already in flight', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // a compression that finishes only when the test says so
    class HeldCompression extends TransformStream<Uint8Array, Uint8Array> {
      constructor(_format: string) {
        super({
          async flush() {
            await gate
          },
        })
      }
    }
    vi.stubGlobal('CompressionStream', HeldCompression)
    const b = new FakeBacking()
    seed(b, ownerV4({ rows: 50, noSync: true }).keys)
    await bootTab({ backing: b })
    await settle()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(T0 + 60_000)
    const t = await bootTab({ backing: b })
    // the pre-v5 copy's compression starts, and waits
    await vi.advanceTimersByTimeAsync(RESUME_DELAY + 50)
    const removing = t.store.getState().removeDataFromThisDevice()
    expect([...b.data.keys()].filter(isSpendTrackKey)).toEqual([])
    release()
    await removing
    // the held compression finishes on real I/O turns (MessageChannel is not faked)
    for (let i = 0; i < 20; i++) await nextTurn()
    expect([...b.data.keys()].filter(isSpendTrackKey)).toEqual([])
    expect(reload.calls).toBe(1)
  })
})

describe('an add’s confirmation (§6.5)', () => {
  it('reads the save the add just made: the first add storage refuses is never a tick', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 10, noSync: true }).keys })
    await settle()
    b.failures.set('st5:db', 'quota')
    t.store.getState().addExpense({ itemName: 'Lunch', amount: 5 })
    // chosen at once, as confirmAdded does: no microtask has run yet
    expect(unsavedNote(t.store.getState().saveNow())).toBe('Not saved on this device yet')
    expect(t.store.getState().local).toBe('error-quota')
  })
})
