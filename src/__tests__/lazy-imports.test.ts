/**
 * Every lazy chunk the app loads goes through importWithReload.
 *
 * A bare `import('./X')` that fails after a deploy skips the one-shot stale-chunk reload and
 * throws straight into the nearest error boundary, which for something rendered in the header
 * is the whole app. This scans the source, so a new lazy site that forgets the wrapper fails
 * here instead of on Shade's phone the day after a deploy.
 */
import { describe, expect, it } from 'vitest'

// Test helpers (`__tests__` folders) load modules for tests, not chunks for the app.
const SOURCES = import.meta.glob<string>(
  ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/**/__tests__/**'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
)

// The Supabase client is a library, not a screen, and syncService loads it on demand. Vite
// still routes that import through its preload helper, so a failed load fires
// vite:preloadError and the one-shot automatic reload (installPreloadErrorRecovery) recovers
// it. There is no in-page retry: syncService keeps the rejected client promise for the life of
// the page.
const ALLOWED_BARE_IMPORTS = new Set(['/src/services/syncService.ts'])

const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length
const DYNAMIC_IMPORT = /\bimport\(\s*['"]/g
const WRAPPED_IMPORT = /\bimportWithReload\(\s*\(\)\s*=>\s*import\(\s*['"]/g
const LAZY = /\blazy\(\s*\(\)\s*=>/g
const LAZY_WRAPPED = /\blazy\(\s*\(\)\s*=>\s*importWithReload\(/g

describe('lazy chunks', () => {
  const files = Object.entries(SOURCES)

  it('scans the app source', () => {
    expect(files.length).toBeGreaterThan(40)
    expect(Object.keys(SOURCES)).toContain('/src/app/routes.tsx')
  })

  it('wraps every dynamic import in importWithReload (the Supabase client excepted)', () => {
    const bare = files
      .filter(([path]) => !ALLOWED_BARE_IMPORTS.has(path))
      .filter(([, text]) => count(text, DYNAMIC_IMPORT) !== count(text, WRAPPED_IMPORT))
      .map(([path]) => path)
    expect(bare).toEqual([])
  })

  it('builds every React.lazy component on importWithReload', () => {
    const unwrapped = files
      .filter(([, text]) => count(text, LAZY) !== count(text, LAZY_WRAPPED))
      .map(([path]) => path)
    expect(unwrapped).toEqual([])
  })

  it('still finds the lazy sites it guards (the patterns match real code)', () => {
    const wrapped = files.reduce((sum, [, text]) => sum + count(text, LAZY_WRAPPED), 0)
    // Two routed screens, five shell overlays and the quick-add full-entry sheet.
    expect(wrapped).toBeGreaterThanOrEqual(8)
  })
})
