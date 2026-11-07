import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BootFailure, DataNotices, QUOTA_TOAST } from './DataNotices'
import { LayerAnnouncer } from '../ui/LayerAnnouncer'
import { useExpenseStore } from '../stores/useExpenseStore'
import { useUIStore, type Toast } from '../stores/useUIStore'
import { downloadJSON } from '../lib/download'
import type { UpdateController } from './swUpdate'

// The browser download is the edge of this test: what is handed to it is checked instead.
vi.mock('../lib/download', () => ({ downloadJSON: vi.fn(), downloadCSV: vi.fn() }))

const initialExpense = useExpenseStore.getState()
const initialUI = useUIStore.getState()

// The first hydrate loads the engine chunk, the data core with it. Under a full parallel run on a
// busy machine that load alone ran past the 5 s default, and the timed-out boot then landed in
// the next test. Load it once here, with room (every boot after it is quick), then start from
// the views of a store not yet loaded, as each test does.
beforeAll(async () => {
  await useExpenseStore.getState().hydrate()
  useExpenseStore.setState(initialExpense, true)
}, 60_000)

beforeEach(() => {
  localStorage.clear()
  vi.mocked(downloadJSON).mockClear()
})

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useUIStore.setState(initialUI, true)
  localStorage.clear()
})

const toasts = (): Toast[] => useUIStore.getState().toasts
const strip = (name: string) => screen.getByRole('region', { name })
const noStrip = (name: string) => screen.queryByRole('region', { name })

/** The shell around the notices: its focusable main, and the live regions they speak through. */
function renderNotices() {
  return render(
    <>
      <DataNotices />
      <main id="main" tabIndex={-1} />
      <LayerAnnouncer />
    </>,
  )
}

const said = (role: 'status' | 'alert') => screen.getByRole(role).textContent

const REPORT = { entries: 0, needsAttention: 0, repaired: 0, deduped: 0, revived: 0 }
const FACTS = { persisted: true, lastBackupAt: null, mirror: 'on', nearlyFull: false } as const

/** Render-only: the views a hydrated store would hold (P2-14 lets render tests set them). */
function show(patch: Partial<ReturnType<typeof useExpenseStore.getState>>) {
  act(() => {
    useExpenseStore.setState({
      hydrated: true,
      bootError: null,
      local: 'saved',
      attention: { quarantined: 0, copies: 0, unseen: 0, full: false },
      facts: FACTS,
      report: null,
      demo: 'none',
      ...patch,
    })
  })
}

describe('DataNotices strips', () => {
  it('shows nothing before the data is loaded, or while everything is fine', () => {
    renderNotices()
    expect(screen.queryAllByRole('region')).toEqual([])
    show({})
    expect(screen.queryAllByRole('region')).toEqual([])
    expect(toasts()).toEqual([])
  })

  it('memory-only: blocks with the raw download, and says so assertively', async () => {
    const user = userEvent.setup()
    localStorage.setItem('expenses', '[{"id":"a"')
    renderNotices()
    show({ local: 'memory-only' })
    const memory = strip('Saved data unreadable')
    expect(memory).toHaveTextContent(
      "Your saved data couldn't be read and there's no room to keep a safety copy. Nothing will be overwritten. New entries won't be kept after you close SpendTrack: download your raw data first.",
    )
    // No way to dismiss it while it holds.
    expect(
      within(memory)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Download raw data'])
    expect(said('alert')).toMatch(/^Your saved data couldn't be read/)
    // The failed-save strip does not pile on: memory-only already says nothing is written.
    expect(noStrip('Not saved')).toBeNull()
    expect(noStrip('Storage nearly full')).toBeNull()

    await user.click(within(memory).getByRole('button', { name: 'Download raw data' }))
    const [name, payload] = vi.mocked(downloadJSON).mock.calls[0] ?? []
    expect(name).toMatch(/^spendtrack-backup-raw-\d{4}-\d{2}-\d{2}-\d{4}\.json$/)
    // Byte for byte what is stored, nothing parsed.
    expect(payload).toMatchObject({ keys: { expenses: '[{"id":"a"' } })
    expect(toasts().at(-1)?.message).toMatch(/Check your Downloads\.$/)
  })

  it('a failed save: "Not saved: storage is full", sticky, with a backup download', async () => {
    const user = userEvent.setup()
    // A real engine behind the download (P2-14); the failure itself is set as a view.
    localStorage.setItem(
      'expenses',
      JSON.stringify([
        {
          id: 'k1',
          itemName: 'Kopi',
          amount: 1.8,
          category: 'Food & Dining',
          date: '2026-10-19T12:00:00',
          createdAt: '2026-10-19T12:00:00',
        },
      ]),
    )
    await act(async () => {
      await useExpenseStore.getState().hydrate()
    })
    renderNotices()
    show({ local: 'error-quota', facts: { ...FACTS, nearlyFull: true } })
    const failed = strip('Not saved')
    expect(failed).toHaveTextContent('Not saved: storage is full')
    // Sticky: the download is its only control, nothing dismisses it while it holds.
    expect(
      within(failed)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Download a backup'])
    expect(said('alert')).toBe('Not saved: storage is full')
    // Nearly full is old news once a save failed.
    expect(noStrip('Storage nearly full')).toBeNull()

    await user.click(within(failed).getByRole('button', { name: 'Download a backup' }))
    const [name, file] = vi.mocked(downloadJSON).mock.calls[0] ?? []
    expect(name).toMatch(/^spendtrack-backup-\d{4}-\d{2}-\d{2}\.json$/)
    expect(file).toMatchObject({ spendtrack: 'backup' })
    expect(JSON.stringify(file)).toContain('Kopi')
    expect(toasts().at(-1)).toMatchObject({ kind: 'success', message: 'Backup downloaded' })

    // Saving again (a retry landed) takes it away.
    show({ local: 'saved' })
    expect(noStrip('Not saved')).toBeNull()

    // Leave an empty device behind: a re-boot stops the engine's pending mirror write.
    localStorage.clear()
    await act(async () => {
      await useExpenseStore.getState().hydrate()
    })
  })

  it("leaves a quota failure to the storage layer's toast when that already said it", () => {
    renderNotices()
    act(() => {
      useUIStore.getState().pushToast({ kind: 'error', message: QUOTA_TOAST })
    })
    show({ local: 'error-quota' })
    expect(strip('Not saved')).toHaveTextContent('Not saved: storage is full')
    // One voice: the toast speaks (from the shell's announcer), the strip stays quiet.
    expect(said('alert')).toBe('')
  })

  it('a storage error that is not quota says the browser is blocking it', () => {
    renderNotices()
    show({ local: 'error-storage' })
    expect(strip('Not saved')).toHaveTextContent('Not saved: this browser is blocking storage')
  })

  it('nearly full: a warning with the backup download, said politely', () => {
    renderNotices()
    show({ facts: { ...FACTS, nearlyFull: true } })
    const full = strip('Storage nearly full')
    expect(full).toHaveTextContent('Storage on this device is nearly full')
    expect(within(full).getByRole('button', { name: 'Download a backup' })).toBeInTheDocument()
    expect(said('status')).toBe('Storage on this device is nearly full')
  })

  it('recovered: says how many came back, downloads the damaged data, dismisses', async () => {
    const user = userEvent.setup()
    const quarantineFile = vi.fn(() => ({ kind: 'needs-attention' }))
    const dismissReport = vi.fn(() => {
      useExpenseStore.setState({ report: null })
    })
    renderNotices()
    show({
      report: { ...REPORT, kind: 'recovered', entries: 299, needsAttention: 1 },
      attention: { quarantined: 1, copies: 0, unseen: 1, full: false },
      quarantineFile,
      dismissReport,
    })
    const recovered = strip('Data recovered')
    expect(recovered).toHaveTextContent(
      "We couldn't read part of your saved data. We recovered 299 entries from backup copies.",
    )
    // The strip is the news: no extra "couldn't be read" toast on top.
    expect(toasts()).toEqual([])

    await user.click(within(recovered).getByRole('button', { name: 'Download damaged data' }))
    expect(vi.mocked(downloadJSON)).toHaveBeenCalledWith(
      expect.stringMatching(/^spendtrack-needs-attention-\d{4}-\d{2}-\d{2}\.json$/),
      { kind: 'needs-attention' },
    )

    // Details: Settings › Backup › Recovery, on what needs attention (acceptance 10).
    await user.click(within(recovered).getByRole('button', { name: 'Details' }))
    expect(useUIStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsTab: 'backup',
      settingsFocus: 'recovery-attention',
    })
    expect(dismissReport).not.toHaveBeenCalled()
    act(() => {
      useUIStore.setState({ settingsOpen: false, settingsFocus: null })
    })

    await user.click(within(recovered).getByRole('button', { name: 'Dismiss recovery notice' }))
    expect(dismissReport).toHaveBeenCalledOnce()
    expect(noStrip('Data recovered')).toBeNull()
    // Focus goes to the screen, not to <body> with the strip.
    expect(document.getElementById('main')).toHaveFocus()
    // Dismissing never brings the attention toast back this boot.
    expect(toasts()).toHaveLength(1)
  })

  it('demo: shown only while sample rows exist, and gone after Clear sample data', async () => {
    const user = userEvent.setup()
    const clearSampleData = vi.fn(() => {
      useExpenseStore.setState({ demo: 'none' })
    })
    renderNotices()
    show({ demo: 'sample', clearSampleData })
    const demo = strip('Demo mode')
    expect(demo).toHaveTextContent('Demo mode — sample data loaded.')

    await user.click(within(demo).getByRole('button', { name: 'Clear sample data' }))
    expect(clearSampleData).toHaveBeenCalledOnce()
    expect(noStrip('Demo mode')).toBeNull()
    expect(document.getElementById('main')).toHaveFocus()
    expect(toasts().at(-1)?.message).toBe('Sample data cleared')
  })

  it('gives every strip button a 44 px phone target', () => {
    renderNotices()
    show({
      local: 'memory-only',
      report: { ...REPORT, kind: 'recovered', entries: 3 },
      demo: 'sample',
    })
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveClass('h-11', 'md:h-8')
    }
  })
})

describe('DataNotices boot toasts', () => {
  it('needs attention: one toast per boot, whose Review opens Recovery on Needs attention', () => {
    renderNotices()
    show({ attention: { quarantined: 2, copies: 0, unseen: 2, full: false } })
    expect(toasts()).toHaveLength(1)
    const toast = toasts()[0]
    expect(toast).toMatchObject({ kind: 'info', message: "2 entries couldn't be read" })
    expect(toast?.action?.label).toBe('Review')

    // More arriving later in the same boot (a damaged row from sync) does not nag again.
    show({ attention: { quarantined: 3, copies: 0, unseen: 3, full: false } })
    expect(toasts()).toHaveLength(1)

    act(() => {
      toast?.action?.onClick()
    })
    expect(useUIStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsTab: 'backup',
      settingsFocus: 'recovery-attention',
    })
  })

  it('says one entry in the singular', () => {
    renderNotices()
    show({ attention: { quarantined: 1, copies: 0, unseen: 1, full: false } })
    expect(toasts()[0]?.message).toBe("1 entry couldn't be read")
  })

  it('counts a whole stored copy set aside as no entry', () => {
    renderNotices()
    show({ attention: { quarantined: 1, copies: 1, unseen: 1, full: false } })
    expect(toasts()[0]?.message).toBe('1 damaged copy of your saved data set aside')
  })

  it('counts items, not entries, when copies are among them; thousands with a separator', () => {
    renderNotices()
    show({ attention: { quarantined: 2_001, copies: 1, unseen: 2_001, full: false } })
    expect(toasts()[0]?.message).toBe("2,001 items couldn't be read")
  })

  it('stays quiet about entries already seen', () => {
    renderNotices()
    show({ attention: { quarantined: 4, copies: 0, unseen: 0, full: false } })
    expect(toasts()).toEqual([])
  })

  it('the upgrade report: one toast with what needs attention, then dismissReport()', () => {
    const dismissReport = vi.fn(() => {
      useExpenseStore.setState({ report: null })
    })
    renderNotices()
    show({
      report: { ...REPORT, kind: 'upgraded', entries: 700, needsAttention: 2 },
      attention: { quarantined: 2, copies: 0, unseen: 2, full: false },
      dismissReport,
    })
    expect(dismissReport).toHaveBeenCalledOnce()
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]).toMatchObject({
      kind: 'info',
      message: 'Your data was upgraded: 700 entries · 2 need attention',
    })
    expect(toasts()[0]?.action?.label).toBe('Review')
    act(() => {
      toasts()[0]?.action?.onClick()
    })
    expect(useUIStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsTab: 'backup',
      settingsFocus: 'recovery-attention',
    })
  })

  it('an upgrade with nothing to look at has no Review', () => {
    renderNotices()
    show({
      report: { ...REPORT, kind: 'upgraded', entries: 1, needsAttention: 0, deduped: 1 },
      dismissReport: () => {
        useExpenseStore.setState({ report: null })
      },
    })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]?.message).toBe('Your data was upgraded: 1 entry')
    expect(toasts()[0]?.action).toBeUndefined()
  })

  it('one entry needing attention reads "1 needs attention"', () => {
    renderNotices()
    show({
      report: { ...REPORT, kind: 'upgraded', entries: 12, needsAttention: 1 },
      dismissReport: () => {
        useExpenseStore.setState({ report: null })
      },
    })
    expect(toasts()[0]?.message).toBe('Your data was upgraded: 12 entries · 1 needs attention')
  })
})

describe('BootFailure', () => {
  const controller = () => {
    const reloadToLatest = vi.fn<(go?: () => void) => void>()
    const updates: UpdateController = {
      start: vi.fn(),
      subscribe: () => () => {},
      getSnapshot: () => 'idle',
      apply: vi.fn(),
      confirmApply: vi.fn(),
      cancelConfirm: vi.fn(),
      dismiss: vi.fn(),
      reloadToLatest,
      checkNow: vi.fn(),
    }
    return { updates, reloadToLatest }
  }

  it('takes focus on its heading, reloads to the latest build, and downloads raw data', async () => {
    const user = userEvent.setup()
    const { updates, reloadToLatest } = controller()
    localStorage.setItem('expenses', '[]')
    render(<BootFailure controller={updates} />)
    const heading = screen.getByRole('heading', { level: 1, name: "SpendTrack couldn't start." })
    expect(heading).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reloadToLatest).toHaveBeenCalledOnce()

    const download = screen.getByRole('button', { name: 'Download my data' })
    expect(download).toHaveAccessibleDescription(
      'Saves a copy of everything stored in this browser, exactly as it is.',
    )
    await user.click(download)
    expect(vi.mocked(downloadJSON)).toHaveBeenCalledOnce()
    expect(screen.getByText(/Check your Downloads\.$/)).toBeInTheDocument()
  })

  it('says so when there is nothing to download', async () => {
    const user = userEvent.setup()
    render(<BootFailure controller={controller().updates} />)
    await user.click(screen.getByRole('button', { name: 'Download my data' }))
    expect(screen.getByText('Nothing is saved in this browser yet.')).toBeInTheDocument()
    expect(vi.mocked(downloadJSON)).not.toHaveBeenCalled()
  })
})
