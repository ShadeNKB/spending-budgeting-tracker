import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { shieldGesture } from './pressShield'

/**
 * One stack of modal layers: the sheets, the command palette and the date picker.
 *
 * Each layer used to manage Escape, Tab and focus on its own, so Escape in the date picker
 * closed the whole Add sheet, focus escaped behind the palette, and a sheet that opened with an
 * autofocused field recorded that field as the place to return to (ending on <body>). Here one
 * keydown and one focusin listener on the document act for the top layer only:
 *
 * - Escape closes the top layer (not one a control already handled, nor one ending an IME
 *   composition).
 * - Tab and Shift+Tab cycle the top layer's tab stops.
 * - Focus that lands outside the top layer is sent back inside it (`[data-layer-exempt]`, the
 *   toast region, may keep it).
 * - On close, focus goes back to what opened the layer, captured while rendering, before an
 *   autoFocus child can take focus; else to `returnFocus()`; else to the screen heading, without
 *   scrolling to it (the page stays where the reader left it).
 *   A layer opened from another layer that closes in the same commit (the palette's "Add
 *   expense") inherits that layer's opener.
 * - Page scroll stays locked while any locking overlay is in the page, whatever order they leave
 *   in: from the moment its box mounts until the box leaves, after its exit (holdScrollLock).
 * - A closed layer is inert while it animates out, and presses pass through it to the page (its
 *   content and live regions, see announce.ts, leave the accessibility tree at once).
 * - A press that opens or closes a layer ends its gesture (pressShield.ts): the second press of
 *   a double click or double tap on Save, a day, a row or a trigger is swallowed, so it never
 *   lands on what the change put under the pointer (a row's trash behind the closing sheet, a
 *   chip under the calendar, the content of a sheet that just opened).
 * - A press that closes the top layer (a tap outside the date picker) is not also a press on
 *   the layer under it: see pressedWhileOnTop.
 */

export interface ModalLayerOptions {
  /** The layer's root (the dialog element, `tabIndex={-1}`). */
  readonly ref: RefObject<HTMLElement | null>
  /** Escape while this layer is on top. */
  readonly onEscape: () => void
  /**
   * Where focus starts. Without it: an element inside that took focus as it mounted (an
   * autoFocus field) keeps it, else the layer element itself is focused.
   */
  readonly initialFocus?: () => HTMLElement | null
  /** Asked on close only when the element that opened the layer is gone. */
  readonly returnFocus?: () => HTMLElement | null
}

interface Layer {
  readonly seq: number
  readonly element: HTMLElement
  readonly returnTarget: HTMLElement | null
  readonly options: RefObject<ModalLayerOptions>
  lastFocused: HTMLElement | null
}

/** What can take focus in this app (it has no iframes, image maps or editable regions). */
const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]'

/** A press this recent names the control that opened a layer. */
const PRESS_WINDOW_MS = 1000
/** Safari sends the key that ends an IME composition just after compositionend. */
const COMPOSITION_TAIL_MS = 100

const stack: Layer[] = []
/** Layers closed in the current commit, kept until its microtask so a new layer can inherit. */
const justClosed: Layer[] = []
/** The one focus return still to run: for the layer that closed last. */
let pendingReturn: ReturnType<typeof setTimeout> | undefined
let nextSeq = 0
let scrollLocks = 0
let overflowBeforeLock = ''
let composing = false
let compositionEndedAt = Number.NEGATIVE_INFINITY
let lastPress: { readonly target: Element; readonly at: number } | null = null
/**
 * The top layer as the press in progress began (null: none was open), until its click is over.
 * Undefined between presses.
 */
let pressTop: Layer | null | undefined

// Safari (and so every iPhone browser) never focuses a tapped button, so the element focused at
// open time is often <body> or a text field typed in earlier; the control pressed just before
// the layer opened is the one to return to. Recorded from the first overlay chunk on, ahead of
// any layer's own outside-press listener (the date picker closes on one).
document.addEventListener(
  'pointerdown',
  (event) => {
    if (event.target instanceof Element) lastPress = { target: event.target, at: performance.now() }
    pressTop = stack.at(-1) ?? null
  },
  true,
)
// A key pressed since then means the keyboard opens whatever opens next (Tab to Settings and
// Enter, a shortcut), from the focused control, not the field clicked a moment before.
document.addEventListener(
  'keydown',
  () => {
    lastPress = null
  },
  true,
)
// Bubbling to the window: after every handler of the click has read pressTop.
window.addEventListener('click', () => {
  pressTop = undefined
})

/**
 * Whether the press now ending began with `element`'s layer on top, or no layer at all (true
 * too for a click sent from code, with no press). False for the tap outside the date picker
 * that closed it: landing on the sheet's backdrop, it must not close the sheet, and the entry
 * typed in it, as well.
 */
export function pressedWhileOnTop(element: HTMLElement | null): boolean {
  return pressTop === undefined || pressTop === null || pressTop.element === element
}

// ─── focus helpers ────────────────────────────────────────────────────────────

/** Has a box and is not `visibility: hidden`. Without any layout (unit tests) only CSS counts. */
function isRendered(el: HTMLElement): boolean {
  const laidOut = document.documentElement.getClientRects().length > 0
  if (laidOut && el.getClientRects().length === 0) return false
  return getComputedStyle(el).visibility !== 'hidden'
}

function canTakeFocus(el: HTMLElement): boolean {
  return (
    el.isConnected &&
    el !== document.body &&
    el.matches(FOCUSABLE) &&
    !el.matches(':disabled') &&
    el.closest('[inert]') === null &&
    isRendered(el)
  )
}

function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && canTakeFocus(el),
  )
}

/** `a` comes before `b` in document order (an ancestor comes before what it contains). */
const precedes = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

function focusedElement(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement && active !== document.body ? active : null
}

/**
 * Focus without the browser's scroll jump. Back on the page, a keyboard user's focus (the ring
 * shows) is then scrolled the least needed to clear the sticky header and the tab bar (the
 * control's scroll margin, the page's scroll-padding); after a tap or click nothing moves.
 * Inside a layer the control stays where it was, in the layer's own scroller.
 */
function focusQuietly(el: HTMLElement, onPage: boolean): void {
  el.focus({ preventScroll: true })
  if (!onPage || !el.matches(':focus-visible')) return
  const box = el.getBoundingClientRect()
  // No box, nothing to bring into view (and no layout at all in unit tests).
  if (box.width === 0 && box.height === 0) return
  el.scrollIntoView({ block: 'nearest' })
}

/** The element to return to: the pressed control, else the focused one (render time). */
function captureOpener(): HTMLElement | null {
  const active = focusedElement()
  const pressed =
    lastPress && lastPress.target.isConnected && performance.now() - lastPress.at < PRESS_WINDOW_MS
      ? lastPress.target.closest<HTMLElement>(FOCUSABLE)
      : null
  // Not an option in a layer that is closing (animating out): it is no place to come back to.
  const press = pressed?.closest('[inert]') === null ? pressed : null
  if (press && (!active || !press.contains(active))) return press
  return active
}

/** Where focus goes back to, and whether it may be scrolled into view. */
function returnTargetOf(
  layer: Layer,
): { readonly element: HTMLElement; readonly scroll: boolean } | null {
  let target = layer.returnTarget
  if (!target || !canTakeFocus(target)) target = layer.options.current.returnFocus?.() ?? null
  if (!target || !canTakeFocus(target)) target = document.querySelector<HTMLElement>('main h1')
  if (!target || !canTakeFocus(target)) return null
  // The screen heading is where focus waits when nothing on the page had it (a shortcut on a
  // page scrolled with the wheel): the next Tab starts in the screen, but the page stays where
  // the reader left it, also when the heading is what a later layer opened from.
  return { element: target, scroll: !target.matches('main h1') }
}

/** Focus back inside `layer`: where it last was, else its first stop, else the layer itself. */
function focusInside(layer: Layer): void {
  const last = layer.lastFocused
  if (last && layer.element.contains(last) && canTakeFocus(last)) {
    last.focus({ preventScroll: true })
    return
  }
  ;(tabStops(layer.element)[0] ?? layer.element).focus({ preventScroll: true })
}

// ─── document listeners ───────────────────────────────────────────────────────

function isComposingKey(event: KeyboardEvent): boolean {
  return (
    event.isComposing ||
    event.key === 'Process' ||
    composing ||
    performance.now() - compositionEndedAt < COMPOSITION_TAIL_MS
  )
}

/**
 * Between stops the browser moves focus itself (selecting a field's text as only a real Tab
 * does), also from a focused element that is no stop (the dialog itself, a roving grid day).
 * Past the last stop, or before the first, focus wraps around instead of leaving the layer.
 * The wrap is a Tab, so it asks for the ring: WebKit draws none for this script focus when the
 * control focused before it was tapped.
 */
function trapTab(layer: Layer, event: KeyboardEvent): void {
  const stops = tabStops(layer.element)
  const active = focusedElement()
  if (active && layer.element.contains(active)) {
    const hasNext = event.shiftKey
      ? stops.some((el) => precedes(el, active))
      : stops.some((el) => precedes(active, el))
    if (hasNext) return
  }
  event.preventDefault()
  ;((event.shiftKey ? stops.at(-1) : stops[0]) ?? layer.element).focus({ focusVisible: true })
}

function onKeyDown(event: KeyboardEvent): void {
  const top = stack.at(-1)
  if (!top || event.defaultPrevented) return
  if (event.key === 'Escape') {
    // One layer per press: a held key's auto-repeat would go on to close the sheet under the
    // calendar it closed, or the one a question was just taken back in, with what was typed.
    if (isComposingKey(event) || event.repeat) return
    event.preventDefault()
    top.options.current.onEscape()
  } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
    trapTab(top, event)
  }
}

function onFocusIn(event: FocusEvent): void {
  const target = event.target
  const top = stack.at(-1)
  if (!(target instanceof HTMLElement) || !top) return
  if (top.element.contains(target)) {
    top.lastFocused = target
    return
  }
  if (target.closest('[data-layer-exempt]')) return
  // Checked after the commit: a layer opening in it may own the element (an autoFocus field
  // takes focus before its layer registers).
  queueMicrotask(() => {
    const current = stack.at(-1)
    if (!current || document.activeElement !== target) return
    if (current.element.contains(target)) current.lastFocused = target
    else focusInside(current)
  })
}

function onCompositionStart(): void {
  composing = true
}

function onCompositionEnd(): void {
  composing = false
  compositionEndedAt = performance.now()
}

// Bubble phase for keys: a control that handles Escape itself (and cancels it) runs first.
// The listeners do nothing while no layer is open.
document.addEventListener('keydown', onKeyDown)
document.addEventListener('focusin', onFocusIn, true)
document.addEventListener('compositionstart', onCompositionStart, true)
document.addEventListener('compositionend', onCompositionEnd, true)

function unlockScroll(): void {
  scrollLocks -= 1
  if (scrollLocks === 0) document.body.style.overflow = overflowBeforeLock
}

/**
 * The ref of an overlay's outermost box (the one that stays in the page while it animates out:
 * sheets and the palette, not the date picker). Page scroll stays locked from the moment the box
 * mounts, before its layer opens and its entrance starts, until the box leaves the page, after
 * its exit. Never at the close: WebKit (every iPhone browser) puts a running CSS transition at
 * its end when the body's overflow changes, so a sheet unlocked as it closed skipped its whole
 * slide away, and the page would scroll under a sheet still on screen. A reopen on its way out
 * keeps the same box and leaves the body alone. Its cleanup (React 19) lets go; StrictMode's
 * second attach locks once more after its cleanup.
 */
export function holdScrollLock(box: HTMLElement | null): (() => void) | undefined {
  if (!box) return undefined
  if (scrollLocks === 0) {
    overflowBeforeLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1
  return unlockScroll
}

// ─── the stack ────────────────────────────────────────────────────────────────

function openLayer(
  element: HTMLElement,
  opener: HTMLElement | null,
  options: RefObject<ModalLayerOptions>,
): Layer {
  const closedAround = opener ? justClosed.find((l) => l.element.contains(opener)) : undefined
  const layer: Layer = {
    seq: ++nextSeq,
    element,
    returnTarget: closedAround ? closedAround.returnTarget : opener,
    options,
    lastFocused: null,
  }
  stack.push(layer)
  // A double tap on what opened it: the second tap would land in the new layer.
  shieldGesture()
  // Reopened while it was still animating out.
  element.removeAttribute('inert')

  const preferred = options.current.initialFocus?.() ?? null
  if (preferred && element.contains(preferred)) preferred.focus({ preventScroll: true })
  const active = focusedElement()
  if (!active || !element.contains(active)) element.focus({ preventScroll: true })
  const now = focusedElement()
  layer.lastFocused = now && element.contains(now) ? now : null
  return layer
}

function handBack(layer: Layer): void {
  const top = stack.at(-1)
  // A layer opened since (or StrictMode's re-run of this one) owns focus now.
  if (top && top.seq > layer.seq) return
  // Focus the user already moved on stays there: the field tapped under the closed calendar.
  const active = focusedElement()
  if (active && !layer.element.contains(active)) return
  const target = returnTargetOf(layer)
  if (top && !(target && top.element.contains(target.element))) focusInside(top)
  else if (target) focusQuietly(target.element, top === undefined && target.scroll)
}

function closeLayer(layer: Layer): void {
  const index = stack.indexOf(layer)
  if (index === -1) return
  const wasTop = index === stack.length - 1
  stack.splice(index, 1)
  // A double tap on Save, a day or the backdrop: the second tap would land on what is under it.
  shieldGesture()
  justClosed.push(layer)
  queueMicrotask(() => {
    justClosed.splice(justClosed.indexOf(layer), 1)
    // Not when the same element registered again in this commit (StrictMode runs a mounting
    // layer's effects twice): inert would take focus from its autofocused field.
    if (!stack.some((l) => l.element === layer.element)) layer.element.setAttribute('inert', '')
  })
  if (!wasTop) return
  // In a task of its own, once the key that closed the layer is done with: Chromium sends the
  // keypress after an Enter to whatever has focus by then, and the Enter that saved the Add sheet
  // pressed the Search button that focus had just gone back to. Two layers closing one after the
  // other (Escape, Escape) move focus once.
  clearTimeout(pendingReturn)
  pendingReturn = setTimeout(() => {
    pendingReturn = undefined
    handBack(layer)
  }, 0)
}

/**
 * Registers the element behind `options.ref` as a modal layer while `active`. Options are read
 * at the moment they are needed, so callers may pass fresh closures on every render.
 */
export function useModalLayer(active: boolean, options: ModalLayerOptions): void {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  })

  // The opener is read while rendering the open state: React runs a child's autoFocus during
  // the commit, before any effect, and would otherwise be taken for the opener.
  const [opener, setOpener] = useState(() => (active ? captureOpener() : null))
  const [activeSeen, setActiveSeen] = useState(active)
  if (active !== activeSeen) {
    setActiveSeen(active)
    if (active) setOpener(captureOpener())
  }

  useLayoutEffect(() => {
    const element = optionsRef.current.ref.current
    if (!active || !element) return
    const layer = openLayer(element, opener, optionsRef)
    return () => {
      closeLayer(layer)
    }
  }, [active, opener])
}
