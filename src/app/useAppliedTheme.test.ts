import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { THEME_CHROME, applyThemeChrome, resolveTheme, useAppliedTheme } from './useAppliedTheme'
import type { Theme } from '../stores/useUIStore'

class FakeMediaQueryList extends EventTarget {
  readonly media = '(prefers-color-scheme: dark)'
  onchange = null
  constructor(public matches: boolean) {
    super()
  }
  setMatches(matches: boolean): void {
    this.matches = matches
    this.dispatchEvent(new Event('change'))
  }
}

function installMetas(doc: Document = document): void {
  doc.head.innerHTML =
    '<meta name="color-scheme" content="dark light"><meta name="theme-color" content="#0c0b0a">'
}

function chrome(doc: Document = document) {
  return {
    theme: doc.documentElement.getAttribute('data-theme'),
    color: doc.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    scheme: doc.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
  }
}

function renderTheme(initial: Theme) {
  return renderHook(
    ({ theme }: { theme: Theme }) => {
      useAppliedTheme(theme)
    },
    { initialProps: { theme: initial } },
  )
}

const DARK = { theme: 'dark', color: '#0c0b0a', scheme: 'dark' }
const LIGHT = { theme: 'light', color: '#faf8f5', scheme: 'light' }

beforeEach(() => {
  installMetas()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveTheme (C2 table)', () => {
  it.each<[Theme, boolean | null, 'dark' | 'light']>([
    ['dark', true, 'dark'],
    ['dark', false, 'dark'],
    ['dark', null, 'dark'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['light', null, 'light'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
    // matchMedia unavailable: dark, the primary theme.
    ['system', null, 'dark'],
  ])('stored %s with OS prefers-dark %s resolves to %s', (stored, prefersDark, expected) => {
    expect(resolveTheme(stored, prefersDark)).toBe(expected)
  })
})

describe('applyThemeChrome', () => {
  it('uses the --surface-0 colours', () => {
    expect(THEME_CHROME).toEqual({ dark: '#0c0b0a', light: '#faf8f5' })
  })

  it('sets data-theme, theme-color and color-scheme together', () => {
    applyThemeChrome('light')
    expect(chrome()).toEqual(LIGHT)
    applyThemeChrome('dark')
    expect(chrome()).toEqual(DARK)
  })

  it('works on another document and tolerates missing metas', () => {
    const other = document.implementation.createHTMLDocument('x')
    expect(() => {
      applyThemeChrome('light', other)
    }).not.toThrow()
    expect(other.documentElement.getAttribute('data-theme')).toBe('light')
    installMetas(other)
    applyThemeChrome('light', other)
    expect(chrome(other)).toEqual(LIGHT)
  })
})

describe('useAppliedTheme', () => {
  it('applies explicit themes and follows toggles', () => {
    vi.stubGlobal('matchMedia', () => new FakeMediaQueryList(true))
    const { rerender } = renderTheme('light')
    expect(chrome()).toEqual(LIGHT)
    rerender({ theme: 'dark' })
    expect(chrome()).toEqual(DARK)
    rerender({ theme: 'light' })
    expect(chrome()).toEqual(LIGHT)
  })

  it('follows the OS while set to system, and stops following when switched away', () => {
    const mql = new FakeMediaQueryList(true)
    vi.stubGlobal('matchMedia', () => mql)
    const { rerender } = renderTheme('system')
    expect(chrome()).toEqual(DARK)

    act(() => {
      mql.setMatches(false)
    })
    expect(chrome()).toEqual(LIGHT)
    act(() => {
      mql.setMatches(true)
    })
    expect(chrome()).toEqual(DARK)

    rerender({ theme: 'light' })
    act(() => {
      mql.setMatches(true)
    })
    expect(chrome()).toEqual(LIGHT)
  })

  it('removes its media listener on unmount', () => {
    const mql = new FakeMediaQueryList(false)
    vi.stubGlobal('matchMedia', () => mql)
    const { unmount } = renderTheme('system')
    expect(chrome()).toEqual(LIGHT)
    unmount()
    mql.setMatches(true)
    expect(chrome()).toEqual(LIGHT)
  })

  it('falls back to dark for system where matchMedia is unavailable', () => {
    // jsdom has no matchMedia at all, like some embedded webviews.
    expect(typeof window.matchMedia).not.toBe('function')
    renderTheme('system')
    expect(chrome()).toEqual(DARK)
  })
})
