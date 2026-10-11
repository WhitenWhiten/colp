import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { mockGuestPublicCollection } from './helpers/library-mocks'

/**
 * Visual baselines for the signed-out surfaces, one per Playwright lane
 * (desktop / mobile / tablet / tablet landscape — the lane name is part of
 * the snapshot filename). Motion is already reduced and animations disabled
 * by playwright.config.ts. Only the first viewport is captured.
 *
 * Refresh deliberately with `npx playwright test visual --update-snapshots`
 * and review the diff; a baseline change is a design change.
 */

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

const SURFACES: Array<{ path: string; name: string; heading: string; prepare: (page: Page) => Promise<void> }> = [
  {
    path: '/login',
    name: 'login',
    heading: 'Sign in',
    prepare: async (page) => {
      await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
      await page.route('**/api/v1/auth/registration-state', (route) => json(route, { open: false, reason: 'closed' }))
    },
  },
  {
    path: '/c/reading-notes',
    name: 'public-collection',
    heading: 'Reading notes',
    prepare: (page) => mockGuestPublicCollection(page),
  },
]

for (const surface of SURFACES) {
  test(`${surface.name} matches its visual baseline`, async ({ page }) => {
    await surface.prepare(page)
    await page.goto(surface.path)
    /* By name: the loading skeleton has a level-1 heading of its own. */
    await expect(page.getByRole('heading', { level: 1, name: surface.heading })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveScreenshot(`${surface.name}.png`)
  })
}
