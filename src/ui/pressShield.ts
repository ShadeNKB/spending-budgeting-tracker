import { CONFIRM_DELAY_MS } from '../utils/amountGuard'

/**
 * Presses that must not land where they fall.
 *
 * A press that changes what is under the pointer ends its gesture: Save closes its sheet, a
 * picked day closes the calendar, a tapped row opens the Edit sheet over the list, a trigger
 * turns into its question, a trash takes its row away. The second press of a double click or a
 * double tap would otherwise act on whatever took that place: a row's trash on the page behind
 * the closing sheet, a category chip under the calendar, Undo on the toast that just appeared,
 * the trash of the row that slid up. So the layer stack, the inline confirmations and the ledger
 * call `shieldGesture()` as they change, and the presses that follow closely are swallowed
 * whole: none of their pointer, mouse or click events gets past the window, so they move no
 * focus and activate nothing. A phone's second tap reports a click count of 1, so a press
 * belongs to the gesture by place and time: within SLOP_PX of the first, and made before the
 * change had been on screen for GESTURE_MS. A mouse's also by the browser's own count (detail 2
 * and up, for as long as a system allows a double click). The first separate press ends it.
 *
 * Time is when a press was made (its `timeStamp`), never when the page gets round to it: a busy
 * page (a long list re-rendering after Save) can handle a second tap made 120 ms after the first
 * a second later. And until the change has been painted, nobody can have aimed at what it put
 * there: a press made before then (a second tap on a screen that has not caught up yet) is part
 * of the gesture however late it comes. A change made while the page is still handling one of
 * the press's events is that press's doing, however long the page takes to make it.
 *
 * A pointer press is delivered whole or not at all: the rest of a slow double click is
 * swallowed from its mousedown on, and its pointerup still follows the pointerdown that got
 * through, so a row's drag or a chart's scrub that started there also ends.
 *
 * A toast leaves by itself, under a finger that may be reaching for its ×. For a moment after,
 * a press where it was may still be aimed at it: the destructive controls that can sit under a
 * toast (a ledger row's trash, a confirmation's Delete) ask `toastJustLeft()` and ignore such a
 * press. Anything else takes it (an Add the toast covered is pressed as soon as it shows).
 *
 * Clicks from the keyboard (detail 0) always pass. Place and time count only for presses a
 * person makes (`isTrusted`): a test library's presses all land at 0,0 a few ms apart.
 */

/** A second press this soon after the change it follows is on screen is the same gesture. */
export const GESTURE_MS = CONFIRM_DELAY_MS
/** ...and this close to the first: a second tap lands a little off the first. */
export const SLOP_PX = 40
/** Longer than any double-click time a system allows (Windows: 500 ms default, 900 ms max). */
const MULTI_CLICK_MS = 1000

/** What the shield reads of a pointer or mouse event (a DOM one has it all). */
export interface PressEvent {
  readonly type: string
  readonly isTrusted: boolean
  readonly clientX: number
  readonly clientY: number
  /** The click count of a mouse event: 0 for a click from the keyboard, 2 for a double click. */
  readonly detail: number
  /** Set on pointer events. */
  readonly pointerType?: string
  /** When the press was made, on the clock every event is stamped with. */
  readonly timeStamp: number
}

/** Where and when a press was made (a DOM mouse or pointer event has both). */
export interface PressPoint {
  readonly clientX: number
  readonly clientY: number
  readonly timeStamp: number
}

export interface ShieldRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface ShieldClock {
  /** Now, on the clock events are stamped with: the `timeStamp` of an event made now. */
  readonly stamp: () => number
  /** Now, as the page runs: how long ago it handled an event. */
  readonly now: () => number
  /** Calls `done` once the task running now (the handling of one event) is over. */
  readonly afterTask: (done: () => void) => void
  /** Calls `done` once the page has painted what has changed by now. */
  readonly afterPaint: (done: () => void) => void
}

/**
 * The time in which a press may still have been aimed at what a change replaced: until the
 * change has been painted, then `ms` more. On the events' clock.
 */
interface Unseen {
  /** Null until the change has been painted. */
  end: number | null
}

function unseenFrom(clock: ShieldClock, ms: number): Unseen {
  const window: Unseen = { end: null }
  clock.afterPaint(() => {
    window.end = clock.stamp() + ms
  })
  return window
}

const covers = (window: Unseen, at: number): boolean => window.end === null || at <= window.end

interface Zone {
  /** Only presses numbered after this one can be swallowed. */
  readonly after: number
  /** While a press that `contains` is swallowed. */
  readonly unseen: Unseen
  /** Until when the rest of a mouse multi-click (detail 2 and up) is swallowed. */
  readonly clicksUntil: number
  readonly contains: (x: number, y: number) => boolean
}

interface Press {
  readonly seq: number
  readonly x: number
  readonly y: number
  readonly trusted: boolean
  /** When it was made and when it ended (events' clock); null while it is held. */
  readonly startedAt: number
  endedAt: number | null
  /** When the page handled its last event (page clock): whether a change now is its doing. */
  handledAt: number
}

export interface PressShield {
  /** Feeds one pointer or mouse event through; true when it is to be swallowed. */
  readonly swallows: (event: PressEvent) => boolean
  /** A key went down: whatever changes next, the keyboard did it. */
  readonly keyPressed: () => void
  /**
   * Ends the gesture of the press in progress or just ended (a no-op after a key: the keyboard
   * did it). `click`, when the caller is handling one, is evidence enough of a press.
   */
  readonly shieldGesture: (click?: { readonly detail: number; readonly timeStamp: number }) => void
}

const nowhere = () => false

/** The shield's rules on clocks of their own, so they can be tested without a browser. */
export function createPressShield(clock: ShieldClock): PressShield {
  let seq = 0
  let press: Press | null = null
  let zones: Zone[] = []
  let swallowing = false
  // A mouse press fires pointerdown, then mousedown: one press, not two. A touch screen sends
  // its mousedown after the pointerup.
  let pointerPressOpen = false
  // Whether the pointerdown of that press was swallowed: its pointerup goes the same way.
  let pointerSwallowed = false
  // From the press's first event to its click.
  let inPress = false
  // Set while an event of the latest press is being handled. A change made then (the commit a
  // click runs) is the press's doing, however long the page takes to get there: on a busy
  // phone, rendering 2,000 rows can take longer than GESTURE_MS between the click and the
  // closing of the sheet.
  let pressTask = 0
  let tasks = 0

  /** A separate press ends the gestures before it (not the one it is making itself). */
  const endGestures = () => {
    zones = zones.filter((z) => z.after >= seq)
  }

  const startPress = (event: PressEvent) => {
    const at = event.timeStamp
    inPress = true
    seq += 1
    zones = zones.filter((z) => covers(z.unseen, at) || at <= z.clicksUntil)
    const hit =
      event.isTrusted &&
      zones.some(
        (z) => z.after < seq && covers(z.unseen, at) && z.contains(event.clientX, event.clientY),
      )
    swallowing = hit
    if (!hit)
      press = {
        seq,
        x: event.clientX,
        y: event.clientY,
        trusted: event.isTrusted,
        startedAt: at,
        endedAt: null,
        handledAt: clock.now(),
      }
  }

  const endPress = (event: PressEvent) => {
    if (swallowing || !press) return
    press.endedAt = event.timeStamp
    press.handledAt = clock.now()
  }

  /** A mouse press's click count: 1 is a separate press, 2 and up the rest of a double click. */
  const countClicks = (event: PressEvent) => {
    if (swallowing) return
    if (event.detail <= 1) endGestures()
    else swallowing = zones.some((z) => z.after < seq && event.timeStamp <= z.clicksUntil)
  }

  /** Whether `event` is the rest of a gesture (or of a press already swallowed). */
  const judge = (event: PressEvent): boolean => {
    switch (event.type) {
      case 'pointerdown':
        startPress(event)
        pointerPressOpen = true
        pointerSwallowed = swallowing
        // A tap that misses the zones is a separate press: the gesture is over. A mouse press
        // waits for its mousedown, whose click count says whether it is a slow double click.
        if (!swallowing && event.pointerType !== 'mouse') endGestures()
        return swallowing
      case 'mousedown': {
        if (!pointerPressOpen) startPress(event)
        pointerPressOpen = false
        countClicks(event)
        return swallowing
      }
      case 'pointerup':
      case 'pointercancel': {
        const swallowed = pointerSwallowed
        pointerSwallowed = false
        // A cancelled press (a scroll) has no click, nor mouse events, to end it. A mouse's
        // mousedown came before its pointerup; a touch screen or a pen sends its own after it.
        if (event.type === 'pointercancel') inPress = false
        if (
          event.type === 'pointercancel' ||
          (event.pointerType !== 'touch' && event.pointerType !== 'pen')
        )
          pointerPressOpen = false
        endPress(event)
        return swallowed
      }
      case 'click': {
        if (event.detail === 0) return false
        // A click with no press before it (a test library's): a press of its own.
        if (!inPress) {
          startPress(event)
          countClicks(event)
        }
        inPress = false
        pointerPressOpen = false
        endPress(event)
        return swallowing
      }
      default:
        // mouseup, dblclick
        return event.detail !== 0 && swallowing
    }
  }

  const swallows = (event: PressEvent): boolean => {
    const swallowed = judge(event)
    // An event of the press that the page goes on to handle. (A click a key makes has no press
    // since that key went down: keyPressed.)
    if (!swallowed && press !== null) {
      const task = ++tasks
      pressTask = task
      clock.afterTask(() => {
        if (pressTask === task) pressTask = 0
      })
    }
    return swallowed
  }

  const shieldGesture = (click?: { readonly detail: number; readonly timeStamp: number }) => {
    const recent =
      press !== null && (pressTask !== 0 || clock.now() - press.handledAt <= GESTURE_MS)
    if (!recent && !(click && click.detail >= 1)) return
    const near = recent && press?.trusted === true ? { x: press.x, y: press.y } : null
    // A system counts a double click from the first press's click.
    const from =
      recent && press ? (press.endedAt ?? press.startedAt) : (click?.timeStamp ?? clock.stamp())
    zones.push({
      after: seq,
      unseen: unseenFrom(clock, GESTURE_MS),
      clicksUntil: from + MULTI_CLICK_MS,
      contains: near ? (x, y) => Math.hypot(x - near.x, y - near.y) <= SLOP_PX : nowhere,
    })
  }

  const keyPressed = () => {
    press = null
  }

  return { swallows, keyPressed, shieldGesture }
}

const pageClock: ShieldClock = {
  // An event made now: its timeStamp is on the clock every event is stamped with.
  stamp: () => new Event('').timeStamp,
  now: () => performance.now(),
  afterTask: (done) => {
    setTimeout(done, 0)
  },
  // The frame's callbacks run before it paints; a task queued from one runs after.
  afterPaint: (done) => {
    requestAnimationFrame(() => {
      setTimeout(done, 0)
    })
  },
}

const shield = createPressShield(pageClock)

function onPress(event: MouseEvent): void {
  if (!shield.swallows(event)) return
  // Default prevented: a mousedown moves no focus and starts no selection; a click follows no
  // link and submits nothing. Stopped on the window, before React or any other listener sees it.
  if (event.type !== 'pointerdown' && event.type !== 'pointerup') event.preventDefault()
  event.stopImmediatePropagation()
}

// Capture on the window: ahead of every listener in the page, React's included.
for (const type of [
  'pointerdown',
  'mousedown',
  'pointerup',
  'pointercancel',
  'mouseup',
  'click',
  'dblclick',
] as const)
  window.addEventListener(type, onPress, true)
window.addEventListener('keydown', shield.keyPressed, true)

/** Swallow the rest of the gesture whose press is changing the screen now. */
export const shieldGesture = shield.shieldGesture

/** A change on its way onto the screen. */
export interface Change {
  /**
   * The press was made before the change had been painted and in view for a moment: it was
   * aimed at what was there before.
   */
  readonly includes: (press: { readonly timeStamp: number }) => boolean
}

/** A change going on screen now (a toast appearing, a row taken away); the moment is `ms`. */
export function changingNow(ms: number = GESTURE_MS): Change {
  const unseen = unseenFrom(pageClock, ms)
  return { includes: (press) => covers(unseen, press.timeStamp) }
}

/** Where toasts were, until a press there can no longer have been aimed at them. */
let toastsLeft: { readonly rect: ShieldRect; readonly unseen: Unseen }[] = []

/** A toast has left `rect` (it timed out, or was dismissed). */
export function noteToastLeft(rect: ShieldRect): void {
  const at = pageClock.stamp()
  toastsLeft = [
    ...toastsLeft.filter((t) => covers(t.unseen, at)),
    { rect, unseen: unseenFrom(pageClock, GESTURE_MS) },
  ]
}

/** Whether `press` may have been aimed at a toast that had just left the spot it landed on. */
export function toastJustLeft(press: PressPoint): boolean {
  const { clientX: x, clientY: y, timeStamp: at } = press
  return toastsLeft.some(
    ({ rect, unseen }) =>
      covers(unseen, at) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
  )
}
