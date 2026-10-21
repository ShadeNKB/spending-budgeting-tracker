import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ErrorBoundary } from './ErrorBoundary'

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error('panel exploded')
  return <p>panel ok</p>
}

function fallback(error: unknown, reset: () => void) {
  return (
    <div>
      <p>caught: {error instanceof Error ? error.message : 'unknown'}</p>
      <button type="button" onClick={reset}>
        retry
      </button>
    </div>
  )
}

beforeEach(() => {
  // React logs caught render errors; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary resetKey={false} fallback={fallback}>
        <Boom fail={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('panel ok')).toBeInTheDocument()
  })

  it('renders the fallback with the thrown error, leaving siblings alone', () => {
    render(
      <>
        <p>shell</p>
        <ErrorBoundary resetKey={false} fallback={fallback}>
          <Boom fail />
        </ErrorBoundary>
      </>,
    )
    expect(screen.getByText('caught: panel exploded')).toBeInTheDocument()
    expect(screen.getByText('shell')).toBeInTheDocument()
  })

  it('resets when the resetKey changes', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey={true} fallback={fallback}>
        <Boom fail />
      </ErrorBoundary>,
    )
    expect(screen.getByText('caught: panel exploded')).toBeInTheDocument()
    rerender(
      <ErrorBoundary resetKey={false} fallback={fallback}>
        <Boom fail={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('panel ok')).toBeInTheDocument()
  })

  it('stays caught on re-render with the same resetKey', () => {
    const { rerender } = render(
      <ErrorBoundary resetKey={true} fallback={fallback}>
        <Boom fail />
      </ErrorBoundary>,
    )
    rerender(
      <ErrorBoundary resetKey={true} fallback={fallback}>
        <Boom fail={false} />
      </ErrorBoundary>,
    )
    expect(screen.getByText('caught: panel exploded')).toBeInTheDocument()
  })

  it('resets through the reset callback', () => {
    let fail = true
    function Flaky() {
      return <Boom fail={fail} />
    }
    render(
      <ErrorBoundary resetKey={true} fallback={fallback}>
        <Flaky />
      </ErrorBoundary>,
    )
    fail = false
    act(() => {
      screen.getByRole('button', { name: 'retry' }).click()
    })
    expect(screen.getByText('panel ok')).toBeInTheDocument()
  })
})
