// The one safe writer and the device's sync identity (track spec §6.3, P2-7).
//
// The data itself lives in the local engine (src/data/local): one atomic envelope plus the v4
// mirror. What stays here is what the shell and the sync bridge need without the engine: the
// quota-aware writer every persistence write goes through, the sync code and the device id.

const SYNC_KEY = 'st5:sync'
const SYNC_ID_KEY = 'syncId'
/**
 * A private bucket's code, `{ code, at, established }` (PRIVATE-SYNC 3.2). Its own key: no
 * build before 0.21.0 reads or writes this name, so none can overwrite the code, and the raw
 * export leaves out every key named `synckey` (lib/rescue.ts), in older builds too.
 */
const PRIVATE_KEY = 'st5:synckey'
/** The display form of a private code. Shape only: the data core checks its sum. */
const PRIVATE_CODE = /^ST5(-[0-9A-HJKMNP-TV-Z]{7}){4}$/
const DEV_KEY = 'st5:dev'
const LEGACY_DEV_KEY = 'spendtrack:dev'
const QUARANTINE_SYNC_PREFIX = 'st5:q:st5:sync:'
const QUARANTINE_SYNC_ID_PREFIX = 'st5:q:syncId:'

const DEVICE_ID_PATTERN = /^[0-9a-z]{6}$/
const CODE_MAX = 200

/**
 * Quota-aware setItem — every persistence write goes through this.
 * If quota is exhausted (5 MB on most browsers, sometimes 2 MB on iOS Safari),
 * we surface the error to subscribers so the app can warn the user instead of
 * silently losing data. The custom event fires once per quota incident.
 */
export class StorageQuotaError extends Error {
  constructor(
    public key: string,
    public bytes: number,
  ) {
    super(`localStorage quota exceeded while writing "${key}" (${bytes} bytes).`)
    this.name = 'StorageQuotaError'
  }
}

// Match on `name`: the deprecated numeric `code` (22 / 1014) is derived from it.
// NS_ERROR_DOM_QUOTA_REACHED is the legacy Firefox name.
const isQuota = (err: unknown): boolean =>
  err instanceof DOMException &&
  (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')

let quotaWarned = false

/**
 * Writes one key. `area` is the Storage to write (the engine passes the one it booted on, so two
 * engines in one test each write their own tab's view); it defaults to `localStorage`.
 */
export function safeSet(
  key: string,
  value: string,
  area: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    area.setItem(key, value)
  } catch (err) {
    if (isQuota(err)) {
      if (!quotaWarned && typeof window !== 'undefined') {
        quotaWarned = true
        window.dispatchEvent(
          new CustomEvent('spendtrack:quota-exceeded', { detail: { key, bytes: value.length } }),
        )
      }
      throw new StorageQuotaError(key, value.length)
    }
    throw err
  }
}

/** The stored value, or null when absent or unreadable. */
function read(key: string): string | null {
  return readKey(key) ?? null
}

/** The stored value; null when the key is absent; undefined when storage refused the read. */
function readKey(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key)
  } catch {
    return undefined
  }
}

/** Best effort: a key that cannot be removed is read the same way next time. */
function forget(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // storage refused: the next read decides again from the same keys
  }
}

/** Best effort: a write that fails leaves the session value in place. */
function tryWrite(key: string, value: string): boolean {
  try {
    safeSet(key, value)
    return true
  } catch {
    return false
  }
}

const isRecordLike = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const validCode = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= CODE_MAX

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

/** A parsed `st5:sync` this build reads: plain, or another kind (a newer build's) it must keep. */
const plainOf = (cfg: unknown): Readonly<Record<string, unknown>> | null =>
  isRecordLike(cfg) && cfg.kind === 'plain' && validCode(cfg.code) ? cfg : null

/** A well-formed config of a kind this build does not know (P3-19): never quarantined or removed. */
const isNewer = (cfg: unknown): boolean =>
  isRecordLike(cfg) && typeof cfg.kind === 'string' && cfg.kind !== 'plain'

/**
 * A plain bucket this device was fenced out of: its row held a moved marker (3.7). While set,
 * the device never pulls, pushes or re-creates that row, whatever the row holds later.
 */
export interface Fence {
  /** The marker's reason: `private` asks for the private code; anything else is a move. */
  readonly why: string
  readonly at: number
}

const fenceOf = (v: unknown): Fence | null =>
  isRecordLike(v) && typeof v.why === 'string' && typeof v.at === 'number'
    ? { why: v.why.slice(0, 40), at: v.at }
    : null

const configOf = (
  code: string,
  joinedAt: unknown,
  established: boolean,
  fenced: Fence | null = null,
): string =>
  JSON.stringify({
    kind: 'plain',
    code,
    rowId: code,
    joinedAt,
    established,
    ...(fenced === null ? {} : { fenced }),
  })

/** What `st5:sync` says on a private device: the kind, and nothing secret. */
const privateConfigOf = (joinedAt: number, established: boolean): string =>
  JSON.stringify({ kind: 'e2e', joinedAt, established })

interface PrivateKey {
  readonly code: string
  readonly at: number
  readonly established: boolean
}

/** The private code this device holds, or null. A value of another shape is no code. */
function privateKey(): PrivateKey | null {
  const raw = read(PRIVATE_KEY)
  const v = raw === null ? null : parseJson(raw)
  if (!isRecordLike(v) || typeof v.code !== 'string' || !PRIVATE_CODE.test(v.code)) return null
  return {
    code: v.code,
    at: typeof v.at === 'number' ? v.at : 0,
    established: v.established !== false,
  }
}

export type SyncConfig =
  | {
      readonly kind: 'plain'
      readonly code: string
      readonly established: boolean
      readonly fenced?: Fence
    }
  | { readonly kind: 'e2e'; readonly code: string; readonly established: boolean }
  | { readonly kind: 'newer' }

// One raw copy per distinct corrupt value per session: getSyncId runs on every sync cycle.
const quarantinedConfigs = new Set<string>()

function quarantineConfig(raw: string, prefix: string = QUARANTINE_SYNC_PREFIX): void {
  const seen = `${prefix}${raw}`
  if (quarantinedConfigs.has(seen)) return
  quarantinedConfigs.add(seen)
  // a copy made in the same millisecond never overwrites another one
  let ts = Date.now()
  while (read(`${prefix}${String(ts)}`) !== null) ts++
  tryWrite(`${prefix}${String(ts)}`, raw)
}

let sessionDeviceId: string | null = null

function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

function storedDeviceId(): string | null {
  const raw = read(DEV_KEY)
  if (raw !== null) {
    const dev = parseJson(raw)
    if (isRecordLike(dev) && typeof dev.id === 'string' && DEVICE_ID_PATTERN.test(dev.id)) {
      return dev.id
    }
  }
  return null
}

export const storage = {
  /**
   * The saved sync code. This build always saves it to both keys, `syncId` (the plaintext key a
   * rolled-back 0.9.x reads and writes) first, then `st5:sync`; so when they disagree, an old
   * build changed the code. A `syncId` that differs from `st5:sync` (0.9.x connected another code)
   * wins and is adopted; a `st5:sync` without any `syncId` (0.9.x disconnected, which removes only
   * `syncId`) stays disconnected here. Only a plain code has the `syncId` mirror, so only a plain
   * config is ever forgotten this way, and only when `syncId` is really absent: a `syncId` that
   * cannot be read (storage refused) or does not hold a code (damaged) is no disconnect, so
   * `st5:sync` and its code stay (a damaged `syncId` is copied to the quarantine; never a removal
   * on a failed read, I12). A corrupt `st5:sync` is copied to the quarantine, and the code falls
   * back to `syncId`.
   */
  getSyncId(): string | null {
    // A private device has no plain code, and none of the rules below may run on it: a stray
    // `syncId` must not be adopted over it, and `st5:sync` must not be forgotten for the lack
    // of a mirror it never had.
    if (privateKey() !== null) return null
    const raw = read(SYNC_KEY)
    const cfg = raw === null ? null : parseJson(raw)
    if (isNewer(cfg)) return null
    const code = plainOf(cfg)?.code
    if (raw !== null && !validCode(code)) quarantineConfig(raw)
    const legacy = readKey(SYNC_ID_KEY)
    if (validCode(legacy)) {
      if (code !== legacy) tryWrite(SYNC_KEY, configOf(legacy, Date.now(), true))
      return legacy
    }
    if (!validCode(code)) return null
    if (legacy === null) {
      forget(SYNC_KEY)
      return null
    }
    if (typeof legacy === 'string') quarantineConfig(legacy, QUARANTINE_SYNC_ID_PREFIX)
    return code
  },

  /**
   * The saved setup: a plain code and whether this device is established on it (it may create
   * the relay copy), a private code, a newer build's setup this one must keep, or null.
   *
   * A private code wins over everything else here (3.2): over a stray `syncId`, over a
   * `st5:sync` an older build wrote in its place, over a missing one. `st5:sync` is then put
   * back as the private marker, which is what tells an older build not to sync.
   */
  getSyncConfig(): SyncConfig | null {
    const priv = privateKey()
    const raw = read(SYNC_KEY)
    const cfg = raw === null ? null : parseJson(raw)
    if (priv !== null) {
      if (!(isRecordLike(cfg) && cfg.kind === 'e2e')) {
        tryWrite(SYNC_KEY, privateConfigOf(priv.at, priv.established))
      }
      if (readKey(SYNC_ID_KEY) !== null) forget(SYNC_ID_KEY)
      return { kind: 'e2e', code: priv.code, established: priv.established }
    }
    if (isNewer(cfg)) return { kind: 'newer' }
    const code = this.getSyncId()
    if (code === null) return null
    // read again: getSyncId may have adopted another code and rewritten the config
    const now = read(SYNC_KEY)
    const plain = plainOf(now === null ? null : parseJson(now))
    const fenced = plain?.code === code ? fenceOf(plain.fenced) : null
    return {
      kind: 'plain',
      code,
      established: plain?.code !== code || plain.established !== false,
      ...(fenced === null ? {} : { fenced }),
    }
  },

  /** Sync is set up on this device, plain or private: the local engine records its outbox. */
  isLinked(): boolean {
    return privateKey() !== null || this.getSyncId() !== null
  },

  /**
   * Saves the code (both keys) or, with null (Disconnect, an explicit action), forgets it.
   * `syncId` goes first: a code this build saved is never in `st5:sync` alone, so that state
   * always means an old build's disconnect. `established` false for a joined code; left out, the
   * same code keeps its flag and a new one is established. A joined code is never left in
   * `syncId` alone: read that way it is an old build's code, established, and the next start
   * could create its relay copy (P3-5). When `st5:sync` refuses it, `syncId` goes back to what
   * it held, so the code lasts this session only (the caller says so).
   */
  saveSyncId(id: string | null, established?: boolean): void {
    if (id === null) {
      // the private code first: were the rest to fail, the device must not stay private
      // with nothing on screen saying so
      localStorage.removeItem(PRIVATE_KEY)
      localStorage.removeItem(SYNC_KEY)
      localStorage.removeItem(SYNC_ID_KEY)
      return
    }
    // The plain writer never writes over a private setup (3.2): start-up and another tab
    // call it with whatever code they hold in memory.
    if (privateKey() !== null) {
      throw new Error('A private sync is set up on this device: disconnect it first.')
    }
    const raw = read(SYNC_KEY)
    const same = plainOf(raw === null ? null : parseJson(raw))
    const kept = same?.code === id ? same : null
    const flag = established ?? kept?.established !== false
    const before = readKey(SYNC_ID_KEY)
    safeSet(SYNC_ID_KEY, id)
    try {
      // the same code keeps its fence: a restart must not un-fence the device
      safeSet(
        SYNC_KEY,
        configOf(id, kept?.joinedAt ?? Date.now(), flag, kept ? fenceOf(kept.fenced) : null),
      )
    } catch (err) {
      if (!flag && before !== id) {
        if (typeof before === 'string') tryWrite(SYNC_ID_KEY, before)
        else forget(SYNC_ID_KEY)
      }
      throw err
    }
  },

  /** A joined code's first cycle found its relay copy: from now on this device may re-create it. */
  markEstablished(code: string): void {
    const priv = privateKey()
    if (priv !== null) {
      if (priv.code === code && !priv.established) {
        tryWrite(PRIVATE_KEY, JSON.stringify({ code, at: priv.at, established: true }))
        tryWrite(SYNC_KEY, privateConfigOf(priv.at, true))
      }
      return
    }
    const raw = read(SYNC_KEY)
    const cfg = plainOf(raw === null ? null : parseJson(raw))
    if (cfg?.code === code && cfg.established === false) {
      tryWrite(SYNC_KEY, configOf(code, cfg.joinedAt, true, fenceOf(cfg.fenced)))
    }
  },

  /**
   * Saves a private code (3.2, 3.5): the key first, read back before anything else changes,
   * then `st5:sync` as the private marker, then the plain mirror goes. A plain setup (and its
   * fence) is replaced. `established` left out keeps the flag the same code already has
   * (start-up re-saves the saved code); a code new to this device is established. Throws
   * when the code has not the shape of one, or storage did not keep it: nothing else was
   * changed then.
   */
  savePrivateSync(code: string, flag?: boolean): void {
    if (!PRIVATE_CODE.test(code)) throw new RangeError('Not a private sync code.')
    const held = privateKey()
    const same = held?.code === code ? held : null
    const at = same === null ? Date.now() : same.at
    const established = flag ?? same?.established ?? true
    const value = JSON.stringify({ code, at, established })
    safeSet(PRIVATE_KEY, value)
    if (read(PRIVATE_KEY) !== value) throw new Error('This browser did not keep the code.')
    tryWrite(SYNC_KEY, privateConfigOf(at, established))
    forget(SYNC_ID_KEY)
  },

  /**
   * Fences this device out of its plain bucket (3.7): persisted before the pause, so a row
   * that is rewritten or removed afterwards never un-fences it. False when there is no plain
   * setup for that code, or storage refused: the caller then pauses for this session only.
   */
  setFenced(code: string, why: string, at: number): boolean {
    if (privateKey() !== null) return false
    const raw = read(SYNC_KEY)
    const cfg = plainOf(raw === null ? null : parseJson(raw))
    if (cfg?.code !== code) return false
    if (fenceOf(cfg.fenced) !== null) return true
    return tryWrite(
      SYNC_KEY,
      configOf(code, cfg.joinedAt, cfg.established !== false, { why: why.slice(0, 40), at }),
    )
  },

  /**
   * This device's id for writer stamps: 6 base36 chars in `st5:dev`, adopting 0.9.x's
   * `spendtrack:dev` so a device keeps one id across the upgrade (and a rollback).
   */
  getDeviceId(): string {
    const stored = storedDeviceId()
    if (stored !== null) return stored
    const legacy = read(LEGACY_DEV_KEY)
    const id =
      legacy !== null && DEVICE_ID_PATTERN.test(legacy)
        ? legacy
        : (sessionDeviceId ?? newDeviceId())
    sessionDeviceId = id
    tryWrite(DEV_KEY, JSON.stringify({ id, name: '' }))
    if (legacy !== id) tryWrite(LEGACY_DEV_KEY, id)
    return id
  },
}
