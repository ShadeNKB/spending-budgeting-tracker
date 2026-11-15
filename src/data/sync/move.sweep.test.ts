// A sweep running in one tab while another tab switches (PRIVATE-SYNC 4.3 step 4; second review
// C-F3): the switch writes the record, then the key. A sweep that read "no key held" just before
// the key was written must not remove the record. Invented codes and row ids only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeSt5 } from '../core/codes'
import { deriveKeys } from '../core/e2e'
import { MOVE_KEY, SWITCH_GRACE_MS, dropVoidMove, moveFingerprint, type MoveRecord } from './move'

const U = '11111111-1111-4111-8111-111111111111'
const SECRET = Uint8Array.from({ length: 16 }, (_, i) => i)
const CODE = encodeSt5(SECRET)
const NOW = Date.UTC(2026, 10, 20, 8, 0, 0)

const record = (rowId: string, at: number): MoveRecord => ({
  v: 1,
  for: moveFingerprint(rowId),
  from: U,
  at,
  phase: 'retiring',
  absorbed: null,
  retired: null,
  checkedAt: null,
  conflicts: 0,
  contested: false,
})

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a sweep and another tab’s switch (C-F3)', () => {
  it('A writes the record; B reads it and sees no key; A writes the key; B does not remove it', async () => {
    const { rowId } = await deriveKeys(SECRET)
    // tab A: the first write of the switch
    localStorage.setItem(MOVE_KEY, JSON.stringify(record(rowId, NOW)))
    // tab B: it has read that the device holds no private key
    const held: string | null = null
    // tab A: the second write, the key
    localStorage.setItem('st5:synckey', JSON.stringify({ code: CODE, at: NOW, established: true }))
    // tab B acts on what it read
    expect(dropVoidMove(held)).toBeNull()
    expect(localStorage.getItem(MOVE_KEY)).not.toBeNull()
    // the record is the bucket's: kept for it
    expect(dropVoidMove(rowId)).toMatchObject({ from: U })
  })

  it('past the grace, or under the lock (`remove`), a record with no key held is void', async () => {
    const { rowId } = await deriveKeys(SECRET)
    localStorage.setItem(MOVE_KEY, JSON.stringify(record(rowId, NOW)))
    expect(dropVoidMove(null, 'remove')).toBeNull()
    expect(localStorage.getItem(MOVE_KEY)).toBeNull()
    localStorage.setItem(MOVE_KEY, JSON.stringify(record(rowId, NOW)))
    vi.setSystemTime(NOW + SWITCH_GRACE_MS - 1)
    expect(dropVoidMove(null)).toBeNull()
    expect(localStorage.getItem(MOVE_KEY)).not.toBeNull()
    vi.setSystemTime(NOW + SWITCH_GRACE_MS)
    expect(dropVoidMove(null)).toBeNull()
    expect(localStorage.getItem(MOVE_KEY)).toBeNull()
  })

  it('a young record for another bucket is still void when a key is held', async () => {
    const { rowId } = await deriveKeys(SECRET)
    localStorage.setItem(MOVE_KEY, JSON.stringify(record(rowId, NOW)))
    expect(dropVoidMove('a1b2c3d4-e5f6-8a7b-9c8d-0e1f2a3b4c5e')).toBeNull()
    expect(localStorage.getItem(MOVE_KEY)).toBeNull()
  })
})
