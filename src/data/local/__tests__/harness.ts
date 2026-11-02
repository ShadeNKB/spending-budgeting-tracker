// Booting a real store + engine over a fake localStorage (P2-14): seed storage in the public
// formats, then hydrate. `vi.resetModules` gives every call its own facade and engine, so two
// calls over one backing store are two tabs on one device.
import { vi } from 'vitest'
import { must, parseJson } from '../../__tests__/support/must'
import { isPlainObject, own } from '../../core/sanitize'
import { FakeBacking, installFakeStorage, seed, type FakeStorage } from './fakeStorage'

export type StoreModule = typeof import('../../../stores/useExpenseStore')

export interface Tab {
  readonly mod: StoreModule
  readonly store: StoreModule['useExpenseStore']
  readonly backing: FakeBacking
  readonly view: FakeStorage
}

export interface BootOptions {
  readonly backing?: FakeBacking
  readonly keys?: Readonly<Record<string, string>>
  /** Wire lifecycle and storage listeners (installPersistence). */
  readonly install?: boolean
}

/** A fresh tab: its own modules, booted over `backing` (seeded with `keys` first). */
export async function bootTab(opts: BootOptions = {}): Promise<Tab> {
  const backing = opts.backing ?? new FakeBacking()
  if (opts.keys !== undefined) seed(backing, opts.keys)
  const { view } = installFakeStorage(backing)
  vi.resetModules()
  const mod: StoreModule = await import('../../../stores/useExpenseStore')
  await mod.useExpenseStore.getState().hydrate()
  if (opts.install === true) mod.installPersistence()
  return { mod, store: mod.useExpenseStore, backing, view }
}

/** Lets queued microtasks (the write-through flush) run. */
export const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** The parsed body of the stored envelope ({f, doc, meta}). */
export function envelopeOf(backing: FakeBacking): Readonly<Record<string, unknown>> {
  const raw = must(backing.data.get('st5:db'), 'st5:db')
  const bar = raw.indexOf('|', 2)
  const body = parseJson(raw.slice(bar + 1))
  if (!isPlainObject(body)) throw new Error('envelope body is not an object')
  return body
}

/** The wire doc inside the stored envelope. */
export function envelopeDoc(backing: FakeBacking): Readonly<Record<string, unknown>> {
  const doc = own(envelopeOf(backing), 'doc')
  if (!isPlainObject(doc)) throw new Error('envelope doc is not an object')
  return doc
}

/** The parsed value of a stored key. */
export function stored(backing: FakeBacking, key: string): unknown {
  return parseJson(must(backing.data.get(key), key))
}

/** Hides the page and fires the lifecycle event (the listeners flush synchronously). */
export function hidePage(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
}
