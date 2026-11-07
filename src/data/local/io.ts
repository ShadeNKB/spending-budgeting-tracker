// Storage access for the local engine (track spec §8, §9.11). Every write goes through the one
// safe writer; nothing here deletes a key on a read or parse failure (I12): `removeKey` is called
// only by Remove-from-this-device, snapshot/journal rotation, visible shedding of derived copies
// and the owner's own Discard of one set-aside copy in the Recovery centre.
import { StorageQuotaError, safeSet } from '../../services/storage'
import { isSpendTrackKey } from './keys'

export type Area = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export type ReadResult =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false }

export type WriteResult = 'ok' | 'quota' | 'error'

/** The tab's localStorage, or null when the browser refuses access (SecurityError). */
export function openArea(): Area | null {
  try {
    const area = globalThis.localStorage
    // Safari with blocked storage throws on the first access, not on the getter
    area.getItem('st5:db')
    return area
  } catch {
    return null
  }
}

export class Io {
  private readonly sizes = new Map<string, number>()

  constructor(readonly area: Area) {}

  read(key: string): ReadResult {
    try {
      return { ok: true, value: this.area.getItem(key) }
    } catch {
      return { ok: false }
    }
  }

  /** The value, or null when absent or unreadable. Every read keeps the tally current. */
  get(key: string): string | null {
    const r = this.read(key)
    if (!r.ok) return null
    if (r.value === null) this.sizes.delete(key)
    else if (isSpendTrackKey(key)) this.sizes.set(key, key.length + r.value.length)
    return r.value
  }

  write(key: string, value: string): WriteResult {
    try {
      safeSet(key, value, this.area)
      this.sizes.set(key, key.length + value.length)
      return 'ok'
    } catch (err) {
      return err instanceof StorageQuotaError ? 'quota' : 'error'
    }
  }

  removeKey(key: string): void {
    try {
      this.area.removeItem(key)
    } catch {
      // A key that cannot be removed stays; the caller's state does not depend on it.
    }
    this.sizes.delete(key)
  }

  /** Every key in storage (empty when storage cannot be listed). */
  keys(): readonly string[] {
    const out: string[] = []
    try {
      for (let i = 0; i < this.area.length; i++) {
        const k = this.area.key(i)
        if (k !== null) out.push(k)
      }
    } catch {
      return out
    }
    return out
  }

  keysWithPrefix(prefix: string): readonly string[] {
    return this.keys().filter((k) => k.startsWith(prefix))
  }

  /** Measures every SpendTrack key (after boot, off the critical path); reads and writes keep it current. */
  measure(): void {
    this.sizes.clear()
    for (const k of this.keys()) if (isSpendTrackKey(k)) this.get(k)
  }

  /** Characters SpendTrack holds in storage, as far as this engine has seen (§9.11). */
  used(): number {
    let n = 0
    for (const s of this.sizes.values()) n += s
    return n
  }
}
