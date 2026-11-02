import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { SyncDevices } from './SyncDevices'
import { useSyncStore, type DeviceRow, type SyncView } from '../../stores/useSyncStore'

const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60_000

const row = (over: Partial<DeviceRow>): DeviceRow => ({
  id: 'dev-me',
  // as the engine names them: this release names no device (track spec §8 cut 1)
  name: 'Other device',
  app: __APP_VERSION__,
  mode: 'table',
  me: false,
  seen: NOW - 2 * 60_000,
  rpcSince: 0,
  stale: false,
  older: false,
  legacy: false,
  ...over,
})

const ME = row({ id: 'me', name: 'This device', me: true, seen: NOW })
const PHONE = row({ id: 'phone' })

const view = (over: Partial<SyncView> = {}): SyncView => ({
  codeMasked: '••••-…-a1b2',
  transport: 'table',
  live: 'on',
  devices: [ME, PHONE],
  legacy: { v084At: null, v085At: null, v5preAt: null },
  sizePct: 10,
  allCurrent: true,
  lockdown: null,
  ...over,
})

const initialSync = useSyncStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  useSyncStore.setState(initialSync, true)
  vi.useRealTimers()
})

function show(v: SyncView | null) {
  useSyncStore.setState({ syncId: '11111111-2222-4333-8444-55555555a1b2', view: v })
  return render(<SyncDevices />)
}

const items = () => within(screen.getByRole('list', { name: 'Devices' })).getAllByRole('listitem')

/** The `i`th device row. */
function item(i: number): HTMLElement {
  const el = items()[i]
  if (!el) throw new Error(`no device row ${String(i)}`)
  return el
}

describe('SyncDevices (AC-U4)', () => {
  it('lists every registered device with name, version and last seen, this device first', () => {
    show(view())
    expect(item(0)).toHaveTextContent(`This deviceSpendTrack ${__APP_VERSION__}`)
    expect(item(0)).not.toHaveTextContent('seen')
    expect(item(1)).toHaveTextContent(`Other deviceSpendTrack ${__APP_VERSION__} · seen 2m ago`)
  })

  it('shows a name a later release gave its device as it is', () => {
    show(view({ devices: [ME, row({ id: 'named', name: 'Kitchen tablet' })] }))
    expect(item(1)).toHaveTextContent('Kitchen tablet')
  })

  it('says "update it" for a device on an older SpendTrack', () => {
    show(
      view({ devices: [ME, row({ id: 'old', app: '0.10.0', older: true, seen: NOW - 3 * DAY })] }),
    )
    expect(item(1)).toHaveTextContent('SpendTrack 0.10.0 · seen 3 days ago · update it')
  })

  it('greys a device not seen for 60 days, says for how long, and asks nothing of it', () => {
    show(
      view({
        devices: [
          ME,
          row({ id: 'gone', app: '0.9.2', older: true, stale: true, seen: NOW - 75 * DAY }),
        ],
      }),
    )
    const gone = item(1)
    expect(gone).toHaveTextContent('SpendTrack 0.9.2 · not seen for 75 days')
    expect(gone).not.toHaveTextContent('update it')
    expect(within(gone).getByText('Other device')).toHaveClass('text-[var(--text-tertiary)]')
  })

  it('names a device on a release that never registers by that release, with no unknown time', () => {
    // as the engine builds it from a 0.9.2 writer stamp (`wr.app: '0.8.5'`, its writer version)
    show(
      view({
        devices: [
          ME,
          row({
            id: 'wr',
            name: 'Older SpendTrack (0.9.2)',
            app: '0.9.2',
            legacy: true,
            older: true,
            seen: 0,
          }),
        ],
      }),
    )
    expect(item(1)).toHaveTextContent('Older SpendTrack (0.9.2)SpendTrack 0.9.2 · update it')
  })

  it('says "just now" for a peer whose clock runs ahead', () => {
    show(view({ devices: [ME, row({ id: 'ahead', seen: NOW + 10 * 60_000 })] }))
    expect(item(1)).toHaveTextContent('seen just now')
  })

  it('says when every device runs this SpendTrack, and nothing when one does not', () => {
    const { unmount } = show(view())
    expect(
      screen.getByText(`All your devices run SpendTrack ${__APP_VERSION__}.`),
    ).toBeInTheDocument()
    unmount()
    show(view({ allCurrent: false }))
    expect(screen.queryByText(/All your devices run/)).toBeNull()
  })

  it.each([
    ['on', 'Live updates on.'],
    ['polling', 'Live updates unavailable · syncing on open and every minute.'],
  ] as const)('footnotes live updates %s', (live, text) => {
    show(view({ live }))
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it.each(['off', 'connecting'] as const)('says nothing about live updates while %s', (live) => {
    show(view({ live }))
    expect(screen.queryByText(/Live updates/)).toBeNull()
  })

  it.each(['offline', 'paused'] as const)(
    'says nothing about live updates or what the devices run while %s',
    (cloudStatus) => {
      useSyncStore.setState({ cloudStatus })
      show(view())
      expect(screen.queryByText(/Live updates/)).toBeNull()
      expect(screen.queryByText(/All your devices run/)).toBeNull()
      expect(item(1)).toHaveTextContent('Other device')
    },
  )

  it('names the relay functions and the lockdown readiness only in RPC mode', () => {
    const { unmount } = show(view())
    expect(screen.queryByText(/sync functions/)).toBeNull()
    expect(screen.queryByText(/lockdown/)).toBeNull()
    unmount()
    show(view({ transport: 'rpc', lockdown: { ready: true, reason: null } }))
    // one line for how changes arrive (track spec §8 cut 2)
    expect(
      screen.getByText("Live updates on · using the relay's sync functions."),
    ).toBeInTheDocument()
    expect(screen.getByText('Ready for the database lockdown.')).toBeInTheDocument()
  })

  it('names the relay functions alone while live updates say nothing (offline)', () => {
    useSyncStore.setState({ cloudStatus: 'offline' })
    show(view({ transport: 'rpc' }))
    expect(screen.getByText("Using the relay's sync functions.")).toBeInTheDocument()
  })

  it('says why the database lockdown is not ready yet, in the engine’s words', () => {
    show(
      view({
        transport: 'rpc',
        lockdown: { ready: false, reason: "Other device hasn't synced for 14 days." },
      }),
    )
    expect(
      screen.getByText(
        "Not ready for the database lockdown: Other device hasn't synced for 14 days.",
      ),
    ).toBeInTheDocument()
  })

  it('shows nothing until the engine has published what it knows', () => {
    const { container } = show(null)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the footnotes without a list while no device has registered yet', () => {
    show(view({ devices: [] }))
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('Live updates on.')).toBeInTheDocument()
  })
})
