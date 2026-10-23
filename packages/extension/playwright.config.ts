import { defineConfig, devices } from '@playwright/test';

const selfHosted = ['**/mv3-colp-server-sync.spec.ts', '**/mv3-browser-rules-server.spec.ts', '**/mv3-capture-visual.spec.ts'];
export default defineConfig({ testDir: './e2e',
  timeout: 45_000, fullyParallel: false, workers: 1,
  use: { ...devices['Desktop Chrome'], headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  projects: [{ name: 'core', testIgnore: selfHosted }, { name: 'self-hosted', testMatch: selfHosted }],
  outputDir: 'test-results', reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]] });
