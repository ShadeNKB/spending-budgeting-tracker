import { test, expect, type Locator } from '@playwright/test'

// The strip under the top bar while offline. Its 12 px amber text on a 10 % amber tint measured
// 4.29:1 in the light theme; axe only reports such text as "incomplete" (it cannot work out a
// translucent background), so the contrast is measured here, with the layers composited.

/** WCAG contrast of an element's text against the layers behind it. */
function textContrast(text: Locator): Promise<number> {
  return text.evaluate((el) => {
    const rgba = (css: string) => {
      const [r = 0, g = 0, b = 0, a = 1] = (css.match(/[\d.]+/g) ?? []).map(Number)
      return { r, g, b, a }
    }
    const layers: ReturnType<typeof rgba>[] = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      const background = rgba(getComputedStyle(node).backgroundColor)
      if (background.a > 0) layers.unshift(background)
      if (background.a >= 1) break
    }
    let below = { r: 255, g: 255, b: 255 }
    for (const { r, g, b, a } of layers) {
      below = {
        r: r * a + below.r * (1 - a),
        g: g * a + below.g * (1 - a),
        b: b * a + below.b * (1 - a),
      }
    }
    const channel = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    const [light, dark] = [luminance(rgba(getComputedStyle(el).color)), luminance(below)].sort(
      (x, y) => y - x,
    )
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`the offline strip's text clears 4.5:1 in the ${theme} theme`, async ({ page, context }) => {
    await page.addInitScript((value) => {
      localStorage.setItem('spendtrack:theme', value)
    }, theme)
    await page.goto('/pulse')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    // The inline pre-boot script sets data-theme before the app runs: wait for the app itself,
    // so going offline is a change it sees, not the state it starts in.
    await page
      .getByRole('textbox', { name: /quick add/i })
      .first()
      .waitFor()
    await context.setOffline(true)
    const strip = page.getByText(/^You're offline — changes are saved on this device/)
    await expect(strip).toBeVisible()
    expect(await textContrast(strip)).toBeGreaterThanOrEqual(4.5)
    await context.setOffline(false)
  })
}
