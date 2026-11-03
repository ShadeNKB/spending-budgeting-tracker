// A string-copying localStorage for the engine tests (track spec §8.13): one backing store shared
// by any number of tab views, a byte (char) quota, per-key failure injection (quota, SecurityError),
// a removeItem spy, and `storage` events delivered to the OTHER views only, as browsers do.
import { vi } from 'vitest'

export type Failure = 'quota' | 'security' | 'error'

/** A fresh copy of a string, so nothing the engine holds aliases what is stored. */
const copy = (s: string): string => (' ' + s).slice(1)

export class FakeBacking {
  readonly data = new Map<string, string>()
  /** Total chars (keys + values) allowed; Infinity = unlimited. */
  quota = Number.POSITIVE_INFINITY
  /** Every access throws SecurityError (Safari with storage blocked). */
  blocked = false
  readonly failures = new Map<string, Failure>()
  /** Keys whose prefix matches fail too (e.g. 'st5:q' for the whole quarantine). */
  readonly prefixFailures = new Map<string, Failure>()
  readonly sets: string[] = []
  readonly removes: string[] = []
  private readonly views: FakeStorage[] = []
  private pending: (() => void)[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  view(): FakeStorage {
    const v = new FakeStorage(this)
    this.views.push(v)
    return v
  }

  used(): number {
    let n = 0
    for (const [k, v] of this.data) n += k.length + v.length
    return n
  }

  failureOf(key: string): Failure | undefined {
    const exact = this.failures.get(key)
    if (exact !== undefined) return exact
    for (const [p, f] of this.prefixFailures) if (key.startsWith(p)) return f
    return undefined
  }

  /** Queues a `storage` event for every view except the writer's. */
  notify(
    from: FakeStorage,
    key: string | null,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    for (const to of this.views) {
      if (to === from) continue
      this.pending.push(() => {
        // A page that has gone gets no events. A write that lands as a test ends can queue one on
        // a real timer, which may fire after the test environment (and its window) is torn down.
        if (typeof window === 'undefined') return
        const e = new Event('storage')
        Object.defineProperty(e, 'key', { value: key })
        Object.defineProperty(e, 'oldValue', { value: oldValue })
        Object.defineProperty(e, 'newValue', { value: newValue })
        Object.defineProperty(e, 'storageArea', { value: to })
        window.dispatchEvent(e)
      })
    }
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.deliver()
    }, 0)
  }

  /** Delivers every queued event now. */
  deliver(): void {
    const list = this.pending
    this.pending = []
    for (const fire of list) fire()
  }

  /** setItem calls for `key` since the last reset. */
  setsOf(key: string): number {
    return this.sets.filter((k) => k === key).length
  }

  resetCounts(): void {
    this.sets.length = 0
    this.removes.length = 0
  }
}

function domError(name: string): DOMException {
  return new DOMException(`${name} (fake storage)`, name)
}

export class FakeStorage implements Storage {
  constructor(private readonly b: FakeBacking) {}

  private guard(): void {
    if (this.b.blocked) throw domError('SecurityError')
  }

  get length(): number {
    this.guard()
    return this.b.data.size
  }

  key(index: number): string | null {
    this.guard()
    return [...this.b.data.keys()][index] ?? null
  }

  getItem(key: string): string | null {
    this.guard()
    const v = this.b.data.get(key)
    return v === undefined ? null : copy(v)
  }

  setItem(key: string, value: string): void {
    this.guard()
    this.b.sets.push(key)
    const f = this.b.failureOf(key)
    if (f === 'quota') throw domError('QuotaExceededError')
    if (f === 'security') throw domError('SecurityError')
    if (f === 'error') throw new Error('write failed (fake storage)')
    const old = this.b.data.get(key)
    const next =
      this.b.used() - (old === undefined ? 0 : key.length + old.length) + key.length + value.length
    if (next > this.b.quota) throw domError('QuotaExceededError')
    this.b.data.set(key, copy(value))
    this.b.notify(this, key, old ?? null, value)
  }

  removeItem(key: string): void {
    this.guard()
    this.b.removes.push(key)
    const old = this.b.data.get(key)
    if (old === undefined) return
    this.b.data.delete(key)
    this.b.notify(this, key, old, null)
  }

  clear(): void {
    this.guard()
    this.b.data.clear()
    this.b.notify(this, null, null, null)
  }
}

/** Installs a fresh backing store as `localStorage` (one tab view) and returns both. */
export function installFakeStorage(backing: FakeBacking = new FakeBacking()): {
  readonly backing: FakeBacking
  readonly view: FakeStorage
} {
  const view = backing.view()
  vi.stubGlobal('localStorage', view)
  return { backing, view }
}

/** Seeds raw strings (v4 keys, a prebuilt envelope) without counting them as engine writes. */
export function seed(backing: FakeBacking, entries: Readonly<Record<string, string>>): void {
  for (const [k, v] of Object.entries(entries)) backing.data.set(k, v)
}
