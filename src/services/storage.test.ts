import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Each case gets a fresh module: the device id and the quota warning are remembered per session.
async function fresh() {
  vi.resetModules()
  return import('./storage')
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('storage.getDeviceId', () => {
  it('creates a 6-char base36 id once and keeps it in st5:dev (and spendtrack:dev for a rollback)', async () => {
    const { storage } = await fresh()
    const id = storage.getDeviceId()
    expect(id).toMatch(/^[0-9a-z]{6}$/)
    expect(JSON.parse(localStorage.getItem('st5:dev') ?? 'null')).toEqual({ id, name: '' })
    expect(localStorage.getItem('spendtrack:dev')).toBe(id)
    expect(storage.getDeviceId()).toBe(id)
  })

  it('adopts the id 0.9.x saved in spendtrack:dev', async () => {
    localStorage.setItem('spendtrack:dev', 'ab12cd')
    const { storage } = await fresh()
    expect(storage.getDeviceId()).toBe('ab12cd')
    expect(JSON.parse(localStorage.getItem('st5:dev') ?? 'null')).toEqual({
      id: 'ab12cd',
      name: '',
    })
  })

  it('is stable across reloads', async () => {
    const id = (await fresh()).storage.getDeviceId()
    expect((await fresh()).storage.getDeviceId()).toBe(id)
  })

  it('replaces a malformed stored id', async () => {
    localStorage.setItem('spendtrack:dev', 'not an id')
    localStorage.setItem('st5:dev', '{"id":7}')
    const id = (await fresh()).storage.getDeviceId()
    expect(id).toMatch(/^[0-9a-z]{6}$/)
    expect(localStorage.getItem('spendtrack:dev')).toBe(id)
  })

  it('still returns one id for the session when storage refuses the write', async () => {
    const { storage } = await fresh()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const id = storage.getDeviceId()
    expect(id).toMatch(/^[0-9a-z]{6}$/)
    expect(storage.getDeviceId()).toBe(id)
  })
})

describe('the sync code (P2-7)', () => {
  it('saves to st5:sync and the plaintext syncId mirror, and reads it back', async () => {
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBeNull()
    storage.saveSyncId('invented-code-1')
    expect(localStorage.getItem('syncId')).toBe('invented-code-1')
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? 'null')).toMatchObject({
      kind: 'plain',
      code: 'invented-code-1',
      rowId: 'invented-code-1',
      established: true,
    })
    expect(storage.getSyncId()).toBe('invented-code-1')
  })

  it('adopts a code that only 0.9.x saved (syncId) into st5:sync on the first read', async () => {
    localStorage.setItem('syncId', 'invented-code-2')
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBe('invented-code-2')
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? 'null')).toMatchObject({
      code: 'invented-code-2',
    })
  })

  it('quarantines a corrupt st5:sync once and falls back to syncId', async () => {
    localStorage.setItem('st5:sync', '{"kind":"pla')
    localStorage.setItem('syncId', 'invented-code-3')
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBe('invented-code-3')
    const copies = Object.keys(localStorage).filter((k) => k.startsWith('st5:q:st5:sync:'))
    expect(copies).toHaveLength(1)
    expect(localStorage.getItem(copies[0] ?? '')).toBe('{"kind":"pla')
  })

  it('is off when st5:sync is corrupt and there is no syncId', async () => {
    localStorage.setItem('st5:sync', 'garbage')
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBeNull()
    expect(storage.getSyncId()).toBeNull()
    expect(Object.keys(localStorage).filter((k) => k.startsWith('st5:q:st5:sync:'))).toHaveLength(1)
  })

  it('forgets both keys on Disconnect (null)', async () => {
    const { storage } = await fresh()
    storage.saveSyncId('invented-code-4')
    storage.saveSyncId(null)
    expect(localStorage.getItem('syncId')).toBeNull()
    expect(localStorage.getItem('st5:sync')).toBeNull()
    expect(storage.getSyncId()).toBeNull()
  })

  // A rolled-back 0.9.2 reads and writes only `syncId`: what it did there holds after the roll
  // forward, instead of this build syncing with a relay the owner left.
  it('rollback, Disconnect on 0.9.2, roll forward: stays disconnected', async () => {
    const before = await fresh()
    before.storage.saveSyncId('invented-old-a')
    // 0.9.2's saveSyncId(null) removes only syncId
    localStorage.removeItem('syncId')
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBeNull()
    expect(localStorage.getItem('st5:sync')).toBeNull()
    expect(storage.getSyncId()).toBeNull()
  })

  it('rollback, another code connected on 0.9.2, roll forward: the new code wins', async () => {
    const before = await fresh()
    before.storage.saveSyncId('invented-old-a')
    // 0.9.2 connects code B: it writes syncId only
    localStorage.setItem('syncId', 'invented-new-b')
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBe('invented-new-b')
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? 'null')).toMatchObject({
      kind: 'plain',
      code: 'invented-new-b',
      rowId: 'invented-new-b',
    })
    expect(storage.getSyncId()).toBe('invented-new-b')
  })

  it('writes syncId before st5:sync, so a refused save never leaves st5:sync alone', async () => {
    const { storage, StorageQuotaError } = await fresh()
    const real = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => {
      if (k === 'syncId') throw new DOMException('full', 'QuotaExceededError')
      real(k, v)
    })
    expect(() => {
      storage.saveSyncId('invented-code-5')
    }).toThrow(StorageQuotaError)
    expect(localStorage.getItem('st5:sync')).toBeNull()
  })

  // I12: no removal on a failed read. Only a syncId that is really absent is 0.9.x's disconnect.
  it('keeps st5:sync and its code when syncId cannot be read (storage refused the read)', async () => {
    const before = await fresh()
    before.storage.saveSyncId('invented-code-6')
    const real = Storage.prototype.getItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => {
      if (k === 'syncId') throw new DOMException('denied', 'SecurityError')
      return real(k)
    })
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBe('invented-code-6')
    vi.restoreAllMocks()
    expect(localStorage.getItem('st5:sync')).not.toBeNull()
    expect(localStorage.getItem('syncId')).toBe('invented-code-6')
  })

  it('keeps st5:sync when syncId holds no code (damaged), copying the damaged value aside once', async () => {
    const before = await fresh()
    before.storage.saveSyncId('invented-code-7')
    for (const damaged of ['', '   ', 'x'.repeat(201)]) {
      localStorage.setItem('syncId', damaged)
      const { storage } = await fresh()
      expect(storage.getSyncId()).toBe('invented-code-7')
      expect(storage.getSyncId()).toBe('invented-code-7')
      expect(localStorage.getItem('st5:sync')).not.toBeNull()
    }
    const copies = Object.keys(localStorage).filter((k) => k.startsWith('st5:q:syncId:'))
    expect(copies.map((k) => localStorage.getItem(k)).sort()).toEqual(
      ['', '   ', 'x'.repeat(201)].sort(),
    )
  })

  it('never forgets a config that is not a plain code (a private one has no syncId mirror)', async () => {
    const sealed = JSON.stringify({ kind: 'e2e', code: 'invented-secret', established: true })
    localStorage.setItem('st5:sync', sealed)
    const { storage } = await fresh()
    expect(storage.getSyncId()).toBeNull()
    expect(localStorage.getItem('st5:sync')).toBe(sealed)
  })
})

// PR-3 track spec P3-5, P3-19: a joined code is not established until a cycle finds its relay
// copy, and a config a newer SpendTrack wrote is never quarantined, removed or overwritten.
describe('the sync config (PR-3)', () => {
  const NEWER = JSON.stringify({ kind: 'e2e', code: 'ST5-INVENTED', rowId: 'r', established: true })

  it('reads a plain config with its established flag, and null without a code', async () => {
    const { storage } = await fresh()
    expect(storage.getSyncConfig()).toBeNull()
    storage.saveSyncId('invented-code-a')
    expect(storage.getSyncConfig()).toEqual({
      kind: 'plain',
      code: 'invented-code-a',
      established: true,
    })
  })

  it('saves a joined code as not established, and keeps that through a re-save of the same code', async () => {
    const { storage } = await fresh()
    storage.saveSyncId('invented-code-b', false)
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? 'null')).toMatchObject({
      kind: 'plain',
      code: 'invented-code-b',
      established: false,
    })
    expect(localStorage.getItem('syncId')).toBe('invented-code-b')
    // start-up re-saves the saved code without saying how: it stays unestablished
    storage.saveSyncId('invented-code-b')
    expect(storage.getSyncConfig()).toMatchObject({ established: false })
    // another code is a new link: established unless it is a join
    storage.saveSyncId('invented-code-c')
    expect(storage.getSyncConfig()).toMatchObject({ code: 'invented-code-c', established: true })
  })

  /** Storage that refuses every write of `st5:sync` (quota) and takes every other key. */
  function refuseConfig() {
    const real = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k, v) => {
      if (k === 'st5:sync') throw new DOMException('full', 'QuotaExceededError')
      real(k, v)
    })
  }

  it('never leaves a joined code in syncId alone when st5:sync refuses it (the next start would create)', async () => {
    const { storage, StorageQuotaError } = await fresh()
    refuseConfig()
    expect(() => {
      storage.saveSyncId('invented-code-j', false)
    }).toThrow(StorageQuotaError)
    expect(localStorage.getItem('syncId')).toBeNull()
    expect(storage.getSyncConfig()).toBeNull()
    vi.restoreAllMocks()
    // the next start reads no code at all, never an established one
    expect((await fresh()).storage.getSyncConfig()).toBeNull()
  })

  it('puts back the code syncId held before a refused join, with its own config', async () => {
    const { storage } = await fresh()
    storage.saveSyncId('invented-code-k')
    refuseConfig()
    expect(() => {
      storage.saveSyncId('invented-code-l', false)
    }).toThrow()
    vi.restoreAllMocks()
    expect(localStorage.getItem('syncId')).toBe('invented-code-k')
    expect((await fresh()).storage.getSyncConfig()).toEqual({
      kind: 'plain',
      code: 'invented-code-k',
      established: true,
    })
  })

  it('keeps syncId when an established code cannot reach st5:sync (read as established, as it is)', async () => {
    const { storage } = await fresh()
    refuseConfig()
    expect(() => {
      storage.saveSyncId('invented-code-m')
    }).toThrow()
    vi.restoreAllMocks()
    expect(localStorage.getItem('syncId')).toBe('invented-code-m')
    expect((await fresh()).storage.getSyncConfig()).toMatchObject({ established: true })
  })

  it('marks a joined code established once, and leaves another code alone', async () => {
    const { storage } = await fresh()
    storage.saveSyncId('invented-code-d', false)
    storage.markEstablished('invented-other')
    expect(storage.getSyncConfig()).toMatchObject({ established: false })
    storage.markEstablished('invented-code-d')
    expect(storage.getSyncConfig()).toMatchObject({ code: 'invented-code-d', established: true })
    expect((await fresh()).storage.getSyncConfig()).toMatchObject({ established: true })
  })

  it('keeps a config a newer SpendTrack wrote: never quarantined, removed or overwritten', async () => {
    localStorage.setItem('st5:sync', NEWER)
    localStorage.setItem('syncId', 'invented-code-e') // even beside an old mirror
    const remove = vi.spyOn(Storage.prototype, 'removeItem')
    const { storage } = await fresh()
    expect(storage.getSyncConfig()).toEqual({ kind: 'newer' })
    expect(storage.getSyncId()).toBeNull()
    storage.markEstablished('invented-code-e')
    expect(remove).not.toHaveBeenCalled()
    expect(localStorage.getItem('st5:sync')).toBe(NEWER)
    expect(Object.keys(localStorage).some((k) => k.startsWith('st5:q:'))).toBe(false)
    // only an explicit Disconnect removes it
    storage.saveSyncId(null)
    expect(localStorage.getItem('st5:sync')).toBeNull()
  })

  it('treats only a non-object, or a plain config without a valid code, as corrupt', async () => {
    for (const bad of ['[1,2]', '"plain"', '{"kind":7}', '{"kind":"plain","code":""}']) {
      localStorage.clear()
      localStorage.setItem('st5:sync', bad)
      const { storage } = await fresh()
      expect(storage.getSyncConfig()).toBeNull()
      expect(Object.keys(localStorage).filter((k) => k.startsWith('st5:q:st5:sync:'))).toHaveLength(
        1,
      )
    }
  })
})

describe('safeSet', () => {
  it('throws StorageQuotaError on quota and fires spendtrack:quota-exceeded once', async () => {
    const { StorageQuotaError, safeSet } = await fresh()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const heard = vi.fn()
    window.addEventListener('spendtrack:quota-exceeded', heard)
    expect(() => {
      safeSet('st5:db', 'x')
    }).toThrow(StorageQuotaError)
    expect(() => {
      safeSet('st5:db', 'y')
    }).toThrow(StorageQuotaError)
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener('spendtrack:quota-exceeded', heard)
  })

  it('rethrows any other failure as it is', async () => {
    const { StorageQuotaError, safeSet } = await fresh()
    const boom = new DOMException('blocked', 'SecurityError')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw boom
    })
    let caught: unknown = null
    try {
      safeSet('k', 'v')
    } catch (err) {
      caught = err
    }
    expect(caught).toBe(boom)
    expect(caught).not.toBeInstanceOf(StorageQuotaError)
  })

  it('writes to the given Storage when one is passed (each engine writes its own tab view)', async () => {
    const { safeSet } = await fresh()
    const writes: string[] = []
    safeSet('st5:db', 'v', { setItem: (k) => writes.push(k) })
    expect(writes).toEqual(['st5:db'])
    expect(localStorage.getItem('st5:db')).toBeNull()
  })

  it('exports nothing but the writer, its error and the sync identity (§6.3)', async () => {
    const mod = await fresh()
    expect(Object.keys(mod).sort()).toEqual(['StorageQuotaError', 'safeSet', 'storage'])
    expect(Object.keys(mod.storage).sort()).toEqual([
      'getDeviceId',
      'getSyncConfig',
      'getSyncId',
      'isLinked',
      'markEstablished',
      'savePrivateSync',
      'saveSyncId',
      'setFenced',
    ])
  })
})

// PRIVATE-SYNC 3.2 and 3.7. Invented codes: the shape of one, never a real secret.
describe('a private sync code (PR-6)', () => {
  const CODE = 'ST5-0004106-1050R3G-G28A1C6-0T3GFS3'
  const OTHER = 'ST5-7ZZZZZZ-ZZZZZZZ-ZZZZZZZ-ZZZZZ00'
  const UUID = '11111111-1111-4111-8111-111111111111'
  const key = () => JSON.parse(localStorage.getItem('st5:synckey') ?? 'null') as unknown

  it('lives in its own key; st5:sync says only the kind, and there is no syncId mirror', async () => {
    const { storage } = await fresh()
    storage.savePrivateSync(CODE, true)
    expect(key()).toMatchObject({ code: CODE, established: true })
    const marker = localStorage.getItem('st5:sync') ?? ''
    expect(JSON.parse(marker)).toMatchObject({ kind: 'e2e', established: true })
    expect(marker).not.toContain('ST5')
    expect(marker).not.toContain('rowId')
    expect(localStorage.getItem('syncId')).toBeNull()
    expect(storage.getSyncConfig()).toEqual({ kind: 'e2e', code: CODE, established: true })
    // a private device has no plain code, and sync is on
    expect(storage.getSyncId()).toBeNull()
    expect(storage.isLinked()).toBe(true)
  })

  it('refuses a value that has not the shape of a private code, and changes nothing', async () => {
    const { storage } = await fresh()
    storage.saveSyncId(UUID)
    for (const bad of [
      '',
      UUID,
      'ST5-short',
      CODE.toLowerCase(),
      `${CODE}-X`,
      CODE.replace('0', 'O'),
    ]) {
      expect(() => storage.savePrivateSync(bad, true), bad).toThrow(RangeError)
    }
    expect(localStorage.getItem('st5:synckey')).toBeNull()
    expect(storage.getSyncConfig()).toMatchObject({ kind: 'plain', code: UUID })
  })

  it('replaces a plain setup, its mirror and its fence', async () => {
    const { storage } = await fresh()
    storage.saveSyncId(UUID)
    expect(storage.setFenced(UUID, 'private', 5)).toBe(true)
    storage.savePrivateSync(CODE, false)
    expect(localStorage.getItem('syncId')).toBeNull()
    expect(storage.getSyncConfig()).toEqual({ kind: 'e2e', code: CODE, established: false })
    expect(localStorage.getItem('st5:sync')).not.toContain(UUID)
  })

  it('the reader rule: the key wins over a stray syncId, a missing st5:sync and a plain one written over it', async () => {
    const { storage } = await fresh()
    storage.savePrivateSync(CODE, true)

    // a stray mirror (an older build, a restored key)
    localStorage.setItem('syncId', UUID)
    expect(storage.getSyncConfig()).toEqual({ kind: 'e2e', code: CODE, established: true })
    expect(localStorage.getItem('syncId')).toBeNull()

    // st5:sync gone
    localStorage.removeItem('st5:sync')
    expect(storage.getSyncConfig()).toEqual({ kind: 'e2e', code: CODE, established: true })
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? '{}')).toMatchObject({ kind: 'e2e' })

    // an older build linked a plain code over it
    localStorage.setItem('syncId', UUID)
    localStorage.setItem(
      'st5:sync',
      JSON.stringify({ kind: 'plain', code: UUID, rowId: UUID, joinedAt: 1, established: true }),
    )
    expect(storage.getSyncId()).toBeNull()
    expect(storage.getSyncConfig()).toEqual({ kind: 'e2e', code: CODE, established: true })
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? '{}')).toMatchObject({ kind: 'e2e' })
    expect(localStorage.getItem('syncId')).toBeNull()
    expect(key()).toMatchObject({ code: CODE })
  })

  it('the plain writer refuses while a private code is set up, and start-up cannot rewrite it', async () => {
    const { storage } = await fresh()
    storage.savePrivateSync(CODE, true)
    expect(() => storage.saveSyncId(UUID)).toThrow(/private sync is set up/)
    expect(() => storage.saveSyncId(UUID, false)).toThrow()
    expect(key()).toMatchObject({ code: CODE })
    expect(localStorage.getItem('syncId')).toBeNull()
  })

  it('Disconnect leaves no code in any key', async () => {
    const { storage } = await fresh()
    storage.savePrivateSync(CODE, true)
    storage.saveSyncId(null)
    expect(localStorage.getItem('st5:synckey')).toBeNull()
    expect(localStorage.getItem('st5:sync')).toBeNull()
    expect(localStorage.getItem('syncId')).toBeNull()
    expect(storage.getSyncConfig()).toBeNull()
    expect(storage.isLinked()).toBe(false)
    const everything = Object.keys(localStorage)
      .map((k) => `${k}=${localStorage.getItem(k) ?? ''}`)
      .join('|')
    expect(everything).not.toContain('ST5')
  })

  it('establishes once, in the key (the flag survives st5:sync being written over)', async () => {
    const { storage } = await fresh()
    storage.savePrivateSync(CODE, false)
    storage.markEstablished(OTHER)
    expect(storage.getSyncConfig()).toMatchObject({ established: false })
    storage.markEstablished(CODE)
    localStorage.removeItem('st5:sync')
    expect(storage.getSyncConfig()).toEqual({ kind: 'e2e', code: CODE, established: true })
  })

  it('saving the same code again keeps when it was joined; another code replaces it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { storage } = await fresh()
    storage.savePrivateSync(CODE, false)
    vi.spyOn(Date, 'now').mockReturnValue(9000)
    storage.savePrivateSync(CODE, true)
    expect(key()).toEqual({ code: CODE, at: 1000, established: true })
    storage.savePrivateSync(OTHER, false)
    expect(key()).toEqual({ code: OTHER, at: 9000, established: false })
  })

  it('a key that storage does not keep is an error, with the plain setup left as it was', async () => {
    const { storage } = await fresh()
    storage.saveSyncId(UUID)
    const real = Storage.prototype.getItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) =>
      k === 'st5:synckey' ? null : real(k),
    )
    expect(() => storage.savePrivateSync(CODE, true)).toThrow(/did not keep/)
    vi.restoreAllMocks()
    expect(localStorage.getItem('syncId')).toBe(UUID)
    expect(JSON.parse(localStorage.getItem('st5:sync') ?? '{}')).toMatchObject({ kind: 'plain' })
  })

  it('a private marker without its key is a setup this build cannot use: kept, never synced over', async () => {
    localStorage.setItem(
      'st5:sync',
      JSON.stringify({ kind: 'e2e', joinedAt: 1, established: true }),
    )
    const { storage } = await fresh()
    expect(storage.getSyncConfig()).toEqual({ kind: 'newer' })
    expect(storage.getSyncId()).toBeNull()
    expect(storage.isLinked()).toBe(false)
  })

  it('a damaged key is no code: nothing is copied aside (it may hold a secret)', async () => {
    localStorage.setItem('st5:synckey', '{"code":"ST5-not-a-code"}')
    const { storage } = await fresh()
    expect(storage.getSyncConfig()).toBeNull()
    expect(Object.keys(localStorage).filter((k) => k.startsWith('st5:q:'))).toEqual([])
  })
})

describe('the durable fence (PR-6, 3.7)', () => {
  const UUID = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'

  it('is written into the plain config and read back with it', async () => {
    const { storage } = await fresh()
    storage.saveSyncId(UUID)
    expect(storage.getSyncConfig()).toEqual({ kind: 'plain', code: UUID, established: true })
    expect(storage.setFenced(UUID, 'private', 1234)).toBe(true)
    expect(storage.getSyncConfig()).toEqual({
      kind: 'plain',
      code: UUID,
      established: true,
      fenced: { why: 'private', at: 1234 },
    })
    // the plain code and its mirror are where they were: an older build still reads them
    expect(storage.getSyncId()).toBe(UUID)
    expect(localStorage.getItem('syncId')).toBe(UUID)
  })

  it('survives a restart that saves the same code again, and being established', async () => {
    const { storage } = await fresh()
    storage.saveSyncId(UUID, false)
    storage.setFenced(UUID, 'private', 7)
    storage.saveSyncId(UUID)
    storage.markEstablished(UUID)
    expect(storage.getSyncConfig()).toMatchObject({ fenced: { why: 'private', at: 7 } })
    // and the first fence stays: a later marker does not move its time
    expect(storage.setFenced(UUID, 'rotated', 99)).toBe(true)
    expect(storage.getSyncConfig()).toMatchObject({ fenced: { why: 'private', at: 7 } })
  })

  it('goes with the code: another code, or Disconnect, starts clean', async () => {
    const { storage } = await fresh()
    storage.saveSyncId(UUID)
    storage.setFenced(UUID, 'private', 7)
    storage.saveSyncId(OTHER)
    expect(storage.getSyncConfig()).toEqual({ kind: 'plain', code: OTHER, established: true })
    storage.setFenced(OTHER, 'stopped', 8)
    storage.saveSyncId(null)
    storage.saveSyncId(OTHER)
    expect(storage.getSyncConfig()).toEqual({ kind: 'plain', code: OTHER, established: true })
  })

  it('is refused for a code that is not the one set up, and on a private device', async () => {
    const { storage } = await fresh()
    expect(storage.setFenced(UUID, 'private', 1)).toBe(false)
    storage.saveSyncId(UUID)
    expect(storage.setFenced(OTHER, 'private', 1)).toBe(false)
    expect(storage.getSyncConfig()).not.toHaveProperty('fenced')
    storage.savePrivateSync('ST5-0004106-1050R3G-G28A1C6-0T3GFS3', true)
    expect(storage.setFenced(UUID, 'private', 1)).toBe(false)
  })

  it('a fence of another shape is no fence', async () => {
    localStorage.setItem('syncId', UUID)
    localStorage.setItem(
      'st5:sync',
      JSON.stringify({
        kind: 'plain',
        code: UUID,
        rowId: UUID,
        joinedAt: 1,
        established: true,
        fenced: 'yes',
      }),
    )
    const { storage } = await fresh()
    expect(storage.getSyncConfig()).toEqual({ kind: 'plain', code: UUID, established: true })
  })
})
