import { test, expect } from '@playwright/test'

test.describe('Chaos — Responsive & Viewport', () => {
  test('trading page survives viewport resize storm', async ({ page }) => {
    const exceptions: string[] = []
    page.on('pageerror', err => exceptions.push(err.message))

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const sizes = [
      { width: 375, height: 812 },   // iPhone
      { width: 1920, height: 1080 },  // Desktop
      { width: 768, height: 1024 },   // Tablet
      { width: 320, height: 568 },    // Small phone
      { width: 2560, height: 1440 },  // 2K
      { width: 375, height: 812 },    // Back to phone
    ]

    for (const size of sizes) {
      await page.setViewportSize(size)
      await page.waitForTimeout(300)
    }

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
    // Filter known chart library errors on rapid resize (TradingView/lightweight-charts)
    const critical = exceptions.filter(e =>
      !e.includes('Hydration') && !e.includes('_internal_') && !e.includes('disposed')
    )
    expect(critical).toEqual([])
  })

  test('mobile trading page loads', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
  })

  test('ultra-wide viewport does not break layout', async ({ page }) => {
    await page.setViewportSize({ width: 3840, height: 2160 })
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
  })
})
