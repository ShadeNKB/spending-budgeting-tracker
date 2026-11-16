// @vitest-environment node
// The device registry (PR-3 track spec P3-7 to P3-9, §3.8): the entry a push carries (no name:
// §8 cut 1), which changes need a push, which writer is a 0.10.0, version order, the Settings rows
// and readiness.
import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '../core/types'
import {
  STALE_AFTER_MS,
  compareApp,
  deviceRows,
  placeV5pre,
  readiness,
  registerFirst,
  registryEntry,
  sameEntry,
  wroteItself,
} from './registry'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 2, 4, 0, 0)

const entry = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  name: '',
  app: '0.11.0',
  mode: 'table',
  e2e: false,
  seen: NOW,
  ...over,
})

describe('registryEntry and sameEntry', () => {
  it('is what a push carries: no name, app, mode, e2e false, seen now', () => {
    expect(registryEntry(undefined, '0.11.0', 'table', NOW)).toEqual({
      name: '',
      app: '0.11.0',
      mode: 'table',
      e2e: false,
      seen: NOW,
    })
  })

  it('keeps seen ahead of every sighting of this device (a clock set back cannot lose its entry)', () => {
    const prev = entry({ seen: NOW + DAY })
    expect(registryEntry(prev, '0.11.0', 'table', NOW).seen).toBe(NOW + DAY + 1)
  })

  it('stamps rpcSince when the device turns to RPC, and keeps it while it stays there', () => {
    const first = registryEntry(entry(), '0.11.0', 'rpc', NOW)
    expect(first.rpcSince).toBe(NOW)
    const later = registryEntry(first, '0.11.0', 'rpc', NOW + 9 * DAY)
    expect(later.rpcSince).toBe(NOW)
    const back = registryEntry(later, '0.11.0', 'table', NOW + 10 * DAY)
    expect(back.rpcSince).toBeUndefined()
  })

  it('ignores seen, and sees every other field', () => {
    const a = entry()
    expect(sameEntry(a, { ...a, seen: NOW + 60_000 })).toBe(true)
    expect(sameEntry(undefined, a)).toBe(false)
    expect(sameEntry(a, { ...a, app: '0.12.0' })).toBe(false)
    expect(sameEntry(a, { ...a, mode: 'rpc', rpcSince: NOW })).toBe(false)
    expect(sameEntry(a, { ...a, name: 'Kitchen tablet' })).toBe(false)
    expect(sameEntry(a, { ...a, e2e: true })).toBe(false)
  })
})

describe('registerFirst (P3-7: what makes a tab push its entry)', () => {
  it('registers a device with no entry, a new app version, a new mode or a private flag', () => {
    expect(registerFirst(undefined, entry())).toBe(true)
    expect(registerFirst(entry({ app: '0.10.0' }), entry())).toBe(true)
    expect(registerFirst(entry({ name: 'Older app', app: '0.8.5' }), entry())).toBe(true)
    expect(registerFirst(entry(), entry({ mode: 'rpc', rpcSince: NOW }))).toBe(true)
    expect(registerFirst(entry(), entry({ e2e: true }))).toBe(true)
  })

  it('never for seen or the name alone: a later release in another tab may name the device', () => {
    expect(registerFirst(entry({ seen: NOW - DAY }), entry())).toBe(false)
    expect(registerFirst(entry({ name: 'Kitchen tablet' }), entry())).toBe(false)
  })

  it('never for an older app than another tab of this device registered (a tab left open)', () => {
    expect(registerFirst(entry({ app: '0.11.1' }), entry({ app: '0.11.0' }))).toBe(false)
    expect(registerFirst(entry({ app: '0.12.0', mode: 'rpc' }), entry({ app: '0.11.0' }))).toBe(
      false,
    )
  })
})

describe('wroteItself and placeV5pre (P3-8: which writer is a 0.10.0)', () => {
  const HOURS = 60 * 60_000

  it('a registering writer stamps its own entry as it writes (first sighting: by the write time)', () => {
    expect(wroteItself(entry({ seen: NOW }), undefined, NOW + 2_000)).toBe(true)
    expect(wroteItself(entry({ seen: NOW }), undefined, null)).toBe(true)
    // clocks that differ by hours are still the same write
    expect(wroteItself(entry({ seen: NOW }), undefined, NOW + 6 * HOURS)).toBe(true)
    expect(wroteItself(entry({ seen: NOW }), undefined, NOW + 6 * HOURS + 1)).toBe(false)
  })

  it('a writer seen before registered itself when its entry moved, whatever either clock says', () => {
    // its clock runs 7 hours slow: the etag (after the last write) is far past its `seen`
    const known = entry({ seen: NOW - 7 * HOURS - 60_000 })
    expect(wroteItself(entry({ seen: NOW - 7 * HOURS }), known, NOW)).toBe(true)
    // a stamp pushed days ahead changes nothing either
    expect(wroteItself(entry({ seen: NOW + 1 }), entry({ seen: NOW }), NOW + 2 * DAY)).toBe(true)
  })

  it('no entry, a 0.9.2 entry, an older release or a carried entry is a 0.10.0 writer', () => {
    expect(wroteItself(undefined, undefined, NOW)).toBe(false)
    expect(wroteItself(entry({ name: 'Older app', app: '0.8.5' }), undefined, NOW)).toBe(false)
    expect(wroteItself(entry({ app: '0.10.0' }), undefined, NOW)).toBe(false)
    // an older release's entry that moved is still an older release's
    expect(wroteItself(entry({ app: '0.10.0', seen: NOW }), entry({ seen: 1 }), NOW)).toBe(false)
    // rolled back: 0.10.0 writes now and carries the entry its 0.11.0 stamped a day ago, the
    // same entry this device already knew, or met for the first time
    const carried = entry({ seen: NOW - DAY })
    expect(wroteItself(carried, carried, NOW)).toBe(false)
    expect(wroteItself(carried, undefined, NOW)).toBe(false)
  })

  it('lists the 0.10.0 device in place of any entry it carries, until it registers again', () => {
    const devices = new Map<string, DeviceInfo>([
      ['me0001', entry()],
      ['old010', entry({ mode: 'rpc', rpcSince: 1, seen: NOW - DAY })],
    ])
    expect(placeV5pre(devices, 'old010', NOW - 60_000)).toBe(NOW - 60_000)
    const rows = deviceRows(devices, 'me0001', '0.11.0', NOW)
    expect(rows.find((r) => r.id === 'old010')).toMatchObject({
      name: 'Older SpendTrack (0.10.0)',
      app: '0.10.0',
      mode: 'table',
      legacy: true,
      older: true,
    })
    // gate E: a rolled-back device that said RPC is never ready for the lockdown
    const legacy = { v084At: null, v085At: null, v5preAt: NOW - 60_000 }
    expect(readiness(rows, legacy, 'rpc', NOW)).toMatchObject({
      allCurrent: false,
      lockdown: { ready: false },
    })
    // an unknown device (no entry at all) is listed too
    const fresh = new Map<string, DeviceInfo>([['me0001', entry()]])
    placeV5pre(fresh, 'new010', NOW - 60_000)
    expect(fresh.get('new010')).toMatchObject({ app: '0.10.0', seen: NOW - 60_000 })
  })

  it('stops counting the sighting once that device registered after it', () => {
    const devices = new Map<string, DeviceInfo>([
      ['me0001', entry()],
      ['old010', entry({ seen: NOW })],
    ])
    expect(placeV5pre(devices, 'old010', NOW - 60_000)).toBeNull()
    expect(devices.get('old010')).toMatchObject({ name: '', app: '0.11.0' })
    expect(placeV5pre(new Map(), null, NOW)).toBe(NOW)
    expect(placeV5pre(new Map(), 'old010', null)).toBeNull()
  })
})

describe('compareApp', () => {
  it.each([
    ['0.11.0', '0.10.0', 1],
    ['0.10.0', '0.11.0', -1],
    ['0.9.2', '0.10.0', -1],
    ['0.11.0', '0.11.0', 0],
    ['1.0', '1.0.0', 0],
    ['0.11.0-beta', '0.11.0', 0],
    ['garbage', '0.0.0', 0],
  ] as const)('%s vs %s → %i', (a, b, sign) => {
    expect(Math.sign(compareApp(a, b))).toBe(sign)
  })
})

describe('deviceRows', () => {
  const devices = new Map<string, DeviceInfo>([
    ['phone1', entry({ seen: NOW - 60_000 })],
    ['lap001', entry({ app: '0.10.0', seen: NOW - 5_000 })],
    ['old001', { name: 'Older app', app: '0.8.5', mode: 'table', e2e: false, seen: 0 }],
    ['gone01', entry({ seen: NOW - STALE_AFTER_MS - 1 })],
  ])

  it('lists this device first, then by last seen, and marks me, older, legacy and stale', () => {
    const rows = deviceRows(devices, 'phone1', '0.11.0', NOW)
    expect(rows.map((r) => r.id)).toEqual(['phone1', 'lap001', 'gone01', 'old001'])
    expect(rows[0]).toMatchObject({ me: true, older: false, stale: false, legacy: false })
    expect(rows[1]).toMatchObject({ me: false, older: true, stale: false, app: '0.10.0' })
    // this release names no device (track spec §8 cut 1)
    expect(rows.slice(0, 3).map((r) => r.name)).toEqual([
      'This device',
      'Other device',
      'Other device',
    ])
    expect(rows[2]).toMatchObject({ stale: true })
    // an 'Older app' entry with no readable time is a legacy row, never stale; 0.9.2 stamps its
    // writes with its writer version 0.8.5, and the row says the release the owner knows
    expect(rows[3]).toMatchObject({
      name: 'Older SpendTrack (0.9.2)',
      app: '0.9.2',
      legacy: true,
      stale: false,
      older: true,
      seen: 0,
    })
  })

  it('shows a name a later release gave its device', () => {
    const named = new Map([['tab001', entry({ name: 'Kitchen tablet' })]])
    expect(deviceRows(named, 'me0001', '0.11.0', NOW)[0]?.name).toBe('Kitchen tablet')
  })

  it('never marks this device stale, whatever its last push', () => {
    const rows = deviceRows(devices, 'gone01', '0.11.0', NOW)
    expect(rows[0]).toMatchObject({ id: 'gone01', me: true, stale: false })
  })
})

describe('readiness', () => {
  const noLegacy = { v084At: null, v085At: null, v5preAt: null }
  const rowsOf = (devices: Map<string, DeviceInfo>) => deviceRows(devices, 'me0001', '0.11.0', NOW)

  it('is all current when every live device runs this build and no old writer wrote for 24 h', () => {
    const rows = rowsOf(
      new Map([
        ['me0001', entry()],
        ['lap001', entry()],
        ['gone01', entry({ app: '0.9.2', seen: NOW - STALE_AFTER_MS - 1 })], // stale: left out
      ]),
    )
    expect(readiness(rows, noLegacy, 'table', NOW)).toEqual({ allCurrent: true, lockdown: null })
    expect(readiness(rows, { ...noLegacy, v5preAt: NOW - DAY + 1 }, 'table', NOW).allCurrent).toBe(
      false,
    )
    expect(readiness(rows, { ...noLegacy, v085At: NOW - DAY - 1 }, 'table', NOW).allCurrent).toBe(
      true,
    )
  })

  it('is never all current with only this device on the list', () => {
    const alone = rowsOf(new Map([['me0001', entry()]]))
    expect(readiness(alone, noLegacy, 'table', NOW).allCurrent).toBe(false)
    const withStale = rowsOf(
      new Map([
        ['me0001', entry()],
        ['gone01', entry({ seen: NOW - STALE_AFTER_MS - 1 })],
      ]),
    )
    expect(readiness(withStale, noLegacy, 'table', NOW).allCurrent).toBe(false)
  })

  it('is not all current with an older device or a live legacy row', () => {
    const older = rowsOf(
      new Map([
        ['me0001', entry()],
        ['lap001', entry({ app: '0.10.0' })],
      ]),
    )
    expect(readiness(older, noLegacy, 'table', NOW).allCurrent).toBe(false)
    const legacy = rowsOf(
      new Map([
        ['me0001', entry()],
        ['old001', { name: 'Older app', app: '0.8.5', mode: 'table', e2e: false, seen: NOW }],
      ]),
    )
    expect(readiness(legacy, noLegacy, 'table', NOW).allCurrent).toBe(false)
  })

  it('computes the lockdown only in RPC mode, naming the first unmet condition', () => {
    const rpc = (over: Partial<DeviceInfo> = {}) =>
      entry({ mode: 'rpc', rpcSince: NOW - 8 * DAY, ...over })
    const ready = rowsOf(
      new Map([
        ['me0001', rpc()],
        ['lap001', rpc()],
      ]),
    )
    expect(readiness(ready, noLegacy, 'rpc', NOW).lockdown).toEqual({ ready: true, reason: null })

    const table = rowsOf(
      new Map([
        ['me0001', rpc()],
        ['lap001', entry()],
      ]),
    )
    expect(readiness(table, noLegacy, 'rpc', NOW).lockdown).toEqual({
      ready: false,
      reason: "Other device doesn't use the relay's sync functions yet.",
    })

    const quiet = rowsOf(
      new Map([
        ['me0001', rpc()],
        ['lap001', rpc({ seen: NOW - 15 * DAY })],
      ]),
    )
    expect(readiness(quiet, noLegacy, 'rpc', NOW).lockdown?.reason).toBe(
      "Other device hasn't synced for 14 days.",
    )

    const fresh = rowsOf(
      new Map([
        ['me0001', rpc()],
        ['lap001', rpc({ rpcSince: NOW - DAY })],
      ]),
    )
    expect(readiness(fresh, noLegacy, 'rpc', NOW).lockdown?.reason).toMatch(
      /^Other device has used the sync functions since \d+ (Oct|Nov)\. Ready on \d+ Nov\.$/,
    )
    // an entry with no start of its own: no day to give until that device pushes again
    const unknown = rowsOf(
      new Map([
        ['me0001', rpc()],
        ['lap001', rpc({ rpcSince: 0 })],
      ]),
    )
    expect(readiness(unknown, noLegacy, 'rpc', NOW).lockdown?.reason).toBe(
      'Other device has used the sync functions for less than 7 days.',
    )

    expect(readiness(ready, { ...noLegacy, v084At: NOW - 13 * DAY }, 'rpc', NOW).lockdown).toEqual({
      ready: false,
      reason: expect.stringMatching(
        /^An older SpendTrack \(0\.8\.4 or earlier\) was last seen in the synced copy on \d+ Oct\. Ready on \d+ Nov\.$/,
      ) as unknown,
    })
    // the 14 days are up to the millisecond, as before
    expect(readiness(ready, { ...noLegacy, v5preAt: NOW - 14 * DAY }, 'rpc', NOW).lockdown).toEqual(
      {
        ready: true,
        reason: null,
      },
    )
  })

  describe('says the day the lockdown is ready, in this device’s time zone', () => {
    // Local noon: the same calendar day in every zone the suite runs in (a DST shift is an hour).
    const noon = (month: number, day: number, year = 2026) =>
      new Date(year, month, day, 12).getTime()
    const TODAY = noon(10, 16) // 16 Nov 2026
    const at = (since: number) =>
      deviceRows(
        new Map([
          ['me0001', entry({ mode: 'rpc', rpcSince: noon(9, 1), seen: TODAY })],
          ['lap001', entry({ mode: 'rpc', rpcSince: since, seen: TODAY })],
        ]),
        'me0001',
        '0.11.0',
        TODAY,
      )
    const settled = at(noon(9, 1))

    it('names the kind of older SpendTrack and the day it was last seen, then the day it is ready', () => {
      const cases = [
        ['v084At', '0.8.4 or earlier'],
        ['v085At', '0.9.2'],
        ['v5preAt', '0.10.0'],
      ] as const
      for (const [key, release] of cases) {
        expect(
          readiness(settled, { ...noLegacy, [key]: noon(10, 7) }, 'rpc', TODAY).lockdown,
        ).toEqual({
          ready: false,
          reason: `An older SpendTrack (${release}) was last seen in the synced copy on 7 Nov. Ready on 21 Nov.`,
        })
      }
    })

    it('names the older kind that keeps it not ready longest', () => {
      const legacy = { v084At: noon(10, 9), v085At: null, v5preAt: noon(10, 7) }
      expect(readiness(settled, legacy, 'rpc', TODAY).lockdown?.reason).toBe(
        'An older SpendTrack (0.8.4 or earlier) was last seen in the synced copy on 9 Nov. Ready on 23 Nov.',
      )
    })

    it('says since when a device has used the sync functions, and the day it has for 7', () => {
      expect(readiness(at(noon(10, 12)), noLegacy, 'rpc', TODAY).lockdown?.reason).toBe(
        'Other device has used the sync functions since 12 Nov. Ready on 19 Nov.',
      )
    })

    it('of the conditions only time ends, names the one that ends last', () => {
      // the device's 7 days end on 19 Nov, the older writer's 14 on 21 Nov: ready on 21 Nov
      const legacy = { ...noLegacy, v5preAt: noon(10, 7) }
      expect(readiness(at(noon(10, 12)), legacy, 'rpc', TODAY).lockdown?.reason).toBe(
        'An older SpendTrack (0.10.0) was last seen in the synced copy on 7 Nov. Ready on 21 Nov.',
      )
      // the other way round: the device's 7 days end after the older writer's 14
      const early = { ...noLegacy, v5preAt: noon(10, 3) }
      expect(readiness(at(noon(10, 15)), early, 'rpc', TODAY).lockdown?.reason).toBe(
        'Other device has used the sync functions since 15 Nov. Ready on 22 Nov.',
      )
    })

    it('gives the year when the day is in another one', () => {
      const newYear = noon(0, 2, 2027)
      const legacy = { ...noLegacy, v085At: noon(11, 26) }
      const rows = deviceRows(
        new Map([
          ['me0001', entry({ mode: 'rpc', rpcSince: noon(9, 1), seen: newYear })],
          ['lap001', entry({ mode: 'rpc', rpcSince: noon(9, 1), seen: newYear })],
        ]),
        'me0001',
        '0.11.0',
        newYear,
      )
      expect(readiness(rows, legacy, 'rpc', newYear).lockdown?.reason).toBe(
        'An older SpendTrack (0.9.2) was last seen in the synced copy on 26 Dec 2026. Ready on 9 Jan.',
      )
    })
  })
})
