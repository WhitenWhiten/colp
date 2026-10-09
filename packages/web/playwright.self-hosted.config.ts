import { defineConfig, devices } from '@playwright/test'

if (!process.env.DISPLAY) throw new Error('Self-hosted acceptance must run under xvfb-run.')
if (!process.env.COLP_ACCEPTANCE_ORIGIN) throw new Error('Set COLP_ACCEPTANCE_ORIGIN to an isolated compose stack.')

export default defineConfig({
  testDir: './acceptance',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  outputDir: process.env.COLP_ACCEPTANCE_OUTPUT,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.COLP_ACCEPTANCE_ORIGIN,
    headless: false,
    trace: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.COLP_ACCEPTANCE_CHROMIUM,
      args: process.env.COLP_ACCEPTANCE_TLS_SPKI
        ? [`--ignore-certificate-errors-spki-list=${process.env.COLP_ACCEPTANCE_TLS_SPKI}`] : [],
    },
  },
})
