import { afterEach, describe, expect, it } from 'vitest'
import { hasUnsavedWork } from './unsavedWork'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('hasUnsavedWork', () => {
  it('is false for an empty page', () => {
    mount('<main><p>Pulse</p><button>Add</button></main>')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('is true while any dialog is open, even with empty fields', () => {
    mount('<div role="dialog" aria-modal="true"><input value=""></div>')
    expect(hasUnsavedWork()).toBe(true)
  })

  it('treats an alertdialog and an open <dialog> as open dialogs', () => {
    mount('<div role="alertdialog"></div>')
    expect(hasUnsavedWork()).toBe(true)
    document.body.innerHTML = ''
    mount('<dialog open></dialog>')
    expect(hasUnsavedWork()).toBe(true)
  })

  it.each(['text', 'search', 'number', 'email', 'tel', 'url'])(
    'is true when a visible %s input has typed text',
    (type) => {
      const root = mount(`<input type="${type}">`)
      const input = root.querySelector('input')!
      input.value = type === 'number' ? '12.5' : 'kopi'
      expect(hasUnsavedWork()).toBe(true)
    },
  )

  it('is true for an input without a type attribute and for a textarea', () => {
    const root = mount('<input><textarea></textarea>')
    root.querySelector('input')!.value = 'grab home'
    expect(hasUnsavedWork()).toBe(true)
    root.querySelector('input')!.value = ''
    root.querySelector('textarea')!.value = 'split with Wei Ling'
    expect(hasUnsavedWork()).toBe(true)
  })

  it('ignores whitespace-only values', () => {
    const root = mount('<input><textarea></textarea>')
    root.querySelector('input')!.value = '   '
    root.querySelector('textarea')!.value = '\n\t'
    expect(hasUnsavedWork()).toBe(false)
  })

  it.each(['checkbox', 'radio', 'range', 'color', 'hidden', 'button', 'submit', 'date'])(
    'ignores a %s input',
    (type) => {
      mount(`<input type="${type}" value="on">`)
      expect(hasUnsavedWork()).toBe(false)
    },
  )

  it('ignores disabled and read-only fields', () => {
    mount('<input disabled value="locked"><textarea readonly>notes</textarea>')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('ignores fields that are not shown', () => {
    mount(
      [
        '<div hidden><input value="a"></div>',
        '<div inert><input value="b"></div>',
        '<div style="display:none"><span><input value="c"></span></div>',
        '<input style="visibility:hidden" value="d">',
      ].join(''),
    )
    expect(hasUnsavedWork()).toBe(false)
  })

  it('only looks inside the given root', () => {
    const outside = mount('<input value="typed elsewhere">')
    const inside = mount('<p>clean</p>')
    expect(outside).toBeTruthy()
    expect(hasUnsavedWork(inside)).toBe(false)
    expect(hasUnsavedWork(document)).toBe(true)
  })
})
