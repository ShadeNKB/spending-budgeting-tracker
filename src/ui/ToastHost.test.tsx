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
