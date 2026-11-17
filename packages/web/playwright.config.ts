import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.KNOWN_WEB_PORT ?? 5183)
const baseURL = process.env.KNOWN_WEB_BASE_URL ?? `http://127.0.0.1:${PORT}`

// E2E route mocks need the real session bootstrap regardless of developer .env.local settings.
process.env.VITE_MOCK_SESSION = 'false'
process.env.VITE_ANNOTATIONS_ACCEPTANCE = 'true'
process.env.VITE_RELATIONS_ACCEPTANCE = 'true'

/**
 * C3-3: the default projects exercise the Vite dev server, which is what the
 * suite's fast feedback needs but not what ships. `npm run test:e2e:built`
 * sets KNOWN_WEB_E2E_BUILT=1 to build the production bundle, serve it with
 * `vite preview`, and run a smoke subset against it: the auth shell, the
 * library desk, and a cross-page share/public-visitor flow. Serving both
 * servers in one config would make every dev run pay for a build, so the
 * built project only exists in built mode.
 *
 * The smoke specs are fully API-mocked, use no dev-only module or HMR
 * surface, and assert behavior or layout without screenshot baselines, so
 * they are stable in the minified bundle. Visual baselines stay in the
 * dev-server lanes.
 * `library-desk-polish.spec.ts` stays dev-only on purpose: its drawer-close
 * case assumes dev animation timing and its direct `?collection=edit` case
 * assumes StrictMode request replay, so `library-tree.spec.ts` carries the
 * library-desk smoke instead.
 */
const built = process.env.KNOWN_WEB_E2E_BUILT === '1'
const previewPort = Number(process.env.KNOWN_WEB_PREVIEW_PORT ?? 5184)
const previewURL = process.env.KNOWN_WEB_PREVIEW_BASE_URL ?? `http://127.0.0.1:${previewPort}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  timeout: 60_000,
  expect: {
    toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 },
  },
  use: {
    baseURL: built ? previewURL : baseURL,
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
  webServer: built ? {
    command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${previewPort} --strictPort`,
    url: previewURL,
    reuseExistingServer: false,
    timeout: 300_000,
  } : {
    command: 'npm run dev -- --host 127.0.0.1 --port ' + PORT,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: built ? [
    {
      name: 'built-chromium',
      testMatch: /(?:login-server-error|library-tree|folder-share)\.spec\.ts$/u,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ] : [
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
