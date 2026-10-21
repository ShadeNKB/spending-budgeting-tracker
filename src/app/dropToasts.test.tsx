import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { OverlaySlot } from './OverlaySlot'
import { dropToasts } from './dropToasts'
import { useUIStore } from '../stores/useUIStore'

// A toast host that crashes on one particular toast, the way a render bug in a single toast
// would. Every other toast renders.
function FlakyToastHost() {
  const toasts = useUIStore((s) => s.toasts)
  if (toasts.some((t) => t.message === 'boom')) throw new Error('toast render failed')
  return (
    <ul>
      {toasts.map((t) => (
        <li key={t.id}>{t.message}</li>
      ))}
    </ul>
  )
}

// AppShell's wiring: the host mounts with the first toast and drops the queue when it fails.
function ToastSlot() {
  const hasToasts = useUIStore((s) => s.toasts.length > 0)
  return (
    <OverlaySlot open={hasToasts} onFail={dropToasts}>
      <FlakyToastHost />
    </OverlaySlot>
  )
}

const push = (message: string) => {
  act(() => {
    useUIStore.getState().pushToast({ kind: 'error', message, duration: 12000 })
  })
}

beforeEach(() => {
  useUIStore.setState({ toasts: [] })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('dropToasts', () => {
  it('empties the toast queue', () => {
    useUIStore.getState().pushToast({ kind: 'info', message: 'a' })
    useUIStore.getState().pushToast({ kind: 'info', message: 'b' })
    dropToasts()
    expect(useUIStore.getState().toasts).toEqual([])
  })

  it('after a toast crashed the host, the next toast still shows (storage-full warning)', () => {
    render(<ToastSlot />)
    push('boom')
    expect(useUIStore.getState().toasts).toEqual([])

    push('Storage is full — export a backup and clear old data to keep saving.')
    expect(screen.getByText(/Storage is full/)).toBeInTheDocument()
  })
})
