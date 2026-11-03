// The device registry (DATA-ENGINE-SPEC §6.8, §11.10; PR-3 track spec P3-7 to P3-9). Pure: every
// push carries this device's entry in `x5.devs`, and Settings › Sync lists what the relay copy
// knows about every device, with the readiness signals the owner reads before a migration.
// Lazy: only the sync engine imports it, so it ships in the `syncEngine` chunk.
import type { DeviceInfo, Stamp } from '../core/types'
import type { DeviceRow, SyncView } from '../../stores/useSyncStore'

const DAY = 86_400_000
/** A device unseen this long is greyed in the list and left out of readiness. */
export const STALE_AFTER_MS = 60 * DAY
/** An old writer seen this recently keeps "all current" false (its banner shows as long). */
const LEGACY_RECENT_MS = DAY
const LOCKDOWN_SEEN_MS = 14 * DAY
const LOCKDOWN_RPC_MS = 7 * DAY
const LOCKDOWN_LEGACY_MS = 14 * DAY
/** The name a 0.9.2 writer stamp (`wr`) decodes to. */
const OLDER_APP = 'Older app'
/** The first release that registers itself with every push it sends (P3-7). */
const REGISTERS_FROM = '0.11.0'
/** The release a v5 writer that never registers itself runs (P3-8). */
const V5PRE_APP = '0.10.0'
/**
 * A registering writer stamps its entry in the moment it writes, so an entry this much older
 * than the write was only carried along: its device went back to a release that does not
 * register (a rollback). The clocks differ (the write's time is the relay's etag, or this
 * device's clock when the etag is ahead of it): six hours leave room for a clock that is off,
 * and readiness counts in days. The window decides only a first sighting or the same copy
 * again; a writer seen before is judged by whether its entry moved (`wroteItself`).
 */
const CARRIED_AFTER_MS = 6 * 60 * 60_000
/** 0.9.2 stamps its writes with its internal writer version; the owner knows the release. */
const RELEASE_OF: Readonly<Record<string, string>> = { '0.8.5': '0.9.2' }

/**
 * The entry this device pushes. It names no device: the list says "This device" and "Other
 * device" (a name worked out from the user agent did not earn its weight, track spec §8 cut 1).
 * `seen` stays ahead of every sighting of this device already on the relay, so its newest entry
 * wins the join everywhere even after its clock went back.
 */
export function registryEntry(
  prev: DeviceInfo | undefined,
  app: string,
  mode: 'table' | 'rpc',
  now: number,
): DeviceInfo {
  const rpcSince: Stamp | undefined =
    mode === 'rpc' ? (prev?.mode === 'rpc' ? (prev.rpcSince ?? now) : now) : undefined
  return {
    name: '',
    app,
    mode,
    ...(rpcSince === undefined ? {} : { rpcSince }),
    e2e: false,
    seen: Math.max(now, (prev?.seen ?? 0) + 1),
  }
}

/** Equal but for `seen`, which the digest leaves out: a change of `seen` alone never pushes. */
export function sameEntry(a: DeviceInfo | undefined, b: DeviceInfo): boolean {
  return (
    a !== undefined &&
    a.name === b.name &&
    a.app === b.app &&
    a.mode === b.mode &&
    a.e2e === b.e2e &&
    a.rpcSince === b.rpcSince
  )
}

/**
 * This tab's entry must be registered, and so pushed, before the push decision (P3-7): a new app
 * version, relay mode or private flag. Never for the name alone (this release names no device; a
 * later one may, in another tab of this device), nor for an app older than one another tab of
 * this device registered (a tab left open across an update): either would have two tabs of one
 * device re-register in turn, each push answered by the other. Such a difference rides this
 * device's next push instead.
 */
export function registerFirst(prev: DeviceInfo | undefined, next: DeviceInfo): boolean {
  if (prev === undefined) return true
  if (compareApp(next.app, prev.app) < 0) return false
  return !sameEntry({ ...prev, name: next.name }, next)
}

/**
 * The writer of a v5 copy registered itself as it wrote it (0.11.0 on): its own entry is from a
 * registering release and was stamped by that write. A missing entry, an 'Older app' entry
 * (0.9.2), an older release's or a frozen one (a device rolled back to 0.10.0 carries the entry
 * its 0.11.0 wrote) says it did not: a 0.10.0 writer. Stamped by the write: its `seen` moved
 * past the one this device knew before the pull (`known`), whatever either clock says; or, for
 * a first sighting or the same copy again, it is as recent as the write (`wroteAt`, the relay's
 * etag capped at this device's clock, so a stamp pushed ahead never stands in for the write's
 * time; null: unknown).
 */
export function wroteItself(
  entry: DeviceInfo | undefined,
  known: DeviceInfo | undefined,
  wroteAt: number | null,
): boolean {
  if (entry === undefined || compareApp(entry.app, REGISTERS_FROM) < 0) return false
  if (known !== undefined && entry.seen > known.seen) return true
  return wroteAt === null || wroteAt - entry.seen <= CARRIED_AFTER_MS
}

/**
 * Puts the 0.10.0 device last seen writing (P3-8) into `devices`, which it never registers in
 * itself: an older device, seen when it wrote, in place of any entry it carries from an older
 * or a rolled-back release. Once it registers again (0.11.0 on, after that sighting) the
 * sighting no longer counts. Returns the sighting that still counts, or null.
 */
export function placeV5pre(
  devices: Map<string, DeviceInfo>,
  dev: string | null,
  at: number | null,
): number | null {
  if (at === null || dev === null) return at
  const entry = devices.get(dev)
  if (entry !== undefined && entry.seen > at && compareApp(entry.app, REGISTERS_FROM) >= 0) {
    return null
  }
  devices.set(dev, { name: OLDER_APP, app: V5PRE_APP, mode: 'table', e2e: false, seen: at })
  return at
}

const parts = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10) || 0)

/** Numeric version order ("0.9.2" < "0.10.0"); a missing or unreadable part counts 0. */
export function compareApp(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Settings › Sync's devices: this one first, then by last seen. This release names no device
 * ("This device", "Other device"); a name a later release gave its own device is shown.
 */
export function deviceRows(
  devices: ReadonlyMap<string, DeviceInfo>,
  me: string,
  app: string,
  now: number,
): readonly DeviceRow[] {
  const rows: DeviceRow[] = []
  for (const [id, d] of devices) {
    const legacy = d.name === OLDER_APP
    const release = legacy ? (RELEASE_OF[d.app] ?? d.app) : d.app
    rows.push({
      id,
      // An entry an older release left is named by that release ("Older SpendTrack (0.9.2)").
      name: legacy
        ? `Older SpendTrack (${release})`
        : d.name !== ''
          ? d.name
          : id === me
            ? 'This device'
            : 'Other device',
      app: release,
      mode: d.mode,
      me: id === me,
      seen: d.seen,
      rpcSince: d.rpcSince ?? 0,
      stale: id !== me && d.seen > 0 && now - d.seen > STALE_AFTER_MS,
      older: compareApp(release, app) < 0,
      legacy,
    })
  }
  return rows.sort(
    (a, b) => Number(b.me) - Number(a.me) || b.seen - a.seen || (a.id < b.id ? -1 : 1),
  )
}

type Legacy = SyncView['legacy']

const lastLegacy = (l: Legacy): number => Math.max(l.v084At ?? 0, l.v085At ?? 0, l.v5preAt ?? 0)

/**
 * Readiness, informational in this release: every live device runs this build, and (in RPC
 * mode only) the §11.10 conditions for the database lockdown, the first unmet one in words.
 */
export function readiness(
  rows: readonly DeviceRow[],
  legacy: Legacy,
  meMode: 'table' | 'rpc',
  now: number,
): { allCurrent: boolean; lockdown: SyncView['lockdown'] } {
  const live = rows.filter((r) => !r.stale)
  const last = lastLegacy(legacy)
  // "All your devices" needs another device on the list: alone, this one proves nothing.
  const allCurrent =
    live.some((r) => !r.me) &&
    live.every((r) => !r.legacy && !r.older) &&
    now - last >= LEGACY_RECENT_MS
  if (meMode !== 'rpc') return { allCurrent, lockdown: null }
  return { allCurrent, lockdown: lockdownOf(live, last, now) }
}

function lockdownOf(
  live: readonly DeviceRow[],
  lastLegacyAt: number,
  now: number,
): NonNullable<SyncView['lockdown']> {
  const unmet = (reason: string) => ({ ready: false, reason })
  const table = live.find((r) => r.mode !== 'rpc')
  if (table) return unmet(`${table.name} doesn't use the relay's sync functions yet.`)
  const quiet = live.find((r) => now - r.seen > LOCKDOWN_SEEN_MS)
  if (quiet) return unmet(`${quiet.name} hasn't synced for 14 days.`)
  const fresh = live.find((r) => r.rpcSince === 0 || now - r.rpcSince < LOCKDOWN_RPC_MS)
  if (fresh) return unmet(`${fresh.name} has used the sync functions for less than 7 days.`)
  if (now - lastLegacyAt < LOCKDOWN_LEGACY_MS) {
    return unmet('An older SpendTrack wrote the synced copy in the last 14 days.')
  }
  return { ready: true, reason: null }
}
