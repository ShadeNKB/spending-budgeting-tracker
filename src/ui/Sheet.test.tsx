import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Sheet } from './Sheet'

function Harness({ label, onClosed }: { label: string; onClosed?: (label: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Sheet
        open={open}
        // A fresh function on every render, as every caller passes it.
        onClose={() => {
          onClosed?.(label)
          setOpen(false)
        }}
        title="Add expense"
      >
        <input aria-label="What" />
        <p>{label}</p>
      </Sheet>
    </>
  )
}

describe('Sheet focus', () => {
  it('moves focus to Close as it opens, with no timer to wait for', () => {
    render(<Harness label="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('leaves focus alone when the parent re-renders while open (the app going idle)', async () => {
    const view = render(<Harness label="a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    const what = screen.getByRole('textbox', { name: 'What' })
    act(() => {
      what.focus()
    })

    view.rerender(<Harness label="b" />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(what).toHaveFocus()
  })

  it('with initialFocus="content", keeps focus on the field that took it as the sheet opened', () => {
    function AutoFocusHarness({ initialFocus }: { initialFocus?: 'close' | 'content' }) {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Sheet
            open={open}
            onClose={() => setOpen(false)}
            title="Add expense"
            side="bottom"
            initialFocus={initialFocus}
          >
            <input aria-label="What" autoFocus />
          </Sheet>
        </>
      )
    }
    const view = render(<AutoFocusHarness initialFocus="content" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
    view.unmount()

    // By default Close still wins, so a sheet does not pop the keyboard up uninvited.
    render(<AutoFocusHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('with initialFocus="content" but no field taking focus, falls back to Close', () => {
    function Plain() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Add" initialFocus="content">
            <input aria-label="What" />
          </Sheet>
        </>
      )
    }
    render(<Plain />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('closes on Escape with the latest onClose', () => {
    const onClosed = vi.fn()
    const view = render(<Harness label="a" onClosed={onClosed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    view.rerender(<Harness label="b" onClosed={onClosed} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClosed).toHaveBeenCalledWith('b')
  })
})

// An installed iPhone app in landscape draws under the side notches (viewport-fit=cover), and an
// iPad app under the status bar. Geometry is checked in e2e with Chromium's inset override.
describe('Sheet safe areas', () => {
  it('pads a bottom sheet clear of the side notches', () => {
    render(
      <Sheet open onClose={() => {}} title="Add expense" side="bottom">
        <p>body</p>
      </Sheet>,
    )
    expect(screen.getByRole('dialog')).toHaveClass(
      'pl-[env(safe-area-inset-left,0px)]',
      'pr-[env(safe-area-inset-right,0px)]',
    )
  })

  it('pads a side sheet clear of the right notch and the status bar', () => {
    render(
      <Sheet open onClose={() => {}} title="Settings">
        <p>body</p>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass(
      'pr-[env(safe-area-inset-right,0px)]',
      'pt-[env(safe-area-inset-top,0px)]',
    )
    expect(dialog).not.toHaveClass('pl-[env(safe-area-inset-left,0px)]')
  })
})
