// PRIVATE-SYNC release 2 (section 4): "Make sync private" on the real engine, against the fake
// relay. AC-M1 to AC-M15 and the engine half of AC-M19. Every test names its AC. Invented data;
// codes are made by the engine itself, never real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSt5 } from '../../data/core/codes'
import { PLAIN_MIN } from '../../data/core/constants'
import { deriveKeys } from '../../data/core/e2e'
import { newRev } from '../../data/core/ids'
import { encodeWire } from '../../data/core/wire'
import { isRecord } from '../../lib/backup'
import { collectRawStorage } from '../../lib/rescue'
import type { MoveView } from '../useSyncStore'
import {
  MemoryStorage,
  SYNC_CODE,
  bootDevice,
  dropRow,
  expense,
  failNext,
  liveIds,
  loadDevice,
  migrate,
  pruneStale,
  relay,
  requestsOf,
  resetRelay,
  retireDevices,
  rowPayload,
  rowStamp,
  seedRow,
  setClientOffline,
  setVisibility,
  steadyRandom,
  stubRelayEnv,
  writeAsOther,
  type Device,
  type StorageArea,
} from '../../__tests__/fakeRelay'
import { realWorkPending, trackRealWork, untrackRealWork } from '../../__tests__/realWork'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 60_000 })

const NOW = Date.UTC(2026, 10, 20, 8, 0, 0)
const MINUTE = 60_000
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// The clocks (as in sync.private.test.ts): real crypto runs on real tasks the fake clock never
// waits for, so the fake clock only moves while none is in flight.
// ---------------------------------------------------------------------------

const realTick = (): Promise<void> =>
  new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })

async function step(done: () => boolean): Promise<void> {
  while (realWorkPending() > 0 && !done()) await realTick()
  if (done()) return
  await vi.advanceTimersByTimeAsync(20)
  await realTick()
}

async function run<T>(promise: Promise<T>, ms = 60_000): Promise<T> {
  const state = { settled: false }
  const mark = () => {
    state.settled = true
  }
  const settled = () => state.settled
  promise.then(mark, mark)
  for (let waited = 0; waited < ms && !settled(); waited += 20) await step(settled)
  return promise
}

async function until(done: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 20) await step(done)
}

const idle = (ms = 4000) => run(new Promise<void>((resolve) => setTimeout(resolve, ms)), ms + 100)

// ---------------------------------------------------------------------------
// The sync lock (as in sync.race.test.ts): exclusive, granted in order, a request whose signal
// aborts while it waits is never granted.
// ---------------------------------------------------------------------------

interface Locks {
  /** Another tab takes the lock and is frozen before it lets go. */
  freeze(): void
  /** While on, every request is refused at once (a page that may not lock). */
  refuse(on: boolean): void
}

function installLocks(): Locks {
  let tail: Promise<void> = Promise.resolve()
  const state = { refusing: false }
  const request = (
    _name: string,
    opts: { signal?: AbortSignal },
    callback: () => Promise<unknown>,
  ): Promise<unknown> => {
    if (state.refusing) {
      return Promise.reject(new DOMException('Locks are not allowed', 'SecurityError'))
    }
    const before = tail
    let release: () => void = () => undefined
    tail = new Promise((resolve) => {
      release = resolve
    })
    return new Promise((resolve, reject) => {
      let aborted = false
      const onAbort = () => {
        aborted = true
        reject(new DOMException('The lock request is aborted', 'AbortError'))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      void before.then(async () => {
        opts.signal?.removeEventListener('abort', onAbort)
        if (aborted) {
          release()
          return
        }
        try {
          resolve(await callback())
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        } finally {
          release()
        }
      })
    })
  }
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true })
  return {
    freeze: () => {
      void request('st5:sync', {}, () => new Promise(() => undefined))
    },
    refuse: (on) => {
      state.refusing = on
    },
  }
}

let locks: Locks

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  vi.stubEnv('VITE_SYNC_RELAY', 'rpc')
  resetRelay()
  migrate('004')
  migrate('005')
  steadyRandom()
  trackRealWork()
  locks = installLocks()
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  untrackRealWork()
  Reflect.deleteProperty(navigator, 'locks')
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LAPTOP = 'lap001'
const PHONE = 'pho001'

const store = (d: Device) => d.sync.useSyncStore.getState()
const codeOf = (d: Device): string | null => store(d).syncId
const moveOf = (d: Device): MoveView | undefined => store(d).view?.move
const names = (d: Device) =>
  d.expense.useExpenseStore
    .getState()
    .expenses.map((e) => e.itemName)
    .sort()
const add = (d: Device, itemName: string, amount = 1.5) =>
  d.expense.useExpenseStore.getState().addExpense({ itemName, amount })
const unsynced = (d: Device) => d.expense.useExpenseStore.getState().unsyncedChanges()
const sync = (d: Device) => run(store(d).triggerSync())
const connectPlain = (d: Device) => run(store(d).setupSync(SYNC_CODE))
const join = (d: Device, code: string) => run(store(d).setupSync(code, { join: true }))
const makePrivate = async (d: Device) => run((await d.sync.loadSyncEngine()).makePrivate())
const record = (d: Device): Record<string, unknown> | null => {
  const raw = d.storage.getItem('st5:synckey:move')
  const v: unknown = raw === null ? null : JSON.parse(raw)
  return isRecord(v) ? v : null
}
const rowIdOf = async (code: string): Promise<string> => {
  const parsed = parseSt5(code)
  if (!parsed.ok) throw new Error('not a private code')
  return (await deriveKeys(parsed.secret)).rowId
}
/** The moved marker on the plain row now (`x5.moved`), or null when the row holds none. */
const markerOnPlain = (): Record<string, unknown> | null => {
  const p = rowPayload(SYNC_CODE)
  const x5 = isRecord(p) && p.expenses === 'moved' ? p.x5 : undefined
  const moved = isRecord(x5) ? x5.moved : undefined
  return isRecord(moved) ? moved : null
}
const pushesTo = (row: string) =>
  requestsOf('rpc').filter((c) => c.fn === 'st_sync_push' && c.args?.p_row === row)
const callsOn = (row: string, fn: string) =>
  requestsOf('rpc').filter((c) => c.fn === fn && c.args?.p_row === row).length

/** Laptop and phone, both on the plain code, both holding each other's entries. */
async function plainPair(): Promise<{ laptop: Device; phone: Device }> {
  const laptop = await bootDevice({
    dev: LAPTOP,
    expenses: [expense('e1', { itemName: 'Invented kopi' })],
  })
  expect(await connectPlain(laptop)).toMatchObject({ ok: true })
  const phone = await bootDevice({
    dev: PHONE,
    expenses: [expense('e2', { itemName: 'Invented teh' })],
  })
  expect(await connectPlain(phone)).toMatchObject({ ok: true })
  expect(await sync(laptop)).toMatchObject({ ok: true })
  await idle(500)
  expect(names(laptop)).toEqual(['Invented kopi', 'Invented teh'])
  return { laptop, phone }
}

const CONTESTED =
  "Another device may also have made this sync private. If your other device asks for a sync code, enter this one there. Only if it shows a code of its own: Disconnect one of them, then enter the other's code there. Your entries stay on each device and are merged."
const NEXT = 'Next: enter this code on your other device. It stops syncing until you do.'
const STRAGGLER =
  'Something was written to the old sync after it was closed. If a device of yours is still on it, update it and enter this sync code there.'
const NOT_CLOSED = 'The old sync is not closed yet. This device keeps trying.'
const BUSY = 'Sync is busy in another tab. Try again in a moment.'
const LOCKDOWN =
  "This sync's server still allows direct reads. Make sync private after the database lockdown."

const deviceIdOf = (d: Device): string => {
  const port = d.expense.getSyncPort()
  if (port === null) throw new Error('not hydrated')
  return port.deviceId()
}

/** A revision drawn from the platform (Math.random is pinned by steadyRandom). */
const freshRev = () => newRev(() => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32)

/** What `d`, a plain device of 0.21.0, writes to the plain row: its whole copy, as a cycle does. */
function plainWriteOf(d: Device): unknown {
  const port = d.expense.getSyncPort()
  if (port === null) throw new Error('not hydrated')
  return encodeWire(port.doc(), { dev: port.deviceId(), rev: freshRev(), min: PLAIN_MIN })
}

/** The relay clients a device has used (by the writes it landed). */
function clientsOf(d: Device): number[] {
  const dev = deviceIdOf(d)
  const ids = relay()
    .pushes.filter((p) => isRecord(p.payload) && isRecord(p.payload.x5) && p.payload.x5.dev === dev)
    .map((p) => p.client)
  return [...new Set(ids)]
}

/** The device loses (or gets back) its network: its requests fail, and it hears nothing. */
function offline(d: Device, off: boolean): void {
  for (const id of clientsOf(d)) setClientOffline(id, off)
}

/**
 * Runs `during` once, while the first call of a WebCrypto step is pending: `encrypt` is inside a
 * seal, `decrypt` inside an open. Later calls go straight through.
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

/** Runs `during` once, as the first write to a row `matches` lands (before it is applied). */
function onWriteTo(matches: (row: string) => boolean, during: () => void): void {
  relay().beforeWrite = (write) => {
    if (!matches(write.row)) return
    relay().beforeWrite = null
    during()
  }
}
const privateRow = (row: string) => row !== SYNC_CODE

type Rows = ReturnType<typeof relay>['rows']
const copyRows = (): Rows =>
  new Map([...relay().rows].map(([k, v]) => [k, { ...v, payload: structuredClone(v.payload) }]))
function restoreRows(rows: Rows): void {
  relay().rows.clear()
  for (const [k, v] of rows) relay().rows.set(k, { ...v, payload: structuredClone(v.payload) })
}
function itemsOf(area: StorageArea): Map<string, string> {
  const items = new Map<string, string>()
  for (let i = 0; i < area.length; i++) {
    const key = area.key(i)
    if (key !== null) items.set(key, area.getItem(key) ?? '')
  }
  return items
}

/** The device started again from what its storage held (a reload, or a crash and a start). */
async function reboot(items: Map<string, string>): Promise<Device> {
  const area = new MemoryStorage()
  for (const [k, v] of items) area.setItem(k, v)
  const d = await loadDevice(area)
  await d.expense.useExpenseStore.getState().hydrate()
  d.sync.installSync()
  return d
}

/** What a 0.21.0 tab writes when it saves the private setup (`savePrivateSync`): from scratch. */
function privateSetupWrittenBy0210(d: Device, code: string): void {
  d.storage.setItem('st5:synckey', JSON.stringify({ code, at: NOW, established: true }))
  d.storage.setItem('st5:sync', JSON.stringify({ kind: 'e2e', joinedAt: NOW, established: true }))
  d.storage.removeItem('syncId')
}

/** A record of the right shape for a private row this device does not hold. */
const voidRecord = (): string =>
  JSON.stringify({
    v: 1,
    for: 'abcdefg1234567',
    from: SYNC_CODE,
    at: NOW,
    phase: 'retiring',
    absorbed: null,
    retired: null,
    checkedAt: null,
    conflicts: 0,
    contested: false,
  })

const SYNC_KEYS: ReadonlySet<string> = new Set([
  'st5:synckey:move',
  'st5:synckey',
  'st5:sync',
  'syncId',
])

interface Moment {
  readonly label: string
  readonly items: Map<string, string>
  readonly rows: Rows
}

/**
 * Makes `d` private, keeping the device's storage and the relay as they were after each write
 * the move made: after each write of the sync keys, before each relay write (that is, after
 * the write before it), and at the end.
 */
async function recordMove(d: Device, during?: () => void): Promise<Moment[]> {
  const moments: Moment[] = []
  const take = (label: string) => {
    moments.push({ label, items: itemsOf(d.storage), rows: copyRows() })
  }
  const set = d.storage.setItem.bind(d.storage)
  const remove = d.storage.removeItem.bind(d.storage)
  const setSpy = vi.spyOn(d.storage, 'setItem').mockImplementation((key, value) => {
    set(key, value)
    if (SYNC_KEYS.has(key)) take(`after writing ${key}`)
  })
  const removeSpy = vi.spyOn(d.storage, 'removeItem').mockImplementation((key) => {
    remove(key)
    if (SYNC_KEYS.has(key)) take(`after removing ${key}`)
  })
  let ran = false
  relay().beforeWrite = ({ row }) => {
    take(`before a write to ${row === SYNC_CODE ? 'the plain row' : 'a private row'}`)
    // the other device's write lands while the move makes its private row
    if (row !== SYNC_CODE && !ran) {
      ran = true
      during?.()
    }
  }
  const moved = await makePrivate(d)
  relay().beforeWrite = null
  setSpy.mockRestore()
  removeSpy.mockRestore()
  expect(moved).toMatchObject({ ok: true })
  take('after the move')
  return moments
}

const engineOf = (d: Device) => d.sync.loadSyncEngine()
const codeMade = (moved: { ok: boolean; code?: string }): string => moved.code ?? ''

// ---------------------------------------------------------------------------

describe('the switch, as the running tab sees it (AC-M19)', () => {
  it('takes the private bucket and its topic; a Broadcast starts a cycle; the next-step line goes once the phone joined', async () => {
    const { laptop, phone } = await plainPair()
    expect(moveOf(laptop)?.offered).toBe(true)
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    const code = codeMade(moved)
    expect(codeOf(laptop)).toBe(code)
    const parsed = parseSt5(code)
    if (!parsed.ok) throw new Error('not a private code')
    const { rowId: row, topic } = await deriveKeys(parsed.secret)
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    expect(record(laptop)).toMatchObject({ phase: 'retired', from: SYNC_CODE })
    expect(moveOf(laptop)).toMatchObject({ phase: 'retired', alone: true, offered: false })
    expect(moveOf(laptop)?.lines).toEqual([NEXT])
    // subscribed to the private topic, with no row events
    await until(() => [...relay().channels].some((c) => c.name === topic && c.joined))
    const channel = [...relay().channels].find((c) => c.name === topic && c.joined)
    expect(channel?.hearsRow(row)).toBe(false)

    // the phone hears the marker's announcement on the plain topic, and asks for the code
    await until(() => store(phone).lastError?.kind === 'moved-private', 10_000)
    expect(store(phone).lastError?.kind).toBe('moved-private')
    expect(await join(phone, code)).toMatchObject({ ok: true })
    await idle(500)
    const pulls = callsOn(row, 'st_sync_pull')
    add(phone, 'Invented laksa')
    await until(() => unsynced(phone) === 0)
    // the laptop hears the phone's Broadcast: well before its next poll
    await until(() => names(laptop).includes('Invented laksa'), 10_000)
    expect(callsOn(row, 'st_sync_pull')).toBeGreaterThan(pulls)
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
    expect(moveOf(laptop)?.alone).toBe(false)
    expect(moveOf(laptop)?.lines).toEqual([])
    expect(moveOf(laptop)?.disconnect).toEqual([])
  })
})

describe('how Settings shows each line (tones, one per line)', () => {
  it('the next-step line is a note; a plain sync has no lines and no tones', async () => {
    const { laptop } = await plainPair()
    expect(moveOf(laptop)).toMatchObject({ lines: [], tones: [] })
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    expect(moveOf(laptop)?.lines).toEqual([NEXT])
    expect(moveOf(laptop)?.tones).toEqual(['note'])
  })

  it('"not closed yet" is a warning, and every line has its tone', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    relay().beforeWrite = (w) => {
      if (w.row === SYNC_CODE && !w.force) seedRow(SYNC_CODE, rowPayload(SYNC_CODE))
    }
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    relay().beforeWrite = null
    expect(moveOf(laptop)?.lines).toEqual([NOT_CLOSED, NEXT])
    expect(moveOf(laptop)?.tones).toEqual(['warning', 'note'])
  })
})

describe('a crash after any write of steps 3 to 5 (AC-M1)', () => {
  it.each([
    ['', false],
    [', the phone having written the old row during the move (the absorb’s writes)', true],
  ])(
    'ends with one live private row, the plain row holding this device’s marker, and both converged after the join%s',
    async (_label, phoneWrote) => {
      const { laptop, phone } = await plainPair()
      offline(phone, true)
      if (phoneWrote) add(phone, 'Invented laksa')
      await idle(1000) // saved on the phone before its storage is copied
      const phoneWrite = plainWriteOf(phone)
      const expected = phoneWrote
        ? ['Invented kopi', 'Invented laksa', 'Invented teh']
        : ['Invented kopi', 'Invented teh']
      const phoneItems = itemsOf(phone.storage)
      store(phone).disconnectSync()
      const moments = await recordMove(
        laptop,
        phoneWrote
          ? () => {
              writeAsOther(SYNC_CODE, phoneWrite)
            }
          : undefined,
      )
      if (phoneWrote) expect(names(laptop)).toContain('Invented laksa')
      store(laptop).disconnectSync()
      const labels = moments.map((m) => m.label)
      // each write of steps 3 to 5 has a moment after it: the private row made, the record, the
      // key, the config, the mirror removed, the marker, and the private cycle after it
      for (const label of [
        'before a write to a private row',
        'after writing st5:synckey:move',
        'after writing st5:synckey',
        'after writing st5:sync',
        'after removing syncId',
        'before a write to the plain row',
        'after the move',
      ]) {
        expect(labels).toContain(label)
      }
      for (const m of moments) {
        restoreRows(m.rows)
        const lap = await reboot(m.items)
        await idle(3000)
        if (codeOf(lap) === SYNC_CODE) {
          // crashed before the switch: still plain, and what the crash left does not block the press
          expect(await makePrivate(lap), m.label).toMatchObject({ ok: true })
        }
        const code = codeOf(lap) ?? ''
        expect(code.startsWith('ST5-'), m.label).toBe(true)
        await until(() => record(lap)?.phase === 'retired')
        expect(markerOnPlain(), m.label).toMatchObject({ why: 'private', by: LAPTOP })
        const row = await rowIdOf(code)
        const orphans = [...relay().rows].filter(([k]) => k !== SYNC_CODE && k !== row)
        const ph = await reboot(phoneItems)
        await until(() => store(ph).lastError?.kind === 'moved-private')
        expect(store(ph).lastError?.kind, m.label).toBe('moved-private')
        expect(await join(ph, code), m.label).toMatchObject({ ok: true })
        await until(() => unsynced(ph) === 0)
        expect(await sync(lap), m.label).toMatchObject({ ok: true })
        expect(names(lap), m.label).toEqual(expected)
        expect(names(ph), m.label).toEqual(expected)
        // a row the crash left is an orphan: nobody writes it again
        for (const [k, v] of orphans) expect(rowStamp(k), m.label).toBe(v.updated_at)
        store(lap).disconnectSync()
        store(ph).disconnectSync()
      }
    },
    600_000,
  )
})

describe('the record, in a key of its own (AC-M2)', () => {
  /** A move whose step 5 met a crossing write each time it tried: the record is `retiring`. */
  async function stillRetiring(): Promise<{ laptop: Device; code: string }> {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    relay().beforeWrite = (w) => {
      // another device's write lands just before each marker: its base is stale
      if (w.row === SYNC_CODE && !w.force) seedRow(SYNC_CODE, rowPayload(SYNC_CODE))
    }
    const moved = await makePrivate(laptop)
    relay().beforeWrite = null
    expect(moved).toMatchObject({ ok: true })
    expect(record(laptop)).toMatchObject({ phase: 'retiring' })
    expect(record(laptop)?.conflicts).toBeGreaterThanOrEqual(2)
    expect(markerOnPlain()).toBeNull()
    return { laptop, code: codeMade(moved) }
  }

  it('survives a 0.21.0 writer, a reload and a setup of the same code; the old row is closed after the reload', async () => {
    const { laptop, code } = await stillRetiring()
    const kept = record(laptop)
    expect(moveOf(laptop)?.lines[0]).toBe(NOT_CLOSED)
    expect(moveOf(laptop)?.disconnect).toEqual([
      'The old sync is not closed yet. A device still on it keeps syncing there, unencrypted.',
      'No other device has this sync code yet. Copy it first: a device waiting for it cannot join without it.',
    ])
    // a tab still on 0.21.0 (or one following the setup) saves it again, from scratch
    privateSetupWrittenBy0210(laptop, code)
    expect(record(laptop)).toEqual(kept)
    // a reload: the record resumes step 5 at the first private cycle
    const items = itemsOf(laptop.storage)
    store(laptop).disconnectSync()
    const again = await reboot(items)
    await until(() => record(again)?.phase === 'retired')
    expect(record(again)).toMatchObject({ for: kept?.for, from: SYNC_CODE, at: kept?.at })
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    // a setup of the same code keeps it
    const before = record(again)
    expect(await run(store(again).setupSync(code))).toMatchObject({ ok: true })
    expect(record(again)).toMatchObject({ for: before?.for, from: SYNC_CODE, phase: 'retired' })
  })

  it('is void, and removed when the engine starts, without st5:synckey or with another bucket’s', async () => {
    const { laptop, code } = await stillRetiring()
    const items = itemsOf(laptop.storage)
    store(laptop).disconnectSync()
    const other = (await engineOf(laptop)).newPrivateCode()
    expect(other).not.toBe(code)
    // past the grace a young record gets (another tab may be between the switch's two writes)
    vi.setSystemTime(Date.now() + 3 * MINUTE)
    for (const variant of ['no key', 'another bucket'] as const) {
      const copy = new Map(items)
      if (variant === 'no key') {
        copy.delete('st5:synckey')
        copy.delete('st5:sync')
      } else {
        copy.set('st5:synckey', JSON.stringify({ code: other, at: NOW, established: true }))
      }
      const asked = callsOn(SYNC_CODE, 'st_sync_pull') + callsOn(SYNC_CODE, 'st_sync_push')
      const d = await reboot(copy)
      await until(() => record(d) === null)
      expect(record(d), variant).toBeNull()
      await idle(2000)
      // and nothing was asked of the old row on its behalf
      expect(callsOn(SYNC_CODE, 'st_sync_pull') + callsOn(SYNC_CODE, 'st_sync_push'), variant).toBe(
        asked,
      )
      store(d).disconnectSync()
    }
  })

  it('a record for another bucket is never acted on, even when it appears while the engine runs', async () => {
    const tablet = await bootDevice({ dev: 'tab001', expenses: [expense('t1')] })
    const code = (await engineOf(tablet)).newPrivateCode()
    expect(await run(store(tablet).setupSync(code))).toMatchObject({ ok: true })
    tablet.storage.setItem('st5:synckey:move', voidRecord())
    const asked = relay().requests.filter((q) => JSON.stringify(q).includes(SYNC_CODE)).length
    expect(await sync(tablet)).toMatchObject({ ok: true })
    await idle(2000)
    expect(record(tablet)).toBeNull()
    expect(relay().requests.filter((q) => JSON.stringify(q).includes(SYNC_CODE)).length).toBe(asked)
  })
})

describe('a lost answer (AC-M3)', () => {
  it('at step 3 leaves the device plain with one orphan row, and the next press makes another', async () => {
    const { laptop } = await plainPair()
    const pushes = relay().pushes.length
    // the private row's create lands, but its answer never comes back
    failNext('push', { ghost: 10 })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: false })
    expect(
      relay()
        .pushes.slice(pushes)
        .map((p) => p.syncId === SYNC_CODE),
    ).toEqual([false])
    expect(codeOf(laptop)).toBe(SYNC_CODE)
    expect(record(laptop)).toBeNull()
    expect(laptop.storage.getItem('st5:synckey')).toBeNull()
    const orphans = [...relay().rows].filter(([k]) => k !== SYNC_CODE)
    expect(orphans).toHaveLength(1)
    expect(markerOnPlain()).toBeNull()

    const again = await makePrivate(laptop)
    expect(again).toMatchObject({ ok: true })
    expect(markerOnPlain()).toMatchObject({ by: LAPTOP })
    const [orphan] = orphans
    expect(rowStamp(orphan?.[0] ?? '')).toBe(orphan?.[1].updated_at)
    expect(relay().rows.size).toBe(3)
  })

  it('at step 5 resolves through the device’s own marker, written once', async () => {
    const { laptop } = await plainPair()
    // the marker lands, but its answer never comes back
    onWriteTo(privateRow, () => {
      failNext('push', { ghost: 10 })
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    await until(() => record(laptop)?.phase === 'retired')
    expect(record(laptop)).toMatchObject({ phase: 'retired', conflicts: 0 })
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    const markers = pushesTo(SYNC_CODE).filter(
      (c) => isRecord(c.args?.p_payload) && c.args.p_payload.expenses === 'moved',
    )
    expect(markers).toHaveLength(1)
    expect(relay().ghostsLanded).toBe(1)
    expect(moveOf(laptop)?.lines).toEqual([NEXT])
  })
})

describe('the other device writes the old row (AC-M4)', () => {
  it('before the absorb: merged once and carried into the private row', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    add(phone, 'Invented laksa')
    // the phone's write lands while the laptop makes the private row
    onWriteTo(privateRow, () => {
      writeAsOther(SYNC_CODE, plainWriteOf(phone))
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(names(laptop)).toContain('Invented laksa')
    expect(record(laptop)).toMatchObject({ phase: 'retired' })
    expect(typeof record(laptop)?.absorbed).toBe('string')
    // the marker went on at once, before the private row was sent what was absorbed
    const row = await rowIdOf(codeMade(moved))
    const order = relay().pushes.map((p) => (p.syncId === row ? 'private' : p.syncId))
    const marker = relay().pushes.findIndex(
      (p) => p.syncId === SYNC_CODE && isRecord(p.payload) && p.payload.expenses === 'moved',
    )
    expect(order.indexOf('private')).toBeLessThan(marker)
    expect(order.indexOf('private', order.indexOf('private') + 1)).toBeGreaterThan(marker)
    // the private row has it: a device that joins it now reads it there
    const tablet = await bootDevice({ dev: 'tab001' })
    expect(await join(tablet, codeMade(moved))).toMatchObject({ ok: true })
    expect(names(tablet)).toEqual(['Invented kopi', 'Invented laksa', 'Invented teh'])
  })

  it('between the absorb and the marker: not merged, and it arrives when the phone joins', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    add(phone, 'Invented rendang')
    // the phone's write lands just before the laptop's marker: the marker's base is stale
    onWriteTo(
      (row) => row === SYNC_CODE && codeOf(laptop) !== SYNC_CODE,
      () => {
        writeAsOther(SYNC_CODE, plainWriteOf(phone))
      },
    )
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    await until(() => record(laptop)?.phase === 'retired')
    expect(markerOnPlain()).toMatchObject({ by: LAPTOP })
    expect(names(laptop)).not.toContain('Invented rendang')
    offline(phone, false)
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
    await until(() => unsynced(phone) === 0)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented rendang', 'Invented teh'])
  })

  it('over the marker: closed again, neither merged nor kept, said in Settings; it arrives at the join (AC-M13)', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    const attention = laptop.expense.useExpenseStore.getState().attention
    add(phone, 'Invented satay')
    writeAsOther(SYNC_CODE, plainWriteOf(phone))
    expect(markerOnPlain()).toBeNull()
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    expect(names(laptop)).not.toContain('Invented satay')
    expect(laptop.expense.useExpenseStore.getState().attention).toEqual(attention)
    expect([...itemsOf(laptop.storage).keys()].filter((k) => k.startsWith('st5:q:'))).toEqual([])
    expect(moveOf(laptop)?.straggler).toBe(true)
    expect(moveOf(laptop)?.lines).toContain(STRAGGLER)
    offline(phone, false)
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
    await until(() => unsynced(phone) === 0)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(names(laptop)).toEqual(['Invented kopi', 'Invented satay', 'Invented teh'])
  })
})

describe('edits during the move (AC-M5)', () => {
  it('an edit made during each of steps 2, 3 and 5 reaches the private row, and none is sent to the old row after step 2', async () => {
    const { laptop } = await plainPair()
    const made: string[] = []
    // step 2: while the plain row is pulled
    relay().pullLatencyFor = () => {
      const last = relay().requests.at(-1)
      if (
        made.length === 0 &&
        last?.kind === 'rpc' &&
        last.fn === 'st_sync_pull' &&
        last.args?.p_row === SYNC_CODE &&
        codeOf(laptop) === SYNC_CODE
      ) {
        made.push('Invented two')
        add(laptop, 'Invented two')
      }
      return undefined
    }
    // step 3: while the private row is sealed
    const pending = { afterThree: -1, atReadBack: -1 }
    whilePending('encrypt', () => {
      made.push('Invented three')
      add(laptop, 'Invented three')
      pending.afterThree = unsynced(laptop)
    })
    // the read-back, at the end of step 3: nothing was acknowledged by making the private row
    whilePending('decrypt', () => {
      pending.atReadBack = unsynced(laptop)
    })
    // step 5: as the marker lands (step 4 has no await: nothing can run inside it)
    onWriteTo(
      (row) => row === SYNC_CODE && codeOf(laptop) !== SYNC_CODE,
      () => {
        made.push('Invented five')
        add(laptop, 'Invented five')
      },
    )
    const moved = await makePrivate(laptop)
    relay().pullLatencyFor = null
    expect(moved).toMatchObject({ ok: true })
    expect(made).toEqual(['Invented two', 'Invented three', 'Invented five'])
    expect(pending.afterThree).toBeGreaterThan(0)
    expect(pending.atReadBack).toBe(pending.afterThree)
    await until(() => unsynced(laptop) === 0)
    await idle(500)
    // nothing made after step 2 went to the old row
    const toPlain = JSON.stringify(relay().pushes.filter((p) => p.syncId === SYNC_CODE))
    expect(toPlain).not.toContain('Invented three')
    expect(toPlain).not.toContain('Invented five')
    const tablet = await bootDevice({ dev: 'tab001' })
    expect(await join(tablet, codeMade(moved))).toMatchObject({ ok: true })
    expect(names(tablet)).toEqual([
      'Invented five',
      'Invented kopi',
      'Invented teh',
      'Invented three',
      'Invented two',
    ])
  })

  it('the cycle after an absorb is a full one: what was absorbed reaches the private row (a resumed move)', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    const moments = await recordMove(laptop)
    store(laptop).disconnectSync()
    // a crash right after the switch: the record is `retiring`, the old row still plain
    const crash = moments.find((m) => m.label === 'after removing syncId')
    if (crash === undefined) throw new Error('no such moment')
    restoreRows(crash.rows)
    // meanwhile the phone writes the old row
    add(phone, 'Invented rendang')
    writeAsOther(SYNC_CODE, plainWriteOf(phone))
    const lap = await reboot(crash.items)
    await until(() => record(lap)?.phase === 'retired')
    expect(names(lap)).toContain('Invented rendang')
    await until(() => unsynced(lap) === 0)
    await idle(3000)
    const tablet = await bootDevice({ dev: 'tab001' })
    expect(await join(tablet, codeOf(lap) ?? '')).toMatchObject({ ok: true })
    expect(names(tablet)).toContain('Invented rendang')
  })
})

describe('both devices move (AC-M6)', () => {
  it('each keeps its private bucket and its code; one finds the other’s marker; Disconnect and a join merge them', async () => {
    const { laptop, phone } = await plainPair()
    // two devices: two browsers, each with a lock of its own
    Object.defineProperty(navigator, 'locks', {
      value: { request: (_n: string, _o: unknown, cb: () => Promise<unknown>) => cb() },
      configurable: true,
    })
    const [lapEngine, phoneEngine] = await Promise.all([engineOf(laptop), engineOf(phone)])
    const [a, b] = await run(Promise.all([lapEngine.makePrivate(), phoneEngine.makePrivate()]))
    expect(a).toMatchObject({ ok: true })
    expect(b).toMatchObject({ ok: true })
    expect(codeMade(a)).not.toBe(codeMade(b))
    await until(() => moveOf(laptop)?.contested === true || moveOf(phone)?.contested === true)
    await idle(3000)
    expect(markerOnPlain()).toMatchObject({ why: 'private' })
    const loser = moveOf(laptop)?.contested === true ? laptop : phone
    const winner = loser === laptop ? phone : laptop
    expect(record(winner)).toMatchObject({ phase: 'retired' })
    expect(record(loser)).toMatchObject({ phase: 'retired', contested: true })
    expect(moveOf(loser)?.lines).toContain(CONTESTED)
    expect(codeOf(winner)?.startsWith('ST5-')).toBe(true)
    expect(codeOf(loser)?.startsWith('ST5-')).toBe(true)
    add(laptop, 'Invented from the laptop')
    add(phone, 'Invented from the phone')
    await until(() => unsynced(laptop) === 0 && unsynced(phone) === 0)
    // the notice's way: Disconnect one of them, then enter the other's code there
    store(loser).disconnectSync()
    expect(await join(loser, codeOf(winner) ?? '')).toMatchObject({ ok: true })
    await until(() => unsynced(loser) === 0)
    expect(await sync(winner)).toMatchObject({ ok: true })
    const all = [
      'Invented from the laptop',
      'Invented from the phone',
      'Invented kopi',
      'Invented teh',
    ]
    expect(names(laptop)).toEqual(all)
    expect(names(phone)).toEqual(all)
  })
})

describe.each([
  ['without migration 006', false],
  ['with migration 006 (AC-M15)', true],
])('a forged marker met at step 5 (AC-M7), %s', (_label, sticky) => {
  const forged = (why: string, by: string | null) => ({
    version: '4.0',
    expenses: 'moved',
    categories: [],
    categoryMappings: {},
    x5: {
      schema: 5,
      minor: 0,
      min: 99,
      moved: { at: '2026-11-19T08:00:00.000Z', why, ...(by === null ? {} : { by }) },
    },
  })

  it.each([
    ['another device', 'private', 'zzz999', true, false],
    ['another reason', 'rotated', 'zzz999', true, true],
    ['no device', 'private', null, false, false],
  ] as const)(
    'naming %s: the key is kept, and no device is left asking for a code none holds',
    async (_what, why, by, contested, replaced) => {
      const { laptop, phone } = await plainPair()
      if (sticky) migrate('006')
      const marker = forged(why, by)
      onWriteTo(privateRow, () => {
        writeAsOther(SYNC_CODE, marker)
      })
      const moved = await makePrivate(laptop)
      expect(moved).toMatchObject({ ok: true })
      const code = codeMade(moved)
      await until(() => record(laptop)?.phase === 'retired')
      expect(codeOf(laptop)).toBe(code)
      expect(JSON.parse(laptop.storage.getItem('st5:synckey') ?? '{}')).toMatchObject({ code })
      expect(record(laptop)).toMatchObject({ phase: 'retired', contested })
      if (replaced) expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
      else expect(rowPayload(SYNC_CODE)).toEqual(marker)
      const lines = moveOf(laptop)?.lines ?? []
      // this device's code is offered to the device that will ask for one
      expect(lines).toContain(NEXT)
      if (contested) {
        expect(lines).toContain(CONTESTED)
        expect(CONTESTED.indexOf('enter this one there')).toBeLessThan(
          CONTESTED.indexOf('Disconnect'),
        )
      } else {
        expect(lines).not.toContain(CONTESTED)
      }
      // the phone asks for a code, and the laptop's is the one it needs
      expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
      expect(await join(phone, code)).toMatchObject({ ok: true })
      await until(() => unsynced(phone) === 0)
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(moveOf(laptop)?.contested).toBe(false)
      expect(moveOf(laptop)?.lines).toEqual([])
      expect(record(laptop)).toMatchObject({ contested: false })
      expect(names(phone)).toEqual(['Invented kopi', 'Invented teh'])
    },
  )
})

describe('the move in two tabs (AC-M8)', () => {
  it('a tab not granted the lock is refused and writes nothing', async () => {
    const { laptop } = await plainPair()
    locks.freeze() // another tab holds the lock and is frozen
    const pushes = relay().pushes.length
    const writes = laptop.storage instanceof MemoryStorage ? laptop.storage.writes.length : 0
    const moved = await makePrivate(laptop)
    expect(moved).toEqual({ ok: false, message: BUSY })
    expect(relay().pushes.length).toBe(pushes)
    expect(codeOf(laptop)).toBe(SYNC_CODE)
    expect(record(laptop)).toBeNull()
    expect(laptop.storage.getItem('st5:synckey')).toBeNull()
    const sinceThen =
      laptop.storage instanceof MemoryStorage ? laptop.storage.writes.slice(writes) : []
    expect(sinceThen.filter((k) => SYNC_KEYS.has(k))).toEqual([])
  })

  it('a tab whose re-read at step 4 finds a changed setup stops, and follows it', async () => {
    const { laptop } = await plainPair()
    const other = (await engineOf(laptop)).newPrivateCode()
    // another tab joins another private sync while this one makes its row
    onWriteTo(privateRow, () => {
      privateSetupWrittenBy0210(laptop, other)
    })
    const moved = await makePrivate(laptop)
    expect(moved).toEqual({
      ok: false,
      message: 'Sync was changed in another tab. Nothing was made private here.',
    })
    expect(JSON.parse(laptop.storage.getItem('st5:synckey') ?? '{}')).toMatchObject({
      code: other,
    })
    expect(record(laptop)).toBeNull()
    expect(markerOnPlain()).toBeNull()
    // the next cycle follows the other tab's setup
    await sync(laptop)
    await until(() => codeOf(laptop) === other)
    expect(codeOf(laptop)).toBe(other)
  })

  it('a tab whose re-read finds another tab’s move under way stops', async () => {
    const { laptop } = await plainPair()
    onWriteTo(privateRow, () => {
      laptop.storage.setItem('st5:synckey:move', voidRecord())
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: false })
    expect(laptop.storage.getItem('st5:synckey')).toBeNull()
    expect(codeOf(laptop)).toBe(SYNC_CODE)
    expect(markerOnPlain()).toBeNull()
  })

  it('st5:synckey is written once, and no code is shown before the read-back', async () => {
    const { laptop } = await plainPair()
    const seen: (string | null)[] = []
    onWriteTo(privateRow, () => {
      seen.push(codeOf(laptop))
    })
    // the first open of the move is the read-back of the private row
    whilePending('decrypt', () => {
      seen.push(codeOf(laptop))
    })
    const writes = laptop.storage instanceof MemoryStorage ? laptop.storage.writes.length : 0
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(seen).toEqual([SYNC_CODE, SYNC_CODE])
    const keyWrites =
      laptop.storage instanceof MemoryStorage
        ? laptop.storage.writes.slice(writes).filter((k) => k === 'st5:synckey')
        : []
    expect(keyWrites).toHaveLength(1)
  })

  it('a void record left by a switch that failed does not block the next press', async () => {
    const { laptop } = await plainPair()
    laptop.storage.setItem('st5:synckey:move', voidRecord())
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(record(laptop)).toMatchObject({ from: SYNC_CODE, phase: 'retired' })
    expect(record(laptop)?.for).not.toBe('abcdefg1234567')
  })
})

describe.each([
  ['without migration 006', false],
  ['with migration 006 (AC-M15)', true],
])('a writer that keeps the old row busy (AC-M9), %s', (_label, sticky) => {
  it('the marker lands by force after three conflicts; one plain payload is merged, a second is not', async () => {
    const { laptop, phone } = await plainPair()
    if (sticky) migrate('006')
    offline(phone, true)
    add(phone, 'Invented A')
    const first = plainWriteOf(phone)
    add(phone, 'Invented B')
    const second = plainWriteOf(phone)
    const markerWrites: boolean[] = []
    let firstWritten = false
    relay().beforeWrite = (w) => {
      if (w.row !== SYNC_CODE) {
        // while the laptop makes its private row, the phone writes the old one
        if (!firstWritten) writeAsOther(SYNC_CODE, first)
        firstWritten = true
        return
      }
      if (codeOf(laptop) === SYNC_CODE) return
      markerWrites.push(w.force)
      // and then before every marker of the laptop's
      seedRow(SYNC_CODE, second)
    }
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    for (let i = 0; i < 4 && record(laptop)?.phase !== 'retired'; i++) {
      expect(await sync(laptop)).toMatchObject({ ok: true })
    }
    relay().beforeWrite = null
    expect(markerWrites).toEqual([false, false, false, true])
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    expect(record(laptop)).toMatchObject({ phase: 'retired', conflicts: 0 })
    expect(names(laptop)).toContain('Invented A')
    expect(names(laptop)).not.toContain('Invented B')
  })

  it('what is not a plain payload is closed over: never merged, no copy kept', async () => {
    const { laptop } = await plainPair()
    if (sticky) migrate('006')
    const attention = laptop.expense.useExpenseStore.getState().attention
    onWriteTo(privateRow, () => {
      writeAsOther(SYNC_CODE, { expenses: 'not a list', junk: 'Invented junk' })
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    expect(laptop.expense.useExpenseStore.getState().attention).toEqual(attention)
    expect(JSON.stringify([...itemsOf(laptop.storage)])).not.toContain('Invented junk')
  })
})

describe('the old row pruned (AC-M10)', () => {
  it('during the move: the marker is put back by a create', async () => {
    const { laptop } = await plainPair()
    onWriteTo(privateRow, () => {
      dropRow(SYNC_CODE)
    })
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    expect(pushesTo(SYNC_CODE).at(-1)?.args).toMatchObject({ p_base: null, p_force: false })
  })

  it('after the move: the next private cycle puts the marker back', async () => {
    const { laptop } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    dropRow(SYNC_CODE)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
  })

  it('a fenced device of release 1 never re-creates the old row', async () => {
    const { laptop, phone } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    store(laptop).disconnectSync()
    dropRow(SYNC_CODE)
    const asked = callsOn(SYNC_CODE, 'st_sync_pull') + callsOn(SYNC_CODE, 'st_sync_push')
    add(phone, 'Invented laksa')
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    await idle(3 * MINUTE)
    expect(relay().rows.has(SYNC_CODE)).toBe(false)
    expect(callsOn(SYNC_CODE, 'st_sync_pull') + callsOn(SYNC_CODE, 'st_sync_push')).toBe(asked)
  })
})

describe('deletions across the move (AC-M11)', () => {
  /** Laptop and phone on the plain code, both holding e1 to e5. */
  async function fivePair(): Promise<{ laptop: Device; phone: Device }> {
    const five = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => expense(id))
    const laptop = await bootDevice({ dev: LAPTOP, expenses: five })
    expect(await connectPlain(laptop)).toMatchObject({ ok: true })
    const phone = await bootDevice({ dev: PHONE, expenses: five })
    expect(await connectPlain(phone)).toMatchObject({ ok: true })
    expect(await sync(laptop)).toMatchObject({ ok: true })
    return { laptop, phone }
  }
  const remove = (d: Device, id: string) => {
    d.expense.useExpenseStore.getState().deleteExpense(id)
  }
  const preview = async (d: Device, code: string) => run((await engineOf(d)).previewJoin(code))

  it('single deletes before, during and after, on either device, hold after the join', async () => {
    const { laptop, phone } = await fivePair()
    // before: the laptop deletes e1
    remove(laptop, 'e1')
    await until(() => unsynced(laptop) === 0)
    expect(await sync(phone)).toMatchObject({ ok: true })
    expect(liveIds(phone)).not.toContain('e1')
    // during: the phone deletes e2, and its write lands while the laptop makes its private row
    offline(phone, true)
    remove(phone, 'e2')
    const during = plainWriteOf(phone)
    onWriteTo(privateRow, () => {
      writeAsOther(SYNC_CODE, during)
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(liveIds(laptop)).toEqual(['e3', 'e4', 'e5'])
    // after: the laptop deletes e3; the phone, fenced, deletes e4
    remove(laptop, 'e3')
    await until(() => unsynced(laptop) === 0)
    offline(phone, false)
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    remove(phone, 'e4')
    // what joining would do: e3 goes here, e4 goes there
    expect(await preview(phone, codeMade(moved))).toMatchObject({
      kind: 'found',
      here: 2,
      synced: 2,
      after: 1,
      removed: 1,
      deletesThere: 1,
    })
    expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
    await until(() => unsynced(phone) === 0)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(liveIds(laptop)).toEqual(['e5'])
    expect(liveIds(phone)).toEqual(['e5'])
  })

  it.each([
    'the phone, before the move',
    'the laptop, during the move',
    'the phone, fenced after it',
  ])('a "Delete everywhere" by %s holds after the join', async (when) => {
    const { laptop, phone } = await fivePair()
    const everywhere = (d: Device) => {
      d.expense.useExpenseStore.getState().deleteAllEverywhere()
    }
    if (when === 'the phone, before the move') {
      everywhere(phone)
      await until(() => unsynced(phone) === 0)
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(liveIds(laptop)).toEqual([])
    }
    if (when === 'the laptop, during the move') {
      whilePending('encrypt', () => {
        everywhere(laptop)
      })
    }
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    await until(() => unsynced(laptop) === 0)
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    if (when === 'the phone, fenced after it') {
      everywhere(phone)
      expect(await preview(phone, codeMade(moved))).toMatchObject({
        kind: 'found',
        here: 0,
        synced: 5,
        after: 0,
        deletesThere: 5,
      })
    } else {
      const p = await preview(phone, codeMade(moved))
      expect(p).toMatchObject({ kind: 'found', synced: 0, after: 0 })
      expect(p).not.toHaveProperty('deletesThere')
    }
    expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
    await until(() => unsynced(phone) === 0)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(liveIds(laptop)).toEqual([])
    expect(liveIds(phone)).toEqual([])
  })
})

describe('when the move is offered (AC-M12)', () => {
  /** A third device in the plain row's registry: the phone's entry, changed. */
  function anotherDevice(change: Record<string, unknown>): void {
    const payload = rowPayload(SYNC_CODE)
    if (!isRecord(payload) || !isRecord(payload.x5) || !isRecord(payload.x5.devs)) {
      throw new Error('no registry on the plain row')
    }
    const entry = payload.x5.devs[PHONE]
    if (!isRecord(entry)) throw new Error('no phone entry')
    payload.x5.devs.old001 = { ...entry, ...change }
    writeAsOther(SYNC_CODE, payload)
  }

  it.each([
    ['a release below release 1', { app: '0.20.0' }, false],
    ['the table', { m: 'table' }, false],
    ['never seen', { at: 0 }, false],
    [
      'a release below release 1, last seen 61 days ago',
      { app: '0.20.0', at: NOW - 61 * DAY },
      true,
    ],
  ] as const)('a recent registry row on %s: offered %s', async (_what, change, offered) => {
    const { laptop } = await plainPair()
    anotherDevice(change)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(moveOf(laptop)?.offered).toBe(offered)
  })

  it('not while an older writer was seen in the last 60 days', async () => {
    const { laptop } = await plainPair()
    writeAsOther(SYNC_CODE, {
      expenses: [{ id: 'old1', itemName: 'Invented old', amount: 1, category: 'Other' }],
      categories: ['Other'],
      categoryMappings: {},
      deletedIds: [],
      exportDate: new Date(NOW).toISOString(),
      version: '4.0',
    })
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(moveOf(laptop)?.offered).toBe(false)
    expect(await makePrivate(laptop)).toMatchObject({ ok: false })
  })

  it('not without Web Locks, and the press then writes nothing', async () => {
    Reflect.deleteProperty(navigator, 'locks')
    const { laptop } = await plainPair()
    expect(moveOf(laptop)?.offered).toBe(false)
    const pushes = relay().pushes.length
    expect(await makePrivate(laptop)).toMatchObject({ ok: false })
    expect(relay().pushes.length).toBe(pushes)
    expect(record(laptop)).toBeNull()
  })

  it('not on a fenced device, nor on one that is not established (paused, not found)', async () => {
    const { laptop, phone } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    expect(moveOf(phone)?.offered).toBe(false)
    const tablet = await bootDevice({ dev: 'tab001' })
    expect(
      await run(store(tablet).setupSync('22222222-2222-4222-8222-222222222222', { join: true })),
    ).toMatchObject({ ok: false, error: 'not-found' })
    expect(moveOf(tablet)?.offered).toBe(false)
  })

  it('not on a transport that cannot compare-and-set', async () => {
    migrate('rollback 005')
    vi.stubEnv('VITE_SYNC_RELAY', 'table')
    const { laptop } = await plainPair()
    expect(moveOf(laptop)?.offered).toBe(false)
  })

  it('a relay that still answers the table stops the move before any write', async () => {
    const { laptop } = await plainPair()
    migrate('rollback 005')
    const pushes = relay().pushes.length
    const rows = relay().rows.size
    expect(moveOf(laptop)?.offered).toBe(true)
    expect(await makePrivate(laptop)).toEqual({ ok: false, message: LOCKDOWN })
    expect(relay().pushes.length).toBe(pushes)
    expect(relay().rows.size).toBe(rows)
    expect(record(laptop)).toBeNull()
    expect(codeOf(laptop)).toBe(SYNC_CODE)
    // it asked about a row no bucket uses, never the plain row
    const probes = requestsOf('head').filter((q) => JSON.stringify(q).includes(SYNC_CODE))
    expect(probes).toEqual([])
  })
})

describe('keeping the old row closed (AC-M13)', () => {
  const heads = () => callsOn(SYNC_CODE, 'st_sync_head')
  const pulls = () => callsOn(SYNC_CODE, 'st_sync_pull')

  it('while no other private device has joined: a HEAD after every cycle for seven days, never in a hide cycle, then daily pulls', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    await idle(500)
    // the phone is in the private row's registry from the first write, as a plain device
    const [h0, p0] = [heads(), pulls()]
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(heads()).toBe(h0 + 2)
    expect(pulls()).toBe(p0)
    // a hide cycle asks the old row nothing
    add(laptop, 'Invented laksa')
    const [h1, p1] = [heads(), pulls()]
    setVisibility('hidden')
    await until(() => unsynced(laptop) === 0)
    expect([heads(), pulls()]).toEqual([h1, p1])
    setVisibility('visible')
    await idle(500)
    // seven days on, alone still: the check is daily, and a daily check pulls
    vi.setSystemTime(NOW + 7 * DAY + MINUTE)
    const [h2, p2] = [heads(), pulls()]
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(pulls()).toBe(p2 + 1)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect([heads(), pulls()]).toEqual([h2, p2 + 1])
    vi.setSystemTime(NOW + 8 * DAY + 2 * MINUTE)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect([heads(), pulls()]).toEqual([h2, p2 + 2])
  })

  it('once another private device joined: daily, by pull, whatever the token says; never stops', async () => {
    const { laptop, phone } = await plainPair()
    const moved = await makePrivate(laptop)
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(moveOf(laptop)?.alone).toBe(false)
    const [h0, p0] = [heads(), pulls()]
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect([heads(), pulls()]).toEqual([h0, p0])
    for (let day = 1; day <= 2; day++) {
      vi.setSystemTime(NOW + day * (DAY + MINUTE))
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect([heads(), pulls()], `day ${String(day)}`).toEqual([h0, p0 + day])
    }
  })

  it('at start-up: a pull', async () => {
    const { laptop, phone } = await plainPair()
    const moved = await makePrivate(laptop)
    expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
    expect(await sync(laptop)).toMatchObject({ ok: true })
    const items = itemsOf(laptop.storage)
    store(laptop).disconnectSync()
    const p0 = pulls()
    const again = await reboot(items)
    await until(() => pulls() > p0)
    expect(pulls()).toBe(p0 + 1)
    expect(record(again)).toMatchObject({ phase: 'retired' })
  })
})

describe('the device’s storage after the move (AC-M14)', () => {
  it('the code only in st5:synckey, the plain code only in the record; neither exported', async () => {
    const { laptop } = await plainPair()
    const moved = await makePrivate(laptop)
    const code = codeMade(moved)
    expect(laptop.storage.getItem('syncId')).toBeNull()
    const items = itemsOf(laptop.storage)
    for (const [key, value] of items) {
      if (key !== 'st5:synckey') expect(value, key).not.toContain(code)
      if (key !== 'st5:synckey:move') expect(value, key).not.toContain(SYNC_CODE)
    }
    expect(items.get('st5:synckey')).toContain(code)
    expect(items.get('st5:synckey:move')).toContain(SYNC_CODE)
    const rescue = JSON.stringify(collectRawStorage(laptop.storage))
    const backup = JSON.stringify(laptop.expense.useExpenseStore.getState().exportBackup())
    for (const text of [rescue, backup]) {
      expect(text).not.toContain(code)
      expect(text).not.toContain(SYNC_CODE)
    }
  })

  it('Disconnect removes the record', async () => {
    const { laptop } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    expect(record(laptop)).not.toBeNull()
    store(laptop).disconnectSync()
    await idle(10)
    expect(laptop.storage.getItem('st5:synckey:move')).toBeNull()
  })

  it('"Remove from this device" removes the record', async () => {
    const { laptop } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    await run(laptop.expense.useExpenseStore.getState().removeDataFromThisDevice())
    expect(laptop.storage.getItem('st5:synckey:move')).toBeNull()
  })

  it('a join of another code removes the record', async () => {
    const { laptop } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    const tablet = await bootDevice({ dev: 'tab001', expenses: [expense('t1')] })
    const other = (await engineOf(tablet)).newPrivateCode()
    expect(await run(store(tablet).setupSync(other))).toMatchObject({ ok: true })
    expect(await join(laptop, other)).toMatchObject({ ok: true })
    expect(laptop.storage.getItem('st5:synckey:move')).toBeNull()
  })

  it('a void record is removed when Settings › Sync opens; the record of this bucket is kept', async () => {
    const { laptop } = await plainPair()
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    const kept = laptop.storage.getItem('st5:synckey:move')
    await run((await engineOf(laptop)).sweepMoveRecord())
    expect(laptop.storage.getItem('st5:synckey:move')).toBe(kept)
    laptop.storage.setItem('st5:synckey:move', voidRecord())
    await run((await engineOf(laptop)).sweepMoveRecord())
    expect(laptop.storage.getItem('st5:synckey:move')).toBeNull()
  })
})

describe('with migration 006: a forced plain write over the marker (AC-M15)', () => {
  it.each([
    ['without 006: it lands, and the mover closes the row again', false],
    ['with 006: it is answered conflict, and a device of 0.21.0 fences', true],
  ])('%s', async (_label, sticky) => {
    const { laptop, phone } = await plainPair()
    if (sticky) migrate('006')
    offline(phone, true)
    const plainBefore = rowPayload(SYNC_CODE)
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    const marker = rowPayload(SYNC_CODE)
    offline(laptop, true)
    // the phone pulled the old row before the marker landed: it is put back for its cycle,
    // and the phone's first three writes cross another's, so its fourth is forced, and the
    // marker lands just before it
    seedRow(SYNC_CODE, plainBefore)
    offline(phone, false)
    add(phone, 'Invented late')
    relay().beforeWrite = (w) => {
      if (w.row !== SYNC_CODE) return
      seedRow(SYNC_CODE, w.force ? marker : plainBefore)
    }
    const result = await sync(phone)
    relay().beforeWrite = null
    const forced = pushesTo(SYNC_CODE).filter((c) => c.args?.p_force === true)
    expect(forced).toHaveLength(1)
    if (sticky) {
      expect(result).toMatchObject({ ok: false, error: 'moved-private' })
      expect(rowPayload(SYNC_CODE)).toEqual(marker)
    } else {
      expect(result).toMatchObject({ ok: true })
      expect(markerOnPlain()).toBeNull()
      offline(laptop, false)
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(markerOnPlain()).toMatchObject({ by: LAPTOP })
      expect(moveOf(laptop)?.lines).toContain(STRAGGLER)
      expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
    }
  })

  it.each([
    ['without 006 the pruned marker is put back by the mover', false],
    ['with 006 prune keeps a moved row four times as long', true],
  ])('%s', async (_label, sticky) => {
    const { laptop } = await plainPair()
    if (sticky) migrate('006')
    expect(await makePrivate(laptop)).toMatchObject({ ok: true })
    vi.setSystemTime(NOW + 100 * DAY)
    pruneStale()
    expect(relay().rows.has(SYNC_CODE)).toBe(sticky)
    expect(await sync(laptop)).toMatchObject({ ok: true })
    expect(markerOnPlain()).toMatchObject({ by: LAPTOP })
    vi.setSystemTime(NOW + 100 * DAY + 361 * DAY)
    pruneStale()
    expect(relay().rows.has(SYNC_CODE)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Second review (15 Nov): findings fixed test-first
// ---------------------------------------------------------------------------

describe('"another private device has joined" needs the code (AC-M13b)', () => {
  /** A plain payload on the old row that lists a made-up device as a private one (`e: 1`). */
  function forgeJoinedDevice(): void {
    const payload = rowPayload(SYNC_CODE)
    if (!isRecord(payload) || !isRecord(payload.x5) || !isRecord(payload.x5.devs)) {
      throw new Error('no registry on the plain row')
    }
    const entry = payload.x5.devs[PHONE]
    if (!isRecord(entry)) throw new Error('no phone entry')
    payload.x5.devs.fake01 = { ...entry, e: 1, at: Date.now() }
    writeAsOther(SYNC_CODE, payload)
  }
  const forgedMarker = {
    version: '4.0',
    expenses: 'moved',
    categories: [],
    categoryMappings: {},
    x5: {
      schema: 5,
      minor: 0,
      min: 99,
      moved: { at: '2026-11-19T08:00:00.000Z', why: 'private', by: 'zzz999' },
    },
  }

  it.each(['merged at step 2', 'merged at the absorb'])(
    'a forged entry %s leaves the device alone, watching, and contested; a real join ends all three, and a reload keeps it',
    async (when) => {
      const { laptop, phone } = await plainPair()
      offline(phone, true)
      if (when === 'merged at step 2') forgeJoinedDevice()
      else onWriteTo(privateRow, forgeJoinedDevice)
      const moved = await makePrivate(laptop)
      expect(moved).toMatchObject({ ok: true })
      // the forged entry is in the registry, claiming a private device
      expect(laptop.expense.getSyncPort()?.doc().devices.get('fake01')?.e2e).toBe(true)
      expect(moveOf(laptop)).toMatchObject({ alone: true })
      expect(moveOf(laptop)?.lines).toContain(NEXT)
      expect(moveOf(laptop)?.disconnect).toContain(
        'No other device has this sync code yet. Copy it first: a device waiting for it cannot join without it.',
      )
      // the close watch runs
      const heads = callsOn(SYNC_CODE, 'st_sync_head')
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(callsOn(SYNC_CODE, 'st_sync_head')).toBe(heads + 1)
      // a marker naming another device: contested, and it stays so while alone
      writeAsOther(SYNC_CODE, forgedMarker)
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(moveOf(laptop)?.contested).toBe(true)
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(moveOf(laptop)?.contested).toBe(true)
      expect(record(laptop)?.joined).toBeUndefined()
      // a real join: the laptop opens a copy the phone sealed
      offline(phone, false)
      expect(await sync(phone)).toMatchObject({ ok: false, error: 'moved-private' })
      expect(await join(phone, codeMade(moved))).toMatchObject({ ok: true })
      await until(() => unsynced(phone) === 0)
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(moveOf(laptop)).toMatchObject({ alone: false, contested: false })
      expect(record(laptop)).toMatchObject({ joined: true, contested: false })
      const heads2 = callsOn(SYNC_CODE, 'st_sync_head')
      expect(await sync(laptop)).toMatchObject({ ok: true })
      expect(callsOn(SYNC_CODE, 'st_sync_head')).toBe(heads2)
      // a reload keeps the answer
      const items = itemsOf(laptop.storage)
      store(laptop).disconnectSync()
      const again = await reboot(items)
      await idle(2000)
      expect(record(again)).toMatchObject({ joined: true })
      expect(moveOf(again)?.alone).toBe(false)
    },
  )
})

describe('the absorb is recorded before the merge (S-F2)', () => {
  it('a record that cannot be written at that moment merges nothing; the payload is merged once, later', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    add(phone, 'Invented laksa')
    const phoneWrite = plainWriteOf(phone)
    onWriteTo(privateRow, () => {
      writeAsOther(SYNC_CODE, phoneWrite)
    })
    const set = laptop.storage.setItem.bind(laptop.storage)
    const refusing = { on: true }
    vi.spyOn(laptop.storage, 'setItem').mockImplementation((key, value) => {
      if (refusing.on && key === 'st5:synckey:move' && value.includes('"absorbed":"')) {
        throw new DOMException('full', 'QuotaExceededError')
      }
      set(key, value)
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(names(laptop)).not.toContain('Invented laksa')
    expect(record(laptop)).toMatchObject({ phase: 'retiring', absorbed: null })
    expect(markerOnPlain()).toBeNull()
    refusing.on = false
    expect(await sync(laptop)).toMatchObject({ ok: true })
    await until(() => record(laptop)?.phase === 'retired')
    expect(names(laptop)).toContain('Invented laksa')
    expect(typeof record(laptop)?.absorbed).toBe('string')
    expect(markerOnPlain()).toMatchObject({ by: LAPTOP })
  })
})

describe('a record that cannot be kept after the switch (S-F4)', () => {
  it('is said plainly: the old row is closed this session, and never "keeps trying"', async () => {
    const { laptop } = await plainPair()
    const set = laptop.storage.setItem.bind(laptop.storage)
    const lost = { on: false }
    vi.spyOn(laptop.storage, 'setItem').mockImplementation((key, value) => {
      if (lost.on && key === 'st5:synckey:move') {
        throw new DOMException('full', 'QuotaExceededError')
      }
      set(key, value)
      // the record goes right after the switch, and storage takes no new one
      if (key === 'st5:synckey') {
        laptop.storage.removeItem('st5:synckey:move')
        lost.on = true
      }
    })
    const moved = await makePrivate(laptop)
    expect(moved).toMatchObject({ ok: true })
    expect(record(laptop)).toBeNull()
    const lines = moveOf(laptop)?.lines ?? []
    expect(lines[0]).toBe(
      "This device couldn't save its note of the move, so it stops closing the old sync when SpendTrack closes. Free up space on this device.",
    )
    expect(lines).not.toContain(NOT_CLOSED)
    expect(lines).not.toContain('Closing the old sync…')
    // this session still closes it
    expect(markerOnPlain()).toMatchObject({ why: 'private', by: LAPTOP })
    expect(moveOf(laptop)?.phase).toBe('retired')
  })
})

describe('the old row only under the sync lock (C-F1)', () => {
  it('a cycle run without the lock neither absorbs nor writes a marker; the next one with it does', async () => {
    const { laptop, phone } = await plainPair()
    offline(phone, true)
    const moments = await recordMove(laptop)
    store(laptop).disconnectSync()
    // a crash right after the switch: the record is `retiring`, the old row still plain
    const crash = moments.find((m) => m.label === 'after removing syncId')
    if (crash === undefined) throw new Error('no such moment')
    restoreRows(crash.rows)
    add(phone, 'Invented rendang')
    writeAsOther(SYNC_CODE, plainWriteOf(phone))
    const plainNow = rowPayload(SYNC_CODE)
    locks.refuse(true)
    const lap = await reboot(crash.items)
    await idle(3000)
    expect(codeOf(lap)?.startsWith('ST5-')).toBe(true)
    expect(store(lap).lastError).toBeNull()
    expect(record(lap)).toMatchObject({ phase: 'retiring', absorbed: null })
    expect(names(lap)).not.toContain('Invented rendang')
    expect(rowPayload(SYNC_CODE)).toEqual(plainNow)
    locks.refuse(false)
    expect(await sync(lap)).toMatchObject({ ok: true })
    await until(() => record(lap)?.phase === 'retired')
    expect(names(lap)).toContain('Invented rendang')
    expect(markerOnPlain()).toMatchObject({ by: LAPTOP })
  })
})

describe('a press that is refused answers its own caller only (C-F2)', () => {
  it('an edit and Sync now in the same turn get a real cycle, not the move’s answer', async () => {
    const { laptop } = await plainPair()
    migrate('rollback 005') // the lockdown probe answers: the move stops at step 1
    relay().latency.pull = 200
    const engine = await engineOf(laptop)
    const first = store(laptop).triggerSync()
    // while that cycle is on the wire: an edit, Sync now and the press, all in the next turn
    add(laptop, 'Invented laksa')
    const now = store(laptop).triggerSync()
    const press = engine.makePrivate()
    const [before, synced, moved] = await run(Promise.all([first, now, press]))
    expect(moved).toEqual({ ok: false, message: LOCKDOWN })
    // whichever turn the move ran in, every other request got a real cycle's answer
    expect(before).toMatchObject({ ok: true })
    expect(synced).toMatchObject({ ok: true, pushed: true })
    expect(JSON.stringify(rowPayload(SYNC_CODE))).toContain('Invented laksa')
    expect(unsynced(laptop)).toBe(0)
  })
})
