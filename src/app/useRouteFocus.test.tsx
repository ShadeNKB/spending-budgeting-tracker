import { useState, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { useRouteFocus } from './useRouteFocus'

function Shell({ children }: { children: ReactNode }) {
  useRouteFocus()
  return <main id="main">{children}</main>
}

/** A screen whose control navigates away and unmounts with it (a heatmap day). */
function Pulse() {
  const navigate = useNavigate()
  return (
    <>
      <h1 tabIndex={-1}>Pulse</h1>
      <button type="button" onClick={() => void navigate('/ledger')}>
        Oct 3: S$12.40
      </button>
    </>
  )
}

/** A screen that shows its heading a moment later, like a lazily loaded one. */
function LateLedger() {
  const [ready, setReady] = useState(false)
  return ready ? (
    <h1 tabIndex={-1}>Ledger</h1>
  ) : (
    <button type="button" onClick={() => setReady(true)}>
      finish loading
    </button>
  )
}

function App({ ledger }: { ledger: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/pulse']}>
      <nav>
        <TabLink />
      </nav>
      <Shell>
        <Routes>
          <Route path="/pulse" element={<Pulse />} />
          <Route path="/ledger" element={ledger} />
        </Routes>
      </Shell>
    </MemoryRouter>
  )
}

function TabLink() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => void navigate('/ledger')}>
      Ledger tab
    </button>
  )
}

function activate(name: string) {
  const button = screen.getByRole('button', { name })
  act(() => {
    button.focus()
  })
  fireEvent.click(button)
}

describe('useRouteFocus', () => {
  it('moves focus to the new screen’s heading when the focused control went away with the old one', () => {
    render(<App ledger={<h1 tabIndex={-1}>Ledger</h1>} />)
    expect(document.body).toHaveFocus()
    activate('Oct 3: S$12.40')
    expect(screen.getByRole('heading', { name: 'Ledger' })).toHaveFocus()
  })

  it('waits for a heading that renders later', async () => {
    render(<App ledger={<LateLedger />} />)
    activate('Oct 3: S$12.40')
    expect(document.body).toHaveFocus()
    // Nothing on screen has focus yet; the heading arrives with the loaded screen.
    fireEvent.click(screen.getByRole('button', { name: 'finish loading' }))
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Ledger' })).toHaveFocus()
    })
  })

  // A first visit on a slow network: the screen's chunk arrives after seconds, not within one.
  it('goes on waiting for a heading that takes seconds to come', async () => {
    vi.useFakeTimers()
    try {
      render(<App ledger={<LateLedger />} />)
      activate('Oct 3: S$12.40')
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      fireEvent.click(screen.getByRole('button', { name: 'finish loading' }))
      // The heading is seen by a mutation observer, in a microtask.
      await act(() => Promise.resolve())
      expect(screen.getByRole('heading', { name: 'Ledger' })).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })

  // Anything that takes focus while the screen loads is the user's own move: the heading does
  // not take it back when it arrives.
  it('stops waiting once something else has taken focus', async () => {
    render(<App ledger={<LateLedger />} />)
    activate('Oct 3: S$12.40')
    const tab = screen.getByRole('button', { name: 'Ledger tab' })
    act(() => {
      tab.focus()
    })
    act(() => {
      tab.blur()
    })
    fireEvent.click(screen.getByRole('button', { name: 'finish loading' }))
    // The heading is seen by a mutation observer, in a microtask, if anything still waits.
    await act(() => Promise.resolve())
    expect(screen.getByRole('heading', { name: 'Ledger' })).toBeInTheDocument()
    expect(document.body).toHaveFocus()
  })

  it('leaves focus alone when the control that navigated is still there', () => {
    render(<App ledger={<h1 tabIndex={-1}>Ledger</h1>} />)
    activate('Ledger tab')
    expect(screen.getByRole('button', { name: 'Ledger tab' })).toHaveFocus()
  })

  it('does nothing on the first render', () => {
    render(<App ledger={<h1 tabIndex={-1}>Ledger</h1>} />)
    expect(screen.getByRole('heading', { name: 'Pulse' })).not.toHaveFocus()
  })
})
