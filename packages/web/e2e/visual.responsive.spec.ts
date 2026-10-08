import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/**
 * Visual baselines for the anonymous core surfaces, one per Playwright lane
 * (desktop / mobile / tablet / tablet landscape — the lane name is part of
 * the snapshot filename). Motion is already reduced and animations disabled
 * by playwright.config.ts, so the Landing typewriter rests on its first word
 * and the caret does not blink. Only the first viewport is captured: the
 * below-fold [data-reveal] sections depend on scroll position and would make
 * a full-page shot order-dependent.
 *
 * Refresh deliberately with `npx playwright test visual --update-snapshots`
 * and review the diff; a baseline change is a design change.
 */

const SURFACES: Array<{ path: string; name: string; ready: (page: Page) => Promise<void> }> = [
  {
    path: '/',
    name: 'landing',
    ready: async (page) => { await expect(page.getByRole('heading', { level: 1 })).toBeVisible() },
  },
  {
    path: '/explore',
    name: 'explore',
    ready: async (page) => { await expect(page.getByRole('heading', { level: 1 })).toBeVisible() },
  },
  {
    path: '/login',
    name: 'login',
    ready: async (page) => { await expect(page.getByRole('heading', { level: 1 })).toBeVisible() },
  },
]

test.beforeEach(async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }),
  }))
})

for (const surface of SURFACES) {
  test(`${surface.name} matches its visual baseline`, async ({ page }) => {
    await page.goto(surface.path)
    await surface.ready(page)
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot(`${surface.name}.png`)
  })
}
