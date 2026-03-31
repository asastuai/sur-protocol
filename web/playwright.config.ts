import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/chaos',
  fullyParallel: false, // Sequential for chaos — order matters
  retries: 0, // No retries in chaos — we want to see real failures
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npx next dev --port 4000',
    url: 'http://localhost:4000',
    reuseExistingServer: true,
    timeout: 30000,
  },
})
