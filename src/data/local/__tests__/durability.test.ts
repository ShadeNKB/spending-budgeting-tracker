// What keeps the owner's data when storage runs short (DATA-ENGINE-SPEC §9.7, §9.10, §9.11,
// track spec §13, P2-14, P2-16, P2-20): a migration that cannot fit never deletes the v4 keys, a
// lost envelope boots from its snapshots, snapshots and the journal restore after a reload, the
// rollback copy comes back once there is room, and a re-boot never drops an unsaved change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { must } from '../../__tests__/support/must'
import { isPlainObject, own } from '../../core/sanitize'
import * as ops from '../../core/ops'
import { decodeWire, encodeWire } from '../../core/wire'
import { V4_DATA_KEYS } from '../keys'
import { decodeSnapshot } from '../recovery'
import { RESUME_DELAY } from '../snapshots'
import { FakeBacking, seed } from './fakeStorage'
import { bootTab, settle, stored, type Tab } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 9, 19, 4)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const V4_NAMES = V4_DATA_KEYS

/** The setTimeout(0) after boot (the digest check, the mirror retry) and its flushes. */
async function afterBoot(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
}

interface SnapIndexEntry {
  readonly id: string
  readonly reason: string
  readonly z: number
}

function snapIndex(backing: FakeBacking): SnapIndexEntry[] {
  const list = stored(backing, 'st5:snaps')
  if (!Array.isArray(list)) return []
  return list.flatMap((e: unknown) => {
    if (!isPlainObject(e)) return []
    const id = own(e, 'id')
    const reason = own(e, 'reason')
    const z = own(e, 'z')
    return typeof id === 'string' && typeof reason === 'string' && typeof z === 'number'
      ? [{ id, reason, z }]
      : []
  })
}

/** A remote copy with `ids` deleted by another device. */
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

describe('storage full at the first v5 boot (§13, P2-16)', () => {
  it.each([false, true])(
    'never loses the v4 keys before an envelope holds them (sync on: %s)',
    async (sync) => {
      const f = ownerV4({ noSync: !sync })
      const probe = new FakeBacking()
      seed(probe, f.keys)
      const v = probe.used()
      // the band where the snapshot fits and the envelope only fits without the v4 keys (the
      // reviewer's sweep found 2.13V–2.43V), with margins either side
      for (let q = 1.9 * v; q <= 3.3 * v; q += 0.05 * v) {
        const b = new FakeBacking()
        seed(b, f.keys)
        b.quota = Math.round(q)
        const first = await bootTab({ backing: b })
        await settle()
        const shown = first.store.getState().expenses.length
        expect(shown).toBe(700)
        const label = `quota ${(q / v).toFixed(2)}V`
        if (!b.data.has('st5:db')) {
          // nothing durable replaced them: the v4 keys are still the data, byte for byte
          for (const k of V4_NAMES) expect(b.data.get(k), `${label} ${k}`).toBe(f.keys[k])
        }
        const next = await bootTab({ backing: b })
        await settle()
        expect(next.store.getState().expenses.length, label).toBe(700)
      }
    },
    120_000,
  )

  it('fits the envelope by keeping the v4 keys and dropping their copy (mirror off)', async () => {
    const f = ownerV4({ noSync: true })
    const probe = new FakeBacking()
    seed(probe, f.keys)
    const v = probe.used()
    const b = new FakeBacking()
    seed(b, f.keys)
    b.quota = Math.round(2.3 * v)
    const t = await bootTab({ backing: b })
    await settle()
    expect(b.data.has('st5:db')).toBe(true)
    for (const k of V4_NAMES) expect(b.data.get(k)).toBe(f.keys[k])
    expect(t.store.getState().facts.mirror).toBe('off')
    expect(t.store.getState().local).toBe('saved')
  })
})

describe('the snapshots are the data when the envelope and the v4 keys are gone (§9.6.3)', () => {
  it('boots from a pre-v5 snapshot, not to an empty app', async () => {
    const f = ownerV4({ noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    await bootTab({ backing: b })
    await settle()
    expect(snapIndex(b).some((s) => s.reason === 'pre-v5')).toBe(true)
    for (const k of [...b.data.keys()]) {
      if (k === 'st5:db' || k === 'st5:gen' || V4_NAMES.includes(k)) {
        b.data.delete(k)
      }
    }
    const t = await bootTab({ backing: b })
    await settle()
    expect(t.store.getState().expenses).toHaveLength(700)
    expect(t.store.getState().report?.kind).toBe('recovered')
    expect(b.data.has('st5:db')).toBe(true)
  })

  it('the snapshot rung of the ladder: a corrupt envelope with the mirror off', async () => {
    const f = ownerV4({ noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    await bootTab({ backing: b })
    await settle()
    for (const k of V4_NAMES) b.data.delete(k)
    b.data.set('st5:db', '5|0000000|{"f":1,"doc":nothing that reads')
    const t = await bootTab({ backing: b })
    await settle()
    // only the snapshots hold the rows: the damaged envelope and the absent mirror hold none
    expect(t.store.getState().expenses).toHaveLength(700)
    expect(t.store.getState().report?.kind).toBe('recovered')
  })
})

describe('a remote mass removal stays restorable after a reload (P2-20)', () => {
  it('the guard snapshot holds every removed record, and restores them after a re-boot', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 120 }).keys })
    await settle()
    const ids = t.store.getState().expenses.map((e) => e.id)
    const out = must(t.mod.getSyncPort(), 'port').applyRemote(remoteWithout(t, ids))
    const mass = must(out.mass, 'mass')
    await settle()
    const snap = must(
      snapIndex(b).find((s) => s.reason === 'mass'),
      'mass snapshot',
    )
    const text = must(b.data.get(`st5:snap:${snap.id}`), 'snapshot body')
    expect(text.startsWith('z0|')).toBe(true)
    const held = decodeSnapshot(text.slice(3), Date.now())
    for (const id of ids) expect(held.expenses.has(id), id).toBe(true)

    const next = await bootTab({ backing: b })
    await settle()
    expect(next.store.getState().expenses).toHaveLength(0)
    await expect(next.store.getState().restoreJournal(mass.entryId)).resolves.toMatchObject({
      applied: 120,
      skipped: 0,
    })
    expect(next.store.getState().expenses).toHaveLength(120)
  })

  it('without room for the snapshot, the journal keeps the records instead', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 120 }).keys })
    await settle()
    const ids = t.store.getState().expenses.map((e) => e.id)
    b.prefixFailures.set('st5:snap', 'quota')
    const out = must(t.mod.getSyncPort(), 'port').applyRemote(remoteWithout(t, ids))
    const mass = must(out.mass, 'mass')
    await settle()
    expect(snapIndex(b).some((s) => s.reason === 'mass')).toBe(false)
    b.prefixFailures.clear()

    const next = await bootTab({ backing: b })
    await settle()
    await expect(next.store.getState().restoreJournal(mass.entryId)).resolves.toMatchObject({
      applied: 120,
      skipped: 0,
    })
    expect(next.store.getState().expenses).toHaveLength(120)
  })
})

describe('a re-boot keeps what storage refused (P2-14)', () => {
  it('an entry added while the envelope could not be written survives hydrate()', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 30, noSync: true }).keys })
    await settle()
    b.failures.set('st5:db', 'quota')
    t.store.getState().addExpense({ itemName: 'Unsaved lunch', amount: 7.5 })
    await settle()
    expect(t.store.getState().local).toBe('error-quota')
    b.failures.clear()
    await t.store.getState().hydrate()
    await settle()
    expect(t.store.getState().expenses.map((e) => e.itemName)).toContain('Unsaved lunch')
    expect(t.store.getState().local).toBe('saved')
    // and it is on disk now
    const again = await bootTab({ backing: b })
    await settle()
    expect(again.store.getState().expenses.map((e) => e.itemName)).toContain('Unsaved lunch')
  })
})

describe('the rollback copy comes back when there is room (§9.10)', () => {
  it('P2-16: the v4 keys kept at migration get their pre-v5 copy, then the mirror', async () => {
    const f = ownerV4({ noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    b.prefixFailures.set('st5:snap', 'quota')
    const t = await bootTab({ backing: b })
    await settle()
    expect(t.store.getState().facts.mirror).toBe('off')
    expect(b.data.get('expenses')).toBe(f.keys.expenses)
    b.prefixFailures.clear()

    const next = await bootTab({ backing: b })
    await settle()
    await afterBoot()
    const pre = must(
      snapIndex(b).find((s) => s.reason === 'pre-v5'),
      'pre-v5 snapshot',
    )
    // the copy holds the original strings, taken before the mirror rewrote them
    const body = must(b.data.get(`st5:snap:${pre.id}`), 'pre-v5 body')
    expect(body).toContain(JSON.stringify(f.keys.expenses))
    expect(next.store.getState().facts.mirror).toBe('on')
    expect(b.data.get('spendtrack:app')).toBe('5')
  })

  it('a mirror shed under quota is written again at the next boot with room', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 40, noSync: true }).keys })
    await settle()
    await afterBoot()
    // the mirror is shed: an expenses write cannot fit, so its keys go (visibly)
    b.failures.set('expenses', 'quota')
    t.store.getState().addExpense({ itemName: 'Kopi', amount: 1.8 })
    await settle()
    t.mod.installPersistence()
    window.dispatchEvent(new Event('pagehide'))
    expect(t.store.getState().facts.mirror).toBe('off')
    expect(b.data.has('expenses')).toBe(false)
    b.failures.clear()

    const next = await bootTab({ backing: b })
    await settle()
    await afterBoot()
    expect(next.store.getState().facts.mirror).toBe('on')
    expect(String(b.data.get('expenses'))).toContain('Kopi')
  })

  it('stays off while storage is still full', async () => {
    const f = ownerV4({ noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    b.prefixFailures.set('st5:snap', 'quota')
    await bootTab({ backing: b })
    await settle()
    const next = await bootTab({ backing: b })
    await settle()
    await afterBoot()
    expect(next.store.getState().facts.mirror).toBe('off')
    for (const k of V4_NAMES) expect(b.data.get(k)).toBe(f.keys[k])
  })
})

// AC-1's one exception (spec §10, F-005): a row 0.9.4 listed with an unreadable date or an amount
// that is not positive leaves the Ledger and the totals on upgrade, kept whole for the owner. The
// upgrade toast's "· N need attention" counts them, so a total that changed has its reason.
describe('rows the upgrade cannot list are counted in its report (AC-1 exception)', () => {
  it('a refund amount and an unreadable date need attention, and are kept as they were', async () => {
    const good = {
      id: 'ok-1',
      itemName: 'invented laksa',
      amount: 6.5,
      category: 'Other',
      date: '2026-10-12T12:00:00',
      createdAt: '2026-10-12T04:00:00.000Z',
    }
    const rows = [
      good,
      { ...good, id: 'refund-1', itemName: 'invented refund', amount: -12.5 },
      { ...good, id: 'when-1', itemName: 'invented someday', date: 'last tuesday' },
    ]
    const t = await bootTab({ keys: { expenses: JSON.stringify(rows), categories: '["Other"]' } })
    await settle()
    expect(t.store.getState().expenses.map((e) => e.id)).toEqual(['ok-1'])
    expect(t.store.getState().report).toMatchObject({
      kind: 'upgraded',
      entries: 1,
      needsAttention: 2,
    })
    const file = JSON.stringify(t.store.getState().quarantineFile())
    expect(file).toContain('invented refund')
    expect(file).toContain('last tuesday')
  })
})

// Remove from this device asks for the backup first while changes are still only here (P2-9).
describe('what only this device holds', () => {
  it('counts the changes not on the relay yet with sync on, and none with sync off', async () => {
    const on = await bootTab({ keys: ownerV4({ rows: 5 }).keys })
    await settle()
    on.store.getState().addExpense({ itemName: 'Kopi', amount: 1.8 })
    expect(on.store.getState().unsyncedChanges()).toBeGreaterThan(0)
    const off = await bootTab({ keys: ownerV4({ rows: 5, noSync: true }).keys })
    await settle()
    off.store.getState().addExpense({ itemName: 'Kopi', amount: 1.8 })
    expect(off.store.getState().unsyncedChanges()).toBe(0)
  })
})

// §8.6: the owner's sessions are short (a quick add, then the app is closed), well inside the 35 s
// compression delay. The next boot compresses what an earlier session left as z0.
describe('a short session leaves its snapshots for the next boot to compress', () => {
  it('the pre-v5 copy taken at the upgrade is compressed after the next boot', async () => {
    const f = ownerV4({ rows: 200, noSync: true })
    const b = new FakeBacking()
    seed(b, f.keys)
    await bootTab({ backing: b })
    await settle()
    const pre = must(
      snapIndex(b).find((s) => s.reason === 'pre-v5'),
      'pre-v5 snapshot',
    )
    expect(pre.z).toBe(0)
    // closed before its 35 s delay ran out: nothing compressed it

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(T0 + 60_000)
    await bootTab({ backing: b })
    await vi.advanceTimersByTimeAsync(RESUME_DELAY + 50)
    await vi.waitFor(() => {
      expect(snapIndex(b).find((s) => s.id === pre.id)?.z).toBe(1)
    })
    expect(must(b.data.get(`st5:snap:${pre.id}`), 'body').startsWith('z1|')).toBe(true)
  })
})
