import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { JoinSync } from './JoinSync'
import { loadSyncEngine } from '../../stores/useSyncStore'
import { previewJoin, type JoinPreview } from '../../stores/syncEngine'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'

// The engine is stubbed: the panel only ever reaches it through loadSyncEngine(), which here
// hands over the stubbed module.
vi.mock('../../stores/syncEngine', () => ({ previewJoin: vi.fn() }))
vi.mock('../../stores/useSyncStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/useSyncStore')>()),
  loadSyncEngine: vi.fn(() => import('../../stores/syncEngine')),
}))

const CODE = '11111111-2222-4333-8444-55555555a1b2'
const FOUND: JoinPreview = {
  kind: 'found',
  here: 12,
  synced: 641,
  after: 653,
  removed: 0,
  unreadable: 0,
}

const initialExpenses = useExpenseStore.getState()
const initialUI = useUIStore.getState()

function stubEngine(result: JoinPreview | Promise<JoinPreview> = FOUND) {
  vi.mocked(previewJoin).mockImplementation(() => Promise.resolve(result))
}

beforeEach(() => {
  stubEngine()
})

afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpenses, true)
  useUIStore.setState(initialUI, true)
  vi.mocked(loadSyncEngine).mockClear()
  vi.mocked(previewJoin).mockReset()
  vi.restoreAllMocks()
})

const field = () => screen.getByLabelText('Sync code')
const joinButton = () => screen.getByRole('button', { name: /^(Join|Checking…|Joining…)$/ })
const message = () => document.getElementById(field().getAttribute('aria-describedby') ?? '')

function type(value: string) {
  fireEvent.change(field(), { target: { value } })
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function join(value: string, onJoin = vi.fn()) {
  render(<JoinSync busy={false} joining={false} onJoin={onJoin} onActiveChange={vi.fn()} />)
  type(value)
  fireEvent.click(joinButton())
  await settle()
  return onJoin
}

describe('JoinSync: validation before any network call (AC-U3)', () => {
  it('AC-U3: an invalid code says so under the field and never loads the engine', async () => {
    await join('not a code')
    expect(message()).toHaveTextContent(
      "That code isn't valid. Paste the full code from your other device.",
    )
    expect(field()).toHaveAttribute('aria-invalid', 'true')
    expect(loadSyncEngine).not.toHaveBeenCalled()
  })

  it('AC-U3: a private ST5 code asks for an update and never loads the engine', async () => {
    await join('ST5-ABCD-EFGH-JKMN-PQRS')
    expect(message()).toHaveTextContent(
      "That's a private sync code. Update SpendTrack on this device to use it.",
    )
    expect(loadSyncEngine).not.toHaveBeenCalled()
  })

  it('the message lives in a polite live region that describes the field', async () => {
    await join('nope')
    expect(message()).toHaveAttribute('role', 'status')
  })

  it('normalises a pasted code (spaces, capitals) before previewing it', async () => {
    await join(`  ${CODE.toUpperCase()} `)
    expect(previewJoin).toHaveBeenCalledWith(CODE)
  })

  it('offline: says so at once, without loading the engine', async () => {
    vi.spyOn(Navigator.prototype, 'onLine', 'get').mockReturnValue(false)
    await join(CODE)
    expect(message()).toHaveTextContent("You're offline. Join when you're back online.")
    expect(loadSyncEngine).not.toHaveBeenCalled()
  })

  it('Join is disabled until something is typed', () => {
    render(<JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={vi.fn()} />)
    expect(joinButton()).toBeDisabled()
  })
})

describe('JoinSync: the preview (AC-E21 counts, AC-U3)', () => {
  it('AC-U3: shows the exact counts and promises nothing is removed', async () => {
    await join(CODE)
    const group = screen.getByRole('group', { name: 'Join this sync?' })
    expect(group).toHaveAccessibleDescription(
      'This device: 12 entries · Synced: 641 entries · After joining: about 653 entries. Nothing here is removed.',
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('says how many entries the join removes, and that a copy stays here', async () => {
    stubEngine({ kind: 'found', here: 1234, synced: 2, after: 1236, removed: 3, unreadable: 0 })
    await join(CODE)
    expect(screen.getByRole('group', { name: 'Join this sync?' })).toHaveAccessibleDescription(
      'This device: 1,234 entries · Synced: 2 entries · After joining: about 1,236 entries. 3 entries here were deleted on your other devices and go when you join; a copy is kept on this device.',
    )
  })

  it('speaks of one entry in the singular, and sets unreadable ones aside', async () => {
    stubEngine({ kind: 'found', here: 1, synced: 1, after: 1, removed: 1, unreadable: 1 })
    await join(CODE)
    expect(screen.getByRole('group', { name: 'Join this sync?' })).toHaveAccessibleDescription(
      "This device: 1 entry · Synced: 1 entry · After joining: about 1 entry. 1 entry here was deleted on your other devices and goes when you join; a copy is kept on this device. 1 synced entry can't be read; it's set aside, not merged.",
    )
  })

  it('a join that removes entries here asks in the danger colour, its button naming the loss', async () => {
    stubEngine({ kind: 'found', here: 60, synced: 0, after: 0, removed: 60, unreadable: 0 })
    await join(CODE)
    const group = screen.getByRole('group', { name: 'Join this sync?' })
    expect(group).toHaveClass('border-negative/30')
    expect(within(group).queryByRole('button', { name: 'Join' })).toBeNull()
    expect(within(group).getByRole('button', { name: 'Join and remove 60' })).toHaveClass(
      'bg-negative-solid',
    )
  })

  it('a join that removes nothing keeps the plain question and its Join', async () => {
    await join(CODE)
    const group = screen.getByRole('group', { name: 'Join this sync?' })
    expect(group).toHaveClass('border-warning/30')
    expect(within(group).getByRole('button', { name: 'Join' })).toBeInTheDocument()
  })

  it('counts an empty device and an empty synced copy as found, never "not found"', async () => {
    stubEngine({ kind: 'found', here: 0, synced: 0, after: 0, removed: 0, unreadable: 2 })
    await join(CODE)
    expect(screen.getByRole('group', { name: 'Join this sync?' })).toHaveAccessibleDescription(
      "This device: 0 entries · Synced: 0 entries · After joining: about 0 entries. Nothing here is removed. 2 synced entries can't be read; they're set aside, not merged.",
    )
  })

  it('Join merges: it hands the code on once, and focus waits on Join meanwhile', async () => {
    const onJoin = await join(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(onJoin).toHaveBeenCalledTimes(1)
    expect(onJoin).toHaveBeenCalledWith(CODE)
    expect(joinButton()).toHaveFocus()
  })

  it('Cancel changes nothing: no join, the code stays, focus back on Join', async () => {
    const onJoin = await join(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onJoin).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Join this sync?' })).toBeNull()
    expect(field()).toHaveValue(CODE)
    expect(joinButton()).toHaveFocus()
  })

  it('Escape backs out of the preview like Cancel', async () => {
    const onJoin = await join(CODE)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(onJoin).not.toHaveBeenCalled()
    expect(joinButton()).toHaveFocus()
  })

  it.each([
    [{ kind: 'not-found' }, 'No synced data found for this code. Check it on your other device.'],
    [
      { kind: 'newer' },
      'This sync was moved by a newer SpendTrack. Reload SpendTrack to update, then join.',
    ],
    [
      { kind: 'unreadable' },
      "The synced copy can't be read. Join from a device that synced it before.",
    ],
    [
      {
        kind: 'failed',
        result: { ok: false, error: 'offline', message: "You're offline." },
      },
      "You're offline. Join when you're back online.",
    ],
    [
      {
        kind: 'failed',
        result: { ok: false, error: 'network', message: "Couldn't reach the sync server." },
      },
      "Couldn't reach the sync server.",
    ],
  ] as const)(
    'AC-U3: %j shows its message under the field and joins nothing',
    async (preview, text) => {
      stubEngine(preview)
      const onJoin = await join(CODE)
      expect(message()).toHaveTextContent(text)
      expect(screen.queryByRole('group', { name: 'Join this sync?' })).toBeNull()
      expect(onJoin).not.toHaveBeenCalled()
      expect(joinButton()).toHaveFocus()
    },
  )

  it('says how to recover when the sync code of the page did not load', async () => {
    vi.mocked(loadSyncEngine).mockImplementationOnce(() => Promise.reject(new Error('chunk')))
    await join(CODE)
    expect(message()).toHaveTextContent(/Reload SpendTrack/)
  })

  it('clears an old message once the code changes', async () => {
    await join('nope')
    type(CODE)
    expect(message()).toHaveTextContent('')
    expect(field()).not.toHaveAttribute('aria-invalid')
  })
})

describe('JoinSync: one request per intent', () => {
  it('a double tap on Join makes one preview request, and says Checking… meanwhile', async () => {
    let resolve: (p: JoinPreview) => void = () => undefined
    stubEngine(
      new Promise<JoinPreview>((r) => {
        resolve = r
      }),
    )
    render(<JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={vi.fn()} />)
    type(CODE)
    fireEvent.click(joinButton())
    await settle()
    expect(joinButton()).toHaveTextContent('Checking…')
    expect(joinButton()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(joinButton())
    await settle()
    expect(previewJoin).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve(FOUND)
      await Promise.resolve()
    })
    expect(screen.getByRole('group', { name: 'Join this sync?' })).toBeInTheDocument()
  })

  it('two presses before the screen catches up still make one preview request', async () => {
    render(<JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={vi.fn()} />)
    type(CODE)
    const button = joinButton()
    act(() => {
      button.click()
      button.click()
    })
    await settle()
    expect(previewJoin).toHaveBeenCalledTimes(1)
  })

  it('offline after the demo question: the question goes, the reason shows', async () => {
    useExpenseStore.setState({ demo: 'sample', clearSampleData: vi.fn() })
    vi.spyOn(Navigator.prototype, 'onLine', 'get').mockReturnValue(false)
    await join(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on this device' }))
    await settle()
    expect(screen.queryByRole('group', { name: 'Remove the sample data first?' })).toBeNull()
    expect(message()).toHaveTextContent("You're offline. Join when you're back online.")
    expect(joinButton()).toHaveFocus()
  })

  it('a held Enter in the field makes one preview request', async () => {
    render(<JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={vi.fn()} />)
    type(CODE)
    fireEvent.keyDown(field(), { key: 'Enter' })
    fireEvent.keyDown(field(), { key: 'Enter', repeat: true })
    fireEvent.keyDown(field(), { key: 'Enter', repeat: true })
    await settle()
    expect(previewJoin).toHaveBeenCalledTimes(1)
  })

  it('Enter never lets its own activation through (preventDefault)', () => {
    render(<JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={vi.fn()} />)
    type(CODE)
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    field().dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does nothing while the panel is setting up (busy)', async () => {
    render(<JoinSync busy joining onJoin={vi.fn()} onActiveChange={vi.fn()} />)
    type(CODE)
    expect(joinButton()).toHaveAttribute('aria-disabled', 'true')
    expect(joinButton()).toHaveTextContent('Joining…')
    fireEvent.click(joinButton())
    await settle()
    expect(loadSyncEngine).not.toHaveBeenCalled()
  })

  it('tells the panel while it checks or asks, and when it is back at its field', async () => {
    let resolve: (p: JoinPreview) => void = () => undefined
    stubEngine(
      new Promise<JoinPreview>((r) => {
        resolve = r
      }),
    )
    const onActiveChange = vi.fn()
    render(
      <JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={onActiveChange} />,
    )
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
    type(CODE)
    fireEvent.click(joinButton())
    await settle()
    expect(onActiveChange).toHaveBeenLastCalledWith(true) // checking
    await act(async () => {
      resolve(FOUND)
      await Promise.resolve()
    })
    expect(onActiveChange).toHaveBeenLastCalledWith(true) // asking
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('reports nothing once the panel is gone', async () => {
    let resolve: (p: JoinPreview) => void = () => undefined
    stubEngine(
      new Promise<JoinPreview>((r) => {
        resolve = r
      }),
    )
    const { unmount } = render(
      <JoinSync busy={false} joining={false} onJoin={vi.fn()} onActiveChange={vi.fn()} />,
    )
    type(CODE)
    fireEvent.click(joinButton())
    await settle()
    unmount()
    await act(async () => {
      resolve({ kind: 'not-found' })
      await Promise.resolve()
    })
    expect(useUIStore.getState().toasts).toEqual([])
  })
})

describe("JoinSync: the demo's sample data comes first (F-027)", () => {
  const QUESTION = 'Remove the sample data first?'

  function withSample() {
    const clearSampleData = vi.fn(() => {
      useExpenseStore.setState({ demo: 'none' })
    })
    useExpenseStore.setState({ demo: 'sample', clearSampleData })
    return clearSampleData
  }

  it('asks before previewing, with the safe answer focused', async () => {
    withSample()
    await join(CODE)
    expect(screen.getByRole('group', { name: QUESTION })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep it on this device' })).toHaveFocus()
    expect(loadSyncEngine).not.toHaveBeenCalled()
  })

  it('Keep it on this device previews with the sample rows kept', async () => {
    const clearSampleData = withSample()
    await join(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Keep it on this device' }))
    await settle()
    expect(clearSampleData).not.toHaveBeenCalled()
    expect(previewJoin).toHaveBeenCalledWith(CODE)
    expect(screen.getByRole('group', { name: 'Join this sync?' })).toBeInTheDocument()
  })

  it('Remove and connect removes the sample rows, then previews', async () => {
    const clearSampleData = withSample()
    await join(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Remove and connect' }))
    await settle()
    expect(clearSampleData).toHaveBeenCalledTimes(1)
    expect(previewJoin).toHaveBeenCalledTimes(1)
  })

  it('Escape backs out: nothing removed, nothing previewed, focus back on Join', async () => {
    const clearSampleData = withSample()
    await join(CODE)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Keep it on this device' }), {
      key: 'Escape',
    })
    expect(screen.queryByRole('group', { name: QUESTION })).toBeNull()
    expect(clearSampleData).not.toHaveBeenCalled()
    expect(loadSyncEngine).not.toHaveBeenCalled()
    expect(joinButton()).toHaveFocus()
  })

  it('a removal that fails says so and previews nothing', async () => {
    useExpenseStore.setState({
      demo: 'sample',
      clearSampleData: () => {
        throw new Error('SpendTrack is still loading your data.')
      },
    })
    await join(CODE)
    fireEvent.click(screen.getByRole('button', { name: 'Remove and connect' }))
    await settle()
    expect(loadSyncEngine).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts.map((t) => t.message)).toEqual([
      'SpendTrack is still loading your data.',
    ])
    expect(joinButton()).toHaveFocus()
  })
})
