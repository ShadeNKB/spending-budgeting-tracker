import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GESTURE_MS,
  SLOP_PX,
  changingNow,
  createPressShield,
  noteToastLeft,
  toastJustLeft,
  type PressEvent,
} from './pressShield'

/**
 * A shield on clocks the test moves by hand: `made` is the events' clock (when a press is made,
 * its `timeStamp`), `handled` the page's (when the page gets round to it). They run together
 * until `busy()` holds the page up. The task that handled the last event is over once time
 * passes (`wait`), not while the page is busy in it.
 */
function setup() {
  let made = 1000
  let handled = 70_000
  let paints: (() => void)[] = []
  let tasks: (() => void)[] = []
  const shield = createPressShield({
    stamp: () => made,
    now: () => handled,
    afterTask: (done) => {
      tasks.push(done)
    },
    afterPaint: (done) => {
      paints.push(done)
    },
  })
  const wait = (ms: number) => {
    const due = tasks
    tasks = []
    for (const done of due) done()
    made += ms
    handled += ms
  }
  /** The page is stuck in work for `ms` (a long list re-rendering): it handles nothing. */
  const busy = (ms: number) => {
    handled += ms
  }
  /** The page draws what has changed: from now on it can be seen. */
  const paint = () => {
    const due = paints
    paints = []
    for (const done of due) done()
  }
  /**
   * The events of one press, as a browser sends them, made `at` (now by default) and handled
   * now; returns which of them were swallowed.
   */
  const pressAt = (
    x: number,
    y: number,
    opts: { pointerType?: string; detail?: number; trusted?: boolean; at?: number } = {},
  ): string[] => {
    const { pointerType = 'touch', detail = 1, trusted = true, at = made } = opts
    const base = { isTrusted: trusted, clientX: x, clientY: y, timeStamp: at }
    const pointer: PressEvent[] = [
      { ...base, type: 'pointerdown', detail: 0, pointerType },
      { ...base, type: 'pointerup', detail: 0, pointerType },
    ]
    const mouse: PressEvent[] = [
      { ...base, type: 'mousedown', detail },
      { ...base, type: 'mouseup', detail },
      { ...base, type: 'click', detail },
    ]
    if (detail === 2) mouse.push({ ...base, type: 'dblclick', detail })
    // A mouse fires mousedown before pointerup; a touch screen sends its mouse events after.
    const [down, up] = pointer
    const events =
      pointerType === 'mouse' ? [down, mouse[0], up, ...mouse.slice(1)] : [down, up, ...mouse]
    return events.flatMap((e) => (e && shield.swallows(e) ? [e.type] : []))
  }
  return { shield, wait, busy, paint, pressAt, now: () => made }
}

const WHOLE_PRESS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']

describe('pressShield: the rest of a gesture that changed the screen', () => {
  it('swallows a second tap on the same spot (a phone reports detail 1 for it)', () => {
    const { shield, wait, paint, pressAt } = setup()
    expect(pressAt(100, 700)).toEqual([])
    shield.shieldGesture() // the tap closed a sheet
    paint()
    wait(120)
    expect(pressAt(104, 703)).toEqual(WHOLE_PRESS)
    // A third tap of the same burst too.
    wait(120)
    expect(pressAt(100, 700)).toEqual(WHOLE_PRESS)
  })

  it('lets a press through once the gesture is over: later, or elsewhere', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700)
    shield.shieldGesture()
    paint()
    wait(GESTURE_MS + 1)
    expect(pressAt(100, 700)).toEqual([])

    pressAt(100, 700)
    shield.shieldGesture()
    paint()
    wait(50)
    expect(pressAt(100 + SLOP_PX + 1, 700)).toEqual([])
  })

  it('is over at the first separate tap, even if a later one comes back to the spot', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700)
    shield.shieldGesture()
    paint()
    wait(60)
    expect(pressAt(300, 200)).toEqual([])
    wait(60)
    expect(pressAt(100, 700)).toEqual([])
  })

  // A busy page (2,000 rows re-rendering after Save) can handle a second tap made 120 ms after
  // the first long after the gesture's time is up by its own clock. It still belongs to the
  // gesture: the second tap is judged by when it was made.
  it('judges a press by when it was made, not by when a busy page handles it', () => {
    const { shield, wait, busy, paint, pressAt, now } = setup()
    pressAt(100, 700)
    shield.shieldGesture()
    paint()
    const second = now() + 120
    wait(150)
    busy(700)
    expect(pressAt(102, 701, { at: second })).toEqual(WHOLE_PRESS)
  })

  // Save re-renders 2,000 rows before the sheet's closing commit: on a slow phone the change
  // comes later than GESTURE_MS after the click was handled, in the same task. It is still the
  // click's doing, and its gesture still ends.
  it('takes a change at the end of a long task as the doing of the press that task handles', () => {
    const { shield, wait, busy, paint, pressAt, now } = setup()
    pressAt(100, 700)
    busy(GESTURE_MS + 500)
    shield.shieldGesture()
    paint()
    const second = now() + 120
    wait(120)
    expect(pressAt(101, 702, { at: second })).toEqual(WHOLE_PRESS)
  })

  // A screen that has not caught up still shows Save: a second tap on it, however late, was
  // aimed at Save, never at the trash the closing sheet has uncovered.
  it('takes every press near it as part of the gesture until the change has been painted', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700)
    shield.shieldGesture()
    wait(900)
    expect(pressAt(100, 700)).toEqual(WHOLE_PRESS)
    paint()
    wait(GESTURE_MS - 50)
    expect(pressAt(100, 700)).toEqual(WHOLE_PRESS)
    wait(51)
    expect(pressAt(100, 700)).toEqual([])
  })

  it('swallows the rest of a slow mouse double click by its click count', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700, { pointerType: 'mouse' })
    shield.shieldGesture()
    paint()
    // Past the tap window, inside the system's double-click time: the browser counts it as 2.
    wait(GESTURE_MS + 150)
    expect(pressAt(100, 700, { pointerType: 'mouse', detail: 2 })).toEqual([
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
    ])
    // A new click (count 1) is the user's again.
    wait(300)
    expect(pressAt(100, 700, { pointerType: 'mouse' })).toEqual([])
  })

  // The browser counts a double click from the first click: a second press it counts as such
  // is swallowed however late the page handles it.
  it('counts a double click from when its first click was made', () => {
    const { shield, wait, busy, paint, pressAt, now } = setup()
    pressAt(100, 700, { pointerType: 'mouse' })
    shield.shieldGesture()
    paint()
    const second = now() + GESTURE_MS + 150
    wait(GESTURE_MS + 200)
    busy(1500)
    expect(pressAt(100, 700, { pointerType: 'mouse', detail: 2, at: second })).toContain('click')
  })

  // The second press of a slow double click lands on the row the change uncovered. A row is
  // a drag: its pointerdown got through and started one, and a drag that never sees its
  // pointerup follows the mouse with no button held, and leaves the row's swipe Delete out.
  it('delivers a pointer press whole: a pointerdown that got through gets its pointerup', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700, { pointerType: 'mouse' })
    shield.shieldGesture()
    paint()
    wait(GESTURE_MS + 150)
    const swallowed = pressAt(100, 700, { pointerType: 'mouse', detail: 2 })
    expect(swallowed).not.toContain('pointerdown')
    expect(swallowed).not.toContain('pointerup')
    // ...and one swallowed from its pointerdown on loses its pointerup too.
    pressAt(100, 700)
    shield.shieldGesture()
    paint()
    wait(100)
    expect(pressAt(100, 700)).toEqual(expect.arrayContaining(['pointerdown', 'pointerup']))
  })

  it('does nothing for a change the keyboard made', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700)
    shield.keyPressed()
    shield.shieldGesture() // Escape closed the sheet
    paint()
    wait(50)
    expect(pressAt(100, 700)).toEqual([])
  })

  it('does nothing for a change long after the last press (a timer, a sync)', () => {
    const { shield, wait, paint, pressAt } = setup()
    pressAt(100, 700)
    wait(GESTURE_MS + 100)
    shield.shieldGesture()
    paint()
    wait(20)
    expect(pressAt(100, 700)).toEqual([])
  })

  it('never swallows a click from the keyboard', () => {
    const { shield, wait, now } = setup()
    shield.shieldGesture({ detail: 1, timeStamp: now() })
    wait(10)
    expect(
      shield.swallows({
        type: 'click',
        isTrusted: true,
        clientX: 0,
        clientY: 0,
        detail: 0,
        timeStamp: now(),
      }),
    ).toBe(false)
  })

  it('lets the press that made the change finish where it landed (a tap outside a calendar)', () => {
    const { shield, now } = setup()
    const base = { isTrusted: true, clientX: 50, clientY: 400, timeStamp: now() }
    // The calendar closes on this press's pointerdown, before its mousedown and click.
    expect(shield.swallows({ ...base, type: 'pointerdown', detail: 0, pointerType: 'touch' })).toBe(
      false,
    )
    shield.shieldGesture()
    expect(shield.swallows({ ...base, type: 'pointerup', detail: 0, pointerType: 'touch' })).toBe(
      false,
    )
    for (const type of ['mousedown', 'mouseup', 'click'])
      expect(shield.swallows({ ...base, type, detail: 1 })).toBe(false)
  })

  it('judges distance and time only for presses a person makes (a test library’s land at 0,0)', () => {
    const { shield, wait, pressAt } = setup()
    pressAt(0, 0, { trusted: false })
    shield.shieldGesture()
    wait(10)
    expect(pressAt(0, 0, { trusted: false })).toEqual([])
    // A synthetic double click still counts as one by its click count.
    pressAt(0, 0, { trusted: false })
    shield.shieldGesture()
    expect(pressAt(0, 0, { trusted: false, pointerType: 'mouse', detail: 2 })).toContain('click')
  })
})

/** The page draws its next frame (jsdom runs animation frames on a timer). */
const painted = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0)
    })
  })

describe('pressShield: a spot a toast just left', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Event times come from Date.now() in jsdom: the test moves that clock.
  it('says a press there may be aimed at the gone toast, for a moment and only there', async () => {
    let now = 5000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    noteToastLeft({ left: 16, top: 668, right: 359, bottom: 724 })
    await painted()
    now += 100
    const at = (clientX: number, clientY: number) => ({ clientX, clientY, timeStamp: now })
    expect(toastJustLeft(at(340, 700))).toBe(true) // its ×, over a row's trash
    expect(toastJustLeft(at(340, 600))).toBe(false) // above it
    now += GESTURE_MS
    expect(toastJustLeft(at(340, 700))).toBe(false)
  })

  it('judges the press by when it was made, and keeps the spot until the page has redrawn', async () => {
    let now = 9000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    noteToastLeft({ left: 16, top: 668, right: 359, bottom: 724 })
    // Not drawn yet: the toast still shows there, so a press there is still aimed at it.
    now += 2000
    expect(toastJustLeft({ clientX: 340, clientY: 700, timeStamp: now })).toBe(true)
    await painted()
    const madeEarlier = now - 1500
    now += GESTURE_MS + 1
    expect(toastJustLeft({ clientX: 340, clientY: 700, timeStamp: madeEarlier })).toBe(true)
    expect(toastJustLeft({ clientX: 340, clientY: 700, timeStamp: now })).toBe(false)
  })
})

describe('pressShield: a change going on screen now', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('holds a press made before the change has been in view for a moment', async () => {
    let now = 40_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const toast = changingNow()
    now += 5000 // a page that has not drawn it yet
    expect(toast.includes({ timeStamp: now })).toBe(true)
    await painted()
    expect(toast.includes({ timeStamp: now + GESTURE_MS })).toBe(true)
    expect(toast.includes({ timeStamp: now + GESTURE_MS + 1 })).toBe(false)
  })

  it('lasts as long as it is asked to', async () => {
    let now = 60_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const deleted = changingNow(450)
    await painted()
    now += 449
    expect(deleted.includes({ timeStamp: now })).toBe(true)
    now += 2
    expect(deleted.includes({ timeStamp: now })).toBe(false)
  })
})
