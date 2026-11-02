// The toasts float over whatever is at the bottom of the screen, and on a phone that is where an
// open sheet's last controls are (Settings › Backup: Import, the REPLACE field, the remove
// question). WCAG 2.2 SC 2.4.11 (Focus Not Obscured): the focused control is never left under a
// toast. Once a frame, while a sheet is open, the host measures how much of the bottom its stack
// covers and gives each open sheet's scroller (`data-toast-room`) that much more bottom padding
// (`--toast-clearance`, on the scroller itself, so only the sheet restyles), then scrolls the
// focused control (with the question it belongs to) clear inside its sheet. The page itself is
// never scrolled: that would move the owner's place in the Ledger, and the rows under a finger,
// each time a toast came (a page control under a toast is uncovered within seconds, as the toast
// goes). With no sheet open nothing is measured or restyled at all: a toast on the page (every
// add, every delete) costs no extra layout.

/** Space kept between a revealed control and the top of the stack (or the sheet's edge). */
const GAP = 8

/** A sheet's scroller whose bottom padding grows by what the toast stack covers. */
export const TOAST_ROOM = 'data-toast-room'
const CLEARANCE = '--toast-clearance'

let frame = 0

/** Px from the bottom of the viewport to the top of the toast stack (0 when it is empty). */
export function clearanceOf(region: HTMLElement): number {
  if (region.childElementCount === 0 || region.offsetHeight === 0) return 0
  const bottom = Math.max(0, window.innerHeight - region.getBoundingClientRect().bottom)
  return Math.ceil(region.offsetHeight + bottom + GAP)
}

const openRooms = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[${TOAST_ROOM}]`))

/**
 * The scroller of the sheet (dialog) a control is in: its nearest ancestor inside the dialog that
 * scrolls vertically. Null for a control on the page, which is never scrolled.
 */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  const layer = el.closest<HTMLElement>('[role="dialog"]')
  if (layer === null) return null
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
      return p
    }
    if (p === layer) return null
  }
  return null
}

interface Span {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

const spanOf = ({ top, bottom, left, right }: Span): Span => ({ top, bottom, left, right })

/**
 * What to bring into sight, as a span of the screen: the question the control belongs to (an
 * InlineConfirm or TypedConfirm group) when it fits in `room`; else the control down to the end
 * of its question (the REPLACE field with its Replace button, which sits below it); else the
 * control alone.
 */
function revealSpan(el: HTMLElement, room: number): Span {
  const own = el.getBoundingClientRect()
  const group = el.closest<HTMLElement>('[role="group"]')
  if (group === null) return own
  const whole = group.getBoundingClientRect()
  if (whole.height <= room) return whole
  if (whole.bottom - own.top <= room) return { ...spanOf(whole), top: own.top }
  return own
}

/**
 * Scrolls the sheet `el` is in, the least needed, so that `el` (with its question, see
 * revealSpan) ends above `limit` px from the top of the screen. Nothing on the page moves.
 */
function revealAbove(el: HTMLElement, limit: number): void {
  const scroller = scrollerOf(el)
  if (scroller === null) return
  const top = scroller.getBoundingClientRect().top
  const span = revealSpan(el, limit - top - GAP)
  if (span.bottom > limit) scroller.scrollBy({ top: span.bottom - limit })
}

/**
 * A control that has just taken focus in a sheet, scrolled into sight with the rest of its
 * question (TypedConfirm: the field and the button it enables). The sheet's own edge is the
 * limit, and the top of the toast stack where one covers the sheet.
 */
export function revealInSheet(el: HTMLElement): void {
  const scroller = scrollerOf(el)
  if (scroller === null) return
  const padding = parseFloat(getComputedStyle(scroller).getPropertyValue(CLEARANCE))
  const band = window.innerHeight - (Number.isFinite(padding) ? padding : 0)
  revealAbove(el, Math.min(band, scroller.getBoundingClientRect().bottom - GAP))
}

/**
 * Scrolls the focused control clear of the stack when the stack covers part of it, or of the
 * question it belongs to (a focused REPLACE field with its Replace button under a toast).
 */
export function revealFocus(region: HTMLElement, clearance: number): void {
  if (clearance === 0) return
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || el === document.body || region.contains(el)) return
  if (el.getBoundingClientRect().height === 0) return
  const scroller = scrollerOf(el)
  if (scroller === null) return
  const stack = region.getBoundingClientRect()
  const bandTop = window.innerHeight - clearance
  const span = revealSpan(el, bandTop - scroller.getBoundingClientRect().top - GAP)
  const covered =
    span.bottom > bandTop &&
    span.top < window.innerHeight &&
    span.right > stack.left &&
    span.left < stack.right
  if (!covered) return
  scroller.scrollBy({ top: span.bottom - bandTop })
}

/**
 * On the next frame (once per frame, however often it is asked): gives every open sheet the
 * stack's clearance as scroll room, then keeps the focused control clear. In a frame, the
 * browser's own scroll for a focus that just moved (which runs after the focus events) is done,
 * so it never undoes the reveal, and the layout read here is the one the frame needs anyway.
 * Room that changed is laid out by the frame after (every property transitions, even under
 * reduced motion, which leaves a 10 µs transition): the reveal then waits for that frame, or the
 * scroll would stop short at the old end.
 */
export function publishClearance(region: HTMLElement): void {
  if (frame !== 0) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const rooms = openRooms()
    if (rooms.length === 0) return
    const px = clearanceOf(region)
    const value = `${String(px)}px`
    let grew = false
    for (const room of rooms) {
      if (room.style.getPropertyValue(CLEARANCE) === value) continue
      room.style.setProperty(CLEARANCE, value)
      grew = true
    }
    if (!grew) {
      revealFocus(region, px)
      return
    }
    frame = requestAnimationFrame(() => {
      frame = 0
      revealFocus(region, clearanceOf(region))
    })
  })
}

/** The host unmounted: nothing covers the screen any more. */
export function clearClearance(): void {
  if (frame !== 0) cancelAnimationFrame(frame)
  frame = 0
  for (const room of openRooms()) room.style.removeProperty(CLEARANCE)
}
