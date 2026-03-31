import { test, expect } from '@playwright/test'

const ALL_ROUTES = [
  '/', '/portfolio', '/agents', '/backtester', '/copytrade',
  '/developers', '/docs', '/leaderboard', '/points',
  '/referrals', '/support', '/terms', '/privacy',
  '/trading-bot', '/vaults',
]

test.describe('Page Stability — No crashes on any route', () => {
  for (const route of ALL_ROUTES) {
    test(`${route} loads without JS exceptions`, async ({ page }) => {
      const exceptions: string[] = []
      page.on('pageerror', err => exceptions.push(err.message))

      await page.goto(route)
      await page.waitForLoadState('domcontentloaded')

      const critical = exceptions.filter(e => !e.includes('Hydration') && !e.includes('hydrat'))
      expect(critical).toEqual([])
    })
  }
})

test.describe('Page Stability — No console errors', () => {
  for (const route of ALL_ROUTES) {
    test(`${route} has no console errors`, async ({ page }) => {
      const errors: string[] = []
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text())
      })

      await page.goto(route)
      await page.waitForLoadState('networkidle')

      const critical = errors.filter(e =>
        !e.includes('WalletConnect') && !e.includes('wagmi') &&
        !e.includes('hydrat') && !e.includes('WebSocket') &&
        !e.includes('favicon') && !e.includes('ERR_CONNECTION_REFUSED')
      )
      expect(critical).toEqual([])
    })
  }
})
