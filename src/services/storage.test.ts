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
    expect(Object.keys(mod.storage).sort()).toEqual(['getDeviceId', 'getSyncId', 'saveSyncId'])
  })
})
