import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SyncCode } from './SyncCode'
import { pushLiveRegions } from '../../ui/announce'
import { useUIStore } from '../../stores/useUIStore'

const CODE = '11111111-2222-4333-8444-55555555a1b2'
const MASKED = '••••-…-a1b2'

const initialUI = useUIStore.getState()

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  useUIStore.setState(initialUI, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(navigator, 'share')
})

const toasts = () => useUIStore.getState().toasts.map((t) => [t.kind, t.message])
const showButton = () => screen.getByRole('button', { name: 'Show code' })
const hideButton = () => screen.getByRole('button', { name: 'Hide code' })
const fullCodeShown = () => screen.queryByText(CODE) !== null

/** Gives this page's navigator a clipboard or a share (jsdom has neither). */
function stubNavigator(prop: 'clipboard' | 'share', value: unknown) {
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true })
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('SyncCode (T-104-1)', () => {
  afterEach(() => {
    setVisibility('visible')
  })

  it('T-104-1: masks the code by default, and names what is hidden for a screen reader', () => {
    render(<SyncCode code={CODE} />)
    expect(screen.getByText('Your sync code')).toBeInTheDocument()
    expect(screen.getByText(MASKED)).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('Sync code, hidden, ends in a 1 b 2')).toHaveClass('sr-only')
    expect(fullCodeShown()).toBe(false)
    expect(document.body.textContent).not.toContain('11111111')
    expect(showButton()).toHaveTextContent('Show')
    expect(showButton()).not.toHaveAttribute('aria-pressed')
  })

  it('T-104-1: Show reveals the full code, and the same button, now Hide, masks it again', () => {
    render(<SyncCode code={CODE} />)
    fireEvent.click(showButton())
    expect(fullCodeShown()).toBe(true)
    expect(screen.queryByText(MASKED)).toBeNull()
    // the name says what a tap does next; no aria-pressed on a toggle whose name changes
    expect(hideButton()).toHaveTextContent('Hide')
    expect(hideButton()).not.toHaveAttribute('aria-pressed')
    fireEvent.click(hideButton())
    expect(showButton()).toHaveTextContent('Show')
    expect(fullCodeShown()).toBe(false)
  })

  it('T-104-1: a revealed code wraps only between its groups (never inside one)', () => {
    render(<SyncCode code={CODE} />)
    fireEvent.click(showButton())
    const shown = screen.getByText(CODE)
    expect(shown).not.toHaveClass('break-all')
    expect(shown.querySelectorAll('wbr')).toHaveLength(4)
    for (const wbr of shown.querySelectorAll('wbr')) {
      expect(wbr.previousSibling?.textContent?.endsWith('-')).toBe(true)
    }
  })

  it('T-104-1: masks it again by itself after 30 seconds', () => {
    render(<SyncCode code={CODE} />)
    fireEvent.click(showButton())
    act(() => {
      vi.advanceTimersByTime(29_000)
    })
    expect(fullCodeShown()).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(fullCodeShown()).toBe(false)
    expect(showButton()).toHaveTextContent('Show')
  })

  it('T-104-1: masks it again when the page is hidden', () => {
    render(<SyncCode code={CODE} />)
    fireEvent.click(showButton())
    act(() => {
      setVisibility('hidden')
    })
    expect(fullCodeShown()).toBe(false)
  })

  it('T-104-1: comes back masked after the panel closes (unmount)', () => {
    const { unmount } = render(<SyncCode code={CODE} />)
    fireEvent.click(showButton())
    unmount()
    render(<SyncCode code={CODE} />)
    expect(fullCodeShown()).toBe(false)
  })

  it('T-104-1: Copy copies the full code, masked or not, and says Copied for 2 seconds', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    stubNavigator('clipboard', { writeText })
    // the live regions the open layer speaks through
    const polite = document.createElement('div')
    const assertive = document.createElement('div')
    const pop = pushLiveRegions({ polite, assertive })
    render(<SyncCode code={CODE} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith(CODE)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    // a focused button's new name is often not read again: it is said as well
    expect(polite.textContent).toBe('Sync code copied')
    pop()
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  })

  it('says how to copy by hand when the clipboard refuses', async () => {
    stubNavigator('clipboard', { writeText: () => Promise.reject(new Error('denied')) })
    render(<SyncCode code={CODE} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
      await Promise.resolve()
    })
    expect(toasts()).toEqual([
      ['error', "Couldn't copy. Tap Show, then select the code and copy it."],
    ])
  })

  it('T-104-1: offers no Share (track spec §8 cut 3): Copy takes the full code', () => {
    stubNavigator('share', () => Promise.resolve())
    render(<SyncCode code={CODE} />)
    expect(screen.queryByRole('button', { name: /share/i })).toBeNull()
  })

  it('gives each button a 44 px target on a phone', () => {
    render(<SyncCode code={CODE} />)
    for (const name of ['Show code', 'Copy']) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-11', 'md:min-h-0')
    }
  })
})
