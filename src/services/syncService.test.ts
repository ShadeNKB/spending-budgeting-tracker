import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Minimal stand-in for the realtime part of @supabase/supabase-js. It mirrors
// realtime-js 2.x: removeChannel unsubscribes the channel, which reports CLOSED to
// that channel's own subscribe callback — synchronously or on a later microtask.
const fake = vi.hoisted(() => {
  type StatusCallback = (status: string) => void

  class FakeChannel {
    private onStatus: StatusCallback | null = null
    on() {
      return this
    }
    subscribe(callback: StatusCallback) {
      this.onStatus = callback
      return this
    }
    emit(status: string) {
      this.onStatus?.(status)
    }
  }

  const state = {
    created: [] as FakeChannel[],
    removed: [] as FakeChannel[],
    closeSync: false,
  }

  const client = {
    channel: () => {
      const channel = new FakeChannel()
      state.created.push(channel)
      return channel
    },
    removeChannel: async (channel: FakeChannel) => {
      state.removed.push(channel)
      if (!state.closeSync) await Promise.resolve()
      channel.emit('CLOSED')
      return 'ok'
    },
  }

  return { state, client }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fake.client }))

const RECONNECT_DELAY = 2000

function channelAt(index: number) {
  const channel = fake.state.created[index]
  if (!channel) throw new Error(`no channel #${index}`)
  return channel
}

async function subscribe() {
  const { subscribeSync } = await import('./syncService')
  return subscribeSync('sync-code', () => undefined)
}

describe('subscribeSync reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'http://supabase.test')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    fake.state.created.length = 0
    fake.state.removed.length = 0
    fake.state.closeSync = false
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it.each([
    ['on a later microtask', false],
    ['synchronously', true],
  ])(
    're-arms exactly once per drop when the old channel reports CLOSED %s',
    async (_label, closeSync) => {
      fake.state.closeSync = closeSync
      const unsubscribe = await subscribe()
      const first = channelAt(0)
      first.emit('SUBSCRIBED')
      first.emit('CHANNEL_ERROR')

      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)

      expect(fake.state.created).toHaveLength(2)
      expect(fake.state.removed).toEqual([first])

      unsubscribe()
      await vi.advanceTimersByTimeAsync(5 * RECONNECT_DELAY)
      expect(fake.state.created).toHaveLength(2)
      expect(fake.state.removed).toEqual([first, channelAt(1)])
    },
  )

  it('still reconnects when the replacement channel drops later', async () => {
    const unsubscribe = await subscribe()
    channelAt(0).emit('TIMED_OUT')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(fake.state.created).toHaveLength(2)

    channelAt(1).emit('CLOSED')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY)
    expect(fake.state.created).toHaveLength(3)

    unsubscribe()
  })

  it('cancels a pending reconnect on unsubscribe', async () => {
    const unsubscribe = await subscribe()
    channelAt(0).emit('CHANNEL_ERROR')
    unsubscribe()

    await vi.advanceTimersByTimeAsync(5 * RECONNECT_DELAY)
    expect(fake.state.created).toHaveLength(1)
    expect(fake.state.removed).toEqual([channelAt(0)])
  })
})
