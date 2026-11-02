import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TOAST_ROOM,
  clearClearance,
  clearanceOf,
  publishClearance,
  revealFocus,
  revealInSheet,
} from './toastClearance'

// jsdom has no layout: each box gets the rect it would have on a 375 x 812 iPhone, where the
// toast stack (88 px above the bottom) sits over the end of the Settings sheet (the probe that
// found "Import JSON backup" fully covered after a Restore: button [20,683,349,723], toast
// [16,658,359,724]).
interface Box {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

function place(el: HTMLElement, b: Box): void {
  el.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top })
}

function sized(el: HTMLElement, props: Record<string, number>): void {
  for (const [k, v] of Object.entries(props))
    Object.defineProperty(el, k, { value: v, configurable: true })
}

let region: HTMLElement
let scroller: HTMLElement
let scrollBy: ReturnType<typeof vi.fn<(opts: ScrollToOptions) => void>>

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('innerHeight', 812)
  region = document.createElement('div')
  region.append(document.createElement('div'))
  place(region, { top: 658, bottom: 724, left: 16, right: 359 })
  sized(region, { offsetHeight: 66 })
  // a sheet: the dialog panel, and its scrolling body
  const sheet = document.createElement('div')
  sheet.setAttribute('role', 'dialog')
  scroller = document.createElement('div')
  scroller.setAttribute(TOAST_ROOM, '')
  sheet.append(scroller)
  scroller.style.overflowY = 'auto'
  sized(scroller, { scrollHeight: 2000, clientHeight: 600 })
  place(scroller, { top: 120, bottom: 812, left: 0, right: 375 })
  scrollBy = vi.fn<(opts: ScrollToOptions) => void>()
  Object.defineProperty(scroller, 'scrollBy', { value: scrollBy })
  document.body.append(sheet, region)
})

afterEach(() => {
  clearClearance()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Publishes, then lets its frames run (the room, then the reveal once the room is laid out). */
function publish(): void {
  publishClearance(region)
  vi.advanceTimersToNextFrame()
  vi.advanceTimersToNextFrame()
}

function focused(b: Box, parent: HTMLElement = scroller): HTMLButtonElement {
  const button = document.createElement('button')
  parent.append(button)
  place(button, b)
  button.focus()
  return button
}

const IMPORT = { top: 683, bottom: 723, left: 20, right: 349 }

describe('the toast stack never hides the focused control (WCAG 2.2 SC 2.4.11)', () => {
  it('measures the stack from the bottom of the screen, with a gap', () => {
    // 66 px of toasts, 88 px above the bottom, 8 px gap
    expect(clearanceOf(region)).toBe(162)
    region.replaceChildren()
    expect(clearanceOf(region)).toBe(0)
  })

  it('gives the open sheet the clearance as scroll room, and scrolls a covered control clear', () => {
    focused(IMPORT)
    publishClearance(region)
    // measured once, on the next frame (the layout that frame needs anyway)
    expect(scroller.style.getPropertyValue('--toast-clearance')).toBe('')
    expect(scrollBy).not.toHaveBeenCalled()
    vi.advanceTimersToNextFrame()
    expect(scroller.style.getPropertyValue('--toast-clearance')).toBe('162px')
    // the new room is laid out by the next frame (a transition holds the old padding till then)
    expect(scrollBy).not.toHaveBeenCalled()
    vi.advanceTimersToNextFrame()
    // its bottom (723) goes to the top of the band (812 - 162 = 650)
    expect(scrollBy).toHaveBeenCalledWith({ top: 73 })
    // with the room unchanged, focus moving under the stack is revealed in its own frame
    scrollBy.mockClear()
    publishClearance(region)
    vi.advanceTimersToNextFrame()
    expect(scrollBy).toHaveBeenCalledWith({ top: 73 })
    // only the sheet restyles: a custom property on <html> restyled the whole page (every
    // Ledger row) on each toast, which doubled the time from a Delete to its paint
    expect(document.documentElement.style.getPropertyValue('--toast-clearance')).toBe('')
  })

  it('measures and restyles nothing while no sheet is open (a toast on the page)', () => {
    scroller.removeAttribute(TOAST_ROOM)
    let reads = 0
    Object.defineProperty(region, 'offsetHeight', {
      configurable: true,
      get: () => {
        reads++
        return 66
      },
    })
    focused(IMPORT)
    publishClearance(region)
    publishClearance(region)
    vi.advanceTimersToNextFrame()
    expect(reads).toBe(0)
    expect(scrollBy).not.toHaveBeenCalled()
    expect(scroller.style.getPropertyValue('--toast-clearance')).toBe('')
  })

  it('asks for one measurement a frame, however often the stack or focus changes', () => {
    let reads = 0
    Object.defineProperty(region, 'offsetHeight', {
      configurable: true,
      get: () => {
        reads++
        return 66
      },
    })
    for (let i = 0; i < 5; i++) publishClearance(region)
    vi.advanceTimersToNextFrame()
    // clearanceOf reads it twice (is there a stack, how tall is it)
    expect(reads).toBe(2)
    for (let i = 0; i < 5; i++) publishClearance(region)
    vi.advanceTimersToNextFrame()
    // the room's own reveal frame took the asks: one more measurement, for the reveal
    expect(reads).toBe(4)
  })

  it('brings the whole question clear when it fits, so its buttons are not under a toast', () => {
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    scroller.append(group)
    place(group, { top: 560, bottom: 760, left: 16, right: 359 })
    // the REPLACE field is in sight; its Replace button (the group's bottom) is under the toast
    focused({ top: 600, bottom: 640, left: 20, right: 180 }, group)
    revealFocus(region, clearanceOf(region))
    expect(scrollBy).toHaveBeenCalledWith({ top: 110 })
  })

  // 320 x 568 with two toasts up: the whole question is taller than the room above the stack.
  it('brings the field and the button row below it when the whole question does not fit', () => {
    vi.stubGlobal('innerHeight', 568)
    place(region, { top: 330, bottom: 480, left: 16, right: 304 })
    sized(region, { offsetHeight: 150 })
    place(scroller, { top: 60, bottom: 568, left: 0, right: 320 })
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    scroller.append(group)
    // the question (detail, field, buttons) runs 300 px; the field starts 150 px down it
    place(group, { top: 250, bottom: 550, left: 16, right: 304 })
    focused({ top: 400, bottom: 444, left: 30, right: 290 }, group)
    // band top = 568 - (150 + 88 + 8) = 322; room above it = 322 - 60 - 8 = 254 < 300
    revealFocus(region, clearanceOf(region))
    // the field's top (400) to the group's bottom (550) is 150 px: both go above the band
    expect(scrollBy).toHaveBeenCalledWith({ top: 550 - 322 })
  })

  it('reveals the question a field opens in, inside its sheet (the REPLACE field)', () => {
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    scroller.append(group)
    // a 1280 x 900 laptop: the field is in sight, its Replace button past the sheet's edge
    vi.stubGlobal('innerHeight', 900)
    place(scroller, { top: 60, bottom: 900, left: 980, right: 1280 })
    place(group, { top: 700, bottom: 940, left: 1000, right: 1260 })
    const field = focused({ top: 780, bottom: 824, left: 1016, right: 1244 }, group)
    revealInSheet(field)
    // the group's bottom (940) goes 8 px above the sheet's bottom edge (900)
    expect(scrollBy).toHaveBeenCalledWith({ top: 940 - 892 })
  })

  it('reveals a field above the toast stack when one covers the sheet', () => {
    focused(IMPORT)
    publish()
    scrollBy.mockClear()
    const group = document.createElement('div')
    group.setAttribute('role', 'group')
    scroller.append(group)
    place(group, { top: 520, bottom: 700, left: 16, right: 359 })
    const field = focused({ top: 560, bottom: 600, left: 20, right: 349 }, group)
    revealInSheet(field)
    // the band starts at 812 - 162 = 650
    expect(scrollBy).toHaveBeenCalledWith({ top: 50 })
  })

  it('leaves a control the stack does not cover alone', () => {
    focused({ top: 500, bottom: 540, left: 20, right: 349 })
    publish()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('leaves a control beside the stack alone (a laptop: the stack is in the corner)', () => {
    place(region, { top: 700, bottom: 776, left: 900, right: 1260 })
    focused({ top: 720, bottom: 760, left: 20, right: 300 })
    publish()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('does nothing without toasts, and forgets the clearance when the host goes', () => {
    region.replaceChildren()
    focused(IMPORT)
    publish()
    expect(scroller.style.getPropertyValue('--toast-clearance')).toBe('0px')
    expect(scrollBy).not.toHaveBeenCalled()
    clearClearance()
    expect(scroller.style.getPropertyValue('--toast-clearance')).toBe('')
  })

  // The Ledger: a reader's place, and the rows under a finger, never move because a toast came.
  it('never scrolls the page itself, only the sheet a control is in', () => {
    const windowScroll = vi.fn()
    vi.stubGlobal('scrollBy', windowScroll)
    focused(IMPORT, document.body)
    publish()
    // a scrolling list on the page is the page too
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    sized(list, { scrollHeight: 2000, clientHeight: 600 })
    const listScroll = vi.fn()
    Object.defineProperty(list, 'scrollBy', { value: listScroll })
    document.body.append(list)
    focused(IMPORT, list)
    publish()
    expect(windowScroll).not.toHaveBeenCalled()
    expect(listScroll).not.toHaveBeenCalled()
    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('never moves focus or scrolls for a control inside the stack (its own Undo)', () => {
    const undo = document.createElement('button')
    region.append(undo)
    place(undo, { top: 670, bottom: 702, left: 280, right: 320 })
    undo.focus()
    publish()
    expect(scrollBy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(undo)
  })
})
