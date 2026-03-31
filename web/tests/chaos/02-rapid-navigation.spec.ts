import { test, expect } from '@playwright/test'

test.describe('Chaos — Rapid Navigation', () => {
  test('rapid page switching does not crash', async ({ page }) => {
    const exceptions: string[] = []
    page.on('pageerror', err => exceptions.push(err.message))

    const routes = ['/', '/portfolio', '/points', '/backtester', '/leaderboard', '/docs', '/']
    for (const route of routes) {
      await page.goto(route, { waitUntil: 'commit' })
    }
    await page.waitForLoadState('domcontentloaded')

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
    expect(exceptions.filter(e => !e.includes('Hydration'))).toEqual([])
  })

  test('back/forward spam does not crash', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await page.goto('/portfolio')
    await page.waitForLoadState('domcontentloaded')
    await page.goto('/points')
    await page.waitForLoadState('domcontentloaded')

    // Spam back/forward
    for (let i = 0; i < 5; i++) {
      await page.goBack()
      await page.goForward()
    }

    const body = await page.textContent('body')
    expect(body!.length).toBeGreaterThan(0)
  })

  test('refresh spam on trading page', async ({ page }) => {
    const exceptions: string[] = []
    page.on('pageerror', err => exceptions.push(err.message))

    for (let i = 0; i < 5; i++) {
      await page.goto('/', { waitUntil: 'commit' })
    }
    await page.waitForLoadState('domcontentloaded')
    expect(exceptions.filter(e => !e.includes('Hydration'))).toEqual([])
  })
})
