// The snapshot ring under the owner's real use (DATA-ENGINE-SPEC §8.6, §9.7, §9.11): a quick add
// closes the app well inside the 35 s compression delay, so every z0 copy an earlier session left
// is compressed after the next boot; a copy waiting for that is never evicted; a daily snapshot
// only ever makes room by shedding older dailies; and the byte budget evicts dailies only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SNAP_BYTES } from '../../core/constants'
import { EMPTY_DOC } from '../../core/doc'
import { Io, type WriteResult } from '../io'
import { RESUME_DELAY, type SnapMeta, Snapshots } from '../snapshots'
import { FakeBacking } from './fakeStorage'

const T0 = Date.UTC(2026, 9, 19, 4)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

interface Ring {
  readonly io: Io
  readonly levels: (number | undefined)[]
  open(): Snapshots
}

/** One storage, opened by as many sessions (page loads) as a test needs. */
function ring(): Ring {
  const io = new Io(new FakeBacking().view())
  const levels: (number | undefined)[] = []
  const write = (key: string, value: string, maxLevel?: number): WriteResult => {
    levels.push(maxLevel)
    return io.write(key, value)
  }
  return { io, levels, open: () => new Snapshots(io, write) }
}

/** A pre-v5 copy of `chars` characters (any body compresses the same way). */
const preV5 = (s: Snapshots, chars: number, at = Date.now()): SnapMeta | null =>
  s.takeV4({ expenses: JSON.stringify('k'.repeat(chars)) }, 1, at)

const zOf = (s: Snapshots, id: string): number | undefined => s.index().find((m) => m.id === id)?.z

describe('a session shorter than the compression delay (§8.6)', () => {
  it('leaves z0 copies that the next boot compresses', async () => {
    const r = ring()
    const first = r.open()
    const meta = preV5(first, 50_000)
    if (meta === null) throw new Error('no snapshot')
    const plain = first.bodySync(meta.id)
    first.stop() // the owner closes the app 8 s after a quick add

    const next = r.open() // the next launch
    next.resume(Date.now())
    expect(zOf(next, meta.id)).toBe(0)
    await vi.advanceTimersByTimeAsync(RESUME_DELAY)
    await vi.waitFor(() => {
      expect(zOf(next, meta.id)).toBe(1)
    })
    const stored = r.io.get(`st5:snap:${meta.id}`) ?? ''
    expect(stored.startsWith('z1|')).toBe(true)
    expect(stored.length).toBeLessThan(5_000)
    expect(await next.body(meta.id)).toBe(plain)
  })

  it('never evicts a copy that is still waiting for compression, across a reload', async () => {
    const r = ring()
    const first = r.open()
    const old: string[] = []
    for (let i = 0; i < 5; i++) old.push(preV5(first, 1000, T0 + i)?.id ?? '')
    first.stop()

    const next = r.open()
    next.resume(Date.now())
    // a sixth pre-destructive copy goes over the cap of 5, but every older one is still waiting
    const sixth = next.takeDoc(EMPTY_DOC, 'delete-all', T0 + 10)
    const ids = next.index().map((m) => m.id)
    for (const id of old) expect(ids).toContain(id)
    expect(ids).toContain(sixth?.id)

    // once they are compressed, the cap applies again (the oldest goes on the next take)
    await vi.advanceTimersByTimeAsync(RESUME_DELAY)
    await vi.waitFor(() => {
      for (const id of old) expect(zOf(next, id)).toBe(1)
    })
    next.takeDoc(EMPTY_DOC, 'import', T0 + 20)
    expect(next.index().map((m) => m.id)).not.toContain(old[0])
  })

  it('without CompressionStream, nothing waits: copies stay z0 and the ring stays capped', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const r = ring()
    const first = r.open()
    for (let i = 0; i < 6; i++) preV5(first, 1000, T0 + i)
    expect(first.index()).toHaveLength(5)
    const next = r.open()
    next.resume(Date.now())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(next.index().map((m) => m.z)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('what makes room for what (§9.7, §9.11)', () => {
  it('a daily snapshot sheds older dailies only; a pre-destructive one may shed more', () => {
    const r = ring()
    const s = r.open()
    s.takeDoc(EMPTY_DOC, 'daily', T0)
    expect(r.levels).toEqual([1, 1, undefined])
    r.levels.length = 0
    s.takeDoc(EMPTY_DOC, 'import', T0 + 1)
    expect(r.levels.every((l) => l === undefined)).toBe(true)
  })

  it('the byte budget evicts dailies, never one of the 5 newest pre-destructive copies', () => {
    vi.stubGlobal('CompressionStream', undefined) // nothing is waiting: everything is evictable
    const r = ring()
    const s = r.open()
    const third = Math.ceil(SNAP_BYTES / 3)
    const daily = s.takeDoc(EMPTY_DOC, 'daily', T0)
    const pre = [preV5(s, third, T0 + 1), preV5(s, third, T0 + 2), preV5(s, third, T0 + 3)]
    const ids = s.index().map((m) => m.id)
    expect(ids).not.toContain(daily?.id)
    for (const p of pre) expect(ids).toContain(p?.id)
  })
})
