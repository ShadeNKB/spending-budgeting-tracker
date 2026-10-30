import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce, pushLiveRegions } from './announce'

function regions() {
  const polite = document.createElement('div')
  polite.setAttribute('role', 'status')
  const assertive = document.createElement('div')
  assertive.setAttribute('role', 'alert')
  document.body.append(polite, assertive)
  return { polite, assertive }
}

const pops: (() => void)[] = []
function push(pair: ReturnType<typeof regions>) {
  const pop = pushLiveRegions(pair)
  pops.push(pop)
  return pop
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  for (const pop of pops.splice(0)) pop()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('announce', () => {
  it('sets the text on the existing polite node, or the assertive one for errors', () => {
    const base = regions()
    push(base)
    announce('Saved')
    expect(base.polite).toHaveTextContent('Saved')
    expect(base.assertive).toHaveTextContent('')

    announce('Sync failed', 'assertive')
    expect(base.assertive).toHaveTextContent('Sync failed')
    expect(base.polite).toHaveTextContent('Saved')
  })

  it('speaks into the top layer, and hands back to the one below when it pops', () => {
    const base = regions()
    const sheet = regions()
    push(base)
    const popSheet = push(sheet)

    announce('Category added')
    expect(sheet.polite).toHaveTextContent('Category added')
    expect(base.polite).toHaveTextContent('')

    popSheet()
    announce('Added "kopi"')
    expect(base.polite).toHaveTextContent('Added "kopi"')
  })

  it('skips a closing layer: once its dialog is inert, the layer below speaks', () => {
    const base = regions()
    push(base)
    const dialog = document.createElement('div')
    const sheet = regions()
    dialog.append(sheet.polite, sheet.assertive)
    document.body.append(dialog)
    push(sheet)

    dialog.setAttribute('inert', '')
    announce('Added "kopi"')
    expect(base.polite).toHaveTextContent('Added "kopi"')
    expect(sheet.polite).toHaveTextContent('')
  })

  it('pops a layer that is not on top without disturbing the order', () => {
    const base = regions()
    const sheet = regions()
    const palette = regions()
    push(base)
    const popSheet = push(sheet)
    push(palette)
    popSheet()
    announce('Hello')
    expect(palette.polite).toHaveTextContent('Hello')
    expect(sheet.polite).toHaveTextContent('')
  })

  it('re-announces an identical message: clears it, then sets it again a moment later', () => {
    const base = regions()
    push(base)
    announce('Added "kopi" · S$4.50')
    announce('Added "kopi" · S$4.50')
    expect(base.polite).toHaveTextContent('')
    vi.advanceTimersByTime(100)
    expect(base.polite).toHaveTextContent('Added "kopi" · S$4.50')
  })

  it('a new message cancels a pending repeat', () => {
    const base = regions()
    push(base)
    announce('Saved')
    announce('Saved')
    announce('Deleted')
    expect(base.polite).toHaveTextContent('Deleted')
    vi.advanceTimersByTime(500)
    expect(base.polite).toHaveTextContent('Deleted')
  })

  it('does nothing without a region', () => {
    expect(() => {
      announce('Nobody listening')
    }).not.toThrow()
  })
})
