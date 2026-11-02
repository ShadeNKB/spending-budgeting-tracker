import { test, expect, type Browser } from '@playwright/test'
import {
  serveBuild,
  startRelay,
  type Relay,
  type RelayRequest,
  type StaticHost,
} from './support/relayServer'
import {
  PORTS,
  SYNC_CODE,
  build,
  closeAll,
  itemNames,
  openDevice,
  quickAdd,
  relayNames,
  type Device,
} from './support/devices'

// The flags build (VITE_SYNC_CAS=on, VITE_SYNC_RELAY=auto: the PR-5 runbook's switches) against
// every database state of §14.1, on the fake relay: before 004 (table transport, compare-and-set
// on updated_at: crossing pushes lose nothing, the loser re-pulls), after 004 (a new session
// probes st_sync_head and then speaks only RPC), 005 applied mid-session (the table refuses: the
// device probes again at once and carries on over RPC, row events off), and 004 rolled back (the
// RPC is gone: back to the table in the same cycle). Invented data.

let relay: Relay | undefined
let hosts: StaticHost[] = []
let devices: Device[] = []

test.afterEach(async () => {
  await closeAll(devices)
  devices = []
  for (const h of hosts) await h.close()
  hosts = []
  await relay?.close()
  relay = undefined
})

/** A fresh relay (prepared by `before`) and two flags-build devices on one code, both linked. */
async function pair(
  browser: Browser,
  before: (r: Relay) => void = () => undefined,
): Promise<{ readonly r: Relay; readonly a: Device; readonly b: Device }> {
  const r = await startRelay(PORTS.relay)
  relay = r
  before(r)
  hosts = [
    await serveBuild(PORTS.candidateA, build('candidate-flags')),
    await serveBuild(PORTS.candidateB, build('candidate-flags')),
  ]
  const [ha, hb] = hosts
  if (ha === undefined || hb === undefined) throw new Error('two hosts expected')
  const a = await openDevice(browser, ha.origin)
  devices.push(a)
  await expect.poll(() => r.row(SYNC_CODE) !== null, { timeout: 30_000 }).toBe(true)
  const b = await openDevice(browser, hb.origin)
  devices.push(b)
  return { r, a, b }
}

const TABLE_KINDS = new Set(['head', 'pull', 'push', 'insert', 'update'])
const isTable = (q: RelayRequest) => TABLE_KINDS.has(q.kind)
const landedOn = (r: Relay, item: string) =>
  expect.poll(() => relayNames(r), { timeout: 30_000 }).toContain(item)
const arrives = (d: Device, item: string) =>
  expect.poll(() => itemNames(d.page), { timeout: 30_000 }).toContain(item)

test('CAS (before 004): crossing pushes lose nothing; the loser logs a conflict, re-pulls, merges', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { r, a, b } = await pair(browser)
  // no relay functions yet: the probe found none, so every call is a table call
  expect(r.requests('rpc', a.origin).map((q) => [q.fn, q.outcome])).toEqual([
    ['st_sync_head', 'no-rpc'],
  ])
  await expect.poll(() => r.channels(SYNC_CODE)).toBe(2)
  // both devices pull the same copy, then both write against it
  const release = r.holdReads()
  const since = Date.now()
  await quickAdd(a.page, 'cross a 1.10')
  await quickAdd(b.page, 'cross b 2.20')
  await expect.poll(() => r.heldReads(), { timeout: 20_000 }).toBe(2)
  release()
  await landedOn(r, 'cross a')
  await landedOn(r, 'cross b')
  await arrives(a, 'cross b')
  await arrives(b, 'cross a')
  const updates = r.requests('update', undefined, since)
  // every write was conditional on the copy it pulled, sent verbatim (µs, +00:00)
  expect(updates.every((q) => typeof q.base === 'string' && q.base.endsWith('+00:00'))).toBe(true)
  const lost = updates.find((q) => q.outcome === 'conflict')
  expect(lost, 'one write lost the race').toBeDefined()
  if (lost === undefined) return
  const after = r.log.filter((q) => q.origin === lost.origin && q.at >= lost.at)
  const repull = after.findIndex((q) => q.kind === 'pull')
  const rewrite = after.findIndex((q) => q.kind === 'update' && q.outcome === 'ok')
  expect(repull, 'the loser pulls again').toBeGreaterThanOrEqual(0)
  expect(rewrite, 'then writes again').toBeGreaterThan(repull)
  expect(r.requests('push')).toEqual([]) // never a blind upsert with CAS on
})

test('after 004: a new session probes the relay functions and then speaks only RPC', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { r, a, b } = await pair(browser, (x) => {
    x.enableRpc()
  })
  await quickAdd(a.page, 'over rpc 3.30')
  await landedOn(r, 'over rpc')
  await arrives(b, 'over rpc')
  for (const d of [a, b]) {
    const mine = r.log.filter((q) => q.origin === d.origin)
    expect(mine.filter(isTable), `${d.origin} made no table call`).toEqual([])
    expect(mine.find((q) => q.kind === 'rpc')?.fn).toBe('st_sync_head') // the probe comes first
  }
  const pushes = r.requests('rpc', a.origin).filter((q) => q.fn === 'st_sync_push')
  expect(pushes.length).toBeGreaterThan(0)
  expect(pushes.every((q) => q.outcome === 'ok' || q.outcome === 'conflict')).toBe(true)
})

test('005 applied mid-session: the table refuses, the device probes again and carries on over RPC', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { r, a, b } = await pair(browser)
  await quickAdd(a.page, 'before lockdown 4.40')
  await arrives(b, 'before lockdown')
  // 004 then 005: functions in, table locked, out of the realtime publication
  const since = Date.now()
  r.enableRpc()
  r.lockTable()
  r.disablePostgresChanges()
  await quickAdd(a.page, 'after lockdown 5.50')
  await landedOn(r, 'after lockdown')
  const mine = r.log.filter((q) => q.origin === a.origin && q.at >= since)
  const denied = mine.findIndex((q) => isTable(q) && q.outcome === 'denied')
  const probe = mine.findIndex(
    (q) => q.kind === 'rpc' && q.fn === 'st_sync_head' && q.outcome === 'ok',
  )
  const pushed = mine.findIndex(
    (q) => q.kind === 'rpc' && q.fn === 'st_sync_push' && q.outcome === 'ok',
  )
  expect(denied, 'a table call was refused').toBeGreaterThanOrEqual(0)
  expect(probe, 'then the relay was probed again').toBeGreaterThan(denied)
  expect(pushed, 'then the push went over RPC').toBeGreaterThan(probe)
  // the other device hears it without row events (Broadcast, or its next poll) and moves too
  await arrives(b, 'after lockdown')
  await expect(a.page.getByText(/Sync paused/)).toHaveCount(0)
})

test('004 rolled back: the RPC is gone, the device falls back to the table in the same cycle', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { r, a, b } = await pair(browser, (x) => {
    x.enableRpc()
  })
  await quickAdd(a.page, 'on rpc 6.60')
  await arrives(b, 'on rpc')
  const since = Date.now()
  r.disableRpc()
  await quickAdd(a.page, 'back on table 7.70')
  await landedOn(r, 'back on table')
  await arrives(b, 'back on table')
  const mine = r.log.filter((q) => q.origin === a.origin && q.at >= since)
  const gone = mine.findIndex((q) => q.kind === 'rpc' && q.outcome === 'no-rpc')
  const table = mine.findIndex((q) => q.kind === 'update' && q.outcome === 'ok')
  expect(gone, 'an RPC found no function').toBeGreaterThanOrEqual(0)
  expect(table, 'the push then went to the table').toBeGreaterThan(gone)
  expect(mine.filter((q) => q.kind === 'rpc' && q.at > (mine[table]?.at ?? 0))).toEqual([])
})
