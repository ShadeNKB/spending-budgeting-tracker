// When "Make sync private" is offered (PRIVATE-SYNC 4.1). Pure: the engine gathers the facts, this
// decides. The registry is read from the plain row and anyone who can write that row can forge
// it, so this is a guard against the owner's own mistake (a device left behind that could not
// join), not a security boundary. One more condition, the relay's lockdown, costs a request and is
// asked when the button is pressed, never here.
// Lazy: only the sync engine imports it.
import type { DeviceInfo } from '../core/types'
import { STALE_AFTER_MS, compareApp } from './registry'

/** The first release that can join a private sync (release 1 of PRIVATE-SYNC). */
export const PRIVATE_FROM = '0.21.0'

export interface OfferFacts {
  /** What this device syncs now. */
  readonly kind: 'plain' | 'e2e'
  /** It has found or made its relay copy (P3-5). */
  readonly established: boolean
  /** Its sync is paused (any pause reason). */
  readonly paused: boolean
  /** It was fenced out of its plain row (3.7). */
  readonly fenced: boolean
  /** The browser has Web Locks: the move runs under the sync lock or not at all. */
  readonly locks: boolean
  /** This device's transport compare-and-sets (the sync functions, or CAS on the table). */
  readonly cas: boolean
  /** The registry of the plain row, as this device holds it. */
  readonly devices: ReadonlyMap<string, DeviceInfo>
  /** When an older writer was last seen writing the plain row (`meta.legacySeen`). */
  readonly legacySeen: { readonly v084?: number; readonly v085?: number; readonly v5pre?: number }
  readonly now: number
}

/**
 * A device that may be left behind by the move: it last pushed within 60 days and either was
 * never seen (`seen` 0), runs a release that cannot join a private sync, or still writes the
 * table (a device that does not use the sync functions cannot be told the row moved in time).
 */
function leftBehind(d: DeviceInfo, now: number): boolean {
  if (d.seen > 0 && now - d.seen > STALE_AFTER_MS) return false
  return d.seen === 0 || d.mode !== 'rpc' || compareApp(d.app, PRIVATE_FROM) < 0
}

/** "Make sync private" is offered: every condition of 4.1 that costs no request holds. */
export function moveOffered(f: OfferFacts): boolean {
  if (f.kind !== 'plain' || !f.established || f.paused || f.fenced) return false
  if (!f.locks || !f.cas) return false
  for (const d of f.devices.values()) if (leftBehind(d, f.now)) return false
  const { v084, v085, v5pre } = f.legacySeen
  return [v084, v085, v5pre].every((at) => at === undefined || f.now - at > STALE_AFTER_MS)
}
