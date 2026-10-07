import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.KNOWN_WEB_PORT ?? 5183)
const baseURL = process.env.KNOWN_WEB_BASE_URL ?? `http://127.0.0.1:${PORT}`

// E2E route mocks need the real session bootstrap regardless of developer .env.local settings.
process.env.VITE_MOCK_SESSION = 'false'
process.env.VITE_ANNOTATIONS_ACCEPTANCE = 'true'
process.env.VITE_RELATIONS_ACCEPTANCE = 'true'

/**
 * P1-13 E2E: web editor + mocked Product API routes.
 * Does not require Known-Backend or real OIDC.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  expect: {
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // E2E asserts behavior, not motion: reduced motion makes exit-animated
    // surfaces (useExitAnimation) unmount immediately instead of adding a
    // 180ms tail to every close/dismiss assertion, freezes the Landing
    // typewriter and dither field, and keeps visual baselines stable.
    // reducedMotion is a BrowserContext option, not a first-class test
    // option — a top-level `reducedMotion` key is silently ignored, so it
    // must go through contextOptions.
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port ' + PORT,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
    // Cross-viewport lanes: every `*.responsive.spec.ts` runs once per lane so the
    // 720 / 1100 nav cuts, the 640 / 900 content cuts, coarse-pointer touch
    // targets and horizontal-overflow guards are exercised in a real layout
    // engine (happy-dom cannot evaluate @media or geometry). The desktop lane
    // above runs them too, so each assertion is checked on both sides of a cut.
    {
      name: 'mobile-chromium',
      testMatch: /\.responsive\.spec\.ts$/u,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'tablet-chromium',
      testMatch: /\.responsive\.spec\.ts$/u,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'tablet-landscape-chromium',
      testMatch: /\.responsive\.spec\.ts$/u,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
})
