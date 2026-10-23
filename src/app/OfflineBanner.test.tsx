import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OfflineBanner } from './OfflineBanner'
import { syncMessage, useSyncStore, type SyncFailure } from '../stores/useSyncStore'

const build = vi.hoisted(() => ({ syncEnabled: true }))
vi.mock('../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/syncConfig')>()),
  get syncEnabled() {
    return build.syncEnabled
  },
}))

const initialSync = useSyncStore.getState()

afterEach(() => {
  cleanup()
  useSyncStore.setState(initialSync, true)
  build.syncEnabled = true
})

const SAVED = "You're offline — changes are saved on this device"
const WILL_SYNC = `${SAVED} and will sync when you're back`
const failure = (kind: SyncFailure['kind']): SyncFailure => ({
  kind,
  message: syncMessage(kind, 1228),
  since: 0,
})

describe('OfflineBanner', () => {
  it('promises a sync when this device is linked and will sync by itself', () => {
    useSyncStore.setState({ syncId: 'code', cloudStatus: 'offline', lastError: failure('offline') })
    render(<OfflineBanner />)
    expect(screen.getByText(WILL_SYNC)).toBeInTheDocument()
  })

  it.each([
    ['no sync code', { syncId: null }, true],
    ['a build without a relay', { syncId: 'code' }, false],
    ['sync paused: too large', { syncId: 'code', lastError: failure('too-large') }, true],
    ['sync paused: moved', { syncId: 'code', lastError: failure('moved') }, true],
    ['sync paused: update', { syncId: 'code', lastError: failure('update-required') }, true],
  ])('promises nothing with %s', (_label, state, relay) => {
    build.syncEnabled = relay
    useSyncStore.setState(state)
    render(<OfflineBanner />)
    expect(screen.getByText(SAVED)).toBeInTheDocument()
    expect(screen.queryByText(/will sync/)).toBeNull()
  })
})
