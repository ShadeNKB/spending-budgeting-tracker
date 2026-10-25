import { useState } from 'react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Sheet } from './Sheet'
import { DatePicker } from './DatePicker'

// framer-motion reads prefers-reduced-motion through matchMedia (absent in jsdom): a stub whose
// answer the reduced-motion test flips, notifying the listener framer registers.
let reduceMotion = false
const motionListeners = new Set<() => void>()
beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return query.includes('reduced-motion') && reduceMotion
    },
    addListener: (listener: () => void) => motionListeners.add(listener),
    removeListener: (listener: () => void) => motionListeners.delete(listener),
    addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => motionListeners.delete(listener),
  }))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

function setReducedMotion(on: boolean) {
  reduceMotion = on
  for (const listener of motionListeners) listener()
}

/** Focus is handed back in a task after the one that closed the sheet. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

function Harness({
  label,
  onClosed,
  autoFocusField = false,
}: {
  label: string
  onClosed?: (label: string) => void
  autoFocusField?: boolean
}) {
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
        side="bottom"
      >
        <input aria-label="What" autoFocus={autoFocusField} />
        <p>{label}</p>
      </Sheet>
    </>
  )
}

/** Open the way a keyboard user does: focus the trigger, activate it. */
function openSheet() {
  const trigger = screen.getByRole('button', { name: 'Open' })
  act(() => {
    trigger.focus()
  })
  fireEvent.click(trigger)
  return trigger
}

describe('Sheet focus', () => {
  it('opens with focus on the dialog when nothing inside takes it, never on Close', () => {
    render(<Harness label="a" />)
    openSheet()
    const dialog = screen.getByRole('dialog', { name: 'Add expense' })
    expect(dialog).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus()
  })

  it('keeps focus on the field that took it as the sheet opened, so typing starts at once', () => {
    render(<Harness label="a" autoFocusField />)
    openSheet()
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
  })

  it('leaves focus alone when the parent re-renders while open (the app going idle)', async () => {
    const view = render(<Harness label="a" />)
    openSheet()
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

  it('closes on Escape with the latest onClose and returns focus to the trigger', async () => {
    const onClosed = vi.fn()
    const view = render(<Harness label="a" onClosed={onClosed} autoFocusField />)
    const trigger = openSheet()
    view.rerender(<Harness label="b" onClosed={onClosed} autoFocusField />)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'What' }), { key: 'Escape' })
    expect(onClosed).toHaveBeenCalledWith('b')
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('returns focus to the trigger after Close and after a backdrop click', async () => {
    const { baseElement } = render(<Harness label="a" autoFocusField />)
    const trigger = openSheet()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await settle()
    expect(trigger).toHaveFocus()

    openSheet()
    const backdrop = baseElement.querySelector('[data-sheet-backdrop]')
    expect(backdrop).not.toBeNull()
    if (backdrop) fireEvent.click(backdrop)
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('asks returnFocus when the trigger is gone', async () => {
    function Gone() {
      const [open, setOpen] = useState(false)
      const [rowShown, setRowShown] = useState(true)
      return (
        <>
          <button type="button">Next row</button>
          {rowShown && (
            <button type="button" onClick={() => setOpen(true)}>
              Row
            </button>
          )}
          <Sheet
            open={open}
            onClose={() => setOpen(false)}
            title="Edit expense"
            returnFocus={() => screen.getByRole('button', { name: 'Next row' })}
          >
            <button
              type="button"
              onClick={() => {
                setRowShown(false)
                setOpen(false)
              }}
            >
              Delete
            </button>
          </Sheet>
        </>
      )
    }
    render(<Gone />)
    const row = screen.getByRole('button', { name: 'Row' })
    act(() => {
      row.focus()
    })
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Next row' })).toHaveFocus()
  })

  it('stays open when the tap that closes its date picker lands on the backdrop', () => {
    const onClose = vi.fn()
    function WithPicker() {
      const [date, setDate] = useState('2026-10-03')
      return (
        <Sheet open onClose={onClose} title="Add expense" side="bottom">
          <input aria-label="What" />
          <DatePicker value={date} onChange={setDate} variant="pill" />
        </Sheet>
      )
    }
    const { baseElement } = render(<WithPicker />)
    fireEvent.click(screen.getByRole('button', { name: /^Change date/ }))
    expect(screen.getByRole('dialog', { name: 'Choose date' })).toBeInTheDocument()
    const backdrop = baseElement.querySelector('[data-sheet-backdrop]')
    if (!backdrop) throw new Error('no backdrop')

    // The tap closes the calendar; its click on the backdrop leaves the entry alone.
    fireEvent.pointerDown(backdrop)
    expect(screen.queryByRole('dialog', { name: 'Choose date' })).toBeNull()
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()

    // A tap there with the sheet on top closes it.
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps Tab inside the sheet', () => {
    render(<Harness label="a" autoFocusField />)
    openSheet()
    const close = screen.getByRole('button', { name: 'Close' })
    const what = screen.getByRole('textbox', { name: 'What' })
    // Close is first in the panel, What last.
    fireEvent.keyDown(what, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(what).toHaveFocus()
  })
})

describe('Sheet semantics', () => {
  it('is a modal div dialog named by its title, with no landmark inside', () => {
    render(
      <Sheet open onClose={() => {}} title="Settings">
        <p>body</p>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog.tagName).toBe('DIV')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog.querySelector('aside, header')).toBeNull()
    expect(screen.queryByRole('banner')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('carries its own live regions, so announcements made while it is open are heard', () => {
    render(
      <Sheet open onClose={() => {}} title="Settings">
        <p>body</p>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[role="status"]')).toBeEmptyDOMElement()
    expect(dialog.querySelector('[role="alert"]')).toBeEmptyDOMElement()
  })

  it('scrolls a focused control clear of its scroller’s edges, ring included', () => {
    render(
      <Sheet open onClose={() => {}} title="Edit expense">
        <button type="button">Delete expense</button>
      </Sheet>,
    )
    const scroller = screen.getByRole('button', { name: 'Delete expense' }).parentElement
    expect(scroller).toHaveClass('overflow-y-auto', 'scroll-py-6')
  })

  it('gives Close a 44 px hit area on touch screens', () => {
    render(
      <Sheet open onClose={() => {}} title="Settings">
        <p>body</p>
      </Sheet>,
    )
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('tap-target')
  })
})

describe('Sheet stacking', () => {
  /** The box a layer is drawn in: its backdrop and its panel share it. */
  const layerOf = (dialog: HTMLElement) => {
    const box = dialog.parentElement
    if (!box) throw new Error('no layer box')
    return box
  }

  it('draws each open sheet in one box, backdrop and panel, so a later one covers it whole', () => {
    function Two({ second }: { second: boolean }) {
      return (
        <>
          <Sheet open onClose={() => {}} title="Add expense" side="bottom">
            <button type="button">Under</button>
          </Sheet>
          <Sheet open={second} onClose={() => {}} title="Settings">
            <button type="button">Over</button>
          </Sheet>
        </>
      )
    }
    const view = render(<Two second={false} />)
    view.rerender(<Two second />)
    const under = layerOf(screen.getByRole('dialog', { name: 'Add expense' }))
    const over = layerOf(screen.getByRole('dialog', { name: 'Settings' }))
    // Opened last, last in the page: the same stacking level then puts it on top.
    expect(under.parentElement).toBe(document.body)
    expect(over.parentElement).toBe(document.body)
    expect(under.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect([...over.classList].filter((c) => c.startsWith('z-'))).toEqual(
      [...under.classList].filter((c) => c.startsWith('z-')),
    )
    for (const box of [under, over]) {
      expect(box.querySelector(':scope > [data-sheet-backdrop]')).not.toBeNull()
      // Panels inside need no stacking level of their own.
      expect(
        [...box.querySelectorAll('*')].some((el) =>
          /(^|\s)z-/.test(el.getAttribute('class') ?? ''),
        ),
      ).toBe(false)
    }
  })

  it('lets a new tap through while it animates out (its dialog is inert by then)', async () => {
    const view = render(
      <Sheet open onClose={() => {}} title="Add expense" side="bottom">
        <button type="button">Save</button>
      </Sheet>,
    )
    const dialog = screen.getByRole('dialog')
    const box = layerOf(dialog)
    expect(box).toHaveClass('[&:has(>[inert])]:pointer-events-none')
    view.rerender(
      <Sheet open={false} onClose={() => {}} title="Add expense" side="bottom">
        <button type="button">Save</button>
      </Sheet>,
    )
    await settle()
    if (dialog.isConnected) expect(dialog).toHaveAttribute('inert')
  })

  // The tap that closes it is not let through: on /ledger the second press of a double click on
  // Save landed on the row's trash under it and deleted an unrelated expense. jsdom does no hit
  // testing, so the second press is sent where the browser would put it: on the page behind.
  it('swallows the rest of the double click whose first press closed it', async () => {
    const trash = vi.fn()
    function Ledger() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={trash}>
            Delete row 0019
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Edit expense">
            <button type="button" onClick={() => setOpen(false)}>
              Save changes
            </button>
          </Sheet>
        </>
      )
    }
    /** A mouse press as a browser sends it; whether its mousedown went through (moved focus). */
    const mousePress = (el: Element, detail: number) => {
      fireEvent.pointerDown(el, { pointerType: 'mouse', button: 0 })
      const down = fireEvent.mouseDown(el, { detail, button: 0 })
      fireEvent.pointerUp(el, { pointerType: 'mouse', button: 0 })
      fireEvent.mouseUp(el, { detail, button: 0 })
      fireEvent.click(el, { detail, button: 0 })
      if (detail === 2) fireEvent.dblClick(el, { detail, button: 0 })
      return down
    }
    render(<Ledger />)
    mousePress(screen.getByRole('button', { name: 'Save changes' }), 1)
    await settle()

    const row = screen.getByRole('button', { name: 'Delete row 0019' })
    expect(mousePress(row, 2)).toBe(false) // no focus moved
    expect(trash).not.toHaveBeenCalled()

    // The next press is the user's.
    mousePress(row, 1)
    expect(trash).toHaveBeenCalledTimes(1)
  })
})

describe('Sheet motion', () => {
  it('slides in normally, and only fades (no transform at all) under reduced motion', () => {
    const view = render(
      <Sheet open onClose={() => {}} title="Add expense" side="bottom">
        <p>body</p>
      </Sheet>,
    )
    expect(screen.getByRole('dialog').style.transform).toContain('translateY')
    view.unmount()

    setReducedMotion(true)
    try {
      render(
        <Sheet open onClose={() => {}} title="Add expense" side="bottom">
          <p>body</p>
        </Sheet>,
      )
      const transform = screen.getByRole('dialog').style.transform
      expect(transform === '' || transform === 'none').toBe(true)
    } finally {
      setReducedMotion(false)
    }
  })

  it('never moves under Reduce Motion turned on while the app is open (framer reads it once)', () => {
    render(
      <Sheet open onClose={() => {}} title="Add expense" side="bottom">
        <p>body</p>
      </Sheet>,
    )
    // In the page's CSS: no transform at all while the system asks for reduced motion.
    expect(screen.getByRole('dialog')).toHaveClass('motion-reduce:!transform-none')
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
