import { Suspense, lazy } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { LedgerScreen } from './LedgerScreen'
import { useExpenseStore } from '../../stores/useExpenseStore'
import type { Expense } from '../../types'

// The router as App.tsx mounts it: a BrowserRouter on the page's own history, which applies a
// navigation in a React transition. A screen whose chunk is still loading leaves the Ledger up
// after the address has changed, with the Ledger's timers still running.

// Invented data.
const KOPI: Expense = {
  id: 'e-1',
  itemName: 'Kopi O',
  amount: 1.8,
  category: 'Food',
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
}

/** A screen whose chunk never arrives. */
const Never = lazy(() => new Promise<never>(() => {}))

function renderApp() {
  render(
    <BrowserRouter>
      <nav>
        <Link to="/insights">Insights tab</Link>
      </nav>
      {/* One boundary for every screen, already showing one: the transition holds the Ledger. */}
      <Suspense fallback={<p>Loading screen</p>}>
        <Routes>
          <Route path="/ledger" element={<LedgerScreen />} />
          <Route path="/insights" element={<Never />} />
        </Routes>
      </Suspense>
    </BrowserRouter>,
  )
}

const address = () => window.location.pathname + window.location.search
const searchBox = () => screen.getByRole('textbox', { name: 'Search expenses' })
/** Longer than the pause after which typing settles into the URL. */
const PAUSE_MS = 1000

describe('the Ledger writes its filters to the address', () => {
  beforeEach(async () => {
    await useExpenseStore.getState().hydrate()
    localStorage.clear()
    localStorage.setItem('expenses', JSON.stringify([KOPI]))
    await useExpenseStore.getState().hydrate()
    vi.stubGlobal('matchMedia', (media: string) =>
      Object.assign(new EventTarget(), { media, matches: false }),
    )
    window.history.replaceState(null, '', '/ledger?range=all')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    window.history.replaceState(null, '', '/')
  })

  it('settles a typed search into the address after a pause, beside the other filters', () => {
    renderApp()
    fireEvent.change(searchBox(), { target: { value: 'kopi' } })
    expect(address()).toBe('/ledger?range=all')
    act(() => {
      vi.advanceTimersByTime(PAUSE_MS)
    })
    expect(address()).toBe('/ledger?range=all&q=kopi')
  })

  // The tab tap moved the address at once; the Ledger stays up until the next screen is ready.
  // Its late write used to replace the entry the user had just gone to: the tap did nothing.
  it('drops a search write that comes after the user has left for another screen', async () => {
    renderApp()
    fireEvent.change(searchBox(), { target: { value: 'kopi' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Insights tab' }))
      await Promise.resolve()
    })
    expect(address()).toBe('/insights')
    expect(searchBox()).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(PAUSE_MS)
    })
    expect(address()).toBe('/insights')
  })

  it('drops the write of a search box that loses focus to that tap', async () => {
    renderApp()
    fireEvent.change(searchBox(), { target: { value: 'kopi' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Insights tab' }))
      await Promise.resolve()
    })
    fireEvent.blur(searchBox())
    expect(address()).toBe('/insights')
  })
})
