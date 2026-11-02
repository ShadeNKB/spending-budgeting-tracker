// ALL_KEYS (§9.2, track spec §8.11): every key the engine writes is listed, so "Remove from this
// device" and the raw export never miss one; and the quarantine never grows on repeats (P2-15).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { must } from '../../__tests__/support/must'
import { QUARANTINE_BYTES } from '../../core/constants'
import { decodeWire } from '../../core/wire'
import { ALL_KEYS, KEY_PREFIXES, isSpendTrackKey } from '../keys'
import { FakeBacking } from './fakeStorage'
import { bootTab, hidePage, settle } from './harness'
import { ownerV4, truncated, withKey } from './fixtures/v4Owner'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 9, 19, 4))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ALL_KEYS', () => {
  it('lists the v5 keys, the eight v4 keys, the code mirror and the device preferences', () => {
    for (const k of [
      'st5:db',
      'st5:gen',
      'st5:sync',
      'st5:dev',
      'st5:q',
      'st5:snaps',
      'st5:journal',
      'st5:demo',
      'expenses',
      'categories',
      'categoryMappings',
      'categoryMappingUpdatedAt',
      'categoryBudgets',
      'categoryBudgetUpdatedAt',
      'categoryBudgetDeletedAt',
      'deletedExpenseIds',
      'syncId',
      'categoryColors',
      'spendtrack:theme',
      'spendtrack:currency',
      'spendtrack:app',
      'spendtrack:dev',
    ]) {
      expect(ALL_KEYS).toContain(k)
    }
    expect(KEY_PREFIXES).toEqual(['st5:', 'spendtrack:'])
    expect(isSpendTrackKey('st5:snap:123')).toBe(true)
    expect(isSpendTrackKey('st5:q:expenses:1')).toBe(true)
    expect(isSpendTrackKey('sb-xyz-auth-token')).toBe(false)
  })

  it('covers every key written across migration, adds, mirror, snapshots, quarantine, journal and sync', async () => {
    const f = ownerV4({ rows: 60 })
    const backing = new FakeBacking()
    const keys = withKey(f, 'deletedExpenseIds', truncated(must(f.keys.deletedExpenseIds), 5))
    const { store, mod } = await bootTab({ backing, keys, install: true })
    const s = store.getState()
    const v = s.addExpense({ itemName: 'Chicken rice', amount: 4.5, category: 'Food & Dining' })
    s.updateExpense(v.id, { notes: 'with egg' })
    s.setBudget('Gaming', 20)
    s.setCurrency('SGD')
    s.renameCategory('Gaming', 'Games')
    s.deleteAllEverywhere()
    const port = must(mod.getSyncPort())
    port.applyRemote(
      decodeWire(
        { version: '4.0', expenses: [{ id: 'x', amount: 'NaN' }], deletedIds: [] },
        'remote',
      ),
    )
    port.setMeta({ repairAt: 1 })
    s.exportBackup()
    s.markAttentionSeen()
    hidePage()
    await settle()
    vi.advanceTimersByTime(60_000)
    const unknown = [...new Set(backing.sets)].filter((k) => !isSpendTrackKey(k))
    expect(unknown).toEqual([])
    expect(backing.sets.length).toBeGreaterThan(10)
  })
})

describe('the quarantine (P2-15)', () => {
  it('logs a repeated bad row once, however often a peer sends it', async () => {
    const { store, mod, backing } = await bootTab()
    const port = must(mod.getSyncPort())
    const payload = {
      version: '4.0',
      expenses: [{ id: 'bad', itemName: 'x', amount: 'abc', date: 'nope' }],
    }
    expect(port.applyRemote(decodeWire(payload, 'remote')).quarantined).toBe(1)
    const size = must(backing.data.get('st5:q')).length
    for (let i = 0; i < 20; i++) {
      expect(port.applyRemote(decodeWire(payload, 'remote')).quarantined).toBe(0)
    }
    expect(must(backing.data.get('st5:q')).length).toBe(size)
    expect(store.getState().attention).toEqual({
      quarantined: 1,
      copies: 0,
      unseen: 1,
      full: false,
    })
    store.getState().markAttentionSeen()
    expect(store.getState().attention.unseen).toBe(0)
  })

  it('stops growing at QUARANTINE_BYTES and says it is full, deleting nothing', async () => {
    const { store, mod, backing } = await bootTab()
    const port = must(mod.getSyncPort())
    const big = 'x'.repeat(60_000)
    for (let i = 0; i < 12; i++) {
      port.quarantine([{ at: i, origin: 'remote', reason: 'bad-date', raw: `${big}${String(i)}` }])
    }
    expect(must(backing.data.get('st5:q')).length).toBeLessThanOrEqual(QUARANTINE_BYTES)
    expect(store.getState().attention.full).toBe(true)
    expect(backing.removes).toEqual([])
  })

  it('downloads the needs-attention entries and raw copies, never the sync code', async () => {
    const f = ownerV4({ rows: 10 })
    const keys = {
      ...withKey(f, 'expenses', truncated(must(f.keys.expenses), 20)),
      'st5:q:st5:sync:1': '{"kind":"plain","code":"invented-secret"}',
    }
    const { store } = await bootTab({ keys })
    const file = JSON.stringify(store.getState().quarantineFile())
    expect(file).toContain('needs-attention')
    expect(file).toContain('st5:q:expenses:')
    expect(file).not.toContain('invented-secret')
  })
})
