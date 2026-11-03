// What the store says (PR-3 track spec P3-10, §3.10; AC-E13, AC-E19, AC-E20, T-016-1, T-016-2,
// T-018-2): the pending count equals the outbox after every commit and acknowledgement, "Synced"
// never shows with anything pending, a scheduled retry says when, every failing transport maps
// to its kind, the size meter reads the payload against the push limit, and the backoff waits
// 2, 4, 8 … 60 s ± 20 % — never while hidden or offline.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Expense } from '../../types'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  relay,
  relayRows,
  resetRelay,
  retireDevices,
  rowPayload,
  setVisibility,
  settle,
  steadyRandom,
  stubRelayEnv,
  writeAsOther,
  payloadOf,
  type Device,
  type Failure,
} from '../../__tests__/fakeRelay'
import { FULL_RELAY_MESSAGE, syncMessage } from '../syncEngine'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
const MINUTE = 60_000
const PUSH_LIMIT = 900_000

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

function portOf(d: Device) {
  const port = d.expense.getSyncPort()
  if (port === null) throw new Error('no port')
  return port
}

async function connected(expenses: Expense[] = [expense('e1')]): Promise<Device> {
  const d = await bootDevice({ expenses })
  await connect(d)
  return d
}

function goOffline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  window.dispatchEvent(new Event('offline'))
}

function goOnline() {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  window.dispatchEvent(new Event('online'))
}

describe('T-016-1: counts and honesty (AC-E19)', () => {
  it('T-016-1 pending equals the outbox after every commit and every acknowledgement', async () => {
    steadyRandom()
    const phone = await connected()
    goOffline()
    const s = phone.expense.useExpenseStore.getState()
    for (const name of ['Kopi', 'Kaya toast', 'Teh']) {
      s.addExpense({ itemName: name, amount: 1.2 })
      expect(state(phone).pending).toBe(portOf(phone).outbox().size)
    }
    expect(state(phone).pending).toBeGreaterThanOrEqual(3)
    goOnline()
    await advance(5000)
    expect(state(phone)).toMatchObject({ cloudStatus: 'synced', pending: 0, pendingLocal: false })
    expect(portOf(phone).outbox().size).toBe(0)
  })

  it('T-016-1 never says Synced while anything is pending', async () => {
    steadyRandom()
    const phone = await connected()
    relay().latency = { pull: 300, push: 500, realtime: 20 }
    const seen: { status: string; pending: number; pendingLocal: boolean }[] = []
    const off = phone.sync.useSyncStore.subscribe((st) => {
      seen.push({ status: st.cloudStatus, pending: st.pending, pendingLocal: st.pendingLocal })
    })
    for (let i = 0; i < 8; i++) {
      phone.expense.useExpenseStore
        .getState()
        .addExpense({ itemName: `Item ${String(i)}`, amount: 1 })
      await advance(400 + i * 150)
    }
    await advance(20_000)
    off()
    // A cycle may end "synced" while a change made during it waits for the next one: the state
    // then says so (pendingLocal), so no surface can call it Synced (I11).
    expect(seen.some((x) => x.pending > 0 && !x.pendingLocal)).toBe(false)
    expect(seen.some((x) => x.status === 'synced' && x.pending === 0)).toBe(true)
    expect(state(phone)).toMatchObject({ cloudStatus: 'synced', pending: 0 })
  })

  it('counts what an older device has not taken (waitingForOld is a number)', async () => {
    steadyRandom()
    const phone = await connected([expense('e1')])
    phone.expense.useExpenseStore.getState().updateExpense('e1', { notes: 'kept here' })
    const chatter = setInterval(() => {
      writeAsOther(SYNC_CODE, payloadOf([expense('e1')]))
    }, 600)
    await advance(MINUTE)
    clearInterval(chatter)
    expect(typeof state(phone).waitingForOld).toBe('number')
    expect(state(phone).waitingForOld).toBeGreaterThan(0)
  })

  it('T-016-1 a scheduled retry says when it runs (retryAt), and only while one is scheduled', async () => {
    steadyRandom()
    const phone = await connected()
    failNext('pull', { status: 503 })
    await settle(state(phone).triggerSync())
    expect(state(phone).lastError).toMatchObject({
      kind: 'server',
      retryAt: Date.now() - 100 + 2000,
    })
    await advance(2000)
    expect(state(phone).lastError).toBeNull()
    failNext('pull', { status: 401 })
    goOffline()
    expect(await settle(state(phone).triggerSync())).toMatchObject({ error: 'offline' })
    expect(state(phone).lastError?.retryAt).toBeUndefined()
  })
})

describe('T-016-1: every failing transport has its kind and words (AC-E20)', () => {
  const cases: [string, 'pull' | 'push', Failure, string, string][] = [
    ['a network failure', 'pull', { status: 0 }, 'network', syncMessage('network')],
    ['a 5xx', 'push', { status: 502, message: 'Bad Gateway' }, 'server', syncMessage('server')],
    ['a full relay (53400)', 'push', { status: 500, code: '53400' }, 'server', FULL_RELAY_MESSAGE],
    [
      'a refused payload (22023)',
      'push',
      { status: 400, code: '22023' },
      'invalid',
      syncMessage('invalid'),
    ],
    [
      'refused access (42501)',
      'pull',
      { status: 401, code: '42501' },
      'permission',
      syncMessage('permission'),
    ],
  ]

  it.each(cases)('T-016-1 %s', async (_label, op, failure, kind, message) => {
    steadyRandom()
    const phone = await connected()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    failNext(op, failure)
    const result = await settle(state(phone).triggerSync())
    expect(result).toEqual({ ok: false, error: kind, message })
    expect(state(phone)).toMatchObject({ cloudStatus: 'error', lastError: { kind, message } })
    expect(state(phone).pending).toBeGreaterThan(0)
  })

  it('T-016-1 refused table access with no sync functions pauses (denied) after one re-probe', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    const phone = await connected()
    relay().lockdown = true // 005 applied without 004: nothing lets this device in
    const probes = () =>
      relay().requests.filter((r) => r.kind === 'rpc' && r.fn === 'st_sync_head').length
    const before = probes()
    // (5 ms: this cycle only; the channel it re-subscribes without row events joins later)
    const result = await settle(state(phone).triggerSync(), 5)
    expect(result).toMatchObject({ ok: false, error: 'denied', message: syncMessage('denied') })
    expect(state(phone)).toMatchObject({ cloudStatus: 'paused', lastError: { kind: 'denied' } })
    expect(probes() - before).toBe(1) // asked once more, in the same cycle
    // a pause schedules no retry: the next trigger asks again, once, and pauses again
    await advance(MINUTE)
    expect(state(phone).lastError?.kind).toBe('denied')
  })

  it('T-016-1 refused table access with the sync functions there carries on through them', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    const phone = await connected()
    relay().rpc = 'present'
    relay().lockdown = true
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    expect(await settle(state(phone).triggerSync(), 1000)).toMatchObject({ ok: true, pushed: true })
    expect(relay().pushes.at(-1)?.via).toBe('rpc')
    expect(state(phone).view?.transport).toBe('rpc')
  })

  it('T-016-1 a 22023 for a payload over the functions’ limit pauses too-large', async () => {
    relay().rpc = 'present'
    vi.stubEnv('VITE_SYNC_RELAY', 'rpc')
    // 1,200 entries with long notes in a 3-byte script: under the push limit in characters,
    // over the relay's 1.2 MB in bytes.
    const notes = '漢'.repeat(400)
    const rows = Array.from({ length: 1200 }, (_, i) =>
      expense(`w${String(i).padStart(4, '0')}`, { notes }),
    )
    const phone = await bootDevice({ expenses: rows })
    const result = await settle(state(phone).setupSync(SYNC_CODE), 10_000)
    expect(result).toMatchObject({ ok: false, error: 'too-large' })
    expect(state(phone)).toMatchObject({ cloudStatus: 'paused', lastError: { kind: 'too-large' } })
  })
})

describe('T-016-2: the size meter', () => {
  /** Entries with notes of `n` characters. */
  const rowsOf = (count: number, n: number): Expense[] =>
    Array.from({ length: count }, (_, i) =>
      expense(`s${String(i).padStart(5, '0')}`, { notes: 'x'.repeat(n) }),
    )

  const pushedChars = () => JSON.stringify(rowPayload(SYNC_CODE)).length

  it('T-016-2 reads the pushed payload against the push limit, and reads 70 at 70 %', async () => {
    steadyRandom()
    // Measure what one entry costs on the wire, then size a doc to 70 % of the limit.
    const probe = await connected(rowsOf(1000, 200))
    const per1000 = pushedChars()
    expect(state(probe).view?.sizePct).toBe(Math.round((100 * per1000) / PUSH_LIMIT))
    retireDevices()
    resetRelay()
    const small = await connected(rowsOf(100, 200))
    const per100 = pushedChars()
    const perRow = (per1000 - per100) / 900
    const base = per100 - 100 * perRow
    const count = Math.round((0.7 * PUSH_LIMIT - base) / perRow)
    expect(state(small).view?.sizePct).toBe(Math.round((100 * per100) / PUSH_LIMIT))
    retireDevices()
    resetRelay()
    const phone = await connected(rowsOf(count, 200))
    expect(Math.abs(pushedChars() - 0.7 * PUSH_LIMIT)).toBeLessThan(perRow)
    expect(state(phone).view?.sizePct).toBe(70)
  })

  it('T-016-2 above 100 % pushes pause and merges continue', async () => {
    steadyRandom()
    const phone = await bootDevice({ expenses: rowsOf(4000, 200) })
    const result = await settle(state(phone).setupSync(SYNC_CODE), 10_000)
    expect(result).toMatchObject({ ok: false, error: 'too-large' })
    expect(state(phone).view?.sizePct).toBeGreaterThan(100)
    expect(relay().pushes).toHaveLength(0)
    writeAsOther(SYNC_CODE, payloadOf([expense('lap1', { itemName: 'From the laptop' })]))
    await advance(5000)
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.id)).toContain('lap1')
    expect(relay().pushes).toHaveLength(0)
    expect(state(phone).lastError?.kind).toBe('too-large')
  })
})

describe('T-018-2: backoff (AC-E13)', () => {
  it('T-018-2 retries after 2, 4, 8, 16, 32, 60, 60 s ± 20 %, never more than 72 s', async () => {
    const phone = await connected()
    failNext('pull', ...Array.from({ length: 9 }, (): Failure => ({ status: 503 })))
    await settle(state(phone).triggerSync(), 0)
    const gaps: number[] = []
    let last = Date.now()
    let pulls = relay().pulls
    for (let ms = 0; ms < 400_000 && gaps.length < 7; ms += 100) {
      await advance(100)
      if (relay().pulls > pulls) {
        pulls = relay().pulls
        gaps.push(Date.now() - last)
        last = Date.now()
      }
    }
    const nominal = [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]
    expect(gaps).toHaveLength(7)
    gaps.forEach((gap, i) => {
      const n = nominal[i] ?? 0
      expect(gap).toBeGreaterThanOrEqual(0.8 * n - 100)
      expect(gap).toBeLessThanOrEqual(1.2 * n + 100)
      expect(gap).toBeLessThanOrEqual(72_000)
    })
  })

  it("T-018-2 'online' runs a cycle at once and resets the backoff", async () => {
    steadyRandom()
    const phone = await connected()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    failNext('pull', ...Array.from({ length: 4 }, (): Failure => ({ status: 503 })))
    await settle(state(phone).triggerSync())
    await advance(2000 + 4000) // the next retry would wait 8 s
    const pulls = relay().pulls
    goOnline()
    await advance(100)
    expect(relay().pulls).toBe(pulls + 1)
    expect(state(phone).lastError?.retryAt).toBe(Date.now() - 100 + 2000)
  })

  it('T-018-2 runs no retry while hidden or offline; becoming visible resumes at once', async () => {
    steadyRandom()
    const phone = await connected()
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    failNext('pull', { status: 503 }, { status: 503 }, { status: 503 })
    await settle(state(phone).triggerSync()) // fails; a retry is due in 2 s
    setVisibility('hidden') // the pending change goes at once (it fails), then nothing retries
    await advance(100)
    const pulls = relay().pulls
    await advance(5 * MINUTE)
    expect(relay().pulls).toBe(pulls)
    setVisibility('visible')
    await advance(100)
    expect(relay().pulls).toBe(pulls + 1) // at once (it fails: the next waits 2 s)
    goOffline()
    await advance(5 * MINUTE)
    expect(relay().pulls).toBe(pulls + 1)
    goOnline()
    await advance(1000)
    expect(relay().pulls).toBe(pulls + 2)
    expect(state(phone)).toMatchObject({ cloudStatus: 'synced', pending: 0 })
    expect(relayRows()).toHaveLength(2)
  })
})
