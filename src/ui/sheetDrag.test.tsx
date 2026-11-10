import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { dragCloses } from './sheetDrag'
import { Sheet } from './Sheet'

describe('dragCloses', () => {
  it('stays for a pull up, a small pull down, or no pull', () => {
    expect(dragCloses(0, 0, 500)).toBe(false)
    expect(dragCloses(-40, 2, 500)).toBe(false)
    expect(dragCloses(60, 0, 500)).toBe(false)
  })

  it('closes past 30 % of the height, 140 px at most', () => {
    // 30 % of 500 is 150: capped at 140
    expect(dragCloses(139, 0, 500)).toBe(false)
    expect(dragCloses(140, 0, 500)).toBe(true)
    expect(dragCloses(59, 0, 200)).toBe(false)
    expect(dragCloses(60, 0, 200)).toBe(true)
  })

  it('closes on a flick down, once it has travelled 24 px', () => {
    expect(dragCloses(30, 0.6, 500)).toBe(true)
    expect(dragCloses(20, 0.6, 500)).toBe(false)
    expect(dragCloses(30, 0.4, 500)).toBe(false)
  })
})

// jsdom stamps events from Date.now(): the tests move that clock between events.
describe('a bottom sheet pulled down', () => {
  let clock = 0
  beforeEach(() => {
    clock = 50_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const FINGER = { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }
  const at = (y: number) => ({ ...FINGER, clientX: 100, clientY: y })
  function open(onClose = vi.fn()) {
    render(
      <Sheet open onClose={onClose} title="Add expense" side="bottom">
        <input aria-label="What" />
      </Sheet>,
    )
    const panel = screen.getByRole('dialog')
    Object.defineProperty(panel, 'offsetHeight', { value: 500, configurable: true })
    const handle = panel.querySelector('[data-sheet-handle]')
    if (!(handle instanceof HTMLElement)) throw new Error('no handle')
    return { panel, handle, title: screen.getByRole('heading', { name: 'Add expense' }), onClose }
  }
  /** Press at 100, then move to each y, `ms` apart. */
  function pull(el: Element, ys: readonly number[], ms = 16) {
    fireEvent.pointerDown(el, at(100))
    for (const y of ys) {
      clock += ms
      fireEvent.pointerMove(el, at(y))
    }
  }

  it('follows the finger down, and never above its place', () => {
    const { panel, handle } = open()
    pull(handle, [103])
    expect(panel.style.transform).toBe('') // inside the slop: a tap moves nothing
    pull(handle, [140])
    expect(panel.style.transform).toBe('translateY(40px)')
    expect(panel.style.transition).toBe('none')
    clock += 16
    fireEvent.pointerMove(handle, at(60))
    expect(panel.style.transform).toBe('translateY(0px)')
  })

  it('released far enough down, closes, and hands the transform back to the classes', () => {
    const { panel, title, onClose } = open()
    pull(title, [150, 200, 250], 200)
    clock += 200
    fireEvent.pointerUp(title, at(250))
    expect(onClose).toHaveBeenCalledOnce()
    expect(panel.style.transform).toBe('')
    expect(panel.style.transition).toBe('')
  })

  it('released after a short slow pull, springs back and stays open', () => {
    const { panel, handle, onClose } = open()
    pull(handle, [120, 150], 200)
    clock += 200
    fireEvent.pointerUp(handle, at(150))
    expect(onClose).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('')
  })

  it('a quick flick down closes though it travels little', () => {
    const { handle, onClose } = open()
    pull(handle, [115, 130, 145], 10)
    clock += 10
    fireEvent.pointerUp(handle, at(145))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a finger that rests before lifting is not a flick', () => {
    const { handle, onClose } = open()
    pull(handle, [115, 130, 145], 10)
    clock += 400
    fireEvent.pointerUp(handle, at(145))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a cancelled pull (the system took the touch) never closes', () => {
    const { panel, handle, onClose } = open()
    pull(handle, [200, 300], 200)
    fireEvent.pointerCancel(handle, at(300))
    expect(onClose).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('')
  })

  it('a press on Close is a press on Close, not a pull', () => {
    const { panel, onClose } = open()
    const close = screen.getByRole('button', { name: 'Close' })
    pull(close, [200, 300], 200)
    expect(panel.style.transform).toBe('')
    fireEvent.pointerUp(close, at(300))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the click that ends a pull presses nothing; the next click does', () => {
    const { handle, title } = open()
    const pressed = vi.fn()
    title.addEventListener('click', pressed)
    pull(handle, [120, 150], 200)
    clock += 200
    fireEvent.pointerUp(handle, at(150))
    fireEvent.click(title)
    expect(pressed).not.toHaveBeenCalled()
    fireEvent.click(title)
    expect(pressed).toHaveBeenCalledOnce()
  })

  it('a side sheet is not pulled, and has no handle', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Settings" side="right">
        <input aria-label="What" />
      </Sheet>,
    )
    const panel = screen.getByRole('dialog')
    expect(panel.querySelector('[data-sheet-handle]')).toBeNull()
    const title = screen.getByRole('heading', { name: 'Settings' })
    pull(title, [200, 400], 200)
    fireEvent.pointerUp(title, at(400))
    expect(panel.style.transform).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('is pulled by touch only where the pull is its own: touch-action none on the grip', () => {
    const { handle, title } = open()
    expect(handle.parentElement).toHaveClass('touch-none')
    expect(handle.parentElement).toContainElement(title)
    // From 768 px the sheet is a column closed by Close, Escape or the backdrop: no handle.
    expect(handle).toHaveClass('md:hidden')
  })
})
