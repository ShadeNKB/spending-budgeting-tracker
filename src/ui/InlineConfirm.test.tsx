import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { InlineConfirm } from './InlineConfirm'
import { useInlineConfirm } from '../hooks/useInlineConfirm'
import { GESTURE_MS, noteToastLeft } from './pressShield'

/** The page draws its next frame (jsdom runs animation frames on a timer). */
const painted = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0)
    })
  })

describe('InlineConfirm', () => {
  it('takes focus on Cancel as it appears (the safe default)', () => {
    render(
      <InlineConfirm
        question="Delete all 12 expenses?"
        confirmLabel="Yes, delete all"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  // A question can appear from no click at all: the import question waits for the file to be
  // read. React runs a plain effect of such an update a task later, while the question is
  // already on screen; a key pressed in between would land on the trigger (Import again), not
  // on Cancel. Focus must move in the same task that shows the question.
  it('has Cancel focused by the time the question is on screen, also after an async update', async () => {
    const previous: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    /** Ends the "file read": set by the harness once it is on screen. */
    let fileRead: () => void = () => undefined
    function AfterFileRead() {
      const [asking, setAsking] = useState(false)
      useEffect(() => {
        fileRead = () => {
          setAsking(true)
        }
      }, [])
      return asking ? (
        <InlineConfirm
          question="Import 3 expenses?"
          confirmLabel="Confirm import"
          tone="warning"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      ) : (
        <button type="button">Import JSON backup</button>
      )
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      root.render(<AfterFileRead />)
      while (!host.querySelector('button')) await tick()
      await tick()
      host.querySelector('button')?.focus()
      expect(document.activeElement).toHaveTextContent('Import JSON backup')

      // Read in the microtask right after the DOM changes, before any later task can run.
      const focusWhenShown = new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          if (!host.querySelector('[role="group"]')) return
          observer.disconnect()
          resolve(document.activeElement?.textContent ?? 'none')
        })
        observer.observe(host, { childList: true, subtree: true })
      })
      // As FileReader's load event does: an update from a task of its own, not from a press.
      setTimeout(fileRead, 0)
      expect(await focusWhenShown).toBe('Cancel')
    } finally {
      root.unmount()
      host.remove()
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous)
    }
  })

  it('is a group named by its question and described by its detail', () => {
    render(
      <InlineConfirm
        question="Delete “Kopi O”?"
        detail="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    const group = screen.getByRole('group', { name: 'Delete “Kopi O”?' })
    expect(group).toHaveAccessibleDescription('This cannot be undone.')
    expect(group).toContainElement(screen.getByRole('button', { name: 'Delete' }))
  })

  it('names icon-only buttons with confirmName and cancelName', () => {
    render(
      <InlineConfirm
        layout="row"
        question="Delete Food?"
        confirmLabel={<span aria-hidden>✓</span>}
        confirmName="Delete category Food"
        cancelLabel={<span aria-hidden>✕</span>}
        cancelName="Keep Food"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Keep Food' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Delete category Food' })).toBeInTheDocument()
  })

  it('runs confirm once for a double tap or a held Enter', async () => {
    const onConfirm = vi.fn()
    render(
      <InlineConfirm
        question="Import 3 expenses?"
        confirmLabel="Confirm import"
        tone="warning"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    )
    const confirm = screen.getByRole('button', { name: 'Confirm import' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    confirm.focus()
    await userEvent.keyboard('{Enter>3/}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  // A toast can sit over the question's Delete; a tap aimed at its × as it times out must not
  // confirm what is under it. Presses are judged by when they were made: an event's time comes
  // from Date.now() in jsdom, so the test moves that clock.
  it('ignores a press on Delete where a toast has just gone', async () => {
    let now = 20_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const onConfirm = vi.fn()
      render(
        <InlineConfirm
          question="Delete all 12 expenses?"
          confirmLabel="Yes, delete all"
          onConfirm={onConfirm}
          onCancel={() => {}}
        />,
      )
      const yes = screen.getByRole('button', { name: 'Yes, delete all' })
      noteToastLeft({ left: 16, top: 668, right: 359, bottom: 724 })
      await painted()
      now += 100
      fireEvent.click(yes, { detail: 1, clientX: 200, clientY: 700 })
      expect(onConfirm).not.toHaveBeenCalled()
      now += GESTURE_MS
      fireEvent.click(yes, { detail: 1, clientX: 200, clientY: 700 })
      expect(onConfirm).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  // Escape is the reflex for backing out of a question. It must take back the question, not
  // close the sheet it sits in: the Edit sheet would drop what was changed in it.
  it('is cancelled by Escape, which goes no further', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    try {
      render(
        <InlineConfirm
          question="Delete “Kopi O”?"
          confirmLabel="Delete"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />,
      )
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      expect(fireEvent.keyDown(cancel, { key: 'Escape' })).toBe(false)
      expect(onCancel).toHaveBeenCalledTimes(1)
      // Handled: the layer stack (a document listener) leaves an Escape it finds handled.
      expect(outside.mock.calls[0]?.[0]).toHaveProperty('defaultPrevented', true)
      // From Delete too; never while an IME composes, and never by a held key's repeat.
      fireEvent.keyDown(screen.getByRole('button', { name: 'Delete' }), { key: 'Escape' })
      expect(onCancel).toHaveBeenCalledTimes(2)
      fireEvent.keyDown(cancel, { key: 'Escape', isComposing: true })
      fireEvent.keyDown(cancel, { key: 'Escape', repeat: true })
      expect(onCancel).toHaveBeenCalledTimes(2)
      expect(onConfirm).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', outside)
    }
  })

  it('draws a destructive confirm with the solid danger button', () => {
    render(
      <InlineConfirm
        question="Delete?"
        confirmLabel="Delete"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/bg-negative/)
  })
})

/** A trigger that is replaced by its confirmation, as every confirmation in the app is. */
function ClearAll({ onClear }: { onClear: () => void }) {
  const confirm = useInlineConfirm<'clear'>()
  return (
    <div>
      <button type="button">Before</button>
      {confirm.pending === 'clear' ? (
        <InlineConfirm
          question="Delete all expenses?"
          confirmLabel="Yes, delete all"
          onConfirm={() => {
            onClear()
            confirm.close()
          }}
          onCancel={() => confirm.close()}
        />
      ) : (
        <button type="button" id={confirm.triggerId()} onClick={() => confirm.ask('clear')}>
          Clear all expenses
        </button>
      )}
    </div>
  )
}

describe('useInlineConfirm', () => {
  it('puts focus back on the trigger, re-mounted, after Cancel', async () => {
    const user = userEvent.setup()
    render(<ClearAll onClear={() => {}} />)
    const trigger = screen.getByRole('button', { name: 'Clear all expenses' })
    await user.click(trigger)
    expect(trigger).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    await user.keyboard('{Enter}')
    const again = screen.getByRole('button', { name: 'Clear all expenses' })
    expect(again).not.toBe(trigger)
    expect(again).toHaveFocus()
  })

  it('puts focus back on the trigger after the action ran (never on <body>)', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(<ClearAll onClear={onClear} />)
    await user.click(screen.getByRole('button', { name: 'Clear all expenses' }))
    await user.click(screen.getByRole('button', { name: 'Yes, delete all' }))
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Clear all expenses' })).toHaveFocus()
  })

  // A double click (or a fast double tap) whose first press answers the question: the second
  // press lands on whatever took the question's place — here the trigger, re-mounted — and must
  // neither reopen the question nor move focus. jsdom has no layout, so the second press is sent
  // to the trigger by hand, the way the browser hit-tests it.
  it('swallows the second press of the double click that answered', () => {
    const onClear = vi.fn()
    render(<ClearAll onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear all expenses' }), { detail: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete all' }), { detail: 1 })
    expect(onClear).toHaveBeenCalledTimes(1)

    const trigger = screen.getByRole('button', { name: 'Clear all expenses' })
    expect(trigger).toHaveFocus()
    const down = fireEvent.mouseDown(trigger, { detail: 2 })
    fireEvent.mouseUp(trigger, { detail: 2 })
    fireEvent.click(trigger, { detail: 2 })
    fireEvent.dblClick(trigger, { detail: 2 })
    expect(down).toBe(false) // default prevented: the press does not move focus
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    // The next, separate press is the user's again.
    fireEvent.mouseDown(trigger, { detail: 1 })
    fireEvent.click(trigger, { detail: 1 })
    expect(screen.getByRole('group', { name: 'Delete all expenses?' })).toBeInTheDocument()
  })

  it('does the same after a Cancel by double click', () => {
    render(<ClearAll onClear={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear all expenses' }), { detail: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 1 })
    const trigger = screen.getByRole('button', { name: 'Clear all expenses' })
    // The second press of the double click, as the browser sends it.
    fireEvent.mouseDown(trigger, { detail: 2 })
    fireEvent.mouseUp(trigger, { detail: 2 })
    fireEvent.click(trigger, { detail: 2 })
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  // The other way round: a double click on the trigger. Its second press lands on the question
  // that just replaced the trigger, and must leave it open for the user to answer.
  it('ignores the second press of the double click that asked', () => {
    const onClear = vi.fn()
    render(<ClearAll onClear={onClear} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear all expenses' }), { detail: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete all' }), { detail: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 2 })
    expect(onClear).not.toHaveBeenCalled()
    expect(screen.getByRole('group', { name: 'Delete all expenses?' })).toBeInTheDocument()
  })

  it('answers from the keyboard without swallowing the next press', () => {
    render(<ClearAll onClear={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Clear all expenses' }), { detail: 0 })
    // Enter or Space on a button clicks it with detail 0.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Clear all expenses' }), { detail: 0 })
    expect(screen.getByRole('group', { name: 'Delete all expenses?' })).toBeInTheDocument()
  })

  // A caller may close after awaiting something (a network call): focus is back on the trigger
  // in the commit that re-mounts it, never on <body> in between.
  it('puts focus back in the same commit when closed from a later task', async () => {
    const previous: unknown = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    let closeLater: () => void = () => undefined
    function Disconnect() {
      const confirm = useInlineConfirm<true>()
      useEffect(() => {
        closeLater = () => {
          confirm.close()
        }
      })
      return confirm.pending ? (
        <InlineConfirm
          question="Disconnect this device?"
          confirmLabel="Disconnect"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      ) : (
        <button type="button" id={confirm.triggerId()} onClick={() => confirm.ask(true)}>
          Disconnect
        </button>
      )
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      root.render(<Disconnect />)
      while (!host.querySelector('button')) await tick()
      host.querySelector('button')?.click()
      while (!host.querySelector('[role="group"]')) await tick()
      await tick()

      const focusWhenBack = new Promise<string>((resolve) => {
        const observer = new MutationObserver(() => {
          if (host.querySelector('[role="group"]')) return
          observer.disconnect()
          resolve(document.activeElement?.id ?? 'none')
        })
        observer.observe(host, { childList: true, subtree: true })
      })
      setTimeout(closeLater, 0)
      const trigger = await focusWhenBack
      expect(trigger).not.toBe('')
      expect(host.querySelector('button')?.id).toBe(trigger)
    } finally {
      root.unmount()
      host.remove()
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previous)
    }
  })

  it('sends focus to a named element, or leaves it alone with null', async () => {
    const user = userEvent.setup()
    function Rows() {
      const confirm = useInlineConfirm<string>()
      const [rows, setRows] = useStateRows()
      return (
        <ul>
          {rows.map((r, i) => (
            <li key={r}>
              {confirm.pending === r ? (
                <InlineConfirm
                  layout="row"
                  question={`Delete ${r}?`}
                  confirmLabel="Yes"
                  onConfirm={() => {
                    const next = rows[i + 1] ?? rows[i - 1]
                    setRows(rows.filter((x) => x !== r))
                    confirm.close(next === undefined ? null : confirm.triggerId(next))
                  }}
                  onCancel={() => confirm.close()}
                />
              ) : (
                <button type="button" id={confirm.triggerId(r)} onClick={() => confirm.ask(r, r)}>
                  {`Delete ${r}`}
                </button>
              )}
            </li>
          ))}
        </ul>
      )
    }
    render(<Rows />)
    await user.click(screen.getByRole('button', { name: 'Delete Food & Drinks' }))
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(screen.getByRole('button', { name: 'Delete Transport' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Delete Transport' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Delete Transport' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Delete Transport' }))
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
  })
})

function useStateRows() {
  return useState(['Food & Drinks', 'Transport'])
}
