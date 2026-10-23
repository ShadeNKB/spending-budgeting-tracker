import { Suspense, lazy, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddExpenseSheet } from './AddExpenseSheet'

const WHAT = /coffee, grab, spotify/i

describe('AddExpenseSheet form refill', () => {
  it('mounted already open, starts from the prefill', () => {
    render(
      <AddExpenseSheet open onClose={() => {}} prefill={{ itemName: 'Kopi O', amount: 1.8 }} />,
    )
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Kopi O')
    expect(screen.getByPlaceholderText('0.00')).toHaveValue(1.8)
  })

  it('refills from the prefill on every open, and keeps typing while open', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = useState(false)
      const [prefill, setPrefill] = useState('Grab to camp')
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <button type="button" onClick={() => setPrefill('Changed prefill')}>
            change prefill
          </button>
          <AddExpenseSheet
            open={open}
            onClose={() => setOpen(false)}
            prefill={{ itemName: prefill }}
          />
        </>
      )
    }
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    const what = screen.getByPlaceholderText(WHAT)
    expect(what).toHaveValue('Grab to camp')

    await user.clear(what)
    await user.type(what, 'Bus ride')
    // A new prefill while open never overwrites what was typed.
    fireEvent.click(screen.getByRole('button', { name: 'change prefill' }))
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Bus ride')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByPlaceholderText(WHAT)).toHaveValue('Changed prefill')
    // Real typing through user-event; it took 8 s once on a machine busy with other suites.
  }, 15_000)

  // The real first-tap path: the sheet's chunk loads, then the sheet mounts already open. That
  // render is not a click, so React runs its effects a moment after the form is on screen. A
  // refill done in an effect would wipe text typed in that moment (seen in e2e under load).
  it('keeps text typed the moment the lazily loaded sheet appears', async () => {
    const previous: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      let resolveChunk: (mod: { default: typeof AddExpenseSheet }) => void = () => undefined
      const chunk = new Promise<{ default: typeof AddExpenseSheet }>((resolve) => {
        resolveChunk = resolve
      })
      const LazySheet = lazy(() => chunk)

      // Type into the What field in the same task that puts it on screen, before React's
      // scheduled effects can run.
      const typed = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          const what = document.querySelector<HTMLInputElement>('input[placeholder^="e.g. Coffee"]')
          if (!what) return
          observer.disconnect()
          fireEvent.change(what, { target: { value: 'Teh tarik' } })
          resolve()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      })

      root.render(
        <Suspense fallback={null}>
          <LazySheet open onClose={() => {}} />
        </Suspense>,
      )
      resolveChunk({ default: AddExpenseSheet })
      await typed
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(document.querySelector('input[placeholder^="e.g. Coffee"]')).toHaveValue('Teh tarik')
    } finally {
      root.unmount()
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous)
    }
  })
})

// The + button, Ctrl+N and the home-screen "Add expense" shortcut all open this sheet to log
// something right away, one-handed: the What field takes focus, not Close.
describe('AddExpenseSheet focus', () => {
  it('opens with focus on What', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <AddExpenseSheet open={open} onClose={() => setOpen(false)} />
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByPlaceholderText(WHAT)).toHaveFocus()
  })
})

describe('AddExpenseSheet "More..." category chip', () => {
  it('shows the chosen extra category at chip size, with the native select on top', async () => {
    const user = userEvent.setup()
    render(<AddExpenseSheet open onClose={() => {}} />)
    const more = screen.getByRole('combobox', { name: 'More categories' })
    const chip = more.parentElement
    const label = () => chip?.querySelector('span[aria-hidden="true"]')
    expect(label()).toHaveTextContent('More...')
    expect(chip).toHaveClass('text-[12px]', 'h-[30px]')
    expect(more).toHaveClass('opacity-0', 'absolute', 'inset-0')

    await user.selectOptions(more, 'Investment')
    expect(more).toHaveValue('Investment')
    expect(label()).toHaveTextContent('Investment')
  })
})
