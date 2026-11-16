import { Suspense } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { bootScreenFor } from './routes'

// Stand-ins for the two lazy screens: what matters is which chunk a URL loads.
vi.mock('../features/ledger/LedgerScreen', () => ({
  LedgerScreen: () => <h1>Ledger chunk</h1>,
}))
vi.mock('../features/insights/InsightsScreen', () => ({
  InsightsScreen: () => <h1>Insights chunk</h1>,
}))

afterEach(cleanup)

/** The heading the screen chosen for `path` renders, once its chunk is in, with no fallback. */
async function bootHeading(path: string): Promise<string | null> {
  const page = bootScreenFor(path)
  if (!page) return null
  await page.preload()
  render(
    <Suspense fallback={<p>Loading screen</p>}>
      <page.Screen />
    </Suspense>,
  )
  expect(screen.queryByText('Loading screen')).toBeNull()
  return screen.getByRole('heading', { level: 1 }).textContent
}

describe('the screen the app boots on', () => {
  it('loads the Ledger chunk for /ledger, however the URL is written', async () => {
    expect(await bootHeading('/ledger')).toBe('Ledger chunk')
    cleanup()
    expect(await bootHeading('/ledger/')).toBe('Ledger chunk')
    cleanup()
    // The router matches paths case-insensitively, so it renders Ledger here too.
    expect(await bootHeading('/Ledger')).toBe('Ledger chunk')
  })

  it('loads the Insights chunk for /insights', async () => {
    expect(await bootHeading('/insights')).toBe('Insights chunk')
  })

  it('loads nothing for Pulse, which is in the entry chunk', () => {
    expect(bootScreenFor('/')).toBeUndefined()
    expect(bootScreenFor('/pulse')).toBeUndefined()
  })

  it('loads nothing for a URL that redirects to Pulse', () => {
    expect(bootScreenFor('/nope')).toBeUndefined()
    expect(bootScreenFor('/ledger/2026')).toBeUndefined()
    expect(bootScreenFor('/settings')).toBeUndefined()
  })
})
