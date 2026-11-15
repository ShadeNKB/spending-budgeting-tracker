// The move's own record (PRIVATE-SYNC 4.2, AC-M2, AC-M14): its key, its strict reader, its
// writer and remover, the fingerprint of the private row id it is for, and the void rule. What
// no existing storage writer may do to it is proved in services/storage.test.ts. Invented codes
// and row ids only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeSt5 } from '../core/codes'
import { deriveKeys } from '../core/e2e'
import { collectRawStorage } from '../../lib/rescue'
import { StorageQuotaError } from '../../services/storage'
import {
  MOVE_KEY,
  dropVoidMove,
  isVoidMove,
  moveFingerprint,
  readMove,
  removeMove,
  sweepVoidMove,
  writeMove,
  type MoveRecord,
} from './move'

const U = '11111111-1111-4111-8111-111111111111'
const ROW = 'a1b2c3d4-e5f6-8a7b-9c8d-0e1f2a3b4c5d'
const OTHER_ROW = 'a1b2c3d4-e5f6-8a7b-9c8d-0e1f2a3b4c5e'
const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i)
const CODE = encodeSt5(SECRET)
const OTHER_CODE = encodeSt5(Uint8Array.from({ length: 16 }, (_, i) => 15 - i))

const record = (over: Partial<Record<keyof MoveRecord, unknown>> = {}): MoveRecord => ({
  v: 1,
  for: moveFingerprint(ROW),
  from: U,
  at: 1000,
  phase: 'retiring',
  absorbed: null,
  retired: null,
  checkedAt: null,
  conflicts: 0,
  contested: false,
  ...(over as Partial<MoveRecord>),
})

const raw = (): string | null => localStorage.getItem(MOVE_KEY)
const put = (value: unknown): void => {
  localStorage.setItem(MOVE_KEY, typeof value === 'string' ? value : JSON.stringify(value))
}
const privateKey = (code: string): void => {
  localStorage.setItem('st5:synckey', JSON.stringify({ code, at: 1, established: true }))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the key', () => {
  it('is st5:synckey:move: matched by the rule that keeps secrets out of the rescue export', () => {
    expect(MOVE_KEY).toBe('st5:synckey:move')
    put(record())
    localStorage.setItem('expenses', '[]')
    const dump = collectRawStorage(localStorage)
    expect(Object.keys(dump)).toEqual(['expenses'])
    expect(JSON.stringify(dump)).not.toContain(U)
  })
})

describe('moveFingerprint', () => {
  it('is 14 base36 characters, the same for the same row id, another for another', () => {
    const f = moveFingerprint(ROW)
    expect(f).toMatch(/^[0-9a-z]{14}$/)
    expect(moveFingerprint(ROW)).toBe(f)
    expect(moveFingerprint(OTHER_ROW)).not.toBe(f)
  })

  it('holds no part of the row id', () => {
    const f = moveFingerprint(ROW)
    for (const part of ROW.split('-')) expect(f).not.toContain(part)
  })
})

describe('readMove (strict)', () => {
  it('reads a record as written', () => {
    const r = record({
      phase: 'retired',
      absorbed: 't1',
      retired: 't2',
      checkedAt: 5,
      conflicts: 2,
    })
    put(r)
    expect(readMove()).toEqual(r)
  })

  it('is null without a record, and for a value that is not one', () => {
    expect(readMove()).toBeNull()
    for (const bad of ['', 'nope', '{', 'null', '[]', '1', '"x"']) {
      put(bad)
      expect(readMove(), bad).toBeNull()
    }
  })

  it.each([
    ['v', 2],
    ['v', '1'],
    ['for', ''],
    ['for', 'ABCDEFGHIJKLMN'],
    ['for', ROW],
    ['from', ''],
    ['from', CODE],
    ['from', 'ABCDEF12-3456-4789-8ABC-DEF123456789'],
    ['from', 'invented-code'],
    ['at', -1],
    ['at', Number.NaN],
    ['at', '1000'],
    ['phase', 'moving'],
    ['phase', null],
    ['absorbed', 5],
    ['absorbed', ''],
    ['absorbed', 'x'.repeat(65)],
    ['retired', {}],
    ['checkedAt', '5'],
    ['checkedAt', -5],
    ['conflicts', -1],
    ['conflicts', 1.5],
    ['conflicts', null],
    ['contested', 'false'],
    ['contested', 0],
  ] as const)('is null when %s is %j', (field, value) => {
    put({ ...record(), [field]: value })
    expect(readMove()).toBeNull()
  })

  it.each([
    'v',
    'for',
    'from',
    'at',
    'phase',
    'absorbed',
    'retired',
    'checkedAt',
    'conflicts',
    'contested',
  ])('is null without %s', (field) => {
    const r: Record<string, unknown> = { ...record() }
    Reflect.deleteProperty(r, field)
    put(r)
    expect(readMove()).toBeNull()
  })

  it('is null with a field it does not know', () => {
    put({ ...record(), code: CODE })
    expect(readMove()).toBeNull()
  })
})

describe('writeMove and removeMove', () => {
  it('writes the record to its key alone and reads it back', () => {
    const before = Object.keys(localStorage)
    writeMove(record())
    expect(Object.keys(localStorage).sort()).toEqual([...before, MOVE_KEY].sort())
    expect(readMove()).toEqual(record())
    expect(JSON.parse(raw() ?? 'null')).toEqual(record())
  })

  it('refuses a record that is not one, and writes nothing', () => {
    for (const bad of [
      record({ phase: 'moving' }),
      record({ from: CODE }),
      record({ conflicts: -1 }),
    ]) {
      expect(() => {
        writeMove(bad)
      }).toThrow(RangeError)
    }
    expect(raw()).toBeNull()
  })

  it('throws when storage refuses it (quota), leaving what was there', () => {
    put(record({ conflicts: 1 }))
    const before = raw()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => {
      writeMove(record({ conflicts: 2 }))
    }).toThrow(StorageQuotaError)
    vi.restoreAllMocks()
    expect(raw()).toBe(before)
  })

  it('throws when storage does not keep it', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    expect(() => {
      writeMove(record())
    }).toThrow(/did not keep/)
  })

  it('removeMove removes the record and nothing else', () => {
    privateKey(CODE)
    put(record())
    removeMove()
    expect(raw()).toBeNull()
    expect(localStorage.getItem('st5:synckey')).not.toBeNull()
    removeMove() // nothing there: no error
  })
})

describe('the void rule', () => {
  it('a record is void without a private key, or for another bucket', () => {
    expect(isVoidMove(record(), null)).toBe(true)
    expect(isVoidMove(record(), OTHER_ROW)).toBe(true)
    expect(isVoidMove(record(), ROW)).toBe(false)
  })

  it('dropVoidMove removes a void record and keeps the one for this bucket', () => {
    put(record())
    expect(dropVoidMove(ROW)).toEqual(record())
    expect(raw()).not.toBeNull()
    expect(dropVoidMove(OTHER_ROW)).toBeNull()
    expect(raw()).toBeNull()
    put(record())
    expect(dropVoidMove(null)).toBeNull()
    expect(raw()).toBeNull()
  })

  it('removes a damaged record (it may hold the plain code) but keeps a newer build’s', () => {
    put('{"v":1,"from":"' + U)
    expect(dropVoidMove(ROW)).toBeNull()
    expect(raw()).toBeNull()
    put({ ...record(), phase: 'moving' })
    expect(dropVoidMove(ROW)).toBeNull()
    expect(raw()).toBeNull()
    const newer = JSON.stringify({ ...record(), v: 2 })
    put(newer)
    expect(dropVoidMove(ROW)).toBeNull()
    expect(raw()).toBe(newer)
  })

  it('without a record, nothing is written', () => {
    expect(dropVoidMove(null)).toBeNull()
    expect(Object.keys(localStorage)).toEqual([])
  })
})

describe('sweepVoidMove (the bucket read from st5:synckey)', () => {
  it('keeps the record for the private bucket the device holds', async () => {
    const { rowId } = await deriveKeys(SECRET)
    privateKey(CODE)
    put(record({ for: moveFingerprint(rowId) }))
    expect(await sweepVoidMove()).toEqual(record({ for: moveFingerprint(rowId) }))
    expect(raw()).not.toBeNull()
  })

  it('removes it with no st5:synckey (a plain device, or none)', async () => {
    const { rowId } = await deriveKeys(SECRET)
    put(record({ for: moveFingerprint(rowId) }))
    expect(await sweepVoidMove()).toBeNull()
    expect(raw()).toBeNull()
    localStorage.setItem('syncId', U)
    localStorage.setItem(
      'st5:sync',
      JSON.stringify({ kind: 'plain', code: U, rowId: U, joinedAt: 1, established: true }),
    )
    put(record({ for: moveFingerprint(rowId) }))
    expect(await sweepVoidMove()).toBeNull()
    expect(raw()).toBeNull()
  })

  it('removes it when st5:synckey names another bucket, or is damaged', async () => {
    const { rowId } = await deriveKeys(SECRET)
    privateKey(OTHER_CODE)
    put(record({ for: moveFingerprint(rowId) }))
    expect(await sweepVoidMove()).toBeNull()
    expect(raw()).toBeNull()
    localStorage.setItem('st5:synckey', '{"code":"ST5-damaged"}')
    put(record({ for: moveFingerprint(rowId) }))
    expect(await sweepVoidMove()).toBeNull()
    expect(raw()).toBeNull()
  })

  it('decides nothing when the setup changes while the row id is derived', async () => {
    const { rowId } = await deriveKeys(SECRET)
    privateKey(OTHER_CODE)
    put(record({ for: moveFingerprint(rowId) }))
    const sweeping = sweepVoidMove()
    privateKey(CODE) // another tab joined the bucket the record is for
    expect(await sweeping).toBeNull()
    expect(raw()).not.toBeNull()
    expect(await sweepVoidMove()).toEqual(record({ for: moveFingerprint(rowId) }))
  })

  it('decides nothing when the row id cannot be derived (no SubtleCrypto)', async () => {
    privateKey(CODE)
    put(record())
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValue(new Error('no crypto'))
    expect(await sweepVoidMove()).toBeNull()
    expect(raw()).not.toBeNull()
  })
})

// Only the lazy sync engine (and, from the next slice, the lazy Settings › Sync panel) may load
// the record: nothing on the start-up path. (A static import from an eager module would pull it,
// with the core's crypto, into the entry chunk; `npm run size:relay` weighs that too.)
const SOURCES = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
)
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set(['/src/stores/syncEngine.ts'])

describe('who may import the record', () => {
  it('is the lazy sync engine only', () => {
    const importers = Object.entries(SOURCES)
      .filter(([, text]) =>
        /from\s+['"][./]*(?:data\/)?sync\/move['"]|from\s+['"]\.\/move['"]/.test(text),
      )
      .map(([path]) => path)
      .filter((path) => path !== '/src/data/sync/move.ts')
    expect(importers.filter((p) => !ALLOWED_IMPORTERS.has(p))).toEqual([])
  })

  it('imports nothing of the stores or the screens itself', () => {
    const text = SOURCES['/src/data/sync/move.ts'] ?? ''
    expect(text).not.toBe('')
    expect(text).not.toMatch(/from\s+['"][^'"]*(?:stores|features|app)\//)
  })
})
