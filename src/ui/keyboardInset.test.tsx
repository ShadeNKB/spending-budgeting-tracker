import { afterEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { keyboardCover } from './keyboardInset'
import { Sheet } from './Sheet'

describe('keyboardCover', () => {
  const view = (height: number, offsetTop = 0, scale = 1) => ({ height, offsetTop, scale })

  it('is 0 with no keyboard', () => {
    expect(keyboardCover(664, view(664))).toBe(0)
  })

  it('is what the keyboard covers of the bottom', () => {
    expect(keyboardCover(664, view(330))).toBe(334)
  })

  it('counts a visual viewport scrolled down inside the page', () => {
    expect(keyboardCover(664, view(330, 40))).toBe(294)
  })

  it('ignores a scrollbar-sized gap and a pinch zoom', () => {
    expect(keyboardCover(800, view(785))).toBe(0)
    expect(keyboardCover(664, view(332, 0, 2))).toBe(0)
  })
})

/** A visual viewport the test drives, standing in for the browser's (jsdom has none). */
class FakeViewport extends EventTarget {
  height = window.innerHeight
  offsetTop = 0
  scale = 1
  set(height: number) {
    this.height = height
    this.dispatchEvent(new Event('resize'))
  }
}

describe('a bottom sheet over the on-screen keyboard', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'visualViewport')
  afterEach(() => {
    if (original) Object.defineProperty(window, 'visualViewport', original)
    else Reflect.deleteProperty(window, 'visualViewport')
  })

  it('stands on the keyboard while it is up, and drops back when it goes', () => {
    const viewport = new FakeViewport()
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    render(
      <Sheet
        open
        onClose={() => {}}
        title="Add expense"
        side="bottom"
        footer={<button>Add</button>}
      >
        <input aria-label="What" />
      </Sheet>,
    )
    const panel = screen.getByRole('dialog')
    expect(panel.style.getPropertyValue('--kb-inset')).toBe('0px')
    expect(panel.style.getPropertyValue('--vv-h')).toBe('')

    act(() => {
      viewport.set(window.innerHeight - 300)
    })
    expect(panel.style.getPropertyValue('--kb-inset')).toBe('300px')
    expect(panel.style.getPropertyValue('--vv-h')).toBe(`${String(window.innerHeight - 300)}px`)

    act(() => {
      viewport.set(window.innerHeight)
    })
    expect(panel.style.getPropertyValue('--kb-inset')).toBe('0px')
    expect(panel.style.getPropertyValue('--vv-h')).toBe('')
  })

  it('gives the footer, not the content, the room a toast takes', () => {
    render(
      <Sheet
        open
        onClose={() => {}}
        title="Add expense"
        side="bottom"
        footer={<button>Add</button>}
      >
        <input aria-label="What" />
      </Sheet>,
    )
    const rooms = document.querySelectorAll('[data-toast-room]')
    expect(rooms).toHaveLength(1)
    expect(rooms[0]).toContainElement(screen.getByRole('button', { name: 'Add' }))
    expect(rooms[0]).not.toContainElement(screen.getByRole('textbox', { name: 'What' }))
  })

  it('without a footer, the content keeps the room', () => {
    render(
      <Sheet open onClose={() => {}} title="Shortcuts" side="bottom">
        <input aria-label="What" />
      </Sheet>,
    )
    const rooms = document.querySelectorAll('[data-toast-room]')
    expect(rooms).toHaveLength(1)
    expect(rooms[0]).toContainElement(screen.getByRole('textbox', { name: 'What' }))
  })
})
