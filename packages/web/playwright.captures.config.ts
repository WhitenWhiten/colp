import { defineConfig, devices } from '@playwright/test'

/* README screenshots of the web app against the mocked Product API in
   e2e/helpers/readme-fixtures.ts. Not part of the e2e suite: the default
   config only picks up *.spec.ts. Run under xvfb with README_CAPTURE_OUT
   naming the output folder (see e2e/readme.capture.ts). */

const PORT = Number(process.env.KNOWN_WEB_PORT ?? 5193)
const baseURL = process.env.KNOWN_WEB_BASE_URL ?? `http://127.0.0.1:${PORT}`

// Same dev-server environment as playwright.config.ts: route mocks need the real session bootstrap.
process.env.VITE_MOCK_SESSION = 'false'
process.env.VITE_ANNOTATIONS_ACCEPTANCE = 'true'
process.env.VITE_RELATIONS_ACCEPTANCE = 'true'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.capture.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results/captures',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'off',
    screenshot: 'only-on-failure',
    // A BrowserContext option, so it goes through contextOptions (see playwright.config.ts).
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port ' + PORT,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
