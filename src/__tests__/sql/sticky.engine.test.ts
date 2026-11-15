// Migration 006 against the released sync engine (PRIVATE-SYNC 4.5, finding A): the unmodified
// store and engine of this build, its unmodified transport and the real supabase-js, over the
// PostgREST-shaped adapter, on real Postgres with 004 applied, with and without 006. Realtime
// stays in memory (the fake relay's channels): nothing opens a socket. Invented data only.
//
// The case 006 closes: a plain device crosses another writer three times, so its fourth push is
// forced (§11.3), and the row turns into a moved marker just before that push arrives. On 004
// the forced write lands over the marker, which is lost. On 006 it is a conflict: the engine
// pulls again, finds the marker, fences itself and writes nothing more.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { movedMarker } from '../../data/core/wire'
import { SYNC_CODE, bootDevice, resetRelay, retireDevices, stubRelayEnv } from '../fakeRelay'
import { bootRelay, closeTemplate, type PgRelay } from '../pgRelay'
import { pgRest, type PgRest } from '../pgRest'

vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@supabase/supabase-js')>()
  const fake = await import('../fakeRelay')
  return {
    ...real,
    createClient: (...args: Parameters<typeof real.createClient>) => {
      const client = real.createClient(...args)
      // Requests go through the real client (and so through the stubbed fetch below); channels
      // come from the fake relay, in memory.
      const channels = new fake.FakeClient()
      return Object.assign(client, {
        channel: channels.channel.bind(channels),
        removeChannel: channels.removeChannel.bind(channels),
      })
    },
  }
})

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const MARKER = movedMarker('private', '2026-11-15T04:00:00.000Z')

interface Push {
  readonly force: boolean
  readonly answer: unknown
}

let relay: PgRelay | null = null

async function rowPayload(r: PgRelay): Promise<unknown> {
  const rows = await r.rows<{ payload: unknown }>(
    `SELECT payload FROM public.sync_buckets WHERE sync_id = $1`,
    [SYNC_CODE],
  )
  return rows[0]?.payload ?? null
}

/** Another writer, as the owner through the function: forces the row's own payload again. */
async function crossWrite(r: PgRelay): Promise<void> {
  await r.rows(
    `SELECT public.st_sync_push($1, b.payload, NULL, true) FROM public.sync_buckets AS b WHERE b.sync_id = $1`,
    [SYNC_CODE],
  )
}

/** The mover, as the owner through the function: the marker by compare-and-set on the head. */
async function writeMarker(r: PgRelay): Promise<void> {
  const rows = await r.rows<{ r: { ok: boolean } }>(
    `SELECT public.st_sync_push($1, $2::jsonb, public.st_sync_head($1)) AS r`,
    [SYNC_CODE, JSON.stringify(MARKER)],
  )
  expect(rows[0]?.r.ok).toBe(true)
}

/**
 * The adapter's fetch, with another writer stepping in before each of the engine's pushes: a
 * crossing write before the first three, the marker before the forced one.
 */
function crossingFetch(r: PgRelay, rest: PgRest, pushes: Push[]) {
  let armed = false
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init)
    if (!armed || !req.url.endsWith('/rpc/st_sync_push')) return rest.fetch(req)
    const args: unknown = JSON.parse(await req.clone().text())
    const force =
      typeof args === 'object' && args !== null && 'p_force' in args && args.p_force === true
    if (pushes.length < 3) await crossWrite(r)
    else if (force) {
      await writeMarker(r)
      armed = false
    }
    const res = await rest.fetch(req)
    pushes.push({ force, answer: await res.clone().json() })
    return res
  }
  return {
    fetch,
    arm: () => {
      armed = true
    },
  }
}

beforeEach(() => {
  stubRelayEnv()
  vi.stubEnv('VITE_SYNC_RELAY', 'rpc')
  resetRelay()
})

afterEach(async () => {
  retireDevices()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await relay?.close()
  relay = null
})

afterAll(closeTemplate)

async function scenario(with006: boolean) {
  const r = await bootRelay('004')
  relay = r
  if (with006) await r.apply('006')
  const rest = pgRest(r)
  const pushes: Push[] = []
  const crossing = crossingFetch(r, rest, pushes)
  vi.stubGlobal('fetch', crossing.fetch)

  const device = await bootDevice()
  const setup = await device.sync.useSyncStore.getState().setupSync(SYNC_CODE)
  expect(setup).toMatchObject({ ok: true })
  device.expense.useExpenseStore.getState().addExpense({ itemName: 'invented kopi', amount: 1.5 })
  crossing.arm()
  const result = await device.sync.useSyncStore.getState().triggerSync()
  return { r, rest, pushes, result, device }
}

describe('006 and the released engine: the forced fourth push meets a marker', () => {
  it('on 004 alone the forced write lands over the marker (the hole 006 closes)', async () => {
    const { r, pushes, result } = await scenario(false)
    expect(pushes.map((p) => p.force)).toEqual([false, false, false, true])
    expect(pushes.slice(0, 3).map((p) => p.answer)).toEqual(
      Array(3).fill(expect.objectContaining({ ok: false, reason: 'conflict' })),
    )
    expect(pushes[3]?.answer).toMatchObject({ ok: true })
    expect(result).toMatchObject({ ok: true })
    expect(await rowPayload(r)).not.toMatchObject({ expenses: 'moved' })
  })

  it('on 004 + 006 the forced write is a conflict; the engine pulls, finds the marker, fences and writes nothing more', async () => {
    const { r, rest, pushes, result, device } = await scenario(true)
    expect(pushes.map((p) => p.force)).toEqual([false, false, false, true])
    expect(pushes[3]?.answer).toMatchObject({ ok: false, reason: 'conflict' })
    expect(result).toMatchObject({ ok: false, error: 'moved-private' })
    expect(await rowPayload(r)).toEqual(MARKER)
    // after the refused forced push: one pull, and no write of any kind
    const fns = rest.log.map((x) => x.fn)
    const forced = fns.lastIndexOf('st_sync_push')
    expect(fns.slice(forced + 1)).toEqual(['st_sync_pull'])
    expect(device.storage.getItem('st5:sync')).toContain('fenced')
    // the next cycle asks the relay nothing
    const before = rest.log.length
    expect(await device.sync.useSyncStore.getState().triggerSync()).toMatchObject({
      ok: false,
      error: 'moved-private',
    })
    expect(rest.log.length).toBe(before)
    expect(await rowPayload(r)).toEqual(MARKER)
  })
})
