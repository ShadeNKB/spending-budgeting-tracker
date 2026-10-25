import { StrictMode, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { pressedWhileOnTop, useModalLayer } from './modalLayer'

interface LayerProps {
  open: boolean
  onClose: () => void
  label: string
  children?: ReactNode
  lockScroll?: boolean
  initialFocus?: () => HTMLElement | null
  returnFocus?: () => HTMLElement | null
}

/** The smallest layer: a dialog that registers itself while open. */
function Layer({ open, onClose, label, children, ...options }: LayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  useModalLayer(open, { ref, onEscape: onClose, ...options })
  return open ? (
    <div ref={ref} role="dialog" aria-label={label} tabIndex={-1}>
      {children}
    </div>
  ) : null
}

/** A trigger that opens one layer, the way every overlay in the app is opened. */
function Opener({
  label = 'Sheet',
  children,
  ...options
}: Omit<LayerProps, 'open' | 'onClose' | 'label'> & { label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open {label}
      </button>
      <Layer open={open} onClose={() => setOpen(false)} label={label} {...options}>
        {children}
        <button type="button" onClick={() => setOpen(false)}>
          Close {label}
        </button>
      </Layer>
    </>
  )
}

/** Focus is handed back in a task after the one that closed a layer. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body
  return fireEvent.keyDown(target, { key, ...init })
}

/** Click the way a keyboard user does: focus the control, then activate it. */
function activate(name: string) {
  const button = screen.getByRole('button', { name })
  act(() => {
    button.focus()
  })
  fireEvent.click(button)
  return button
}

afterEach(() => {
  document.body.style.overflow = ''
})

describe('useModalLayer: Escape', () => {
  it('closes only the top layer, then the one below it', async () => {
    const outer = vi.fn()
    const inner = vi.fn()
    function Two() {
      const [top, setTop] = useState(true)
      return (
        <>
          <Layer open onClose={outer} label="Outer">
            <button type="button">in outer</button>
          </Layer>
          <Layer
            open={top}
            onClose={() => {
              inner()
              setTop(false)
            }}
            label="Inner"
          >
            <button type="button">in inner</button>
          </Layer>
        </>
      )
    }
    render(<Two />)
    press('Escape')
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
    await settle()
    press('Escape')
    expect(outer).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('leaves an Escape a control already handled, and one that ends an IME composition', async () => {
    const onClose = vi.fn()
    render(
      <Layer open onClose={onClose} label="Sheet">
        <input
          aria-label="Field"
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.preventDefault()
          }}
        />
        <input aria-label="Plain" />
      </Layer>,
    )
    act(() => {
      screen.getByRole('textbox', { name: 'Field' }).focus()
    })
    press('Escape')
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      screen.getByRole('textbox', { name: 'Plain' }).focus()
    })
    press('Escape', { isComposing: true })
    press('Process')
    expect(onClose).not.toHaveBeenCalled()

    const plain = screen.getByRole('textbox', { name: 'Plain' })
    fireEvent.compositionStart(plain)
    press('Escape')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.compositionEnd(plain)
    // Safari sends the key that ends a composition just after compositionend.
    press('Escape')
    expect(onClose).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 120))
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('marks the Escape it used as handled', () => {
    render(<Layer open onClose={() => {}} label="Sheet" />)
    const event = press('Escape')
    // fireEvent returns false when the event was cancelled.
    expect(event).toBe(false)
  })

  // A held Escape closes the calendar, and its auto-repeat must not go on to close the sheet
  // under it with the entry typed there.
  it('closes one layer per press: a held key’s repeats close nothing more', async () => {
    const outer = vi.fn()
    function Two() {
      const [top, setTop] = useState(true)
      return (
        <>
          <Layer open onClose={outer} label="Add expense">
            <button type="button">in the sheet</button>
          </Layer>
          <Layer open={top} onClose={() => setTop(false)} label="Choose date">
            <button type="button">in the calendar</button>
          </Layer>
        </>
      )
    }
    render(<Two />)
    press('Escape')
    expect(screen.queryByRole('dialog', { name: 'Choose date' })).not.toBeInTheDocument()
    await settle()
    for (let i = 0; i < 5; i++) expect(press('Escape', { repeat: true })).toBe(true)
    expect(outer).not.toHaveBeenCalled()
    press('Escape')
    expect(outer).toHaveBeenCalledTimes(1)
  })
})

describe('useModalLayer: Tab stays inside the top layer', () => {
  function Three() {
    return (
      <>
        <button type="button">Behind</button>
        <Layer open onClose={() => {}} label="Sheet">
          <button type="button">First</button>
          <button type="button" disabled>
            Disabled
          </button>
          <button type="button" tabIndex={-1}>
            Not in order
          </button>
          <button type="button">Middle</button>
          <button type="button" style={{ visibility: 'hidden' }}>
            Hidden
          </button>
          <button type="button">Last</button>
          <div inert>
            <button type="button">Inert</button>
          </div>
        </Layer>
      </>
    )
  }

  it('wraps from the last stop to the first and back', () => {
    render(<Three />)
    act(() => {
      screen.getByRole('button', { name: 'Last' }).focus()
    })
    expect(press('Tab')).toBe(false)
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()

    expect(press('Tab', { shiftKey: true })).toBe(false)
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus()
  })

  it('asks for the focus ring where a wrap lands (WebKit draws none after a tap otherwise)', () => {
    render(<Three />)
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    try {
      act(() => {
        screen.getByRole('button', { name: 'Last' }).focus()
      })
      focus.mockClear()
      press('Tab')
      expect(focus).toHaveBeenCalledTimes(1)
      expect(focus.mock.contexts[0]).toBe(screen.getByRole('button', { name: 'First' }))
      expect(focus).toHaveBeenCalledWith({ focusVisible: true })

      focus.mockClear()
      press('Tab', { shiftKey: true })
      expect(focus.mock.contexts[0]).toBe(screen.getByRole('button', { name: 'Last' }))
      expect(focus).toHaveBeenCalledWith({ focusVisible: true })
    } finally {
      focus.mockRestore()
    }
  })

  it('lets the browser move between stops inside (a real Tab selects a field’s text)', () => {
    render(<Three />)
    act(() => {
      screen.getByRole('button', { name: 'First' }).focus()
    })
    // fireEvent returns true when nothing cancelled the key: the browser moves focus on.
    expect(press('Tab')).toBe(true)
    act(() => {
      screen.getByRole('button', { name: 'Middle' }).focus()
    })
    expect(press('Tab', { shiftKey: true })).toBe(true)
  })

  it('wraps from a focused element that is no stop (the dialog, a roving day) only at the ends', () => {
    function Roving() {
      return (
        <Layer open onClose={() => {}} label="Calendar">
          <button type="button" tabIndex={-1}>
            Before
          </button>
          <button type="button">Previous</button>
          <button type="button" tabIndex={-1}>
            Day 3
          </button>
          <button type="button">Clear</button>
          <button type="button" tabIndex={-1}>
            After
          </button>
        </Layer>
      )
    }
    render(<Roving />)
    const focusOn = (name: string) => {
      act(() => {
        screen.getByRole('button', { name }).focus()
      })
    }
    // Stops on both sides: the browser goes on to the next one.
    focusOn('Day 3')
    expect(press('Tab')).toBe(true)
    focusOn('Day 3')
    expect(press('Tab', { shiftKey: true })).toBe(true)

    // Nothing after: back to the first stop. Nothing before: round to the last one.
    focusOn('After')
    expect(press('Tab')).toBe(false)
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveFocus()
    focusOn('Before')
    expect(press('Tab', { shiftKey: true })).toBe(false)
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveFocus()

    // The dialog comes before everything in it.
    act(() => {
      screen.getByRole('dialog').focus()
    })
    expect(press('Tab')).toBe(true)
    act(() => {
      screen.getByRole('dialog').focus()
    })
    expect(press('Tab', { shiftKey: true })).toBe(false)
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveFocus()
  })

  it('brings focus that is outside back in on Tab', () => {
    render(<Three />)
    act(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    expect(document.activeElement).toBe(document.body)
    press('Tab')
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
  })

  it('keeps focus on the dialog when it has nothing to tab to', () => {
    render(
      <Layer open onClose={() => {}} label="Empty">
        <p>Nothing here</p>
      </Layer>,
    )
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(press('Tab')).toBe(false)
    expect(screen.getByRole('dialog')).toHaveFocus()
  })
})

describe('useModalLayer: focus guard', () => {
  it('sends focus that leaves the top layer back to where it was inside', async () => {
    render(
      <>
        <button type="button">Behind</button>
        <div data-layer-exempt="">
          <button type="button">Undo</button>
        </div>
        <Layer open onClose={() => {}} label="Sheet">
          <button type="button">One</button>
          <button type="button">Two</button>
        </Layer>
      </>,
    )
    act(() => {
      screen.getByRole('button', { name: 'Two' }).focus()
    })
    act(() => {
      screen.getByRole('button', { name: 'Behind' }).focus()
    })
    await settle()
    expect(screen.getByRole('button', { name: 'Two' })).toHaveFocus()

    // The toast region is exempt: its Undo may keep focus.
    act(() => {
      screen.getByRole('button', { name: 'Undo' }).focus()
    })
    await settle()
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus()
  })
})

describe('useModalLayer: initial focus', () => {
  it('focuses the dialog itself when nothing inside took focus', () => {
    render(<Opener>{null}</Opener>)
    activate('Open Sheet')
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('keeps an autofocused field', () => {
    render(
      <Opener>
        <input aria-label="What" autoFocus />
      </Opener>,
    )
    activate('Open Sheet')
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
  })

  it('focuses what initialFocus names', () => {
    function WithInitial() {
      const [open, setOpen] = useState(false)
      const fieldRef = useRef<HTMLInputElement>(null)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Layer
            open={open}
            onClose={() => setOpen(false)}
            label="Palette"
            initialFocus={() => fieldRef.current}
          >
            <button type="button">Clear</button>
            <input ref={fieldRef} aria-label="Search" />
          </Layer>
        </>
      )
    }
    render(<WithInitial />)
    activate('Open')
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus()
  })
})

describe('useModalLayer: returning focus', () => {
  it('hands focus back only after the key that closed the layer is done with', async () => {
    // Chromium sends the keypress that follows an Enter to whatever has focus by then: had focus
    // gone back to the trigger at once, the Enter that saved the sheet would press it again.
    const onTrigger = vi.fn()
    function SaveOnEnter() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button
            type="button"
            onClick={() => {
              onTrigger()
              setOpen(true)
            }}
          >
            Search
          </button>
          <Layer open={open} onClose={() => setOpen(false)} label="Add">
            <input
              aria-label="Amount"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') setOpen(false)
              }}
            />
          </Layer>
        </>
      )
    }
    render(<SaveOnEnter />)
    const trigger = activate('Search')
    expect(onTrigger).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Amount' }), { key: 'Enter' })
    // Still the task of that key (act would wait for a later one): its microtasks run, then the
    // rest of the Enter, a keypress, lands on whatever has focus.
    await Promise.resolve()
    await Promise.resolve()
    act(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.click()
    })
    expect(onTrigger).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('leaves focus where the user already put it (a tap on a field under the closed calendar)', async () => {
    function Stacked() {
      const [picker, setPicker] = useState(false)
      return (
        <Opener>
          <input aria-label="What" />
          <button type="button" onClick={() => setPicker(true)}>
            Date
          </button>
          <Layer open={picker} onClose={() => setPicker(false)} label="Calendar">
            <button type="button">Day</button>
          </Layer>
        </Opener>
      )
    }
    render(<Stacked />)
    activate('Open Sheet')
    activate('Date')
    const what = screen.getByRole('textbox', { name: 'What' })
    // The calendar closes on the press, and the field takes focus from the same press.
    press('Escape')
    act(() => {
      what.focus()
    })
    await settle()
    expect(what).toHaveFocus()
  })

  it('moves focus once when two layers close before it moves: to the last one’s opener', async () => {
    function Stacked() {
      const [picker, setPicker] = useState(false)
      return (
        <Opener>
          <button type="button" onClick={() => setPicker(true)}>
            Date
          </button>
          <Layer open={picker} onClose={() => setPicker(false)} label="Calendar">
            <button type="button">Day</button>
          </Layer>
        </Opener>
      )
    }
    render(
      <main>
        <h1 tabIndex={-1}>Pulse</h1>
        <Stacked />
      </main>,
    )
    const trigger = activate('Open Sheet')
    activate('Date')
    const visits: string[] = []
    const record = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement) visits.push(e.target.textContent)
    }
    document.addEventListener('focusin', record)
    try {
      press('Escape')
      press('Escape')
      await settle()
    } finally {
      document.removeEventListener('focusin', record)
    }
    expect(trigger).toHaveFocus()
    expect(visits).toEqual(['Open Sheet'])
  })

  it('returns focus to the trigger, never to the autofocused field inside', async () => {
    render(
      <Opener>
        <input aria-label="What" autoFocus />
      </Opener>,
    )
    const trigger = activate('Open Sheet')
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
    press('Escape')
    await settle()
    expect(trigger).toHaveFocus()

    activate('Open Sheet')
    fireEvent.click(screen.getByRole('button', { name: 'Close Sheet' }))
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('returns to a control that was pressed without taking focus (Safari never focuses a tapped button)', async () => {
    render(
      <>
        <input aria-label="Quick add" />
        <Opener>
          <input aria-label="What" autoFocus />
        </Opener>
      </>,
    )
    act(() => {
      screen.getByRole('textbox', { name: 'Quick add' }).focus()
    })
    const trigger = screen.getByRole('button', { name: 'Open Sheet' })
    fireEvent.pointerDown(trigger)
    fireEvent.click(trigger)
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
    press('Escape')
    await settle()
    // Not the quick-add field: focusing it would pop the phone keyboard up after a save.
    expect(trigger).toHaveFocus()
  })

  it('returns to the control the keyboard opened it from, not one clicked a moment before', async () => {
    // A click in the quick-add field, then Tab to Settings and Enter, all within a second: the
    // keyboard was used after the press, so the press did not open the layer.
    render(
      <>
        <input aria-label="Quick add" />
        <Opener>
          <p>Settings</p>
        </Opener>
      </>,
    )
    const field = screen.getByRole('textbox', { name: 'Quick add' })
    fireEvent.pointerDown(field)
    act(() => {
      field.focus()
    })
    fireEvent.keyDown(field, { key: 'Tab' })
    const trigger = screen.getByRole('button', { name: 'Open Sheet' })
    act(() => {
      trigger.focus()
    })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toHaveFocus()
    press('Escape')
    await settle()
    expect(trigger).toHaveFocus()
  })

  it('asks returnFocus when the trigger is gone, then falls back to the screen heading', async () => {
    function Gone({ fallback }: { fallback: () => HTMLElement | null }) {
      const [open, setOpen] = useState(false)
      const [showTrigger, setShowTrigger] = useState(true)
      return (
        <main>
          <h1 tabIndex={-1}>Ledger</h1>
          <button type="button">Next row</button>
          {showTrigger && (
            <button type="button" onClick={() => setOpen(true)}>
              Row
            </button>
          )}
          <Layer open={open} onClose={() => setOpen(false)} label="Edit" returnFocus={fallback}>
            <button
              type="button"
              onClick={() => {
                setShowTrigger(false)
                setOpen(false)
              }}
            >
              Delete
            </button>
          </Layer>
        </main>
      )
    }
    const view = render(<Gone fallback={() => screen.getByRole('button', { name: 'Next row' })} />)
    activate('Row')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Next row' })).toHaveFocus()
    view.unmount()

    render(<Gone fallback={() => null} />)
    activate('Row')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Ledger' })).toHaveFocus()
  })

  // Ctrl+N on a page scrolled with the wheel: nothing had focus, so the heading takes it on close.
  // Scrolling it into view would throw the reader back to the top of a long ledger.
  it('hands focus to the heading without scrolling the page to it', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })
    try {
      function Shortcut() {
        const [open, setOpen] = useState(false)
        return (
          <main>
            <h1 tabIndex={-1}>Ledger</h1>
            <button type="button" onClick={() => setOpen(true)}>
              Shortcut
            </button>
            <Layer open={open} onClose={() => setOpen(false)} label="Add" />
          </main>
        )
      }
      render(<Shortcut />)
      const heading = screen.getByRole('heading', { name: 'Ledger' })
      // Laid out and showing a ring, as after a key: still no scroll.
      heading.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: -900, width: 300, height: 40 })
      const matches = heading.matches.bind(heading)
      Object.defineProperty(heading, 'matches', {
        configurable: true,
        value: (selectors: string) => selectors === ':focus-visible' || matches(selectors),
      })
      const focus = vi.spyOn(heading, 'focus')
      // Opened with focus on <body>: a click from code stands in for the shortcut.
      expect(document.activeElement).toBe(document.body)
      fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }))
      press('Escape')
      await settle()
      expect(heading).toHaveFocus()
      expect(focus).toHaveBeenCalledWith({ preventScroll: true })
      expect(scrollIntoView).not.toHaveBeenCalled()

      // The next shortcut opens from the heading itself: back there, still no scroll.
      fireEvent.click(screen.getByRole('button', { name: 'Shortcut' }))
      press('Escape')
      await settle()
      expect(heading).toHaveFocus()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('hands a layer opened from another one, closing in the same commit, that layer’s trigger', async () => {
    // The palette's "Add expense": the palette closes as the sheet opens, so the sheet's opener
    // (the palette's option) disappears; the sheet returns to what opened the palette.
    function PaletteToSheet() {
      const [palette, setPalette] = useState(false)
      const [sheet, setSheet] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setPalette(true)}>
            Search
          </button>
          <Layer open={palette} onClose={() => setPalette(false)} label="Palette">
            <button
              type="button"
              onClick={() => {
                setSheet(true)
                setPalette(false)
              }}
            >
              Add expense
            </button>
          </Layer>
          <Layer open={sheet} onClose={() => setSheet(false)} label="Add">
            <input aria-label="What" autoFocus />
          </Layer>
        </>
      )
    }
    render(<PaletteToSheet />)
    const search = activate('Search')
    activate('Add expense')
    await settle()
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
    press('Escape')
    await settle()
    expect(search).toHaveFocus()
  })

  it('never takes a press inside a closing layer for the opener (a sheet that loads late)', async () => {
    // The palette's option is pressed, the palette closes and animates out (still in the page,
    // inert), and the sheet it asked for mounts a moment later, once its chunk has loaded.
    function Lingering({ open, onClose, children }: Omit<LayerProps, 'label'>) {
      const ref = useRef<HTMLDivElement>(null)
      useModalLayer(open, { ref, onEscape: onClose })
      return (
        <div ref={ref} role="dialog" aria-label="Palette" tabIndex={-1}>
          {children}
        </div>
      )
    }
    function LateSheet({ sheet, onSheetClose }: { sheet: boolean; onSheetClose: () => void }) {
      const [palette, setPalette] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setPalette(true)}>
            Search
          </button>
          <Lingering open={palette} onClose={() => setPalette(false)}>
            <button type="button" onClick={() => setPalette(false)}>
              Add expense
            </button>
          </Lingering>
          <Layer open={sheet} onClose={onSheetClose} label="Add">
            <input aria-label="What" autoFocus />
          </Layer>
        </>
      )
    }
    const onSheetClose = vi.fn()
    const view = render(<LateSheet sheet={false} onSheetClose={onSheetClose} />)
    const search = activate('Search')
    const option = screen.getByRole('button', { name: 'Add expense' })
    fireEvent.pointerDown(option)
    fireEvent.click(option)
    await settle()
    expect(search).toHaveFocus()

    view.rerender(<LateSheet sheet onSheetClose={onSheetClose} />)
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
    press('Escape')
    expect(onSheetClose).toHaveBeenCalledTimes(1)
    view.rerender(<LateSheet sheet={false} onSheetClose={onSheetClose} />)
    await settle()
    expect(search).toHaveFocus()
  })

  it('scrolls a keyboard user’s focus on the page clear of the header and tab bar, nothing else', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })
    // The browser's own call (jsdom guesses differently): the ring shows after a key, not a tap.
    let keyboard = true
    try {
      function Stacked() {
        const [picker, setPicker] = useState(false)
        return (
          <Opener>
            <button type="button" onClick={() => setPicker(true)}>
              Date
            </button>
            <Layer open={picker} onClose={() => setPicker(false)} label="Calendar" />
          </Opener>
        )
      }
      render(<Stacked />)
      const trigger = screen.getByRole('button', { name: 'Open Sheet' })
      // jsdom does not lay out: give both controls a box, as a browser would.
      const box = { x: 0, y: 700, width: 60, height: 44 }
      trigger.getBoundingClientRect = () => DOMRect.fromRect(box)
      const matches = trigger.matches.bind(trigger)
      Object.defineProperty(trigger, 'matches', {
        configurable: true,
        value: (selectors: string) =>
          selectors === ':focus-visible' ? keyboard : matches(selectors),
      })
      activate('Open Sheet')
      const date = activate('Date')
      date.getBoundingClientRect = () => DOMRect.fromRect(box)

      // Back inside the sheet: its own scroller keeps the control where it was.
      press('Escape')
      await settle()
      expect(date).toHaveFocus()
      expect(scrollIntoView).not.toHaveBeenCalled()

      // Back on the page by keyboard: into the area the sticky bars leave (scroll margin).
      press('Escape')
      await settle()
      expect(trigger).toHaveFocus()
      expect(scrollIntoView.mock.contexts).toEqual([trigger])
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

      // After a tap (no ring to show) the page does not move.
      scrollIntoView.mockClear()
      keyboard = false
      activate('Open Sheet')
      fireEvent.click(screen.getByRole('button', { name: 'Close Sheet' }))
      await settle()
      expect(trigger).toHaveFocus()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    }
  })

  it('returns focus down the stack, one layer at a time', async () => {
    function Stacked() {
      const [picker, setPicker] = useState(false)
      return (
        <Opener>
          <input aria-label="What" autoFocus />
          <button type="button" onClick={() => setPicker(true)}>
            Date
          </button>
          <Layer open={picker} onClose={() => setPicker(false)} label="Calendar">
            <button type="button">Day</button>
          </Layer>
        </Opener>
      )
    }
    render(<Stacked />)
    const trigger = activate('Open Sheet')
    const date = activate('Date')
    expect(screen.getByRole('dialog', { name: 'Calendar' })).toHaveFocus()
    press('Escape')
    await settle()
    expect(date).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Sheet' })).toBeInTheDocument()
    press('Escape')
    await settle()
    expect(trigger).toHaveFocus()
  })
})

describe('useModalLayer: a closing layer', () => {
  it('is inert while it animates out (no double tap on Save, not read), and live again on reopen', async () => {
    function Lingering({ open }: { open: boolean }) {
      const ref = useRef<HTMLDivElement>(null)
      useModalLayer(open, { ref, onEscape: () => {} })
      return (
        <div ref={ref} role="dialog" aria-label="Exiting" tabIndex={-1}>
          <button type="button">Save</button>
        </div>
      )
    }
    const view = render(<Lingering open />)
    const dialog = screen.getByRole('dialog', { name: 'Exiting' })
    expect(dialog).not.toHaveAttribute('inert')
    view.rerender(<Lingering open={false} />)
    // Right after the commit that closed it.
    await settle()
    expect(dialog).toHaveAttribute('inert')
    view.rerender(<Lingering open />)
    expect(dialog).not.toHaveAttribute('inert')
  })
})

/**
 * One mouse press as a browser sends it: pointerdown, mousedown, pointerup, mouseup, click (and
 * dblclick for the second press of a double click). Returns whether its mousedown went through
 * (false: default prevented, so it moved no focus).
 */
function mousePress(el: Element, detail = 1): boolean {
  fireEvent.pointerDown(el, { pointerType: 'mouse', button: 0 })
  const down = fireEvent.mouseDown(el, { detail, button: 0 })
  fireEvent.pointerUp(el, { pointerType: 'mouse', button: 0 })
  fireEvent.mouseUp(el, { detail, button: 0 })
  fireEvent.click(el, { detail, button: 0 })
  if (detail === 2) fireEvent.dblClick(el, { detail, button: 0 })
  return down
}

// A press that opens or closes a layer changes what is under the pointer: the second press of
// its double click would land on what the change put there (src/ui/pressShield.ts). jsdom does
// no hit testing, so the second press is sent where a browser would put it.
describe('useModalLayer: the press that opens or closes a layer', () => {
  it('ends its gesture on close: the rest of its double click presses nothing behind', () => {
    const trash = vi.fn()
    function Ledger() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={trash}>
            Delete row 0019
          </button>
          <Layer open={open} onClose={() => setOpen(false)} label="Edit expense">
            <button type="button" onClick={() => setOpen(false)}>
              Save changes
            </button>
          </Layer>
        </>
      )
    }
    render(<Ledger />)
    mousePress(screen.getByRole('button', { name: 'Save changes' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    const row = screen.getByRole('button', { name: 'Delete row 0019' })
    expect(mousePress(row, 2)).toBe(false)
    expect(trash).not.toHaveBeenCalled()
    // The next press is the user's.
    mousePress(row)
    expect(trash).toHaveBeenCalledTimes(1)
  })

  it('ends its gesture on open: the rest of its double click presses nothing in the layer', () => {
    const chip = vi.fn()
    function Entry() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Add expense
          </button>
          <Layer open={open} onClose={() => setOpen(false)} label="Add">
            <button type="button" onClick={chip}>
              Gaming
            </button>
          </Layer>
        </>
      )
    }
    render(<Entry />)
    mousePress(screen.getByRole('button', { name: 'Add expense' }))
    const gaming = screen.getByRole('button', { name: 'Gaming' })
    expect(mousePress(gaming, 2)).toBe(false)
    expect(chip).not.toHaveBeenCalled()
    mousePress(gaming)
    expect(chip).toHaveBeenCalledTimes(1)
  })
})

describe('useModalLayer: scroll lock', () => {
  it('restores the page overflow only when the last locking layer closes, in either order', async () => {
    function Locks({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          <Layer open={a} onClose={() => {}} label="A" lockScroll />
          <Layer open={b} onClose={() => {}} label="B" lockScroll />
          <Layer open onClose={() => {}} label="Picker" />
        </>
      )
    }
    document.body.style.overflow = 'clip'
    const view = render(<Locks a b />)
    expect(document.body.style.overflow).toBe('hidden')
    view.rerender(<Locks a={false} b />)
    expect(document.body.style.overflow).toBe('hidden')
    view.rerender(<Locks a={false} b={false} />)
    expect(document.body.style.overflow).toBe('clip')

    view.rerender(<Locks a b />)
    view.rerender(<Locks a b={false} />)
    expect(document.body.style.overflow).toBe('hidden')
    view.rerender(<Locks a={false} b={false} />)
    await settle()
    expect(document.body.style.overflow).toBe('clip')
  })
})

describe('useModalLayer: a press outside the top layer', () => {
  /**
   * A sheet with a backdrop and a calendar in it that closes on any press outside itself, as
   * DatePicker does. The backdrop closes the sheet only for a press that began with the sheet
   * on top.
   */
  function SheetWithCalendar({ onSheetClose }: { onSheetClose: () => void }) {
    const sheetRef = useRef<HTMLDivElement>(null)
    const calendarRef = useRef<HTMLDivElement>(null)
    const backdropRef = useRef<HTMLDivElement>(null)
    const [calendar, setCalendar] = useState(false)
    useModalLayer(true, { ref: sheetRef, onEscape: onSheetClose })
    useModalLayer(calendar, { ref: calendarRef, onEscape: () => setCalendar(false) })
    // A plain listener: the backdrop is a pointer target only, as in Sheet.
    useLayoutEffect(() => {
      const backdrop = backdropRef.current
      if (!backdrop) return
      const onClick = () => {
        if (pressedWhileOnTop(sheetRef.current)) onSheetClose()
      }
      backdrop.addEventListener('click', onClick)
      return () => {
        backdrop.removeEventListener('click', onClick)
      }
    }, [onSheetClose])
    useLayoutEffect(() => {
      if (!calendar) return
      const outside = (event: PointerEvent) => {
        if (!(event.target instanceof Node) || !calendarRef.current?.contains(event.target))
          setCalendar(false)
      }
      document.addEventListener('pointerdown', outside, true)
      return () => {
        document.removeEventListener('pointerdown', outside, true)
      }
    }, [calendar])
    return (
      <>
        <div ref={backdropRef} data-testid="backdrop" />
        <div ref={sheetRef} role="dialog" aria-label="Add" tabIndex={-1}>
          <button type="button" onClick={() => setCalendar(true)}>
            Pick date
          </button>
        </div>
        {calendar && (
          <div ref={calendarRef} role="dialog" aria-label="Calendar" tabIndex={-1}>
            <button type="button">Day</button>
          </div>
        )}
      </>
    )
  }

  it('closes only the calendar when the tap that dismissed it lands on the sheet’s backdrop', () => {
    const onSheetClose = vi.fn()
    render(<SheetWithCalendar onSheetClose={onSheetClose} />)
    activate('Pick date')
    expect(screen.getByRole('dialog', { name: 'Calendar' })).toBeInTheDocument()

    const backdrop = screen.getByTestId('backdrop')
    fireEvent.pointerDown(backdrop)
    expect(screen.queryByRole('dialog', { name: 'Calendar' })).toBeNull()
    fireEvent.click(backdrop)
    expect(onSheetClose).not.toHaveBeenCalled()

    // The next tap there began with the sheet on top: it closes the sheet.
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onSheetClose).toHaveBeenCalledTimes(1)
  })

  it('lets a click with no press before it through (a click sent from code)', () => {
    const onSheetClose = vi.fn()
    render(<SheetWithCalendar onSheetClose={onSheetClose} />)
    fireEvent.click(screen.getByTestId('backdrop'))
    expect(onSheetClose).toHaveBeenCalledTimes(1)
  })
})

describe('useModalLayer under StrictMode', () => {
  /**
   * StrictMode runs a component's effects twice when it mounts, so the layer here mounts already
   * open, as a sheet does on its first open once its chunk has loaded.
   */
  function MountsOpen({ children }: { children: ReactNode }) {
    const [shown, setShown] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setShown(true)}>
          Open Sheet
        </button>
        {shown && (
          <Layer open onClose={() => setShown(false)} label="Sheet" lockScroll>
            {children}
          </Layer>
        )}
      </>
    )
  }

  it('never turns the dialog inert while its effects run twice', () => {
    const view = render(
      <StrictMode>
        <MountsOpen>
          <input aria-label="What" autoFocus />
        </MountsOpen>
      </StrictMode>,
    )
    // Inert would blur the autofocused field in a browser.
    const observer = new MutationObserver(() => {})
    observer.observe(view.container, { subtree: true, attributeFilter: ['inert'] })
    activate('Open Sheet')
    const records = observer.takeRecords()
    observer.disconnect()
    expect(records).toEqual([])
    expect(screen.getByRole('dialog')).not.toHaveAttribute('inert')
  })

  it('keeps the autofocused field and still returns focus to the trigger', async () => {
    render(
      <StrictMode>
        <MountsOpen>
          <input aria-label="What" autoFocus />
        </MountsOpen>
      </StrictMode>,
    )
    const trigger = activate('Open Sheet')
    await settle()
    expect(screen.getByRole('textbox', { name: 'What' })).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')

    press('Escape')
    await settle()
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })
})
