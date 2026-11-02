// The 60 s mixed-version soak, shared by the runs beside 0.9.2 and beside 0.10.0: two devices
// on one sync code, each on its own build, add, edit, delete, undo and change a budget, on their
// own entries and on each other's; then 15 s of quiet. Afterwards both hold the same live
// entries (nothing lost, nothing deleted comes back), traffic stayed bounded (each device at
// most 2 pushes per change of its own + 6) and the last 10 s saw no push at all (no ping-pong).
// Driven through the real UI of each build. Invented data.

import { expect, type Browser } from '@playwright/test'
import type { Relay, StaticHost, WriterClass } from './relayServer'
import {
  SYNC_CODE,
  deleteEntry,
  editAmount,
  itemNames,
  openDevice,
  quickAdd,
  setBudget,
  storedRows,
  undoLast,
  type Device,
} from './devices'

const SLOT_MS = 4_000
const QUIET_MS = 15_000

export interface SoakResult {
  /** The device on the build under test (`hostNew`) and the other one. */
  readonly n: Device
  readonly o: Device
  /** When the quiet tail ended. */
  readonly end: number
}

/**
 * Runs the soak and checks one live set, no resurrection, bounded traffic, a quiet end and the
 * wire each build writes. `devices` receives both devices as soon as they open (closed by the
 * caller's afterAll, even when an assertion fails).
 */
export async function soak(
  browser: Browser,
  relay: Relay,
  hostNew: StaticHost,
  hostOld: StaticHost,
  writers: { readonly n: WriterClass | null; readonly o: WriterClass },
  devices: Device[],
): Promise<SoakResult> {
  const n = await openDevice(browser, hostNew.origin, { path: '/ledger?range=all' })
  devices.push(n)
  const o = await openDevice(browser, hostOld.origin, { path: '/ledger?range=all' })
  devices.push(o)
  await expect.poll(() => relay.channels(SYNC_CODE)).toBe(2)

  const changes = new Map<Device, number>([
    [n, 0],
    [o, 0],
  ])
  const did = (d: Device, count = 1) => changes.set(d, (changes.get(d) ?? 0) + count)
  /** Waits until the other device has `item` (or no longer has it). */
  const seen = (d: Device, item: string, present = true) =>
    expect
      .poll(async () => (await itemNames(d.page)).includes(item), { timeout: 20_000 })
      .toBe(present)

  const plan: (() => Promise<void>)[] = [
    async () => {
      await quickAdd(n.page, 'new coffee 3.20')
      did(n)
    },
    async () => {
      await quickAdd(o.page, 'old lunch 8.50')
      did(o)
    },
    async () => {
      await quickAdd(n.page, 'new taxi 2.40')
      did(n)
    },
    async () => {
      await quickAdd(o.page, 'old tea 1.50')
      did(o)
    },
    async () => {
      // An edit of the other device's entry.
      await seen(n, 'old lunch')
      await editAmount(n.page, 'old lunch', '9')
      did(n)
    },
    async () => {
      await seen(o, 'new taxi')
      await deleteEntry(o.page, 'new taxi')
      did(o)
    },
    async () => {
      // An add taken back at once.
      await quickAdd(n.page, 'new snack 4.30')
      await undoLast(n.page)
      did(n, 2)
    },
    async () => {
      await quickAdd(o.page, 'old cake 6.10')
      await undoLast(o.page)
      did(o, 2)
    },
    async () => {
      await setBudget(n.page, 'Food & Dining', '300')
      did(n)
    },
    async () => {
      await seen(o, 'new coffee')
      await editAmount(o.page, 'new coffee', '3.5')
      did(o)
    },
    async () => {
      await seen(n, 'old tea')
      await deleteEntry(n.page, 'old tea')
      did(n)
    },
    async () => {
      await setBudget(o.page, 'Transportation', '80')
      did(o)
    },
    async () => {
      await quickAdd(n.page, 'new dinner 12.20')
      did(n)
    },
    async () => {
      await quickAdd(o.page, 'old grab 15.70')
      did(o)
    },
    async () => {
      // A delete taken back at once.
      await deleteEntry(n.page, 'new dinner')
      await undoLast(n.page)
      did(n, 2)
    },
  ]

  const started = Date.now()
  for (const [i, step] of plan.entries()) {
    const due = started + i * SLOT_MS
    if (Date.now() < due) await n.page.waitForTimeout(due - Date.now())
    await step()
  }
  const busyUntil = Math.max(Date.now(), started + 60_000)
  await n.page.waitForTimeout(busyUntil - Date.now() + QUIET_MS)
  const end = Date.now()

  // One live set on both, with every edit and nothing that was deleted or taken back.
  const live = ['new coffee', 'new dinner', 'old grab', 'old lunch']
  expect(await itemNames(n.page)).toEqual(live)
  expect(await itemNames(o.page)).toEqual(live)
  const rowsOf = async (d: Device) =>
    (await storedRows(d.page)).map((r) => [r.id, r.itemName, r.amount, r.category])
  expect(await rowsOf(n)).toEqual(await rowsOf(o))
  const amounts = new Map((await storedRows(o.page)).map((r) => [r.itemName, r.amount]))
  expect(amounts.get('new coffee')).toBe(3.5)
  expect(amounts.get('old lunch')).toBe(9)
  const relayText = JSON.stringify(relay.row(SYNC_CODE)?.payload ?? null)
  for (const gone of ['new taxi', 'old tea', 'new snack', 'old cake']) {
    expect(relayText, `${gone} stays gone on the relay`).not.toContain(`"${gone}"`)
  }

  // Bounded traffic, and quiet at the end.
  for (const d of [n, o]) {
    const pushes = relay.pushes(d.origin).length
    const bound = 2 * (changes.get(d) ?? 0) + 6
    expect(
      pushes,
      `${d.origin}: ${String(pushes)} pushes for ${String(changes.get(d))} changes`,
    ).toBeLessThanOrEqual(bound)
  }
  expect(relay.pushes(undefined, end - 10_000)).toEqual([])
  // What each build pushed is its own wire: v5 (additive x5) from 0.10.0 and later, 0.8.5 from 0.9.2.
  expect(new Set(relay.pushes(hostOld.origin).map((p) => p.writer))).toEqual(new Set([writers.o]))
  if (writers.n !== null) {
    expect(new Set(relay.pushes(hostNew.origin).map((p) => p.writer))).toEqual(new Set([writers.n]))
  }
  return { n, o, end }
}
