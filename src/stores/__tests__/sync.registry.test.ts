// The device registry and the view (PR-3 track spec P3-7 to P3-9, §3.9; AC-E18): every push
// carries this device's entry; `seen` alone never pushes; a new app version or relay mode pushes
// exactly once; old writers are remembered (0.8.4, 0.9.2 and 0.10.0, which never registers
// itself); Settings › Sync reads one view object that changes only when what it shows changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maskCode } from '../../data/core/codes'
import {
  SYNC_CODE,
  advance,
  bootDevice,
  connect,
  expense,
  failNext,
  loadDevice,
  micros,
  migrate,
  payloadOf,
  pgTime,
  relay,
  requestsOf,
  resetRelay,
  retireDevices,
  rowPayload,
  rowStamp,
  setVisibility,
  setClientOffline,
  settle,
  steadyRandom,
  stubRelayEnv,
  writeAsLegacy,
  writeAsOther,
  type Device,
} from '../../__tests__/fakeRelay'
import { LOCKDOWN_PROBE_ROW } from '../../services/syncService'

vi.mock(
  '@supabase/supabase-js',
  async () => (await import('../../__tests__/fakeRelay')).supabaseModule,
)

vi.setConfig({ testTimeout: 30_000 })

const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)
const MINUTE = 60_000
const DAY = 86_400_000
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  localStorage.clear()
  stubRelayEnv()
  resetRelay()
  steadyRandom()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
})

afterEach(() => {
  retireDevices()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function portOf(d: Device) {
  const port = d.expense.getSyncPort()
  if (port === null) throw new Error('no port')
  return port
}

/** The relay copy's `x5`, as an object. */
function x5(): Record<string, unknown> {
  const payload = rowPayload(SYNC_CODE)
  const block = isObject(payload) ? payload.x5 : undefined
  if (!isObject(block)) throw new Error('no x5 on the relay')
  return block
}

async function connected(id = 'e1'): Promise<Device> {
  const d = await bootDevice({ expenses: [expense(id)] })
  await connect(d)
  return d
}

describe('AC-E18: every push carries this device’s entry', () => {
  it('as {name, app, mode, e2e false, seen}, with no name (track spec §8 cut 1)', async () => {
    const phone = await connected()
    const me = portOf(phone).deviceId()
    const devs = x5().devs
    const mine = isObject(devs) ? devs[me] : undefined
    expect(mine).toEqual({
      n: '',
      app: __APP_VERSION__,
      m: 'table',
      e: 0,
      rs: 0,
      at: expect.any(Number) as unknown,
    })
    // seen: when it pushed (a fake timer of 0 ms runs 1 ms later)
    const at = isObject(mine) ? mine.at : 0
    expect(typeof at === 'number' && at >= NOW && at < NOW + 1000).toBe(true)
  })

  it('never pushes for `seen` alone: 30 idle minutes of polls, resumes and a peer’s pushes', async () => {
    const phone = await connected('p1')
    const laptop = await connected('l1')
    await advance(MINUTE)
    const pushes = relay().pushes.length
    for (let i = 0; i < 6; i++) {
      setVisibility('hidden')
      await advance(4 * MINUTE)
      setVisibility('visible')
      await advance(MINUTE)
    }
    expect(relay().pushes.length).toBe(pushes)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
    expect(laptop.sync.useSyncStore.getState().cloudStatus).toBe('synced')
  })

  it('a new app version pushes exactly once, then the relay is quiet again', async () => {
    const phone = await connected()
    await advance(MINUTE)
    const port = portOf(phone)
    const me = port.deviceId()
    const entry = port.doc().devices.get(me)
    if (entry === undefined) throw new Error('not registered')
    // An older build of this device registered it, here and on the relay.
    port.register(me, { ...entry, app: '0.9.9', seen: entry.seen + 1 })
    const stored = relay().rows.get(SYNC_CODE)?.payload // the relay's own object, edited in place
    const block = isObject(stored) ? stored.x5 : undefined
    const devs = isObject(block) ? block.devs : undefined
    const mine = isObject(devs) ? devs[me] : undefined
    if (!isObject(devs) || !isObject(mine)) throw new Error('no entry on the relay')
    devs[me] = { ...mine, app: '0.9.9', at: entry.seen + 1 }
    const pushes = relay().pushes.length
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(10 * MINUTE)
    expect(relay().pushes.length - pushes).toBe(1) // the change and the new entry, together
    const after = x5().devs
    expect(isObject(after) && isObject(after[me]) ? after[me].app : null).toBe(__APP_VERSION__)
  })

  it('a change of relay mode (the functions appeared) pushes once, with rpcSince', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    const phone = await connected()
    await advance(MINUTE)
    expect(portOf(phone).meta()).toMatchObject({ transport: 'table', probedAt: NOW })
    relay().rpc = 'present' // migration 004 applied; the table hint is re-probed after 24 h
    vi.setSystemTime(NOW + DAY + MINUTE)
    const pushes = relay().pushes.length
    window.dispatchEvent(new Event('online'))
    await advance(10_000)
    expect(relay().pushes.length - pushes).toBe(1)
    expect(relay().pushes.at(-1)?.via).toBe('rpc')
    const me = portOf(phone).deviceId()
    const devs = x5().devs
    const mine = isObject(devs) ? devs[me] : undefined
    expect(mine).toMatchObject({ m: 'rpc' })
    const since = isObject(mine) ? mine.rs : 0
    const switched = NOW + DAY + MINUTE
    expect(typeof since === 'number' && since >= switched && since < switched + 1000).toBe(true)
    await advance(10 * MINUTE)
    expect(relay().pushes.length - pushes).toBe(1)
    expect(phone.sync.useSyncStore.getState().view).toMatchObject({
      transport: 'rpc',
      lockdown: { ready: false },
    })
  })
})

describe('old writers (P3-8)', () => {
  it('remembers a 0.8.4 and a 0.9.2 writer when it pulls their copies', async () => {
    const phone = await connected()
    writeAsLegacy(SYNC_CODE, payloadOf([expense('e1'), expense('o1')]))
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v084).toBeGreaterThanOrEqual(NOW)
    vi.setSystemTime(Date.now() + MINUTE)
    writeAsOther(
      SYNC_CODE,
      payloadOf([expense('e1'), expense('o2')], {
        wr: { app: '0.8.5', dev: 'old092', rev: 'x1', at: new Date().toISOString() },
      }),
    )
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v085).toBeGreaterThan(NOW)
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.legacy.v084At).not.toBeNull()
    expect(view?.legacy.v085At).not.toBeNull()
    // 0.9.2 stamps its writes `wr.app: '0.8.5'` (its writer version): the list says the release
    expect(view?.devices.find((d) => d.id === 'old092')).toMatchObject({
      name: 'Older SpendTrack (0.9.2)',
      app: '0.9.2',
      legacy: true,
      older: true,
    })
    expect(view?.allCurrent).toBe(false)
  })

  it('marks a v5 copy written by another device with no entry of its own as a 0.10.0 (v5pre)', async () => {
    const phone = await connected()
    await advance(5000)
    // 0.10.0 carries the registry it pulled, stamps x5.dev, and never adds itself.
    const block = x5()
    const payload = rowPayload(SYNC_CODE)
    writeAsOther(SYNC_CODE, {
      ...(isObject(payload) ? payload : {}),
      x5: { ...block, dev: 'old010', rev: 'rev0100000000001' },
    })
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v5pre).toBeGreaterThanOrEqual(NOW)
    expect(phone.sync.useSyncStore.getState().view?.legacy.v5preAt).not.toBeNull()
    expect(phone.sync.useSyncStore.getState().view?.allCurrent).toBe(false)
  })

  /** A 0.10.0 write by `old010`: it carries the registry it pulled plus `devs.old010`, if any. */
  function writeAs010(own: Record<string, unknown> | null, rev: string): void {
    const payload = rowPayload(SYNC_CODE)
    if (!isObject(payload)) throw new Error('no row')
    const block = x5()
    const devs = isObject(block.devs) ? block.devs : {}
    writeAsOther(SYNC_CODE, {
      ...payload,
      x5: { ...block, dev: 'old010', rev, devs: own === null ? devs : { ...devs, old010: own } },
    })
  }

  it('a 0.10.0 that once ran 0.9.2 is a 0.10.0 writer, although its 0.9.2 entry carries its id', async () => {
    const phone = await connected()
    await advance(5000)
    // its 0.9.2 writes left an 'Older app' entry (decoded from `wr`), which 0.10.0 re-encodes
    writeAs010(
      { n: 'Older app', app: '0.8.5', m: 'table', e: 0, at: NOW - DAY },
      'rev0100000000001',
    )
    await advance(5000)
    expect(portOf(phone).meta()).toMatchObject({ v5preDev: 'old010' })
    expect(portOf(phone).meta().legacySeen.v5pre).toBeGreaterThanOrEqual(NOW)
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.legacy.v5preAt).not.toBeNull()
    // listed by the release it runs (it never registers itself), not its 0.9.2 entry
    expect(view?.devices.find((d) => d.id === 'old010')).toMatchObject({
      name: 'Older SpendTrack (0.10.0)',
      app: '0.10.0',
      legacy: true,
      older: true,
    })
    expect(view?.allCurrent).toBe(false)
  })

  it('a device rolled back from 0.11.0 to 0.10.0 is a 0.10.0 writer: its frozen entry proves nothing', async () => {
    const phone = await connected()
    await advance(5000)
    // its 0.11.0 registered a day ago; 0.10.0 writes now and carries that entry unchanged
    writeAs010(
      { n: '', app: '0.11.0', m: 'rpc', e: 0, rs: NOW - 9 * DAY, at: NOW - DAY },
      'rev0100000000002',
    )
    await advance(5000)
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.legacy.v5preAt).not.toBeNull()
    expect(view?.devices.find((d) => d.id === 'old010')).toMatchObject({ app: '0.10.0' })
    expect(view?.allCurrent).toBe(false)
  })

  it('a peer on this release whose entry was stamped as it wrote is never a 0.10.0 writer', async () => {
    const phone = await connected()
    await advance(5000)
    writeAs010({ n: '', app: __APP_VERSION__, m: 'table', e: 0, at: Date.now() }, 'r11')
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    expect(phone.sync.useSyncStore.getState().view?.allCurrent).toBe(true)
  })

  it('a peer still on 0.11.0 registers as it writes: listed as older, never a 0.10.0 writer', async () => {
    // the upgrade window: this device runs this release, the other has not reloaded yet
    const phone = await connected()
    await advance(5000)
    writeAs010({ n: '', app: '0.11.0', m: 'table', e: 0, at: Date.now() }, 'r11d')
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.legacy.v5preAt).toBeNull()
    expect(view?.devices.find((d) => d.id === 'old010')).toMatchObject({
      name: 'Other device',
      app: '0.11.0',
      legacy: false,
      older: true,
    })
    expect(view?.allCurrent).toBe(false)
  })

  it('a 0.10.0 that updates is listed by its own entry again, and its sighting stops counting', async () => {
    const phone = await connected()
    await advance(5000)
    writeAs010(null, 'rev0100000000003')
    await advance(5000)
    expect(phone.sync.useSyncStore.getState().view?.devices.map((d) => d.app)).toContain('0.10.0')
    vi.setSystemTime(Date.now() + MINUTE)
    // the same device, updated to this release: it registers itself as it writes
    writeAs010({ n: '', app: __APP_VERSION__, m: 'table', e: 0, at: Date.now() }, 'r11b')
    await advance(5000)
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.devices.find((d) => d.id === 'old010')).toMatchObject({
      name: 'Other device',
      app: __APP_VERSION__,
      legacy: false,
    })
    expect(view?.legacy.v5preAt).toBeNull()
    expect(view?.allCurrent).toBe(true)
  })

  /** Sets the relay row's stamp as if a device whose clock runs `ahead` ms fast wrote it last. */
  function stampAhead(ahead: number): void {
    const row = relay().rows.get(SYNC_CODE)
    if (row === undefined) throw new Error('no row')
    row.updated_at = pgTime((Date.now() + ahead) * 1000)
  }

  it('a single write stamped days ahead never makes a current 0.11.0 peer a 0.10.0 writer', async () => {
    const laptop = await bootDevice({ expenses: [expense('l1')], dev: 'lap001' })
    await connect(laptop)
    // An old device (0.9.2 and 0.10.0 send their own `new Date()`) with its clock 2 days fast
    // wrote the row once; every later token is after it (tok = base + 1 µs).
    stampAhead(2 * DAY)
    const phone = await bootDevice({ expenses: [expense('p1')], dev: 'pho001' })
    await connect(phone)
    expect((micros(rowStamp(SYNC_CODE) ?? '') ?? 0) / 1000).toBeGreaterThan(Date.now() + DAY)
    await settle(laptop.sync.useSyncStore.getState().triggerSync(), 3000)
    await advance(5000)
    // hours later, the same copy again (a start-up's full pull): still the phone's own write
    vi.setSystemTime(Date.now() + 7 * 60 * MINUTE)
    await settle(laptop.sync.useSyncStore.getState().triggerSync(), 3000)
    for (const d of [laptop, phone]) {
      const view = d.sync.useSyncStore.getState().view
      expect(portOf(d).meta().legacySeen.v5pre).toBeUndefined()
      expect(view?.legacy.v5preAt).toBeNull()
      expect(view?.devices.map((r) => [r.id, r.app, r.legacy])).toEqual(
        expect.arrayContaining([
          ['lap001', __APP_VERSION__, false],
          ['pho001', __APP_VERSION__, false],
        ]),
      )
      expect(view?.allCurrent).toBe(true)
    }
  })

  it('a peer on this release whose clock runs 7 hours slow is itself once seen writing again', async () => {
    const phone = await connected()
    await advance(5000)
    const slow = () => Date.now() - 7 * 60 * MINUTE
    // its first write is stamped by its own clock (no faster writer pinned it): it is itself
    writeAs010({ n: '', app: __APP_VERSION__, m: 'table', e: 0, at: slow() }, 'slow0001')
    stampAhead(-7 * 60 * MINUTE)
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    // the phone writes (the relay's stamp is real time again), then the slow laptop writes after
    // it: its token is after the phone's, 7 hours past its own `seen`, which moved
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(10_000)
    vi.setSystemTime(Date.now() + MINUTE)
    writeAs010({ n: '', app: __APP_VERSION__, m: 'table', e: 0, at: slow() }, 'slow0002')
    await advance(5000)
    const view = phone.sync.useSyncStore.getState().view
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    expect(view?.legacy.v5preAt).toBeNull()
    expect(view?.devices.find((d) => d.id === 'old010')).toMatchObject({
      app: __APP_VERSION__,
      legacy: false,
    })
    expect(view?.allCurrent).toBe(true)
  })

  it('a slow peer on this release misread once at its first sighting is itself again at its next write', async () => {
    const phone = await connected()
    await advance(5000)
    const slow = () => Date.now() - 7 * 60 * MINUTE
    // first sighting, its token pinned after the phone's write: 7 hours past its `seen`
    writeAs010({ n: '', app: __APP_VERSION__, m: 'table', e: 0, at: slow() }, 'slow0003')
    await advance(5000)
    expect(portOf(phone).meta().v5preDev).toBe('old010')
    vi.setSystemTime(Date.now() + MINUTE)
    writeAs010({ n: '', app: __APP_VERSION__, m: 'table', e: 0, at: slow() }, 'slow0004')
    await advance(5000)
    // its entry moved: it registered as it wrote, and the sighting ends whatever the clocks say
    expect(portOf(phone).meta()).toMatchObject({ v5preDev: null })
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.legacy.v5preAt).toBeNull()
    expect(view?.devices.find((d) => d.id === 'old010')).toMatchObject({ legacy: false })
    expect(view?.allCurrent).toBe(true)
  })

  it('a device rolled back to 0.10.0 still reads as one when this device knew its entry', async () => {
    const phone = await connected()
    await advance(5000)
    // its 0.11.0 wrote an hour ago (this device merged that entry) …
    writeAs010({ n: '', app: '0.11.0', m: 'table', e: 0, at: Date.now() }, 'r11c')
    await advance(5000)
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    const payload = rowPayload(SYNC_CODE)
    if (!isObject(payload)) throw new Error('no row')
    const block = x5()
    const devs = isObject(block.devs) ? block.devs : {}
    // … then, back on 0.10.0 seven hours later, it writes carrying that entry unchanged
    vi.setSystemTime(Date.now() + 7 * 60 * MINUTE)
    writeAsOther(SYNC_CODE, {
      ...payload,
      x5: { ...block, dev: 'old010', rev: 'rev0100000000009', devs: { ...devs } },
    })
    await advance(5000)
    expect(portOf(phone).meta()).toMatchObject({ v5preDev: 'old010' })
    expect(phone.sync.useSyncStore.getState().view?.legacy.v5preAt).not.toBeNull()
  })

  it('with only this device on the list, it never says all your devices are current', async () => {
    const phone = await connected()
    await advance(5000)
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.devices).toHaveLength(1)
    expect(view?.allCurrent).toBe(false)
  })

  it('never marks this device, nor a peer on this release with its own entry, as v5pre', async () => {
    const phone = await connected('p1')
    await connected('l1') // the laptop registers itself on its pushes
    await advance(5000)
    phone.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1 })
    await advance(10_000)
    expect(portOf(phone).meta().legacySeen.v5pre).toBeUndefined()
    expect(phone.sync.useSyncStore.getState().view?.allCurrent).toBe(true)
  })
})

describe('the view (§3.9)', () => {
  it('lists this device first, then the others, with the masked code', async () => {
    const phone = await connected('p1')
    const laptop = await connected('l1')
    await advance(10_000)
    const view = phone.sync.useSyncStore.getState().view
    expect(view?.codeMasked).toBe(maskCode(SYNC_CODE))
    expect(view?.codeMasked).not.toContain(SYNC_CODE.slice(0, 8))
    expect(view?.devices.map((d) => d.me)).toEqual([true, false])
    expect(view?.devices[0]).toMatchObject({
      id: portOf(phone).deviceId(),
      name: 'This device',
      app: __APP_VERSION__,
      mode: 'table',
      older: false,
      stale: false,
      legacy: false,
    })
    expect(view?.devices[1]?.id).toBe(portOf(laptop).deviceId())
    expect(view?.transport).toBe('table')
    expect(view?.lockdown).toBeNull()
  })

  it('keeps the same view object while nothing it shows changes', async () => {
    const phone = await connected()
    await advance(MINUTE)
    const view = phone.sync.useSyncStore.getState().view
    expect(view).not.toBeNull()
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event('online'))
      await advance(5 * MINUTE)
    }
    expect(phone.sync.useSyncStore.getState().view).toBe(view)
    // a second device appears: a new view
    await connected('l1')
    await advance(10_000)
    expect(phone.sync.useSyncStore.getState().view).not.toBe(view)
    expect(phone.sync.useSyncStore.getState().view?.devices).toHaveLength(2)
  })

  it('is cleared on Disconnect', async () => {
    const phone = await connected()
    phone.sync.useSyncStore.getState().disconnectSync()
    await advance(MINUTE)
    expect(phone.sync.useSyncStore.getState().view).toBeNull()
  })
})

/** HEADs of the row no bucket can be (the lockdown probe's), by every client or one. */
const probes = (client?: number) =>
  requestsOf('head', client).filter((q) => JSON.stringify(q).includes(LOCKDOWN_PROBE_ROW)).length

/** The page hidden and shown again: the channel is closed, then joined again. */
async function resubscribe(): Promise<void> {
  setVisibility('hidden')
  await advance(MINUTE)
  setVisibility('visible')
  await advance(MINUTE)
}

/**
 * The app closed (its client `client` hears and asks nothing more) and opened again on the same
 * storage: the new page load and the relay client it asks with.
 */
async function reopenClosed(d: Device, client: number): Promise<[Device, number]> {
  setClientOffline(client, true)
  const next = relay().nextClient
  const opened = await loadDevice(d.storage)
  await opened.expense.useExpenseStore.getState().hydrate()
  opened.sync.installSync()
  await advance(MINUTE)
  return [opened, next]
}

describe('the lockdown, once this device has seen it (0.22.2)', () => {
  it('remembers the refusal for this relay, says so after a reload without asking again, and forgets it once the table answers', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    migrate('004')
    const phone = await connected()
    await advance(MINUTE)
    expect(phone.sync.useSyncStore.getState().view).toMatchObject({
      transport: 'rpc',
      lockedDown: false,
    })
    // asked once after the first cycle (0.22.3): the table answers, so nothing is noted
    expect(probes()).toBe(1)

    // 005 applied while this page stays open: a day on, the relay is asked again
    migrate('005')
    vi.setSystemTime(Date.now() + DAY)
    await resubscribe()
    expect(probes()).toBe(2)
    expect(portOf(phone).meta().lockdownSeen?.relay).toEqual(expect.any(String))
    expect(phone.sync.useSyncStore.getState().view?.lockedDown).toBe(true)

    // the app opened again: it knows at once, and asks nothing
    const [reloaded, client] = await reopenClosed(phone, 1)
    expect(reloaded.sync.useSyncStore.getState().view?.lockedDown).toBe(true)
    await resubscribe()
    expect(probes(client)).toBe(0)

    // 005 rolled back: a joined change feed proves nothing (0.22.3), so the line stays until
    // the relay's own answer, a day on, clears it
    migrate('rollback 005')
    await resubscribe()
    expect(reloaded.sync.useSyncStore.getState().view?.lockedDown).toBe(true)
    vi.setSystemTime(Date.now() + DAY)
    await resubscribe()
    expect(probes(client)).toBe(1)
    expect(reloaded.sync.useSyncStore.getState().view?.lockedDown).toBe(false)
    expect(portOf(reloaded).meta().lockdownSeen).toMatchObject({ relay: null })
  })

  it('never says the lockdown is applied when the project only lacks the change feed', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    migrate('004')
    const phone = await connected()
    await advance(MINUTE)
    relay().rowEvents = 'rejected' // no publication: the table itself still answers
    await resubscribe()
    expect(probes()).toBe(1) // the one after the first cycle: the refusals ask nothing more
    expect(phone.sync.useSyncStore.getState().view?.lockedDown).toBe(false)
  })
})

describe('the lockdown, asked of the relay itself (0.22.3)', () => {
  const live = (d: Device) => d.sync.useSyncStore.getState().view?.live
  const lockedDown = (d: Device) => d.sync.useSyncStore.getState().view?.lockedDown
  /** The last channel opened with a Broadcast binding (the engine's subscription). */
  const lastChannel = () =>
    relay()
      .created.filter((c) => c.broadcastEvents)
      .at(-1)

  /** 004 and 005 applied, as on the owner's project; the build detects the functions. */
  function lockedRelay(): void {
    vi.stubEnv('VITE_SYNC_RELAY', 'auto')
    migrate('004')
    migrate('005')
  }

  it('says the lockdown is applied after the first cycle, though the change feed joins', async () => {
    lockedRelay()
    const phone = await connected()
    await advance(MINUTE)
    expect(relay().rowEvents).toBe('silent') // the server joins row events it cannot deliver
    expect(probes()).toBe(1)
    expect(lockedDown(phone)).toBe(true)
    expect(portOf(phone).meta().lockdownSeen?.relay).toEqual(expect.any(String))
    // live updates stay on, over Broadcast alone: no row events are asked for any more
    expect(live(phone)).toBe('on')
    expect(lastChannel()?.rowEvents).toBe(false)
    expect(lastChannel()?.joined).toBe(true)
    expect(relay().channels.size).toBe(1)
  })

  it('keeps it after a reload with no new question that day; a joined channel never clears it', async () => {
    lockedRelay()
    const phone = await connected()
    await advance(MINUTE)
    expect(probes()).toBe(1)
    vi.setSystemTime(Date.now() + 6 * 60 * MINUTE)
    const [reopened, client] = await reopenClosed(phone, 1)
    expect(lockedDown(reopened)).toBe(true)
    expect(lastChannel()?.rowEvents).toBe(false)
    for (let i = 0; i < 3; i++) await resubscribe()
    await advance(30 * MINUTE)
    expect(probes(client)).toBe(0)
    expect(lockedDown(reopened)).toBe(true)
    expect(live(reopened)).toBe('on')
  })

  it('asks again once a day while it knows, and stays applied while the relay says so', async () => {
    lockedRelay()
    const phone = await connected()
    await advance(MINUTE)
    const first = portOf(phone).meta().lockdownSeen?.at ?? 0
    vi.setSystemTime(first + DAY)
    const [reopened, client] = await reopenClosed(phone, 1)
    expect(probes(client)).toBe(1)
    expect(lockedDown(reopened)).toBe(true)
    // the answer moved the day on: within the next day nothing is asked, open or reloaded
    expect(portOf(reopened).meta().lockdownSeen?.at ?? 0).toBeGreaterThanOrEqual(first + DAY)
    for (let i = 0; i < 3; i++) await resubscribe()
    expect(probes(client)).toBe(1)
    vi.setSystemTime(Date.now() + 12 * 60 * MINUTE)
    const [again, next] = await reopenClosed(reopened, client)
    expect(probes(next)).toBe(0)
    expect(lockedDown(again)).toBe(true)
  })

  it('clears it when the relay answers open (005 rolled back), and asks for row events again', async () => {
    lockedRelay()
    const phone = await connected()
    await advance(MINUTE)
    expect(lockedDown(phone)).toBe(true)
    migrate('rollback 005')
    await resubscribe()
    expect(lockedDown(phone)).toBe(true) // within the day, nothing is asked
    vi.setSystemTime(Date.now() + DAY)
    await resubscribe()
    expect(probes()).toBe(2)
    expect(lockedDown(phone)).toBe(false)
    expect(portOf(phone).meta().lockdownSeen).toMatchObject({ relay: null })
    await resubscribe()
    expect(lastChannel()?.rowEvents).toBe(true)
  })

  it('changes nothing on an answer the relay cannot give', async () => {
    lockedRelay()
    const phone = await connected()
    await advance(MINUTE)
    const at = portOf(phone).meta().lockdownSeen?.at
    vi.setSystemTime(Date.now() + DAY)
    const asked = probes()
    // Sync now pulls in full (no HEAD): the question after it is the one that fails
    failNext('head', { status: 503, message: 'Service Unavailable' })
    await settle(phone.sync.useSyncStore.getState().triggerSync(), 3000)
    await advance(MINUTE)
    expect(phone.sync.useSyncStore.getState().cloudStatus).toBe('synced')
    expect(probes()).toBe(asked + 1)
    expect(lockedDown(phone)).toBe(true)
    expect(portOf(phone).meta().lockdownSeen?.at).toBe(at)
  })

  it('a Broadcast from the other device still starts a cycle under the lockdown', async () => {
    lockedRelay()
    const phone = await connected('p1')
    const laptop = await connected('l1')
    await advance(MINUTE)
    for (const d of [phone, laptop]) {
      expect(lockedDown(d)).toBe(true)
      expect(live(d)).toBe('on')
    }
    const open = relay().created.filter((c) => relay().channels.has(c))
    expect(open.map((c) => c.rowEvents)).toEqual([false, false])
    const broadcasts = relay().broadcasts
    laptop.expense.useExpenseStore.getState().addExpense({ itemName: 'Kopi', amount: 1.5 })
    await advance(10_000) // far sooner than the 5-minute poll
    expect(relay().broadcasts).toBeGreaterThan(broadcasts)
    expect(phone.expense.useExpenseStore.getState().expenses.map((e) => e.itemName)).toContain(
      'Kopi',
    )
  })

  it('asks nothing on a device that is not linked', async () => {
    lockedRelay()
    await bootDevice({ expenses: [expense('e1')] })
    await advance(10 * MINUTE)
    expect(probes()).toBe(0)
  })
})

describe('an older writer is recorded once per copy (0.22.2)', () => {
  /** The device reopened on its own storage, as the app opens after being closed. */
  async function reopen(d: Device): Promise<Device> {
    const next = await loadDevice(d.storage)
    await next.expense.useExpenseStore.getState().hydrate()
    next.sync.installSync()
    await advance(10_000)
    return next
  }

  it('a current peer misread as a 0.10.0 at its first sighting is not seen again at each start: the 14 days run from that sighting', async () => {
    vi.stubEnv('VITE_SYNC_RELAY', 'rpc')
    migrate('004')
    const phone = await bootDevice({ expenses: [expense('p1')], dev: 'pho001' })
    await connect(phone)
    // the phone is closed (its network gone: it hears nothing)
    setClientOffline(1, true)
    // An older build with a fast clock once stamped the row 2 days ahead: every later token is
    // after it (the functions' GREATEST(clock, base + 1 µs)).
    const row = relay().rows.get(SYNC_CODE)
    if (row === undefined) throw new Error('no row')
    row.updated_at = pgTime((Date.now() + 2 * DAY) * 1000)
    // A laptop on this release joins (its first write, its entry stamped as it wrote), then closes.
    const laptop = await bootDevice({ expenses: [expense('l1')], dev: 'lap001' })
    await connect(laptop)
    setClientOffline(2, true)

    // 7 hours later the phone opens: its first sighting of the laptop, judged by the window, is
    // read as a 0.10.0 (how a writer is judged is unchanged)
    vi.setSystemTime(Date.now() + 7 * 60 * MINUTE)
    const opened = await reopen(phone)
    const first = portOf(opened).meta().legacySeen.v5pre ?? 0
    expect(first).toBeGreaterThan(0)
    expect(portOf(opened).meta().v5preDev).toBe('lap001')
    const reason = opened.sync.useSyncStore.getState().view?.lockdown?.reason
    // (the line names the device listed as Older SpendTrack (0.10.0) first; it stays the same)
    expect(reason).toContain('Older SpendTrack (0.10.0)')

    // The next days the phone opens again; nothing new on either device, so the copy is still the
    // laptop's: judged as before, but not seen again, so the day it was last seen stays.
    for (let day = 1; day <= 2; day++) {
      vi.setSystemTime(Date.now() + DAY)
      const next = await reopen(opened)
      await settle(next.sync.useSyncStore.getState().triggerSync(), 3000)
      expect(portOf(next).meta().legacySeen.v5pre).toBe(first)
      const view = next.sync.useSyncStore.getState().view
      expect(view?.legacy.v5preAt).toBe(first)
      expect(view?.lockdown?.reason).toBe(reason)
    }
  })

  it('a real 0.10.0 copy keeps its verdict when judged again, even with this device’s clock set back', async () => {
    const phone = await connected()
    await advance(5000)
    const written = () => {
      const payload = rowPayload(SYNC_CODE)
      if (!isObject(payload)) throw new Error('no row')
      return payload
    }
    // its 0.11.0 wrote (this device merged that entry) …
    const block = x5()
    const devs = isObject(block.devs) ? block.devs : {}
    const own = { n: '', app: '0.11.0', m: 'table', e: 0, at: Date.now() }
    writeAsOther(SYNC_CODE, {
      ...written(),
      x5: { ...block, dev: 'old010', rev: 'r11e', devs: { ...devs, old010: own } },
    })
    await advance(5000)
    // … then, rolled back to 0.10.0 seven hours later, it writes carrying that entry unchanged
    const wrote = Date.now()
    vi.setSystemTime(wrote + 7 * 60 * MINUTE)
    const after = x5()
    writeAsOther(SYNC_CODE, {
      ...written(),
      x5: { ...after, dev: 'old010', rev: 'rev0100000000010' },
    })
    await advance(5000)
    const first = portOf(phone).meta().legacySeen.v5pre
    expect(portOf(phone).meta().v5preDev).toBe('old010')
    // The owner sets this device's clock back to just after the 0.11.0 write, and opens the app:
    // the same copy, judged again by the clocks alone, would now pass for a registration.
    vi.setSystemTime(wrote + MINUTE)
    const next = await reopen(phone)
    expect(portOf(next).meta()).toMatchObject({ v5preDev: 'old010', legacySeen: { v5pre: first } })
    expect(next.sync.useSyncStore.getState().view?.legacy.v5preAt).toBe(first)
  })
})
