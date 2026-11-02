import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ClearData } from './ClearData'
import { useExpenseStore, type ExpenseView, type UndoOutcome } from '../../stores/useExpenseStore'
import { useSyncStore } from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'

// Invented data. Render tests: the views and the actions are set on the store directly (P2-14).
const view = (id: string): ExpenseView => ({
  id,
  itemName: `Item ${id}`,
  amount: 4.5,
  category: 'Food',
  date: '2026-10-19T12:00:00',
  day: '2026-10-19',
  createdAt: '2026-10-19T04:00:00.000Z',
  ext: {},
})
const CODE = '11111111-1111-4111-8111-111111111111'

const initialExpense = useExpenseStore.getState()
const initialSync = useSyncStore.getState()
const initialUI = useUIStore.getState()

let deleteAll: ReturnType<typeof vi.fn<() => void>>
let removeHere: ReturnType<typeof vi.fn<() => Promise<void>>>
let consumeUndo: ReturnType<typeof vi.fn<(id: string) => UndoOutcome | null>>
let download: ReturnType<typeof vi.fn<() => void>>

function seed(count: number, opts: { sync?: boolean; unsynced?: number } = {}) {
  deleteAll = vi.fn(() => {
    useExpenseStore.setState({
      expenses: [],
      undoStack: [{ id: 'all-r1', label: 'Delete all', expiresAt: Date.now() + 30_000 }],
    })
  })
  removeHere = vi.fn(() => new Promise<void>(() => undefined))
  consumeUndo = vi.fn(() => ({ applied: count, skipped: 0 }))
  download = vi.fn()
  useExpenseStore.setState({
    expenses: Array.from({ length: count }, (_, i) => view(`e${String(i)}`)),
    undoStack: [],
    deleteAllEverywhere: deleteAll,
    removeDataFromThisDevice: removeHere,
    unsyncedChanges: () => opts.unsynced ?? 0,
    consumeUndo,
  })
  useSyncStore.setState({ syncId: opts.sync === true ? CODE : null })
  render(<ClearData onDownloadBackup={download} />)
}

const toasts = () => useUIStore.getState().toasts

beforeEach(() => {
  useUIStore.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useSyncStore.setState(initialSync, true)
  useUIStore.setState(initialUI, true)
})

describe('ClearData without sync', () => {
  it('offers one "Delete all entries" and asks with the exact copy, Cancel focused', async () => {
    const user = userEvent.setup()
    seed(3)
    expect(screen.queryByRole('button', { name: /everywhere/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /this device only/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Delete all entries' }))
    const group = screen.getByRole('group', { name: 'Delete all 3 entries?' })
    expect(group).toHaveAccessibleDescription(
      'A copy is kept on this device, and you can undo for 30 seconds.',
    )
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(deleteAll).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Delete all entries' })).toHaveFocus()
  })

  it('deletes once on a double click, toasts with a 30 s Undo, and focus returns to the trigger', async () => {
    const user = userEvent.setup()
    seed(3)
    await user.click(screen.getByRole('button', { name: 'Delete all entries' }))
    await user.dblClick(screen.getByRole('button', { name: 'Delete all' }))
    expect(deleteAll).toHaveBeenCalledTimes(1)
    const [toast] = toasts()
    expect(toast?.message).toBe('All entries deleted')
    expect(toast?.duration).toBe(30_000)
    expect(toast?.action?.label).toBe('Undo')
    expect(screen.getByRole('button', { name: 'Delete all entries' })).toHaveFocus()

    act(() => {
      toast?.action?.onClick()
    })
    expect(consumeUndo).toHaveBeenCalledWith('all-r1')
    expect(toasts().at(-1)?.message).toBe('Restored 3 entries')
  })

  it('says how many entries changed on another device when the Undo is partly skipped', async () => {
    const user = userEvent.setup()
    seed(3)
    consumeUndo.mockReturnValue({ applied: 2, skipped: 1 })
    await user.click(screen.getByRole('button', { name: 'Delete all entries' }))
    await user.click(screen.getByRole('button', { name: 'Delete all' }))
    act(() => {
      toasts()[0]?.action?.onClick()
    })
    expect(toasts().at(-1)?.message).toBe('Undone, except 1 entry changed on another device')
  })

  it('a refused snapshot deletes nothing and offers the backup download', async () => {
    const user = userEvent.setup()
    seed(3)
    deleteAll.mockImplementation(() => {
      throw new Error("There's no room to keep a safety copy, so nothing was deleted.")
    })
    await user.click(screen.getByRole('button', { name: 'Delete all entries' }))
    await user.click(screen.getByRole('button', { name: 'Delete all' }))
    expect(toasts()).toEqual([])
    const refused = screen.getByRole('group', { name: 'Download a backup, then try again' })
    expect(refused).toHaveAccessibleDescription(
      "There's no room to keep a safety copy, so nothing was deleted.",
    )
    const get = within(refused).getByRole('button', { name: 'Download backup' })
    expect(get).toHaveFocus()
    await user.click(get)
    expect(download).toHaveBeenCalledTimes(1)
    // Back to the trigger, to try again.
    expect(screen.queryByRole('group', { name: 'Download a backup, then try again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete all entries' })).toHaveFocus()
  })

  it('with nothing to delete, the trigger says so and asks nothing', async () => {
    const user = userEvent.setup()
    seed(0)
    const trigger = screen.getByRole('button', { name: 'Delete all entries' })
    expect(trigger).toHaveAttribute('aria-disabled', 'true')
    await user.click(trigger)
    expect(screen.queryByRole('group')).toBeNull()
    expect(deleteAll).not.toHaveBeenCalled()
  })

  it('speaks of one entry in the singular', async () => {
    const user = userEvent.setup()
    seed(1)
    await user.click(screen.getByRole('button', { name: 'Delete all entries' }))
    expect(screen.getByRole('group', { name: 'Delete 1 entry?' })).toBeInTheDocument()
  })
})

describe('ClearData with sync on', () => {
  it('offers "Delete all N entries everywhere" and "Remove SpendTrack from this device only"', () => {
    seed(12, { sync: true })
    expect(screen.queryByRole('button', { name: 'Delete all entries' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete all 12 entries everywhere' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    ).toBeEnabled()
  })

  it('delete everywhere needs DELETE typed, then deletes once with a 30 s Undo', async () => {
    const user = userEvent.setup()
    seed(12, { sync: true })
    await user.click(screen.getByRole('button', { name: 'Delete all 12 entries everywhere' }))
    const group = screen.getByRole('group', {
      name: 'Delete all 12 entries on this device and on your other devices?',
    })
    expect(group).toHaveAccessibleDescription(
      'They go everywhere when your devices next sync. A copy is kept on this device, and you can undo for 30 seconds.',
    )
    const field = within(group).getByRole('textbox', { name: 'Type DELETE to confirm' })
    expect(field).toHaveFocus()
    const confirm = within(group).getByRole('button', { name: 'Delete everywhere' })
    expect(confirm).toBeDisabled()
    await user.type(field, 'DELETE')
    await user.dblClick(confirm)
    expect(deleteAll).toHaveBeenCalledTimes(1)
    expect(toasts()[0]?.message).toBe('All entries deleted')
    expect(toasts()[0]?.duration).toBe(30_000)
    expect(screen.getByRole('button', { name: 'Delete all entries everywhere' })).toHaveFocus()
  })

  it('a held Enter in the DELETE field deletes once', async () => {
    const user = userEvent.setup()
    seed(12, { sync: true })
    await user.click(screen.getByRole('button', { name: 'Delete all 12 entries everywhere' }))
    const field = screen.getByRole('textbox', { name: 'Type DELETE to confirm' })
    fireEvent.change(field, { target: { value: 'DELETE' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter', repeat: true })
    expect(deleteAll).toHaveBeenCalledTimes(1)
  })

  it('Escape in the DELETE field takes the question back to its trigger', async () => {
    const user = userEvent.setup()
    seed(12, { sync: true })
    await user.click(screen.getByRole('button', { name: 'Delete all 12 entries everywhere' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Delete all 12 entries everywhere' })).toHaveFocus()
    expect(deleteAll).not.toHaveBeenCalled()
  })

  // WebKit drops a download that a reload lands on in the same task: the backup is a tap of its
  // own, and the wipe (which reloads) comes with the next one.
  it('remove from this device takes the preselected backup as its own tap first', async () => {
    const user = userEvent.setup()
    seed(12, { sync: true })
    await user.click(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    )
    const group = screen.getByRole('group', { name: 'Remove SpendTrack data from this device?' })
    expect(group).toHaveAccessibleDescription(
      /^Your other devices and the sync copy keep everything\. This device forgets its data and its sync code\./,
    )
    const box = within(group).getByRole('checkbox', { name: 'Download a backup first' })
    expect(box).toBeChecked()
    expect(within(group).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.dblClick(within(group).getByRole('button', { name: 'Download backup' }))
    expect(download).toHaveBeenCalledTimes(1)
    expect(removeHere).not.toHaveBeenCalled()

    const again = screen.getByRole('group', { name: 'Remove SpendTrack data from this device?' })
    expect(again).toHaveTextContent('Backup downloaded.')
    expect(within(again).queryByRole('checkbox')).toBeNull()
    expect(within(again).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.dblClick(within(again).getByRole('button', { name: 'Remove from this device' }))
    expect(removeHere).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(deleteAll).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Removing SpendTrack from this device…')
  })

  it('remove from this device in one tap when the box is cleared (focus stays on the box)', async () => {
    const user = userEvent.setup()
    seed(2, { sync: true })
    await user.click(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    )
    const box = screen.getByRole('checkbox', { name: 'Download a backup first' })
    await user.click(box)
    expect(box).not.toBeChecked()
    expect(box).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Remove from this device' }))
    expect(removeHere).toHaveBeenCalledTimes(1)
    expect(download).not.toHaveBeenCalled()
  })

  it('changes that have not synced yet make the backup the required first step', async () => {
    const user = userEvent.setup()
    seed(4, { sync: true, unsynced: 3 })
    await user.click(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    )
    const group = screen.getByRole('group', { name: 'Remove SpendTrack data from this device?' })
    expect(group).toHaveAccessibleDescription(
      "3 changes on this device haven't synced yet, so only a backup keeps them. This device forgets its data and its sync code.",
    )
    expect(within(group).queryByRole('checkbox')).toBeNull()
    expect(within(group).queryByRole('button', { name: 'Remove from this device' })).toBeNull()
    await user.click(within(group).getByRole('button', { name: 'Download backup' }))
    expect(download).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Remove from this device' }))
    expect(removeHere).toHaveBeenCalledTimes(1)
  })

  it('a backup that cannot download removes nothing and goes back to the trigger', async () => {
    const user = userEvent.setup()
    seed(2, { sync: true })
    download.mockImplementation(() => {
      throw new Error('blocked')
    })
    await user.click(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    )
    await user.click(screen.getByRole('button', { name: 'Download backup' }))
    expect(removeHere).not.toHaveBeenCalled()
    expect(toasts().at(-1)).toMatchObject({
      kind: 'error',
      message: "The backup couldn't download, so nothing was removed. Try again.",
    })
    expect(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    ).toHaveFocus()
  })

  it('a failed removal says so and leaves the device as it was', async () => {
    const user = userEvent.setup()
    seed(2, { sync: true })
    removeHere.mockRejectedValue(new Error('Nothing was removed.'))
    await user.click(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    )
    await user.click(screen.getByRole('checkbox', { name: 'Download a backup first' }))
    await user.click(screen.getByRole('button', { name: 'Remove from this device' }))
    await vi.waitFor(() => {
      expect(toasts().at(-1)?.message).toBe('Nothing was removed.')
    })
    expect(toasts().at(-1)?.kind).toBe('error')
    expect(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    ).toHaveFocus()
  })

  it('Escape on the checkbox takes the question back, not the sheet', async () => {
    const user = userEvent.setup()
    seed(2, { sync: true })
    await user.click(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    )
    screen.getByRole('checkbox', { name: 'Download a backup first' }).focus()
    await user.keyboard('{Escape}')
    expect(
      screen.getByRole('button', { name: 'Remove SpendTrack from this device only' }),
    ).toHaveFocus()
  })
})
