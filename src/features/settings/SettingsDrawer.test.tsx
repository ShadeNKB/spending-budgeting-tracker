import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsDrawer } from './SettingsDrawer'
import { syncMessage, useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'

// A build with sync configured; the stores are set directly, so no request is made.
vi.mock('../../services/syncConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/syncConfig')>()),
  syncEnabled: true,
}))

const CODE = '11111111-1111-4111-8111-111111111111'
const NOW = Date.UTC(2026, 9, 19, 8, 0, 0)

const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

afterEach(() => {
  cleanup()
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The drawer open on `tab`, after the sheet's opening focus has run. */
function openOn(tab: 'sync' | 'backup') {
  useUIStore.setState({ settingsOpen: true, settingsTab: tab })
  render(<SettingsDrawer />)
  act(() => {
    vi.advanceTimersByTime(50)
  })
}

describe('SettingsDrawer focus', () => {
  it("Sync's Export backup lands on the Download JSON backup button, and focus stays there", () => {
    useSyncStore.setState({
      syncId: CODE,
      cloudStatus: 'paused',
      lastError: { kind: 'too-large', message: syncMessage('too-large', 1365), since: NOW },
    })
    openOn('sync')
    const exportButton = screen.getByRole('button', { name: 'Export backup' })
    exportButton.focus()
    fireEvent.click(exportButton)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getByRole('button', { name: /Download JSON backup/ })).toHaveFocus()
    expect(useUIStore.getState().settingsFocus).toBeNull()
  })

  it('opening Backup any other way does not move focus to Download', () => {
    openOn('sync')
    const backupTab = screen.getByRole('button', { name: 'Backup' })
    backupTab.focus()
    fireEvent.click(backupTab)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // The sheet's own opening focus does not run again on a tab switch either.
    expect(backupTab).toHaveFocus()
  })
})
