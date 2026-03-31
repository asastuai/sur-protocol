import { test, expect } from '@playwright/test'

test.describe('Chaos — Network Disruption', () => {
  test('page survives network offline', async ({ page, context }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    // Go offline
    await context.setOffline(true)
    await page.waitForTimeout(3000)

    // Page should still be visible (not white screen)
    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)

    // Go back online
    await context.setOffline(false)
    await page.waitForTimeout(2000)

    const bodyAfter = await page.textContent('body')
    expect(bodyAfter!.length).toBeGreaterThan(0)
  })

  test('page handles slow network gracefully', async ({ page }) => {
    // Throttle to slow 3G
    const client = await page.context().newCDPSession(page)
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 500 * 1024 / 8, // 500kbps
      uploadThroughput: 500 * 1024 / 8,
      latency: 2000, // 2 second latency
    })

    await page.goto('/', { timeout: 30000, waitUntil: 'commit' })
    await page.waitForTimeout(5000) // Give slow network time

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
  })

  test('offline then navigate does not crash', async ({ page, context }) => {
    const exceptions: string[] = []
    page.on('pageerror', err => exceptions.push(err.message))

    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    await context.setOffline(true)

    // Try navigating while offline
    await page.goto('/portfolio').catch(() => {})
    await page.goto('/points').catch(() => {})

    await context.setOffline(false)
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
  })
})
