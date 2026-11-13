import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

const shell = vi.hoisted(() => ({ error: null as Error | null }))

// The real route tree is the whole app. App's own job is the wiring around it: the page's own
// history, and the boundary that takes a failing shell (nothing above it would).
vi.mock('./app/routes', async () => {
  const { Outlet } = await import('react-router-dom')
  function Shell() {
    if (shell.error) throw shell.error
    return (
      <div>
        <p>SHELL</p>
        <Outlet />
      </div>
    )
  }
  return {
    appRoutes: [
      {
        path: '/',
        element: <Shell />,
        children: [{ path: 'pulse', element: <p>Pulse screen</p> }],
      },
    ],
  }
})

describe('App', () => {
  beforeEach(() => {
    shell.error = null
    window.history.replaceState(null, '', '/pulse')
    // React reports what a boundary caught; the tests read the screen instead.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
  })

  it("renders the routes at the page's own address", () => {
    render(<App />)
    expect(screen.getByText('SHELL')).toBeInTheDocument()
    expect(screen.getByText('Pulse screen')).toBeInTheDocument()
  })

  it('shows the full-page recovery card when the shell itself fails', () => {
    shell.error = new TypeError('shell broke')
    render(<App />)
    expect(screen.queryByText('SHELL')).toBeNull()
    const heading = screen.getByRole('heading', { name: 'Something went wrong' })
    expect(screen.getByRole('main')).toContainElement(heading)
    expect(screen.getByRole('button', { name: 'Download my data' })).toBeInTheDocument()
  })
})
