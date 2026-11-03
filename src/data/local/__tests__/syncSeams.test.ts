// The local engine's seams for the sync engine v5 (PR-3 track spec §3.1, P3-3, P3-7): the new
// sync meta fields persist, read tolerantly and join across tabs as pairs; `register` commits the
// device registry without an outbox entry, a localRev bump or a new expenses Map. The two PR-2
// survivors are killed here by name: M23 (another tab's damaged envelope written over without a
// copy) and M34 (an outbox written while sync is off).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { must } from '../../__tests__/support/must'
import { isPlainObject, own } from '../../core/sanitize'
import type { DeviceInfo } from '../../core/types'
import { freshMeta, joinMeta, readMeta } from '../envelope'
import { FakeBacking } from './fakeStorage'
import { bootTab, envelopeOf, settle } from './harness'
import { ownerV4 } from './fixtures/v4Owner'

const T0 = Date.UTC(2026, 10, 2, 4)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const meEntry: DeviceInfo = {
  name: 'iPhone · Safari',
  app: '0.11.0',
  mode: 'table',
  e2e: false,
  seen: T0,
}

describe('sync meta (P3-3)', () => {
  it('starts empty and persists lastEtag, etagFor, transport, probedAt and v5pre', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 3 }).keys })
    const port = must(t.mod.getSyncPort(), 'port')
    expect(port.meta()).toMatchObject({
      lastEtag: null,
      etagFor: null,
      transport: null,
      probedAt: 0,
    })
    port.setMeta({
      lastEtag: '2026-11-02T04:00:00.123456+00:00',
      etagFor: 'abc123',
      transport: 'rpc',
      probedAt: T0,
      legacySeen: { v5pre: T0 - 5 },
    })
    const next = await bootTab({ backing: b })
    expect(must(next.mod.getSyncPort(), 'port').meta()).toMatchObject({
      lastEtag: '2026-11-02T04:00:00.123456+00:00',
      etagFor: 'abc123',
      transport: 'rpc',
      probedAt: T0,
      legacySeen: { v5pre: T0 - 5 },
    })
  })

  it('reads a damaged field as its fresh value', () => {
    const meta = readMeta({
      sync: {
        lastEtag: 5,
        etagFor: ['x'],
        transport: 'carrier-pigeon',
        probedAt: 'soon',
        legacySeen: { v5pre: 'yesterday', v084: 7 },
      },
    })
    expect(meta.sync).toMatchObject({
      lastEtag: null,
      etagFor: null,
      transport: null,
      probedAt: 0,
      legacySeen: { v084: 7 },
    })
    expect(meta.sync.legacySeen.v5pre).toBeUndefined()
  })

  it('joins another tab’s meta: the etag with its code as a pair, the newer probe, v5pre by max', () => {
    const base = freshMeta()
    const ours = {
      ...base,
      sync: {
        ...base.sync,
        lastEtag: 'ours',
        etagFor: 'code-a',
        transport: 'table' as const,
        probedAt: 100,
        legacySeen: { v5pre: 50 },
      },
    }
    const theirs = {
      ...base,
      sync: {
        ...base.sync,
        lastEtag: 'theirs',
        etagFor: 'code-b',
        transport: 'rpc' as const,
        probedAt: 200,
        legacySeen: { v5pre: 40 },
      },
    }
    expect(joinMeta(ours, theirs).sync).toMatchObject({
      lastEtag: 'theirs',
      etagFor: 'code-b',
      transport: 'rpc',
      probedAt: 200,
      legacySeen: { v5pre: 50 },
    })
    // theirs has no etag: ours stays, with ours's code (never theirs's code with ours's etag)
    const blank = { ...theirs, sync: { ...theirs.sync, lastEtag: null, etagFor: 'code-b' } }
    expect(joinMeta(ours, blank).sync).toMatchObject({ lastEtag: 'ours', etagFor: 'code-a' })
    // an older probe never replaces a newer one
    const older = { ...theirs, sync: { ...theirs.sync, probedAt: 10 } }
    expect(joinMeta(ours, older).sync).toMatchObject({ transport: 'table', probedAt: 100 })
  })
})

describe('register (P3-7)', () => {
  it('commits devices[id] with no outbox entry, no localRev bump and the same expenses Map', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 5 }).keys })
    await settle()
    const port = must(t.mod.getSyncPort(), 'port')
    const before = { doc: port.doc(), rev: port.localRev(), outbox: port.outbox() }
    const heard = vi.fn()
    const off = port.onCommit(heard)
    port.register('me0001', meEntry)
    off()
    const after = port.doc()
    expect(after.devices.get('me0001')).toEqual(meEntry)
    expect(after.expenses).toBe(before.doc.expenses)
    expect(after.tombs).toBe(before.doc.tombs)
    expect(port.localRev()).toBe(before.rev)
    expect(port.outbox()).toBe(before.outbox)
    expect(heard).not.toHaveBeenCalled()
    // flushed with the next flush (a microtask): it survives a reload
    await settle()
    const next = await bootTab({ backing: b })
    expect(must(next.mod.getSyncPort(), 'port').doc().devices.get('me0001')).toEqual(meEntry)
  })
})

describe('the PR-2 survivors, by name', () => {
  const FOREIGN = '5|00000000|{"f":2,"doc":{"broken":true}}'

  // M23: absorb() must keep a copy of another tab's envelope that does not read before this tab
  // writes over it, and must not write over it while no copy can be kept.
  it('M23 (absorb raw copy ignored): another tab’s damaged envelope is copied before it is written over', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 4, noSync: true }).keys })
    await settle()
    b.data.set('st5:db', FOREIGN)
    b.data.set('st5:gen', 'other-tab:7')
    b.prefixFailures.set('st5:q', 'quota')
    t.store.getState().addExpense({ itemName: 'Invented lunch', amount: 4.5 })
    await settle()
    // no copy possible: the damaged envelope is the only one, so it stays
    expect(b.data.get('st5:db')).toBe(FOREIGN)
    b.prefixFailures.clear()
    t.store.getState().addExpense({ itemName: 'Invented dinner', amount: 7 })
    await settle()
    const copies = [...b.data].filter(([k]) => k.startsWith('st5:q:st5:db:'))
    expect(copies.map(([, v]) => v)).toEqual([FOREIGN])
    expect(b.data.get('st5:db')).not.toBe(FOREIGN)
    expect(b.removes).toEqual([])
  })

  // M34: commit() adds to the outbox only while a sync code is saved.
  it('M34 (outbox written with sync off): changes with sync off leave the outbox empty, also after connecting', async () => {
    const b = new FakeBacking()
    const t = await bootTab({ backing: b, keys: ownerV4({ rows: 4, noSync: true }).keys })
    await settle()
    const s = t.store.getState()
    const added = s.addExpense({ itemName: 'Invented taxi', amount: 12 })
    s.updateExpense(added.id, { amount: 13 })
    s.addCategory('Invented hobby')
    s.setBudget('Invented hobby', 50)
    await settle()
    const meta = own(envelopeOf(b), 'meta')
    expect(isPlainObject(meta) ? own(meta, 'outbox') : null).toEqual([])
    expect(must(t.mod.getSyncPort(), 'port').outbox().size).toBe(0)
    // connecting later: what was done before is no outbox entry (the first cycle compares docs)
    b.data.set('syncId', 'invented-sync-code-0000-test')
    expect(t.store.getState().unsyncedChanges()).toBe(0)
    t.store.getState().addExpense({ itemName: 'Invented bus', amount: 1.2 })
    expect(t.store.getState().unsyncedChanges()).toBeGreaterThan(0)
  })
})
