import { Profiler } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { LedgerRow } from './LedgerRow'
import { LedgerScreen } from './LedgerScreen'
import { CLICK_GUARD_MS, SNAP_HZ, SNAP_SPRING, actionOpacity, tintOpacity } from './swipe'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { GESTURE_MS, noteToastLeft } from '../../ui/pressShield'
import { springSamples } from '../../ui/spring'
import {
  installFakeAnimations,
  setReducedMotion,
  type FakeAnimations,
} from '../../__tests__/fakeAnimations'
import type { Expense } from '../../types'

// Invented data.
const KOPI: Expense = {
  id: 'e-1',
  itemName: 'Kopi O',
  amount: 1.8,
  category: 'Food',
  date: '2026-10-19T12:00:00',
  createdAt: '2026-10-19T12:00:00',
}
const GRAB: Expense = { ...KOPI, id: 'e-2', itemName: 'Grab to camp', amount: 14.2 }

function renderRows(
  onEdit = vi.fn(),
  onDelete = vi.fn(),
  rows: readonly (readonly [Expense, string])[] = [
    [KOPI, 'Oct 19'],
    [GRAB, 'Oct 19'],
  ],
) {
  const view = render(
    <ul>
      {rows.map(([e, day]) => (
        <li key={e.id}>
          <LedgerRow expense={e} dateLabel={day} onEdit={onEdit} onDelete={onDelete} />
        </li>
      ))}
    </ul>,
  )
  return { ...view, onEdit, onDelete }
}

const mainButton = (item: string) =>
  screen.getByRole('button', { name: new RegExp(`^Edit ${item}, .*, Food, Oct 19$`) })
const trashOf = (item: string) =>
  screen.getByRole('button', { name: new RegExp(`^Delete ${item}, .*, Oct 19$`) })

/** The page draws its next frame (jsdom runs animation frames on a timer). */
const painted = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(resolve, 0)
        })
      }),
  )

// Under a full parallel run on a loaded machine, the first test to render a row and drive it
// with user-event took the warm-up of React and user-event on itself, ran past
// the 5 s default and, timed out, left its key presses to land in the next test. The warm-up
// runs here instead, and the tests that drive rows and the screen have room to finish.
const ROOMY = { timeout: 30_000 }
beforeAll(async () => {
  renderRows()
  await userEvent.setup().tab()
  cleanup()
}, ROOMY.timeout)

describe('LedgerRow semantics', ROOMY, () => {
  it('is one tab stop per row: Tab goes from one row straight to the next', async () => {
    const user = userEvent.setup()
    renderRows()
    await user.tab()
    expect(mainButton('Kopi O')).toHaveFocus()
    await user.tab()
    expect(mainButton('Grab to camp')).toHaveFocus()
    await user.tab()
    expect(document.body).toHaveFocus()
  })

  it('names the row by item, amount, category and day, and says Delete deletes it', () => {
    renderRows()
    const main = mainButton('Kopi O')
    expect(main).toHaveAccessibleName(/^Edit Kopi O, .*1\.80, Food, Oct 19$/)
    expect(main).toHaveAttribute('aria-keyshortcuts', 'Delete')
  })

  it('has exactly one Delete button per row, named by item, amount and day, outside the row button', () => {
    renderRows()
    // getByRole throws unless exactly one button has the name.
    const del = trashOf('Kopi O')
    expect(del).toHaveAccessibleName(/^Delete Kopi O, .*1\.80, Oct 19$/)
    expect(del).toHaveAttribute('tabindex', '-1')
    expect(mainButton('Kopi O')).not.toContainElement(del)
    // No interactive element nested in the row button.
    expect(within(mainButton('Kopi O')).queryAllByRole('button')).toHaveLength(0)
    expect(mainButton('Kopi O').querySelector('button, a, input, select, [tabindex]')).toBeNull()
  })

  // A daily "kopi" used to give a screen reader or voice control several "Delete kopi" buttons.
  it('tells entries of the same item apart: other day, other amount', () => {
    const YESTERDAY: Expense = { ...KOPI, id: 'e-3', date: '2026-10-18T12:00:00' }
    const LARGE: Expense = { ...KOPI, id: 'e-4', amount: 2.4 }
    renderRows(vi.fn(), vi.fn(), [
      [KOPI, 'Oct 19'],
      [LARGE, 'Oct 19'],
      [YESTERDAY, 'Oct 18'],
    ])
    const names = screen
      .getAllByRole('button', { name: /^(Edit|Delete) Kopi O, / })
      .map((b) => b.getAttribute('aria-label'))
    expect(new Set(names).size).toBe(6)
  })

  it('keeps the swipe action out of the tab order and the accessibility tree', () => {
    const { container } = renderRows()
    const swipe = container.querySelectorAll('[data-swipe-delete]')
    expect(swipe).toHaveLength(2)
    for (const el of swipe) {
      expect(el).toHaveAttribute('aria-hidden', 'true')
      expect(el).toHaveAttribute('tabindex', '-1')
    }
  })
})

// On a phone a toast's × sits over the trash of the row under it. A tap aimed at the × just as
// the toast times out must not delete that row in one tap. Presses are judged by when they
// were made: an event's time comes from Date.now() in jsdom, so the test moves that clock.
describe('LedgerRow trash under a toast', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ignores a press where a toast has just gone, and takes the next one', async () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { onDelete } = renderRows()
    const trash = trashOf('Kopi O')
    noteToastLeft({ left: 16, top: 668, right: 359, bottom: 724 })
    await painted()
    now += 150
    fireEvent.click(trash, { detail: 1, clientX: 340, clientY: 700 })
    expect(onDelete).not.toHaveBeenCalled()
    // Elsewhere, or a moment later, the trash is the user's.
    fireEvent.click(trash, { detail: 1, clientX: 340, clientY: 600 })
    expect(onDelete).toHaveBeenCalledTimes(1)
    now += GESTURE_MS
    fireEvent.click(trash, { detail: 1, clientX: 340, clientY: 700 })
    expect(onDelete).toHaveBeenCalledTimes(2)
  })
})

describe('LedgerRow keyboard', ROOMY, () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes on Delete from the row button, once per press, saying when the key was pressed', () => {
    let now = 30_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { onDelete } = renderRows()
    fireEvent.keyDown(mainButton('Kopi O'), { key: 'Delete' })
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenLastCalledWith('e-1', 30_000)
    now += 700
    fireEvent.keyDown(mainButton('Grab to camp'), { key: 'Delete' })
    expect(onDelete).toHaveBeenLastCalledWith('e-2', 30_700)
    expect(onDelete).toHaveBeenCalledTimes(2)
  })

  // Focus lands on the row after every Edit sheet closes, and a reflex Backspace there (meant
  // for the text just typed) must not delete the entry. That holds on a Mac or iPhone keyboard
  // too, whose key labelled "delete" sends Backspace: fn + delete sends Delete there.
  it.each([
    [
      'a Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
    ],
    ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1'],
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'],
  ])('never deletes on Backspace, from %s keyboard either', (_, ua) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
    const { onDelete } = renderRows()
    const backspace = fireEvent.keyDown(mainButton('Grab to camp'), { key: 'Backspace' })
    expect(onDelete).not.toHaveBeenCalled()
    expect(backspace).toBe(true) // not taken over either
  })

  it('ignores the auto-repeat of a held Delete and modified presses', () => {
    const { onDelete } = renderRows()
    const main = mainButton('Kopi O')
    fireEvent.keyDown(main, { key: 'Delete', repeat: true })
    fireEvent.keyDown(main, { key: 'Delete', ctrlKey: true })
    fireEvent.keyDown(main, { key: 'Backspace', metaKey: true })
    fireEvent.keyDown(main, { key: 'Delete', altKey: true })
    fireEvent.keyDown(main, { key: 'Delete', shiftKey: true })
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('opens the editor on Enter and never deletes', async () => {
    const user = userEvent.setup()
    const { onEdit, onDelete } = renderRows()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(onEdit).toHaveBeenCalledWith(KOPI)
    await user.keyboard(' ')
    expect(onEdit).toHaveBeenCalledTimes(2)
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('deletes from the visible Delete button', async () => {
    const user = userEvent.setup()
    const { onDelete, onEdit } = renderRows()
    await user.click(trashOf('Grab to camp'))
    expect(onDelete).toHaveBeenCalledWith('e-2', expect.any(Number))
    expect(onEdit).not.toHaveBeenCalled()
  })
})

describe('LedgerRow swipe', ROOMY, () => {
  /**
   * A mouse or trackpad swipe: press on `el`, move left past the drag threshold a frame at a
   * time, release. The row moves with the pointer, so the release lands on `el` again, and the
   * browser follows it with a click there.
   */
  async function swipeFrom(el: HTMLElement) {
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, isPrimary: true }
    const at = (x: number) => ({ ...pointer, clientX: x, clientY: 20, pageX: x, pageY: 20 })
    fireEvent.pointerDown(el, at(300))
    for (let step = 1; step <= 8; step++) {
      fireEvent.pointerMove(el, at(300 - step * 10))
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
    }
    fireEvent.pointerUp(el, at(220))
    fireEvent.click(el, { detail: 1 })
  }

  it('a swipe that starts on the Delete button reveals the action and deletes nothing', async () => {
    const { onDelete, onEdit } = renderRows()
    await swipeFrom(trashOf('Kopi O'))
    expect(onDelete).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('a swipe that starts on the row button neither edits nor deletes', async () => {
    const { onDelete, onEdit } = renderRows()
    await swipeFrom(mainButton('Kopi O'))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })
})

// The swipe, step by step: framer's drag maths (src/features/ledger/swipe.ts) on pointer events.
// Event times come from Date.now() in jsdom, so the tests move that clock between events.
describe('LedgerRow swipe, step by step', ROOMY, () => {
  let clock = 0
  let fake: FakeAnimations | null = null
  beforeEach(() => {
    clock = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    fake?.restore()
    fake = null
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  function animate(): FakeAnimations {
    fake = installFakeAnimations()
    return fake
  }

  const MOUSE = { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }
  type PointerInit = Partial<typeof MOUSE> & { clientY?: number }
  const init = (x: number, extra: PointerInit = {}) => ({
    ...MOUSE,
    clientX: x,
    clientY: 20,
    ...extra,
  })
  /** Pointer events `ms` after the one before. */
  function press(el: Element, x: number, extra?: PointerInit, ms = 16) {
    clock += ms
    fireEvent.pointerDown(el, init(x, extra))
  }
  function move(el: Element, x: number, extra?: PointerInit, ms = 16) {
    clock += ms
    fireEvent.pointerMove(el, init(x, extra))
  }
  function release(el: Element, x: number, extra?: PointerInit, ms = 16) {
    clock += ms
    fireEvent.pointerUp(el, init(x, { buttons: 0, ...extra }))
  }
  /** A slow drag: from `from` to each x in turn, 100 ms apart (no flick in it). */
  function slowDrag(el: Element, from: number, xs: readonly number[]) {
    press(el, from)
    for (const x of xs) move(el, x, {}, 100)
  }
  /** The click the browser sends with a release, as a person's press (detail 1). */
  const clickOn = (el: Element) => fireEvent.click(el, { detail: 1 })
  const later = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)))

  const rowOf = (item: string) => {
    const row = mainButton(item).closest<HTMLElement>('[data-ledger-row]')
    if (!row) throw new Error(`no row for ${item}`)
    return row
  }
  const contentOf = (item: string) => {
    const content = mainButton(item).parentElement
    if (!content) throw new Error(`no content for ${item}`)
    return content
  }
  const tintOf = (item: string) => rowOf(item).querySelector<HTMLElement>('[data-swipe-tint]')
  const actionOf = (item: string) => rowOf(item).querySelector<HTMLElement>('[data-swipe-delete]')

  it('starts after 3 px and then follows the pointer from where it was pressed', () => {
    renderRows()
    const main = mainButton('Kopi O')
    const content = contentOf('Kopi O')
    press(main, 300)
    move(main, 298)
    expect(content.style.transform).toBe('')
    move(main, 296)
    expect(content.style.transform).toBe('translateX(-4px)')
    move(main, 250)
    expect(content.style.transform).toBe('translateX(-50px)')
    // The tint and the swipe Delete follow x as framer mapped them.
    expect(Number(tintOf('Kopi O')?.style.opacity)).toBeCloseTo(0.0525, 9)
    expect(Number(actionOf('Kopi O')?.style.opacity)).toBeCloseTo(0.72, 9)
  })

  it('moves on x only, within -120..0: elastic 0.12 past -120, none past 0', () => {
    renderRows()
    const main = mainButton('Kopi O')
    press(main, 300)
    move(main, 100, { clientY: 60 })
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-129.6px)')
    move(main, 350, { clientY: 0 })
    expect(contentOf('Kopi O').style.transform).toBe('translateX(0px)')
  })

  it('reveals the swipe Delete past 76 px, and snaps back short of it', () => {
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [260, 223])
    release(main, 223, {}, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
    expect(Number(actionOf('Kopi O')?.style.opacity)).toBeCloseTo(0.904, 9)

    const other = mainButton('Grab to camp')
    slowDrag(other, 300, [270, 225])
    release(other, 225, {}, 100)
    expect(contentOf('Grab to camp').style.transform).toBe('')
    expect(tintOf('Grab to camp')?.style.opacity).toBe('')
    expect(actionOf('Grab to camp')?.style.opacity).toBe('')
  })

  it('reveals on a flick to the left, however short', () => {
    renderRows()
    const main = mainButton('Kopi O')
    press(main, 300)
    move(main, 290, {}, 8)
    move(main, 275, {}, 8)
    release(main, 270, {}, 8)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
  })

  it('judges a revealed row by the same rule: a short slow drag closes it', () => {
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [250, 210])
    release(main, 210, {}, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
    slowDrag(main, 210, [204, 200])
    release(main, 200, {}, 100)
    expect(contentOf('Kopi O').style.transform).toBe('')
  })

  it('takes the click after a drag as nothing for 50 ms, then as a tap again', async () => {
    const { onEdit, onDelete } = renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [280, 260])
    release(main, 260, {}, 100)
    clickOn(main)
    clickOn(trashOf('Kopi O'))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
    await later(60)
    clickOn(main)
    expect(onEdit).toHaveBeenCalledWith(KOPI)
  })

  // The guard's length is the only protection where a phone sends the click after the release
  // and pointer capture does not move it (iOS Safari): a short drag that starts on the trash
  // must not delete the row. Clicks in the release's own tick pass with any length, even 0.
  it('holds the guard exactly 50 ms: a click at 49 ms edits and deletes nothing, at 50 ms it is a tap', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { onEdit, onDelete } = renderRows()
    const main = mainButton('Kopi O')
    // A short slow drag: the row springs back to rest, so a tap afterwards edits.
    slowDrag(main, 300, [290, 285])
    release(main, 285, {}, 100)
    act(() => {
      vi.advanceTimersByTime(CLICK_GUARD_MS - 1)
    })
    clickOn(main)
    clickOn(trashOf('Kopi O'))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    clickOn(main)
    expect(onEdit).toHaveBeenCalledWith(KOPI)
    clickOn(trashOf('Kopi O'))
    expect(onDelete).toHaveBeenCalledWith('e-1', expect.any(Number))
  })

  it('closes a revealed row on a tap, without opening the editor', async () => {
    const { onEdit } = renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [250, 200])
    release(main, 200, {}, 100)
    await later(60)
    press(main, 200, {}, 400)
    release(main, 200)
    clickOn(main)
    expect(onEdit).not.toHaveBeenCalled()
    expect(contentOf('Kopi O').style.transform).toBe('')
  })

  it('ends a cancelled drag like a release, at the last point it reached', () => {
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [250, 210])
    clock += 100
    fireEvent.pointerCancel(main, init(300))
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
  })

  // The browser took the gesture (a scroll): no click of that drag follows, so the guard ends
  // at once, and Enter on the row right after it opens the editor.
  it('ends the click guard at once when the browser cancels a drag', () => {
    const { onEdit } = renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [290, 285])
    clock += 100
    fireEvent.pointerCancel(main, init(285))
    expect(contentOf('Kopi O').style.transform).toBe('')
    fireEvent.click(main, { detail: 0 })
    expect(onEdit).toHaveBeenCalledWith(KOPI)
  })

  // Virtual scrolling unmounts rows at any time, a just-released one included.
  it('leaves no timer behind when it goes within 50 ms of a release', () => {
    const view = renderRows()
    const main = mainButton('Kopi O')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    slowDrag(main, 300, [290, 285])
    release(main, 285, {}, 100)
    const guards = timers.mock.calls.flatMap(([, ms], i) => {
      const id: unknown = timers.mock.results[i]?.value
      return ms === CLICK_GUARD_MS ? [id] : []
    })
    expect(guards).toHaveLength(1)
    expect(cleared).not.toHaveBeenCalledWith(guards[0])
    view.unmount()
    expect(cleared).toHaveBeenCalledWith(guards[0])
  })

  it('ends the drag when the row loses the pointer’s capture', () => {
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [250, 210])
    clock += 100
    fireEvent.lostPointerCapture(contentOf('Kopi O'), init(210))
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
    move(main, 150)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
  })

  it('keeps dragging when a touch hands its implicit capture over to the row', () => {
    renderRows()
    const main = mainButton('Kopi O')
    const touch = { pointerType: 'touch', pointerId: 5 }
    press(main, 300, touch)
    move(main, 280, touch, 100)
    // A touch is captured by what it went down on; taking it for the row makes that element
    // (the row button) lose it, and its lostpointercapture bubbles through the row.
    fireEvent.lostPointerCapture(main, init(280, touch))
    move(main, 210, touch, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-90px)')
    release(main, 210, touch, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
  })

  it('ends a mouse drag whose button was let go outside the window (no pointerup came)', () => {
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [250, 210])
    move(main, 205, { buttons: 0 }, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
    move(main, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
  })

  it('drags with the primary pointer or the left mouse button only', () => {
    renderRows()
    const main = mainButton('Kopi O')
    press(main, 300, { button: 2, buttons: 2 })
    move(main, 250, { buttons: 2 })
    expect(contentOf('Kopi O').style.transform).toBe('')
    release(main, 250, { button: 2 })

    const touch = { pointerType: 'touch', pointerId: 7 }
    press(main, 300, { ...touch, isPrimary: false })
    move(main, 250, { ...touch, isPrimary: false })
    expect(contentOf('Kopi O').style.transform).toBe('')

    press(main, 300, touch)
    move(main, 280, { pointerType: 'touch', pointerId: 8 })
    expect(contentOf('Kopi O').style.transform).toBe('')
    move(main, 280, touch)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-20px)')
  })

  it('takes the pointer’s capture as the drag starts, never on the press', () => {
    const capture = vi.fn()
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      value: capture,
    })
    renderRows()
    const main = mainButton('Kopi O')
    press(main, 300)
    move(main, 299)
    expect(capture).not.toHaveBeenCalled()
    move(main, 290)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.contexts[0]).toBe(contentOf('Kopi O'))
    expect(capture).toHaveBeenCalledWith(1)
  })

  it('under reduced motion it still follows the finger, and snaps at once', () => {
    const animations = animate()
    setReducedMotion(true)
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [280, 250])
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-50px)')
    release(main, 250, {}, 100)
    expect(contentOf('Kopi O').style.transform).toBe('')
    expect(animations.animated).toEqual([])
  })

  it('snaps on framer’s spring from where it was let go, the target written first', () => {
    const animations = animate()
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [280, 250])
    release(main, 250, {}, 100)
    const content = contentOf('Kopi O')
    // Where it ends, under the animation: seamless once it is over.
    expect(content.style.transform).toBe('')
    expect(tintOf('Kopi O')?.style.opacity).toBe('')

    // Still for 100 ms before the release: no velocity left.
    const snap = springSamples({ from: -50, to: 0, velocity: 0, ...SNAP_SPRING }, SNAP_HZ)
    const [moving, tint, action] = animations.animated
    expect(animations.animated).toHaveLength(3)
    expect(moving?.element).toBe(content)
    expect(moving?.keyframes).toEqual(
      snap.values.map((x) => ({ transform: `translateX(${String(x)}px)` })),
    )
    expect(moving?.options).toEqual({ duration: snap.duration, easing: 'linear' })
    expect(tint?.element).toBe(tintOf('Kopi O'))
    expect(tint?.keyframes).toEqual(snap.values.map((x) => ({ opacity: tintOpacity(x) })))
    expect(action?.element).toBe(actionOf('Kopi O'))
    expect(action?.keyframes).toEqual(snap.values.map((x) => ({ opacity: actionOpacity(x) })))
  })

  it('carries the row’s own velocity into the snap', () => {
    const animations = animate()
    renderRows()
    const main = mainButton('Kopi O')
    press(main, 300)
    move(main, 260, {}, 100)
    move(main, 250, {}, 16)
    release(main, 248, {}, 4)
    // The row moved 10 px in the 16 ms before its last move, 4 ms before the release.
    const snap = springSamples({ from: -50, to: 0, velocity: -625, ...SNAP_SPRING }, SNAP_HZ)
    expect(animations.animated[0]?.keyframes).toEqual(
      snap.values.map((x) => ({ transform: `translateX(${String(x)}px)` })),
    )
  })

  it('a drag that starts on a settling row takes over from where it is, without a jump', () => {
    const animations = animate()
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [280, 250])
    release(main, 250, {}, 100)
    const snap = springSamples({ from: -50, to: 0, velocity: 0, ...SNAP_SPRING }, SNAP_HZ)
    const running = [...animations.animated]
    for (const a of running) a.currentTime = snap.step * 3
    const here = snap.values[3] ?? NaN

    press(main, 250, {}, 50)
    move(main, 246)
    expect(running.every((a) => a.playState === 'idle')).toBe(true)
    expect(contentOf('Kopi O').style.transform).toBe(`translateX(${String(here - 4)}px)`)
  })

  it('a tap on a settling row lets it settle', () => {
    const animations = animate()
    renderRows()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [280, 250])
    release(main, 250, {}, 100)
    const running = [...animations.animated]
    expect(running).toHaveLength(3)
    press(main, 250, {}, 50)
    release(main, 250, {}, 60)
    expect(running.every((a) => a.playState === 'running')).toBe(true)
  })

  it('keeps the moving content on a layer of its own while it moves, and lets it go after', () => {
    const animations = animate()
    renderRows()
    const main = mainButton('Kopi O')
    const content = contentOf('Kopi O')
    expect(content.style.willChange).toBe('')
    slowDrag(main, 300, [260, 200])
    expect(content.style.willChange).toBe('transform')
    release(main, 200, {}, 100)
    expect(content.style.willChange).toBe('transform')
    act(() => {
      animations.finishAll()
    })
    expect(content.style.willChange).toBe('')
    expect(content.style.transform).toBe('translateX(-96px)')
  })

  it('re-renders nothing while it is dragged and let go', () => {
    const renders = vi.fn()
    render(
      <Profiler id="row" onRender={renders}>
        <LedgerRow expense={KOPI} dateLabel="Oct 19" onEdit={vi.fn()} onDelete={vi.fn()} />
      </Profiler>,
    )
    renders.mockClear()
    const main = mainButton('Kopi O')
    slowDrag(main, 300, [290, 280, 260, 240, 220, 200])
    release(main, 200, {}, 100)
    expect(contentOf('Kopi O').style.transform).toBe('translateX(-96px)')
    expect(renders).not.toHaveBeenCalled()
  })

  it('lets the page scroll vertically from a row, and keeps text and callouts out of a drag', () => {
    renderRows()
    const content = contentOf('Kopi O')
    expect(rowOf('Kopi O')).toHaveClass('touch-pan-y')
    expect(content).toHaveClass('touch-pan-y', 'select-none', '[-webkit-touch-callout:none]')
    expect(content).toHaveAttribute('draggable', 'false')
    expect(tintOf('Kopi O')).toHaveAttribute('aria-hidden', 'true')
    expect(tintOf('Kopi O')).toHaveClass('pointer-events-none', 'bg-negative', 'opacity-0')
    expect(actionOf('Kopi O')).toHaveClass('opacity-0')
  })
})

// The rows inside the real screen: where focus goes once the focused row is gone, and focus
// in the screen's scrolling range row.
describe('Ledger screen focus', ROOMY, () => {
  // Three days, newest first in the list: A (Oct 19), B (Oct 18), C (Oct 17).
  const day = (id: string, itemName: string, date: string): Expense => ({
    id,
    itemName,
    amount: 3,
    category: 'Food',
    date: `${date}T12:00:00`,
    createdAt: `${date}T12:00:00`,
  })
  const A = day('a', 'Laksa', '2026-10-19')
  const B = day('b', 'Teh peng', '2026-10-18')
  const C = day('c', 'Bus fare', '2026-10-17')

  let clock = 0
  const scrollIntoView = vi.fn()
  beforeEach(() => {
    // The screen ignores a delete until the last one has been on screen for 450 ms (a reflex
    // double tap), judged by when the press was made: event times come from Date.now() here.
    clock = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.stubGlobal('matchMedia', (media: string) =>
      Object.assign(new EventTarget(), { media, matches: false }),
    )
    // jsdom does not lay out, so it has no scrollIntoView; record the calls instead.
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
    })
    useExpenseStore.setState({ expenses: [A, B, C], hydrated: true })
  })
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    scrollIntoView.mockClear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** The screen shows the last change, and a deliberate second passes before the next key. */
  const later = async () => {
    await painted()
    clock += 1000
  }

  function renderLedger() {
    const router = createMemoryRouter([{ path: '/ledger', element: <LedgerScreen /> }], {
      initialEntries: ['/ledger?range=all'],
    })
    render(<RouterProvider router={router} />)
  }
  const row = (item: string) => screen.getByRole('button', { name: new RegExp(`^Edit ${item},`) })
  const ids = () => useExpenseStore.getState().expenses.map((e) => e.id)

  /** The browser's own call (jsdom guesses differently): the ring shows after a key. */
  function ringAfterKeys() {
    const native: unknown = Reflect.get(Element.prototype, 'matches')
    if (typeof native !== 'function') throw new Error('no Element.prototype.matches')
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selectors: string,
    ): boolean {
      return selectors === ':focus-visible' || Reflect.apply(native, this, [selectors]) === true
    })
  }

  it('moves focus to the row that takes its place, then the one before, then the heading', async () => {
    ringAfterKeys()
    renderLedger()
    row('Teh peng').focus()
    fireEvent.keyDown(row('Teh peng'), { key: 'Delete' })
    expect(ids()).toEqual(['a', 'c'])
    expect(row('Bus fare')).toHaveFocus()
    // Scrolled only as far as needed to keep it clear of the bars.
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })

    await later()
    fireEvent.keyDown(row('Bus fare'), { key: 'Delete' })
    expect(ids()).toEqual(['a'])
    expect(row('Laksa')).toHaveFocus()

    await later()
    fireEvent.keyDown(row('Laksa'), { key: 'Delete' })
    expect(ids()).toEqual([])
    expect(screen.getByRole('heading', { level: 1, name: 'Ledger' })).toHaveFocus()
  })

  // A second Delete that comes before the screen has shown the first one for a moment is a
  // reflex: the row it lands on slid there a moment ago, unseen.
  it('ignores a delete made before the last one had been on screen for a moment', async () => {
    renderLedger()
    fireEvent.keyDown(row('Teh peng'), { key: 'Delete' })
    expect(ids()).toEqual(['a', 'c'])
    // Not drawn yet: a key pressed now cannot be aimed at the row that took its place.
    clock += 2000
    fireEvent.keyDown(row('Bus fare'), { key: 'Delete' })
    expect(ids()).toEqual(['a', 'c'])
    await painted()
    clock += 300
    fireEvent.keyDown(row('Bus fare'), { key: 'Delete' })
    expect(ids()).toEqual(['a', 'c'])
    clock += 200
    fireEvent.keyDown(row('Bus fare'), { key: 'Delete' })
    expect(ids()).toEqual(['a'])
  })

  it('moves on from a clicked Delete, and leaves focus alone when another row goes', async () => {
    const user = userEvent.setup()
    renderLedger()
    const search = screen.getByRole('textbox', { name: 'Search expenses' })
    search.focus()
    await user.click(screen.getByRole('button', { name: /^Delete Laksa, / }))
    expect(ids()).toEqual(['b', 'c'])
    // A click focuses what it lands on; the row it was in is gone, so focus moves on. No ring
    // shows after a click, so nothing is scrolled (or measured) for it.
    expect(row('Teh peng')).toHaveFocus()
    expect(scrollIntoView).not.toHaveBeenCalled()
    row('Bus fare').focus()
    act(() => {
      useExpenseStore.getState().deleteExpense('b')
    })
    expect(row('Bus fare')).toHaveFocus()
  })

  // The six ranges scroll sideways on a narrow phone, and the arrow keys move focus by script,
  // which no browser scrolls into a part-hidden spot: focus brings the whole option into view.
  it('brings a range option that takes focus fully into view inside its scrolling row', async () => {
    const user = userEvent.setup()
    renderLedger()
    screen.getByRole('radio', { name: 'All' }).focus()
    scrollIntoView.mockClear()
    await user.keyboard('{ArrowRight}')
    const custom = screen.getByRole('radio', { name: 'Custom' })
    expect(custom).toHaveFocus()
    expect(scrollIntoView.mock.contexts).toContain(custom)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
  })

  it('labels each day with a level-2 heading under the screen heading', () => {
    renderLedger()
    const h1 = screen.getByRole('heading', { level: 1, name: 'Ledger' })
    expect(h1).toHaveAttribute('tabindex', '-1')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toHaveLength(3)
  })
})
