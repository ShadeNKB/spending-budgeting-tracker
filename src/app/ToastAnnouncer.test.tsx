import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ToastAnnouncer } from './ToastAnnouncer'
import { LayerAnnouncer } from '../ui/LayerAnnouncer'
import { useUIStore, type Toast } from '../stores/useUIStore'

function push(toast: Omit<Toast, 'id'>) {
  act(() => {
    useUIStore.getState().pushToast(toast)
  })
}

/** Toasts are announced just after the commit they arrive in. */
function settle() {
  act(() => {
    vi.advanceTimersByTime(150)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useUIStore.setState({ toasts: [] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ToastAnnouncer', () => {
  it('announces a toast in its persistent status region, the same node before and after', () => {
    render(<ToastAnnouncer />)
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()
    expect(status).not.toHaveAttribute('aria-live')

    push({
      kind: 'success',
      message: 'Added "kopi" · S$4.50',
      action: { label: 'Undo', onClick: () => {} },
    })
    settle()
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Added "kopi" · S$4.50. Undo available.')
  })

  it('puts errors in the alert region', () => {
    render(<ToastAnnouncer />)
    push({ kind: 'error', message: 'Storage is full.' })
    settle()
    expect(screen.getByRole('alert')).toHaveTextContent('Storage is full.')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('announces a second identical toast again (the same quick add twice)', () => {
    render(<ToastAnnouncer />)
    const status = screen.getByRole('status')
    const added = {
      kind: 'success',
      message: 'Added "kopi" · S$4.50',
      action: { label: 'Undo', onClick: () => {} },
    } as const
    push(added)
    settle()
    push(added)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(status).toBeEmptyDOMElement()
    settle()
    expect(status).toHaveTextContent('Added "kopi" · S$4.50. Undo available.')
  })

  it('says nothing for news merged into a toast already showing (no new toast)', () => {
    render(<ToastAnnouncer />)
    const status = screen.getByRole('status')
    push({ kind: 'info', message: 'Sync disconnected' })
    settle()
    expect(status).toHaveTextContent('Sync disconnected')
    push({ kind: 'info', message: 'Sync disconnected' })
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(useUIStore.getState().toasts).toHaveLength(1)
    expect(status).toHaveTextContent('Sync disconnected')
  })

  it('speaks inside the open layer, and in the app region once that layer closes', () => {
    const view = render(
      <>
        <ToastAnnouncer />
        <div role="dialog" aria-label="Settings">
          <LayerAnnouncer />
        </div>
      </>,
    )
    const [appStatus, layerStatus] = screen.getAllByRole('status')
    push({ kind: 'success', message: 'Category added' })
    settle()
    expect(layerStatus).toHaveTextContent('Category added')
    expect(appStatus).toBeEmptyDOMElement()

    // Closing: the layer turns inert in the same commit as the toast that closed it.
    act(() => {
      screen.getByRole('dialog').setAttribute('inert', '')
      useUIStore.getState().pushToast({ kind: 'success', message: 'Expense updated' })
    })
    settle()
    expect(appStatus).toHaveTextContent('Expense updated')

    view.rerender(<ToastAnnouncer />)
    push({ kind: 'success', message: 'Deleted' })
    settle()
    expect(appStatus).toHaveTextContent('Deleted')
  })

  it('ignores dismissals', () => {
    render(<ToastAnnouncer />)
    push({ kind: 'info', message: 'One' })
    settle()
    act(() => {
      const first = useUIStore.getState().toasts[0]
      if (first) useUIStore.getState().dismissToast(first.id)
    })
    settle()
    expect(screen.getByRole('status')).toHaveTextContent('One')
  })
})
