import { defineConfig, devices } from '@playwright/test';

export default defineConfig({ testDir: './e2e',
  ...(process.env.KNOWN_P3_38_RUNTIME ? {} : { testIgnore: 'mv3-multi-device-recovery.spec.ts' }),
  timeout: 45_000, fullyParallel: false, workers: 1,
  use: { ...devices['Desktop Chrome'], headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  outputDir: 'test-results', reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]] });
