import { useEffect } from 'react'
import type { Theme } from '../stores/useUIStore'

export type ResolvedTheme = 'dark' | 'light'

/** Browser chrome colours: the --surface-0 token of each theme. */
export const THEME_CHROME: Record<ResolvedTheme, string> = {
  dark: '#0c0b0a',
  light: '#faf8f5',
}

/**
 * The same table as the pre-paint script in index.html: an explicit choice wins, `system`
 * follows the OS, and without matchMedia (`null`) the primary dark theme is used.
 */
export function resolveTheme(stored: Theme, prefersDark: boolean | null): ResolvedTheme {
  if (stored === 'dark' || stored === 'light') return stored
  return prefersDark === false ? 'light' : 'dark'
}

/** Theme attribute plus the browser chrome (Android toolbar, native controls) in one go. */
export function applyThemeChrome(resolved: ResolvedTheme, doc: Document = document): void {
  doc.documentElement.setAttribute('data-theme', resolved)
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_CHROME[resolved])
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved)
}

/** Keeps the document in step with the stored theme, and with the OS while on `system`. */
export function useAppliedTheme(theme: Theme): void {
  useEffect(() => {
    const query =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    const apply = () => {
      applyThemeChrome(resolveTheme(theme, query ? query.matches : null))
    }
    apply()
    if (theme !== 'system' || !query) return undefined
    query.addEventListener('change', apply)
    return () => {
      query.removeEventListener('change', apply)
    }
  }, [theme])
}
