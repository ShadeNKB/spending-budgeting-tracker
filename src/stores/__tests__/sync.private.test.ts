// PRIVATE-SYNC release 1 (PR-6): a private bucket on the real engine, against a relay that only
// ever holds ciphertext for it. AC-P1 to P9, P12 to P16, and 3.9. Invented data; the code is the
// codec's known-answer vector (a secret of bytes 00..0f), never a real one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeSt5 } from '../../data/core/codes'
import { deriveKeys, open, seal } from '../../data/core/e2e'
import { isRecord } from '../../lib/backup'
import type { CloudStatus } from '../useSyncStore'
import {
  SYNC_CODE,
  bootDevice,
  connect,
  dropRealtime,
  expense,
  liveIds,
  migrate,
  payloadOf,
  relay,
  requestsOf,
  resetRelay,
  retireDevices,
  rowPayload,
  rowStamp,
  seedRow,
  steadyRandom,
  stubRelayEnv,
  type Device,
} from '../../__tests__/fakeRelay'
import { realWorkPending, trackRealWork, untrackRealWork } from '../../__tests__/realWork'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)
const MINUTE = 60_000
const CODE = encodeSt5(Uint8Array.from({ length: 16 }, (_, i) => i))
/** What `deriveKeys` gives for that secret (the vector in core/e2e.test.ts). */
const ROW = 'e4555323-21f5-8f92-8c6a-97e208c0967b'
const TOPIC = 'st:LlILSIkurgodVGmluLVEOQ'

// WebCrypto and compression streams settle on real tasks, which fake timers never run. A
// message channel is a real task the fake clock does not own: one round of it lets them finish
// between steps of the fake clock.
const realTick = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

/**
 * One step of the fake clock, taken only once no WebCrypto call or gzip stream is in flight.
 * Until then only real tasks run: real work takes what it takes on this machine, and none of
 * that becomes fake time, so a fake budget or deadline is reached at the same point however
 * loaded the machine is.
 */
async function step(done: () => boolean): Promise<void> {
  while (realWorkPending() > 0 && !done()) await realTick()
  if (done()) return
  await vi.advanceTimersByTimeAsync(20)
  await realTick()
}

/** Runs the fake clock and real tasks in turn until `promise` settles (or `ms` of fake time). */
async function run<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  const state = { settled: false }
  const mark = () => {
    state.settled = true
  }
  const settled = () => state.settled
  promise.then(mark, mark)
  for (let waited = 0; waited < ms && !settled(); waited += 20) await step(settled)
  return promise
}

/** Runs the clocks until `done()` holds (or `ms` of fake time). */
async function until(done: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 20) await step(done)
}

/** Lets cycles that nobody awaits (a commit's push, a poll) run out. */
const idle = (ms = 4000) => run(new Promise<void>((resolve) => setTimeout(resolve, ms)), ms + 100)

/**
 * Until `d` has sent what it changed, then a breath for what trails the push. A fixed wait is
 * not enough here: the push is sealed by real crypto, which takes what it takes under load.
 */
async function sent(d: Device): Promise<void> {
  await until(() => d.expense.useExpenseStore.getState().unsyncedChanges() === 0)
  await idle(300)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  vi.stubEnv('VITE_SYNC_RELAY', 'rpc')
  resetRelay()
  migrate('004')
  steadyRandom()
  trackRealWork()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  untrackRealWork()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

const start = (d: Device, join = false) =>
  run(d.sync.useSyncStore.getState().setupSync(CODE, join ? { join: true } : undefined))
const sync = (d: Device) => run(d.sync.useSyncStore.getState().triggerSync())
/**
 * What `d` shows once it is between cycles. A setup's or a Sync now's result is the cycle's that
 * took the request; a cycle another trigger asked for meanwhile (the live channel joining asks
 * for one 30 ms after a setup) may still be running when that result comes back, sealing with
 * real crypto that takes what it takes, so the status is read when that cycle has published its
 * outcome, not at whatever moment this machine's speed left it in.
 */
async function statusBetweenCycles(d: Device): Promise<CloudStatus> {
  await until(() => d.sync.useSyncStore.getState().cloudStatus !== 'syncing')
  return d.sync.useSyncStore.getState().cloudStatus
}
const add = (d: Device, itemName: string, amount = 1.5) =>
  d.expense.useExpenseStore.getState().addExpense({ itemName, amount })
const names = (d: Device) =>
  d.expense.useExpenseStore
    .getState()
    .expenses.map((e) => e.itemName)
    .sort()
const envelope = (): Record<string, unknown> => {
  const payload = rowPayload(ROW)
  if (!isRecord(payload)) throw new Error('no private row')
  return payload
}
/** Everything the relay was ever sent or holds, as text. */
const seenByRelay = (): string =>
  JSON.stringify([relay().requests, relay().pushes, [...relay().rows.entries()]])
/**
 * Whether `seen` names `code` in any form a request could carry it: whole, without its prefix,
 * or as the bare secret, in either case. Never by the three letters `ST5` alone: a few KB of
 * random base64url ciphertext holds those by chance about once in a hundred runs.
 */
const namesCode = (seen: string, code: string): boolean => {
  const flat = seen.toLowerCase()
  const whole = code.toLowerCase()
  return [whole, whole.slice(4), whole.replace(/-/g, '').slice(3)].some((form) =>
    flat.includes(form),
  )
}
const storedText = (d: Device): string => {
  const out: string[] = []
  for (let i = 0; i < d.storage.length; i++) {
    const key = d.storage.key(i) ?? ''
    out.push(`${key}=${d.storage.getItem(key) ?? ''}`)
  }
  return out.join('\n')
}

describe('a private bucket round-trips on ciphertext alone (AC-P1, AC-P2)', () => {
  it('two devices converge; the relay holds an envelope under the derived row, and never the code', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    expect(await start(laptop)).toMatchObject({ ok: true, pushed: true })
    const phone = await bootDevice({ expenses: [expense('e2', { itemName: 'Invented teh' })] })
    expect(await start(phone, true)).toMatchObject({ ok: true })
    await sent(phone)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented teh'])
    expect(names(phone)).toEqual(['Invented kopi', 'Invented teh'])

    add(phone, 'Invented laksa', 6.5)
    await sent(phone)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(names(laptop)).toContain('Invented laksa')

    // one row, under the derived id, holding the six envelope fields and nothing else
    expect([...relay().rows.keys()]).toEqual([ROW])
    expect(Object.keys(envelope()).sort()).toEqual(['ct', 'iv', 'k', 'r', 'st', 'z'])
    expect(envelope()).toMatchObject({ st: 5, k: 1 })
    // nothing the relay saw names an entry, the code or its secret
    const seen = seenByRelay()
    for (const word of ['Invented', 'kopi', 'laksa']) {
      expect(seen, word).not.toContain(word)
    }
    expect(namesCode(seen, CODE)).toBe(false)
    expect(namesCode(`p_row=${CODE.replace(/-/g, '').slice(3).toLowerCase()}`, CODE)).toBe(true)
    // every call named the derived row, by the sync functions, never forced
    const calls = requestsOf('rpc')
    expect(calls.length).toBeGreaterThan(3)
    for (const call of calls) expect(call.args?.p_row).toBe(ROW)
    expect(calls.some((c) => c.args?.p_force === true)).toBe(false)
    expect(requestsOf('upsert')).toEqual([])
  })

  it('the device keeps the code in its own key only, and shows it masked', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    expect(laptop.storage.getItem('syncId')).toBeNull()
    expect(laptop.storage.getItem('st5:sync')).not.toContain('ST5')
    expect(JSON.parse(laptop.storage.getItem('st5:synckey') ?? '{}')).toMatchObject({ code: CODE })
    // the code is in that one key and nowhere else on the device (the envelope's sync meta too)
    const elsewhere = storedText(laptop)
      .split('\n')
      .filter((line) => !line.startsWith('st5:synckey='))
      .join('\n')
    expect(elsewhere).not.toContain('ST5-')
    // what Settings shows of it: the last four symbols only
    expect(laptop.sync.useSyncStore.getState().view?.codeMasked).toBe('••••-…-GFS3')

    laptop.sync.useSyncStore.getState().disconnectSync()
    expect(storedText(laptop)).not.toContain('ST5-')
  })

  it('live updates use the derived topic and no row events', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    const text = JSON.stringify(relay().clientOptions) + seenByRelay()
    expect(text).not.toContain(`sync_id=eq.${ROW}`)
    expect(laptop.sync.useSyncStore.getState().view?.live).not.toBe('row-events')
    expect(TOPIC.startsWith('st:')).toBe(true)
  })
})

describe('what is not an envelope of this bucket is never merged (AC-P4, AC-P5)', () => {
  async function linked(): Promise<Device> {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    await idle(500)
    return laptop
  }

  it.each([
    ['a flipped ciphertext character', (e: Record<string, unknown>) => ({ ...e, ct: flip(e.ct) })],
    [
      'another revision on the same ciphertext',
      (e: Record<string, unknown>) => ({ ...e, r: 'A'.repeat(22) }),
    ],
    [
      'a plaintext payload with an injected entry',
      () => payloadOf([expense('evil', { itemName: 'Invented injection', amount: 999 })]),
    ],
    [
      'a plaintext moved marker',
      () => ({ version: '4.0', expenses: 'moved', categories: [], x5: { min: 99 } }),
    ],
    ['an empty object', () => ({})],
  ])('%s: not merged, repaired from this device', async (_label, tamper) => {
    const laptop = await linked()
    const before = envelope()
    seedRow(ROW, tamper(before))
    const result = await sync(laptop)
    expect(result).toMatchObject({ ok: true, pushed: true })
    expect(names(laptop)).toEqual(['Invented kopi'])
    expect(liveIds(laptop)).not.toContain('evil')
    // the row is this device's own sealed copy again, and it opens for a second device
    expect(envelope()).toMatchObject({ st: 5, k: 1 })
    expect(envelope().ct).not.toBe(before.ct)
    const phone = await bootDevice({ expenses: [] })
    expect(await start(phone, true)).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi'])
    // it was never fenced or paused by it
    expect(laptop.sync.useSyncStore.getState().lastError).toBeNull()
  })

  // The two variants only a holder of a key can make: both authenticate under some key, and
  // neither is this bucket's own copy.
  const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i)
  const freshIv = () => crypto.getRandomValues(new Uint8Array(12))
  async function innerOf(): Promise<string> {
    const opened = await open(envelope(), await deriveKeys(SECRET))
    if (!opened.ok) throw new Error('the row did not open')
    return JSON.stringify(opened.inner)
  }

  it('an authentic envelope whose inner revision is not the one on its label is not merged', async () => {
    const laptop = await linked()
    const relabelled = await seal(await innerOf(), await deriveKeys(SECRET), {
      r: 'B'.repeat(22),
      iv: freshIv(),
      z: 0,
    })
    if (!relabelled.ok) throw new Error('the copy did not seal')
    seedRow(ROW, relabelled.envelope)
    // unreadable, so repaired: merged, the same entries would have left nothing to push
    expect(await sync(laptop)).toMatchObject({ ok: true, pushed: true })
    expect(envelope().r).not.toBe('B'.repeat(22))
    expect(laptop.sync.useSyncStore.getState().lastError).toBeNull()
  })

  it('an envelope copied from another private sync is not merged', async () => {
    const laptop = await linked()
    const elsewhere = await deriveKeys(Uint8Array.from({ length: 16 }, (_, i) => 255 - i))
    const foreign = await seal(await innerOf(), elsewhere, {
      r: String(envelope().r),
      iv: freshIv(),
      z: 0,
    })
    if (!foreign.ok) throw new Error('the copy did not seal')
    seedRow(ROW, foreign.envelope)
    expect(await sync(laptop)).toMatchObject({ ok: true, pushed: true })
    expect(envelope().ct).not.toBe(foreign.envelope.ct)
    const phone = await bootDevice({ expenses: [] })
    expect(await start(phone, true)).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi'])
  })

  it('an older valid envelope put back loses nothing', async () => {
    const laptop = await linked()
    const old = envelope()
    add(laptop, 'Invented laksa', 6.5)
    await sent(laptop)
    expect(envelope().r).not.toBe(old.r)
    seedRow(ROW, old)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented laksa'])
    const phone = await bootDevice({ expenses: [] })
    await start(phone, true)
    expect(names(phone)).toEqual(['Invented kopi', 'Invented laksa'])
  })
})

const flip = (ct: unknown): string => {
  const text = typeof ct === 'string' ? ct : ''
  return (text.startsWith('A') ? 'B' : 'A') + text.slice(1)
}

describe('a newer format, and conflicts (AC-P6, AC-P7, AC-P8)', () => {
  it('a newer envelope pauses and is never written over', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    const newer = { st: 6, k: 1, r: 'B'.repeat(22), iv: 'A'.repeat(16), z: 0, ct: 'AAAA' }
    seedRow(ROW, newer)
    add(laptop, 'Invented laksa')
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    await idle(5 * MINUTE)
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    expect(rowPayload(ROW)).toEqual(newer)
    // the edit is kept and still waiting
    expect(names(laptop)).toContain('Invented laksa')
    expect(laptop.expense.useExpenseStore.getState().unsyncedChanges()).toBeGreaterThan(0)
  })

  it('a copy marked newer is remembered: the polls that follow do not pull it again', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    seedRow(ROW, { st: 6, k: 1, r: 'B'.repeat(22), iv: 'A'.repeat(16), z: 0, ct: 'AAAA' })
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    const calls = (fn: string) => requestsOf('rpc').filter((c) => c.fn === fn).length
    const pulls = calls('st_sync_pull')
    const heads = calls('st_sync_head')
    // nothing is waiting to be sent, so a poll may ask for the row's stamp alone
    await idle(11 * MINUTE)
    expect(calls('st_sync_head')).toBeGreaterThan(heads)
    expect(calls('st_sync_pull')).toBe(pulls)
  })

  it('a private row is never force-written: every write names the copy it was merged from', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    // another device keeps landing a write just before each of ours
    relay().beforeWrite = () => {
      const current = rowPayload(ROW)
      relay().beforeWrite = null
      seedRow(ROW, current)
      relay().beforeWrite = bump
    }
    const bump = relay().beforeWrite
    add(laptop, 'Invented laksa')
    const result = await sync(laptop)
    relay().beforeWrite = null
    expect(result).toMatchObject({ ok: false, error: 'busy' })
    const pushes = requestsOf('rpc').filter((c) => c.fn === 'st_sync_push')
    expect(pushes.length).toBeGreaterThanOrEqual(6)
    expect(pushes.some((c) => c.args?.p_force === true)).toBe(false)
    // and once the other device is quiet, the edit goes through
    expect(await sync(laptop)).toMatchObject({ ok: true, pushed: true })
  })

  it('every seal draws a fresh IV, whatever the engine generator returns', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    const ivs = new Set<unknown>([envelope().iv])
    for (const name of ['Invented a', 'Invented b', 'Invented c']) {
      add(laptop, name)
      await sent(laptop)
      ivs.add(envelope().iv)
    }
    // Math.random is pinned by steadyRandom(): four writes, four IVs all the same
    expect(ivs.size).toBe(4)
  })
})

// PRIVATE-SYNC 3.9: "newer" is read off a header nobody signed, so a damaged or forged one would
// pause a private sync for good. The owner, and only the owner, may write over it.
describe("the owner's way out of a copy marked newer (3.9)", () => {
  const NEWER = { st: 6, k: 1, r: 'B'.repeat(22), iv: 'A'.repeat(16), z: 0, ct: 'AAAA' }
  const pushCalls = () => requestsOf('rpc').filter((c) => c.fn === 'st_sync_push')
  const replace = async (d: Device) => run((await d.sync.loadSyncEngine()).replaceRelayCopy())

  it('replaces it with this device’s copy, by compare-and-set on the copy just pulled', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    await idle(500)
    seedRow(ROW, NEWER)
    const stamp = rowStamp(ROW)
    add(laptop, 'Invented laksa')
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    const before = pushCalls().length

    expect(await replace(laptop)).toMatchObject({ ok: true, pushed: true })
    const pushes = pushCalls().slice(before)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.args).toMatchObject({ p_base: stamp, p_force: false })
    expect(envelope()).toMatchObject({ st: 5, k: 1 })
    expect(laptop.sync.useSyncStore.getState().lastError).toBeNull()
    expect(laptop.expense.useExpenseStore.getState().unsyncedChanges()).toBe(0)

    // the copy is readable again: a second device joins it
    const phone = await bootDevice()
    expect(await start(phone, true)).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi', 'Invented laksa'])
  })

  it('does not wait out the pace of automatic repairs', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    // a repair has just run: the next automatic one is ten minutes away
    seedRow(ROW, { ...envelope(), ct: flip(envelope().ct) })
    expect(await sync(laptop)).toMatchObject({ ok: true, pushed: true })
    seedRow(ROW, { ...envelope(), ct: flip(envelope().ct) })
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'invalid' })
    seedRow(ROW, NEWER)
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    expect(await replace(laptop)).toMatchObject({ ok: true, pushed: true })
    expect(envelope()).toMatchObject({ st: 5 })
  })

  it('a write that lands first is not written over: the replace merges it instead', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    const phone = await bootDevice()
    await start(phone, true)
    add(phone, 'Invented teh')
    await sent(phone)
    const phoneCopy = envelope()
    seedRow(ROW, NEWER)
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    // the phone's copy comes back just before the laptop's replacing write
    relay().beforeWrite = () => {
      relay().beforeWrite = null
      seedRow(ROW, phoneCopy)
    }
    expect(await replace(laptop)).toMatchObject({ ok: true })
    relay().beforeWrite = null
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented teh'])
    expect(pushCalls().some((c) => c.args?.p_force === true)).toBe(false)
  })

  it('is the owner’s alone: the next cycle does not write over a newer copy', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    seedRow(ROW, NEWER)
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    expect(await replace(laptop)).toMatchObject({ ok: true })
    seedRow(ROW, NEWER)
    add(laptop, 'Invented laksa')
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'update-required' })
    await idle(11 * MINUTE)
    expect(rowPayload(ROW)).toEqual(NEWER)
  })

  it('does nothing on a plain sync', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await run(connect(laptop))
    await idle(500)
    const before = relay().requests.length
    expect(await replace(laptop)).toMatchObject({ ok: false, error: 'off' })
    expect(relay().requests.length).toBe(before)
  })
})

describe('transports and the fence (AC-P14, AC-P16)', () => {
  it('on the upsert transport a private bucket pauses and writes nothing', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'table')
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    expect(await start(laptop)).toMatchObject({ ok: false, error: 'no-cas' })
    expect([...relay().rows.keys()]).toEqual([])
    expect(relay().upserts).toBe(0)
  })

  it('a device fenced out of its plain bucket joins the private one with its own edits', async () => {
    // the laptop already syncs privately; the phone is still on the plain code
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    const phone = await bootDevice({ expenses: [expense('e2', { itemName: 'Invented teh' })] })
    await run(connect(phone))
    seedRow(SYNC_CODE, {
      version: '4.0',
      expenses: 'moved',
      categories: [],
      x5: { min: 99, moved: { at: '2026-10-19T08:00:00.000Z', why: 'private' } },
    })
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    add(phone, 'Invented laksa', 6.5)
    await idle(2000)
    // fenced: the plain row is as the marker left it
    expect(rowPayload(SYNC_CODE)).toMatchObject({ expenses: 'moved' })

    expect(await start(phone, true)).toMatchObject({ ok: true })
    await sent(phone)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
    expect(names(phone)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
    // the fence went with the plain setup; the plain row was not touched again
    expect(phone.storage.getItem('st5:sync')).not.toContain('fenced')
    expect(rowPayload(SYNC_CODE)).toMatchObject({ expenses: 'moved' })
    expect(phone.sync.useSyncStore.getState().lastError).toBeNull()
  })
})

describe('the join preview for a private code (AC-P12)', () => {
  const preview = async (d: Device, input: string) =>
    run((await d.sync.loadSyncEngine()).previewJoin(input))

  it('a code that fails its check says what is wrong, and asks the relay nothing', async () => {
    const phone = await bootDevice({ expenses: [expense('e2')] })
    const requests = relay().requests.length
    const wrong = `${CODE.slice(0, -1)}${CODE.endsWith('3') ? '4' : '3'}`
    const message = async (input: string): Promise<string> => {
      const p = await preview(phone, input)
      return p.kind === 'failed' && p.result.error === 'invalid' ? p.result.message : p.kind
    }
    expect(await message(wrong)).toContain('One character of that code')
    expect(await message('ST5-0004106')).toContain('too short or too long')
    expect(await preview(phone, 'not a code')).toMatchObject({
      kind: 'failed',
      result: { message: "That code isn't valid." },
    })
    expect(relay().requests.length).toBe(requests)
  })

  it('a valid code with no row is "not found", asked for by its derived row only', async () => {
    const phone = await bootDevice({ expenses: [expense('e2')] })
    expect(await preview(phone, CODE)).toEqual({ kind: 'not-found', private: true })
    expect(namesCode(seenByRelay(), CODE)).toBe(false)
    expect(requestsOf('rpc').every((c) => c.args?.p_row === ROW)).toBe(true)
  })

  it('shows what joining would do before anything is merged or saved, however the code was typed', async () => {
    const laptop = await bootDevice({
      expenses: [expense('e1', { itemName: 'Invented kopi' }), expense('e3')],
    })
    await start(laptop)
    await idle(500)
    const phone = await bootDevice({ expenses: [expense('e2', { itemName: 'Invented teh' })] })
    const row = rowPayload(ROW)
    const typed = ` ${CODE.toLowerCase().replace(/-/g, ' ')} `
    expect(await preview(phone, typed)).toEqual({
      kind: 'found',
      code: CODE,
      here: 1,
      synced: 2,
      after: 3,
      removed: 0,
      unreadable: 0,
    })
    // read-only: nothing merged, nothing saved, nothing written
    expect(names(phone)).toEqual(['Invented teh'])
    expect(phone.storage.getItem('st5:synckey')).toBeNull()
    expect(phone.sync.useSyncStore.getState().syncId).toBeNull()
    expect(rowPayload(ROW)).toEqual(row)
  })

  it('a row that does not open with this code is unreadable: nothing is joined', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    seedRow(ROW, { ...envelope(), ct: flip(envelope().ct) })
    const phone = await bootDevice({ expenses: [] })
    expect(await preview(phone, CODE)).toEqual({ kind: 'unreadable' })
    seedRow(ROW, payloadOf([expense('evil')]))
    expect(await preview(phone, CODE)).toEqual({ kind: 'unreadable' })
    seedRow(ROW, { st: 6, k: 1, r: 'B'.repeat(22), iv: 'A'.repeat(16), z: 0, ct: 'AAAA' })
    expect(await preview(phone, CODE)).toEqual({ kind: 'newer' })
  })
})

describe('starting a new private sync (AC-P13)', () => {
  it('the engine makes a fresh, valid code each time; its first push creates the row and a second device joins', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    const engine = await laptop.sync.loadSyncEngine()
    const made = engine.newPrivateCode()
    expect(made).toMatch(/^ST5(-[0-9A-HJKMNP-TV-Z]{7}){4}$/)
    expect(engine.newPrivateCode()).not.toBe(made)
    // steadyRandom() pins Math.random: the code does not come from it
    expect(made).not.toBe(CODE)

    expect(await run(laptop.sync.useSyncStore.getState().setupSync(made))).toMatchObject({
      ok: true,
      pushed: true,
    })
    const rows = [...relay().rows.keys()]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(namesCode(seenByRelay(), made)).toBe(false)

    const phone = await bootDevice({ expenses: [] })
    const preview = await run((await phone.sync.loadSyncEngine()).previewJoin(made))
    expect(preview).toMatchObject({ kind: 'found', code: made, synced: 1 })
    expect(
      await run(phone.sync.useSyncStore.getState().setupSync(made, { join: true })),
    ).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi'])
  })
})

/**
 * Runs `during` once, while the first call of a WebCrypto step is pending: `encrypt` is inside
 * the engine's seal, `decrypt` inside its open. Later calls go straight through.
 */
function whilePending(step: 'encrypt' | 'decrypt', during: () => void): void {
  const subtle = globalThis.crypto.subtle
  const real: SubtleCrypto['encrypt'] = subtle[step].bind(subtle)
  const spy = step === 'encrypt' ? vi.spyOn(subtle, 'encrypt') : vi.spyOn(subtle, 'decrypt')
  let ran = false
  spy.mockImplementation((algorithm, key, data) => {
    const pending = real(algorithm, key, data)
    if (!ran) {
      ran = true
      queueMicrotask(during)
    }
    return pending
  })
}

describe('edits and bucket changes while a copy is being opened or sealed (AC-P3)', () => {
  const unsynced = (d: Device) => d.expense.useExpenseStore.getState().unsyncedChanges()
  const pushCount = () => requestsOf('rpc').filter((c) => c.fn === 'st_sync_push').length

  it('an edit made while the copy is being sealed is kept, and is not marked sent', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    await idle(500)
    add(laptop, 'Invented laksa')
    const one = unsynced(laptop)
    expect(one).toBeGreaterThan(0)
    whilePending('encrypt', () => {
      add(laptop, 'Invented teh')
    })
    expect(await sync(laptop)).toMatchObject({ ok: true, pushed: true })
    // the push carried the copy as it was when the seal began: only the later edit still waits
    expect(unsynced(laptop)).toBe(one)
    await sent(laptop)
    expect(unsynced(laptop)).toBe(0)
    const phone = await bootDevice()
    expect(await start(phone, true)).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
  })

  it('an edit made while the pulled copy is being opened goes out with that cycle', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    const phone = await bootDevice()
    await start(phone, true)
    // live updates are down: the laptop first hears of the phone's edit in the cycle below
    dropRealtime(true)
    add(phone, 'Invented teh')
    await sent(phone)
    expect(names(laptop)).toEqual(['Invented kopi'])
    whilePending('decrypt', () => {
      add(laptop, 'Invented laksa')
    })
    expect(await sync(laptop)).toMatchObject({ ok: true, pushed: true })
    expect(unsynced(laptop)).toBe(0)
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
    expect(await sync(phone)).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
  })

  it('Disconnect while the copy is being sealed stops the cycle: nothing is written', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    await idle(500)
    add(laptop, 'Invented laksa')
    const before = envelope()
    const pushes = pushCount()
    whilePending('encrypt', () => {
      laptop.sync.useSyncStore.getState().disconnectSync()
    })
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'off' })
    await idle()
    expect(pushCount()).toBe(pushes)
    expect(envelope()).toEqual(before)
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented laksa'])
  })

  it('Disconnect while the pulled copy is being opened stops the cycle: nothing is merged or written', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await start(laptop)
    const phone = await bootDevice()
    await start(phone, true)
    dropRealtime(true)
    add(phone, 'Invented teh')
    await sent(phone)
    expect(names(laptop)).toEqual(['Invented kopi'])
    const before = envelope()
    const pushes = pushCount()
    whilePending('decrypt', () => {
      laptop.sync.useSyncStore.getState().disconnectSync()
    })
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'off' })
    await idle()
    expect(pushCount()).toBe(pushes)
    expect(envelope()).toEqual(before)
    expect(names(laptop)).toEqual(['Invented kopi'])
  })
})

// The fixture: 2,500 entries with 200-character notes, about 97% of the plaintext limit
// (WIRE_PUSH_MAX). Sealed without compression its ciphertext alone is a third longer than that,
// past what the relay takes.
describe('size at the plaintext limit (AC-P15)', () => {
  const COUNT = 2500
  const big = () =>
    Array.from({ length: COUNT }, (_, i) =>
      expense(`b${String(i)}`, { itemName: `Invented ${String(i)}`, notes: 'x'.repeat(200) }),
    )

  it('with gzip the envelope is accepted, and a second device reads all of it', async () => {
    const laptop = await bootDevice({ expenses: big() })
    expect(await start(laptop)).toMatchObject({ ok: true, pushed: true })
    const pct = laptop.sync.useSyncStore.getState().view?.sizePct ?? 0
    expect(pct).toBeGreaterThanOrEqual(90)
    expect(pct).toBeLessThanOrEqual(100)
    expect(envelope()).toMatchObject({ st: 5, z: 1 })
    expect(JSON.stringify(envelope()).length).toBeLessThan(1024 * 1024)
    const phone = await bootDevice()
    expect(await start(phone, true)).toMatchObject({ ok: true })
    expect(liveIds(phone)).toHaveLength(COUNT)
  })

  it('without gzip it pauses too-large: nothing thrown, nothing written, nothing cut short', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const laptop = await bootDevice({ expenses: big() })
    expect(await start(laptop)).toMatchObject({ ok: false, error: 'too-large' })
    expect(await statusBetweenCycles(laptop)).toBe('paused')
    expect([...relay().rows.keys()]).toEqual([])
    expect(liveIds(laptop)).toHaveLength(COUNT)
    // paused, not failing: no retry writes later either
    await idle(5 * MINUTE)
    expect([...relay().rows.keys()]).toEqual([])
  })
})

// PRIVATE-SYNC 3.2 and AC-P3's second half: another tab of this browser changes the device's
// sync. A tab's engine holds its bucket in memory, so the change reaches it through storage
// alone: these tests write to the device's storage what the other tab's Disconnect, Generate
// or Join writes there. A tab left on a plain code would otherwise keep sending, unencrypted,
// what the device adds after it went private.
describe('a setup changed in another tab is followed (3.2, AC-P3)', () => {
  const askedFor = (row: string) =>
    relay().requests.filter((q) => JSON.stringify(q).includes(row)).length
  const pushCount = () => requestsOf('rpc').filter((c) => c.fn === 'st_sync_push').length
  const disconnectedElsewhere = (d: Device) => {
    for (const key of ['st5:synckey', 'st5:sync', 'syncId']) d.storage.removeItem(key)
  }
  /** Generate or Join of the private code in another tab: the key, and no plain mirror. */
  const privateElsewhere = (d: Device) => {
    d.storage.removeItem('syncId')
    d.storage.removeItem('st5:sync')
    d.storage.setItem('st5:synckey', JSON.stringify({ code: CODE, at: NOW, established: true }))
  }
  const linkedTo = (d: Device) => d.sync.useSyncStore.getState().syncId

  it('a tab on the plain code asks its row nothing once the device went private elsewhere', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await run(connect(laptop))
    await idle(500)
    const plainRow = rowPayload(SYNC_CODE)
    const asked = askedFor(SYNC_CODE)
    privateElsewhere(laptop)
    // added after the device went private: it must never reach the plain row
    add(laptop, 'Invented laksa')
    await until(() => relay().rows.has(ROW))
    await idle(500)
    expect(askedFor(SYNC_CODE)).toBe(asked)
    expect(rowPayload(SYNC_CODE)).toEqual(plainRow)
    expect(linkedTo(laptop)).toBe(CODE)
    // this tab syncs the private bucket now: the entry went out sealed
    expect(envelope()).toMatchObject({ st: 5 })
    expect(seenByRelay()).not.toContain('Invented laksa')
    const phone = await bootDevice()
    expect(await start(phone, true)).toMatchObject({ ok: true })
    expect(names(phone)).toEqual(['Invented kopi', 'Invented laksa'])
  })

  it('a Disconnect in another tab is followed: no request, and this tab reads as not linked', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    const before = envelope()
    const asked = relay().requests.length
    disconnectedElsewhere(laptop)
    add(laptop, 'Invented laksa')
    await idle()
    expect(relay().requests.length).toBe(asked)
    expect(envelope()).toEqual(before)
    expect(laptop.sync.useSyncStore.getState()).toMatchObject({ syncId: null, cloudStatus: 'off' })
    expect(names(laptop)).toContain('Invented laksa')
  })

  it('a fenced tab follows the private code joined in another tab, and leaves the plain row alone', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1', { itemName: 'Invented kopi' })] })
    await run(connect(laptop))
    seedRow(SYNC_CODE, {
      version: '4.0',
      expenses: 'moved',
      categories: [],
      x5: { min: 99, moved: { at: '2026-10-19T08:00:00.000Z', why: 'private' } },
    })
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'moved-private' })
    privateElsewhere(laptop)
    // the marker is later written over by a straggler: no fence in storage any more, and
    // still nothing may be asked of that row
    const plain = payloadOf([expense('straggler')])
    seedRow(SYNC_CODE, plain)
    const asked = askedFor(SYNC_CODE)
    add(laptop, 'Invented laksa')
    await until(() => linkedTo(laptop) === CODE)
    await idle(500)
    expect(askedFor(SYNC_CODE)).toBe(asked)
    expect(rowPayload(SYNC_CODE)).toEqual(plain)
    expect(linkedTo(laptop)).toBe(CODE)
    expect(liveIds(laptop)).not.toContain('straggler')
  })

  it('a setup changed elsewhere while a copy is being sealed gets no write', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    await start(laptop)
    await idle(500)
    add(laptop, 'Invented laksa')
    const before = envelope()
    const pushes = pushCount()
    whilePending('encrypt', () => {
      disconnectedElsewhere(laptop)
    })
    expect(await sync(laptop)).toMatchObject({ ok: false, error: 'off' })
    await idle()
    expect(pushCount()).toBe(pushes)
    expect(envelope()).toEqual(before)
    expect(linkedTo(laptop)).toBeNull()
  })

  it('a code storage refused still works for the session: nothing saved is not a change', async () => {
    const laptop = await bootDevice({ expenses: [expense('e1')] })
    const refuse = vi.spyOn(laptop.storage, 'setItem').mockImplementation((key) => {
      if (key === 'st5:synckey') throw new DOMException('full', 'QuotaExceededError')
    })
    expect(await start(laptop)).toMatchObject({ ok: true, pushed: true })
    refuse.mockRestore()
    expect(laptop.storage.getItem('st5:synckey')).toBeNull()
    add(laptop, 'Invented laksa')
    await sent(laptop)
    expect(linkedTo(laptop)).toBe(CODE)
    expect(laptop.expense.useExpenseStore.getState().unsyncedChanges()).toBe(0)
  })
})
