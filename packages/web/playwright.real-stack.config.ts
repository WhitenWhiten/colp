import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!baseURL) {
  throw new Error(
    'KNOWN_REAL_STACK_WEB_BASE_URL is required; use npm run test:e2e:real-stack so infrastructure failures fail closed',
  )
}

export default defineConfig({
  testDir: './e2e-real-stack',
  fullyParallel: false,
  forbidOnly: true,
  // The lifecycle mutates a real isolated database and controls worker state;
  // rerunning inside the same harness would not be an independent retry.
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 360_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    // A missing or covered control must not consume the whole lifecycle budget.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // E2E asserts behavior, not motion: reduced motion makes exit-animated
    // surfaces (useExitAnimation) unmount immediately instead of adding a
    // 180ms tail to every close/dismiss assertion. It is a BrowserContext
    // option — a top-level `reducedMotion` key is silently ignored.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    {
      name: 'real-stack-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
})
