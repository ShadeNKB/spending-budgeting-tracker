import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ToastHost } from './ToastHost'
import { useUIStore } from '../stores/useUIStore'

function push(message: string, duration?: number) {
  act(() => {
    useUIStore.getState().pushToast({ kind: 'info', message, duration })
  })
}

function messages(): string[] {
  return useUIStore.getState().toasts.map((t) => t.message)
}

beforeEach(() => {
  vi.useFakeTimers()
  useUIStore.setState({ toasts: [] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ToastHost tones', () => {
  const kinds = ['success', 'error', 'warning', 'info'] as const

  // A tone tint as a second background class won or lost by stylesheet order: warning's came
  // after the surface, so amber toasts were 95 % see-through over the screen under them.
  it.each(kinds)('a %s toast has the surface as its one background', (kind) => {
    render(<ToastHost />)
    act(() => {
      useUIStore.getState().pushToast({ kind, message: `A ${kind} toast` })
    })
    const toast = screen.getByText(`A ${kind} toast`).parentElement
    const backgrounds = [...(toast?.classList ?? [])].filter((c) => /^bg-/.test(c))
    expect(backgrounds).toEqual(['bg-surface-1/95'])
  })

  // Neutral grey, as the sync pill and panel show the same states: cyan means a sync in progress.
  it('shows info in neutral grey, not the accent colour', () => {
    render(<ToastHost />)
    push('Sync disconnected')
    const toast = screen.getByText('Sync disconnected').parentElement
    expect(toast).toHaveClass('text-[var(--text-secondary)]')
    expect(toast?.className).not.toMatch(/accent/)
  })
})

describe('ToastHost durations', () => {
  it('dismisses a default toast after 4 s', () => {
    render(<ToastHost />)
    push('Saved')
    act(() => {
      vi.advanceTimersByTime(3999)
    })
    expect(messages()).toEqual(['Saved'])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(messages()).toEqual([])
  })

  it.each([0, -1])('keeps a toast with duration %s until the user closes it', (duration) => {
    render(<ToastHost />)
    push('Storage is full', duration)
    act(() => {
      vi.advanceTimersByTime(10_000)
    })
    expect(messages()).toEqual(['Storage is full'])
    expect(screen.getByText('Storage is full')).toBeInTheDocument()

    act(() => {
      screen.getByRole('button', { name: 'Dismiss' }).click()
    })
    expect(messages()).toEqual([])
  })

  it('shows the countdown bar only on timed toasts', () => {
    const { container } = render(<ToastHost />)
    push('Sticky', 0)
    expect(container.querySelectorAll('.h-\\[2px\\]')).toHaveLength(0)
    push('Timed', 6000)
    expect(container.querySelectorAll('.h-\\[2px\\]')).toHaveLength(1)
  })
})
