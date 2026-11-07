// 004's checks met on the table path (PR-4 track spec §3.5, AC 24; F-016, F-068). Migration 004
// refuses a new table write whose payload is over 2 MiB of jsonb text (sync_buckets_payload_bounded,
// 23514). A build on the table path meets it between 004 and the VITE_SYNC_RELAY=auto redeploy,
// and only with more than 2 MiB of bytes under the app's 900,000-character push limit: mostly a
// 3-byte script. That refusal pauses as "too large", as the functions' 22023 does: nothing is
// pushed again until the data shrinks, and what the other device writes still merges here. A 23514
// the size does not explain retries with the usual backoff.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WIRE_PUSH_MAX } from '../../data/core/constants'
import type { Expense } from '../../types'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  landedPushes,
  liveIds,
  migrate,
  payloadOf,
  relay,
  requestsOf,
  resetRelay,
  retireDevices,
  rowPayload,
  settle,
  steadyRandom,
  stubRelayEnv,
  writeAsOther,
  type Device,
} from '../../__tests__/fakeRelay'
import { syncMessage } from '../syncEngine'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
/** What 004's sync_buckets_payload_bounded allows: 2 MiB of jsonb text. */
const TABLE_PAYLOAD_MAX = 2 * 1024 * 1024

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const state = (d: Device) => d.sync.useSyncStore.getState()

/**
 * 200 invented entries with 3,600-character notes in a 3-byte script: about 760,000 characters on
 * the wire (under the push limit), about 2.2 MB of UTF-8 (over the table's 2 MiB).
 */
const CJK_ROWS: readonly Expense[] = Array.from({ length: 200 }, (_, i) =>
  expense(`k${String(i).padStart(3, '0')}`, { notes: '漢'.repeat(3600) }),
)

/** Every write the device sent (table or functions), as the relay saw it. */
const writes = () => relay().requests.filter((r) => r.kind !== 'head' && r.kind !== 'pull')

/** The last payload the device sent, as JSON text (its UTF-8 bytes are a floor of its jsonb text). */
function lastSent(): string {
  const payload = writes().at(-1)?.body?.payload
  return payload === undefined ? '' : JSON.stringify(payload)
}

describe('a table write refused by 004’s size check (23514)', () => {
  it.each([
    ['the plain upsert', {}],
    ['compare-and-set', { VITE_SYNC_CAS: 'on' }],
  ] as const)(
    'with %s: pauses as too large, with no backoff retry, and still merges what the other device writes',
    async (_label, env) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
      // 004 applied; this build has no VITE_SYNC_RELAY flag, so it stays on the table.
      migrate('004')
      const phone = await bootDevice({ expenses: CJK_ROWS })
      const result = await settle(state(phone).setupSync(SYNC_CODE), 10_000)

      expect(result).toMatchObject({ ok: false, error: 'too-large' })
      expect(state(phone)).toMatchObject({
        cloudStatus: 'paused',
        lastError: { kind: 'too-large' },
      })
      const kb = Number(/\((\d+) KB\)/.exec(state(phone).lastError?.message ?? '')?.[1])
      expect(state(phone).lastError?.message).toBe(syncMessage('too-large', kb))
      // It names the size of what was sent, as the functions' 22023 pause does.
      expect(Math.abs(kb - lastSent().length / 1024)).toBeLessThan(2)
      expect(state(phone).lastError?.retryAt).toBeUndefined()
      // The relay's refusal, not the device's own limit: it was sent to the table, under the push
      // limit in characters and over the table's limit in bytes, and nothing landed.
      expect(writes().length).toBeGreaterThan(0)
      expect(writes().every((r) => r.kind !== 'rpc')).toBe(true)
      expect(lastSent().length).toBeLessThanOrEqual(WIRE_PUSH_MAX)
      expect(new TextEncoder().encode(lastSent()).length).toBeGreaterThan(TABLE_PAYLOAD_MAX)
      expect(state(phone).view?.sizePct).toBeLessThanOrEqual(100)
      expect(landedPushes()).toBe(0)
      expect(rowPayload(SYNC_CODE)).toBeUndefined()

      // Paused, not failing: no backoff retry (2, 4, 8 … 60 s) sends the 2 MB again.
      const sent = writes().length
      await advance(2 * 60_000)
      expect(writes()).toHaveLength(sent)
      expect(state(phone)).toMatchObject({
        cloudStatus: 'paused',
        lastError: { kind: 'too-large' },
      })

      // The other device's write still merges here; nothing of this device's is lost.
      writeAsOther(SYNC_CODE, payloadOf([expense('lap1', { itemName: 'From the laptop' })]))
      await advance(5000)
      expect(liveIds(phone)).toContain('lap1')
      expect(liveIds(phone)).toHaveLength(CJK_ROWS.length + 1)
      expect(state(phone).lastError?.kind).toBe('too-large')
      expect(state(phone).cloudStatus).toBe('paused')
      expect(landedPushes()).toBe(0)
    },
  )

  it('a 23514 the size does not explain retries with backoff, then lands', async () => {
    steadyRandom()
    migrate('004')
    const phone = await bootDevice({ expenses: [expense('e1')] })
    await connect(phone)
    expect(state(phone).cloudStatus).toBe('synced')
    const landed = landedPushes()

    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    const at = Date.now()
    failNext('push', {
      status: 400,
      code: '23514',
      message:
        'new row for relation "sync_buckets" violates check constraint "sync_buckets_updated_at_finite"',
    })
    const result = await settle(state(phone).triggerSync(), 1000)
    expect(result).toMatchObject({ ok: false, error: 'invalid' })
    expect(state(phone)).toMatchObject({
      cloudStatus: 'error',
      lastError: { kind: 'invalid', message: syncMessage('invalid') },
    })
    // The first backoff step: 2 s (no jitter here).
    const retryAt = state(phone).lastError?.retryAt ?? 0
    expect(retryAt - at).toBeGreaterThanOrEqual(2000)
    expect(retryAt - at).toBeLessThan(2100)
    expect(landedPushes()).toBe(landed)

    // It sends it again then, and it lands.
    await advance(retryAt - Date.now() + 100)
    expect(state(phone)).toMatchObject({ cloudStatus: 'synced', lastError: null })
    expect(landedPushes()).toBe(landed + 1)
    expect(requestsOf('upsert').length).toBeGreaterThan(1)
  })
})
