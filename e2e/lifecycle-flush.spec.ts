import { test, expect, type Locator, type Page } from '@playwright/test'

// F-017: mobile OSes send visibilitychange (not pagehide) when the app is switched away from,
// then may suspend or kill it. An expense added just before must already be in localStorage.
// Port of the auditors' lifecycle-flush probe: add and hide in the same task, then read storage.
// 0.10.0 writes its one envelope (`st5:db`) through on every change; the v4 keys are a rollback
// copy written after it, and on hide.

async function quickAdd(page: Page): Promise<Locator> {
  await page.goto('/pulse')
  // An add before the data has loaded waits for it: this probe needs the add made in its task.
  await expect(page.getByText('Loading local spending data')).toHaveCount(0, { timeout: 15_000 })
  const input = page
    .getByRole('textbox', { name: /quick add/i })
    .filter({ visible: true })
    .first()
  await input.fill('lifecycle test 3.3')
  return input
}

test.describe('Lifecycle flush (F-017)', () => {
  test('an add is in localStorage when the app is hidden in the same task', async ({ page }) => {
    const input = await quickAdd(page)
    const persistedAtHide = await input.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      return (localStorage.getItem('st5:db') ?? '').includes('lifecycle test')
    })
    expect(persistedAtHide).toBe(true)
  })

  test('an add is in localStorage at pagehide too', async ({ page }) => {
    const input = await quickAdd(page)
    const persistedAtPagehide = await input.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      return (localStorage.getItem('st5:db') ?? '').includes('lifecycle test')
    })
    expect(persistedAtPagehide).toBe(true)
  })

  test('the rollback copy is current at hide, marked with the v5 writer (P2-6)', async ({
    page,
  }) => {
    const input = await quickAdd(page)
    const mirrored = await input.evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      return (localStorage.getItem('expenses') ?? '').includes('lifecycle test')
    })
    expect(mirrored).toBe(true)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('spendtrack:app'))).toBe('5')
  })
})
