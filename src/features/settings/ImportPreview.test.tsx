import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ImportPreview } from './ImportPreview'
import {
  useExpenseStore,
  type ImportOutcome,
  type ImportPreview as Preview,
  type UndoOutcome,
} from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'

// Invented data. A render test: the preview and the store's actions are stand-ins (P2-14).
const PREVIEW: Preview = {
  fileName: 'spendtrack-backup-2026-10-12.json',
  counts: {
    inFile: 641,
    added: 12,
    restored: 3,
    updated: 1,
    alreadyHere: 625,
    unreadable: 2,
    deletedInFile: 0,
  },
  replaceDeletes: 7,
}
const OUTCOME: ImportOutcome = {
  applied: 16,
  skipped: 0,
  added: 12,
  restored: 3,
  updated: 1,
  removed: 0,
}

const initialExpense = useExpenseStore.getState()
const initialUI = useUIStore.getState()

let applyImport: ReturnType<
  typeof vi.fn<(p: Preview, mode: 'restore' | 'replace') => ImportOutcome>
>
let consumeUndo: ReturnType<typeof vi.fn<(id: string) => UndoOutcome | null>>
let onClose: ReturnType<typeof vi.fn<() => void>>
let onDownload: ReturnType<typeof vi.fn<() => void>>

function show(preview: Preview = PREVIEW) {
  applyImport = vi.fn(() => {
    useExpenseStore.setState({
      undoStack: [{ id: 'imp-r7', label: 'Import', expiresAt: Date.now() + 30_000 }],
    })
    return OUTCOME
  })
  consumeUndo = vi.fn(() => ({ applied: 16, skipped: 0 }))
  onClose = vi.fn()
  onDownload = vi.fn()
  useExpenseStore.setState({ undoStack: [], applyImport, consumeUndo })
  render(<ImportPreview preview={preview} onClose={onClose} onDownloadBackup={onDownload} />)
  return screen.getByRole('region', { name: 'Import spendtrack-backup-2026-10-12.json?' })
}

const toasts = () => useUIStore.getState().toasts

beforeEach(() => {
  useUIStore.setState({ toasts: [] })
})
afterEach(() => {
  cleanup()
  useExpenseStore.setState(initialExpense, true)
  useUIStore.setState(initialUI, true)
})

describe('ImportPreview', () => {
  it('shows the exact counts and the promise, with Restore focused', () => {
    const region = show()
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      // every row of the file is in one line below, the 2 unreadable ones included
      '643 in the file',
      '12 new',
      '3 restored (they were deleted)',
      '1 updated',
      '625 already here',
      "2 can't be read",
    ])
    expect(region).toHaveAccessibleDescription(
      'Nothing on this device or your other devices will be removed.',
    )
    expect(screen.getByRole('button', { name: 'Restore' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Replace instead…' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('Restore applies once on a double click, toasts the outcome with a 30 s Undo, and closes', async () => {
    const user = userEvent.setup()
    show()
    await user.dblClick(screen.getByRole('button', { name: 'Restore' }))
    expect(applyImport).toHaveBeenCalledTimes(1)
    expect(applyImport).toHaveBeenCalledWith(PREVIEW, 'restore')
    expect(onClose).toHaveBeenCalledTimes(1)
    const [toast] = toasts()
    expect(toast?.message).toBe('Imported · 12 added, 3 restored, 1 updated')
    expect(toast?.duration).toBe(30_000)
    expect(toast?.action?.label).toBe('Undo')
    act(() => {
      toast?.action?.onClick()
    })
    expect(consumeUndo).toHaveBeenCalledWith('imp-r7')
    expect(toasts().at(-1)?.message).toBe('Undone')
  })

  it('a partly skipped Undo says how many entries changed on another device', () => {
    show()
    consumeUndo.mockReturnValue({ applied: 15, skipped: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }), { detail: 1 })
    act(() => {
      toasts()[0]?.action?.onClick()
    })
    expect(toasts().at(-1)?.message).toBe('Undone, except 1 entry changed on another device')
    expect(toasts().at(-1)?.kind).toBe('warning')
  })

  it('lists only the counts that are not zero after the file total', () => {
    const region = show({
      ...PREVIEW,
      counts: { ...PREVIEW.counts, restored: 0, updated: 0, unreadable: 0, deletedInFile: 4 },
    })
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['641 in the file', '12 new', '625 already here', '4 marked deleted in the file'])
  })

  it('sets the figures in mono and the words in the body font, with grouped thousands', () => {
    const region = show({
      ...PREVIEW,
      counts: { ...PREVIEW.counts, added: 5000, alreadyHere: 0, restored: 0, updated: 0 },
    })
    const [first] = within(region).getAllByRole('listitem')
    expect(first?.textContent).toBe(`${(5002).toLocaleString()} in the file`)
    const figure = within(first ?? region).getByText((5002).toLocaleString())
    expect(figure).toHaveClass('font-mono', 'tabular-nums')
    expect(within(first ?? region).getByText('in the file')).not.toHaveClass('font-mono')
  })

  it('names what was added and restored, and updated only when anything was', () => {
    show()
    applyImport.mockReturnValue({ ...OUTCOME, updated: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(toasts()[0]?.message).toBe('Imported · 12 added, 3 restored')
  })

  it('applies what the store plans now, not the counts it showed (a stale preview)', () => {
    show()
    // Meanwhile another device's sync brought most of the file in: the store plans again.
    applyImport.mockReturnValue({ ...OUTCOME, applied: 1, added: 1, restored: 0, updated: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(applyImport).toHaveBeenCalledWith(PREVIEW, 'restore')
    // the parts that did not happen are left out
    expect(toasts()[0]?.message).toBe('Imported · 1 added')
  })

  it('a restore that changes nothing says so, with no Undo', () => {
    show()
    applyImport.mockReturnValue({ ...OUTCOME, applied: 0, added: 0, restored: 0, updated: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]?.message).toBe('Nothing to import: everything in the file is already here')
    expect(toasts()[0]?.action).toBeUndefined()
  })

  it('Replace instead… asks for REPLACE, says what it deletes, then replaces once', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'Replace instead…' }))
    const group = screen.getByRole('group', { name: /^Replace everything/ })
    expect(group).toHaveAccessibleDescription(
      "Replace deletes the 7 entries that aren't in this file, on every linked device.",
    )
    // The Restore promise no longer holds: it is not shown with the Replace question.
    expect(
      screen.queryByText('Nothing on this device or your other devices will be removed.'),
    ).toBeNull()
    const field = within(group).getByRole('textbox', { name: 'Type REPLACE to confirm' })
    expect(field).toHaveFocus()
    const confirm = within(group).getByRole('button', { name: 'Replace' })
    expect(confirm).toBeDisabled()
    await user.type(field, 'REPLACE{Enter}')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(applyImport).toHaveBeenCalledTimes(1)
    expect(applyImport).toHaveBeenCalledWith(PREVIEW, 'replace')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(toasts()[0]?.action?.label).toBe('Undo')
  })

  // It used to say "Imported · 0 added, 4 restored" after deleting 57 entries everywhere.
  it('a Replace names what it removed first', async () => {
    const user = userEvent.setup()
    show()
    applyImport.mockReturnValue({ ...OUTCOME, added: 0, restored: 4, updated: 0, removed: 57 })
    await user.click(screen.getByRole('button', { name: 'Replace instead…' }))
    await user.type(screen.getByRole('textbox', { name: 'Type REPLACE to confirm' }), 'REPLACE')
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(toasts()[0]?.message).toBe('Replaced · 57 removed, 4 restored')
  })

  it('backing out of Replace returns to the preview with focus on "Replace instead…"', async () => {
    const user = userEvent.setup()
    show()
    await user.click(screen.getByRole('button', { name: 'Replace instead…' }))
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Replace instead…' })).toHaveFocus()
    expect(applyImport).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('Cancel and Escape close it without importing', async () => {
    const user = userEvent.setup()
    show()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(applyImport).not.toHaveBeenCalled()
  })

  it('a refused snapshot imports nothing and offers the backup download', async () => {
    const user = userEvent.setup()
    show()
    applyImport.mockImplementation(() => {
      throw new Error("There's no room to keep a safety copy, so nothing was imported.")
    })
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
    const refused = screen.getByRole('group', { name: 'Download a backup, then try again' })
    expect(refused).toHaveAccessibleDescription(
      "There's no room to keep a safety copy, so nothing was imported.",
    )
    const get = within(refused).getByRole('button', { name: 'Download backup' })
    expect(get).toHaveFocus()
    await user.click(get)
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('names a replace that deletes nothing for what it does', async () => {
    const user = userEvent.setup()
    show({ ...PREVIEW, replaceDeletes: 0 })
    await user.click(screen.getByRole('button', { name: 'Replace instead…' }))
    expect(screen.getByRole('group', { name: /^Replace everything/ })).toHaveAccessibleDescription(
      /nothing is deleted/,
    )
  })
})

// PR-4: a snapshot kept on this device previews the same way, as a restore only (Recovery).
describe('ImportPreview of a snapshot', () => {
  const SNAP: Preview = {
    fileName: 'snapshot-s1',
    counts: {
      inFile: 12,
      added: 0,
      restored: 12,
      updated: 0,
      alreadyHere: 0,
      unreadable: 0,
      deletedInFile: 0,
    },
    replaceDeletes: 12,
  }

  function showSnapshot(
    preview: Preview = SNAP,
    skips?: { readonly back: number; readonly deletedSince: number },
  ) {
    applyImport = vi.fn(() => {
      useExpenseStore.setState({
        undoStack: [{ id: 'imp-s1', label: 'Import', expiresAt: Date.now() + 30_000 }],
      })
      return { applied: 12, skipped: 0, added: 0, restored: 12, updated: 0, removed: 0 }
    })
    consumeUndo = vi.fn(() => ({ applied: 12, skipped: 0 }))
    onClose = vi.fn()
    onDownload = vi.fn()
    useExpenseStore.setState({ undoStack: [], applyImport, consumeUndo })
    render(
      <ImportPreview
        preview={preview}
        source={{ kind: 'snapshot', skips }}
        onClose={onClose}
        onDownloadBackup={onDownload}
      />,
    )
    return screen.getByRole('region', { name: 'Restore from this copy?' })
  }

  it('says what the copy holds and that nothing here changes; Restore only, never Replace', () => {
    const region = showSnapshot()
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['12 in the copy', '12 restored (they were deleted)'])
    expect(region).toHaveAccessibleDescription('Nothing here is removed or changed.')
    expect(screen.getByRole('button', { name: 'Restore' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('Restore restores (never replaces), with a 30 s Undo, and closes', async () => {
    const user = userEvent.setup()
    showSnapshot()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(applyImport).toHaveBeenCalledExactlyOnceWith(SNAP, 'restore')
    expect(onClose).toHaveBeenCalledTimes(1)
    const [toast] = toasts()
    expect(toast).toMatchObject({
      kind: 'success',
      message: 'Restored 12 entries',
      duration: 30_000,
    })
    act(() => {
      toast?.action?.onClick()
    })
    expect(consumeUndo).toHaveBeenCalledWith('imp-s1')
  })

  it('a copy whose entries are all here already says so, with no Undo', () => {
    showSnapshot()
    applyImport.mockReturnValue({
      applied: 0,
      skipped: 0,
      added: 0,
      restored: 0,
      updated: 0,
      removed: 0,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]?.message).toBe('Nothing to restore: everything in the copy is already here')
    expect(toasts()[0]?.action).toBeUndefined()
  })

  it('counts what restored before is left alone: back already, or deleted again since', () => {
    const region = showSnapshot(
      { ...SNAP, counts: { ...SNAP.counts, inFile: 0, restored: 0 } },
      { back: 29, deletedSince: 1 },
    )
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['30 in the copy', '29 already here', '1 deleted again since (they stay deleted)'])
    applyImport.mockReturnValue({
      applied: 0,
      skipped: 0,
      added: 0,
      restored: 0,
      updated: 0,
      removed: 0,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }), { detail: 1 })
    expect(toasts()[0]?.message).toBe(
      'Nothing to restore: the rest of the copy is here already or was deleted again since',
    )
  })

  it("names deleted entries in the copy as the copy's", () => {
    const region = showSnapshot({
      ...SNAP,
      counts: { ...SNAP.counts, inFile: 13, deletedInFile: 1 },
    })
    expect(within(region).getByText('marked deleted in the copy')).toBeInTheDocument()
  })
})

describe('ImportPreview without Replace (a first run)', () => {
  it('replace={false}: Restore and Cancel only', () => {
    applyImport = vi.fn(() => OUTCOME)
    useExpenseStore.setState({ undoStack: [], applyImport })
    render(
      <ImportPreview
        preview={PREVIEW}
        replace={false}
        onClose={vi.fn()}
        onDownloadBackup={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Restore' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: /Replace/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })
})
