import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { mockGuestPublicCollection, mockOwnerLibrary } from './helpers/library-mocks'

/**
 * Cross-viewport chrome contract. Runs on every Playwright lane (desktop,
 * mobile 390, tablet 768, tablet landscape 1024) — see playwright.config.ts —
 * so the assertions branch on the lane's viewport rather than pin one size.
 *
 * Breakpoints under test (src/styles/breakpoints.contract.test.ts):
 *   nav      — 720 shows the primary links, 1100 shows the full search box
 *              and drops the burger; compact search stays visible below 1100.
 *   touch    — 44px (2.75rem) floor for chrome controls under (pointer: coarse).
 */

const TOUCH_FLOOR_PX = 44

const GUEST_PAGE = '/c/reading-notes'

function viewportWidth(page: Page): number {
  const size = page.viewportSize()
  if (!size) throw new Error('responsive specs need a fixed viewport')
  return size.width
}

async function assertNoHorizontalOverflow(page: Page) {
  const report = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth
    // Descendants of an intentional horizontal scroller (chip rows, card
    // rails) are allowed past the edge — the scroller itself is not.
    const insideScroller = (el: HTMLElement) => {
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return true
      }
      return false
    }
    const offenders = [...document.querySelectorAll<HTMLElement>('header, main, footer, main *')]
      .filter((el) => el.offsetParent !== null || el.tagName === 'HEADER' || el.tagName === 'MAIN')
      .filter((el) => !insideScroller(el))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.right > viewport + 1)
      .slice(0, 8)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} right=${Math.round(rect.right)}`)
    return { viewport, documentScrollWidth: document.documentElement.scrollWidth, offenders }
  })
  expect(report.documentScrollWidth, 'document must not scroll horizontally').toBeLessThanOrEqual(report.viewport)
  expect(report.offenders, 'no rendered box may extend past the viewport').toEqual([])
}

test.describe('top bar follows the nav cuts', () => {
  test('primary links, search affordance and burger match the lane width', async ({ page }) => {
    await mockOwnerLibrary(page)
    await page.goto('/library/col-1')
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    const width = viewportWidth(page)
    const burger = page.getByRole('button', { name: 'Open menu' })
    const primary = page.getByRole('navigation', { name: 'Primary', exact: true })
    const fullSearch = page.locator('.nav-search')
    // Both search triggers open the same palette; pick by class.
    const compactSearch = page.locator('.nav-search-compact')

    if (width >= 1100) {
      await expect(burger).toBeHidden()
      await expect(primary).toBeVisible()
      await expect(primary.getByRole('link')).toHaveText(['Library', 'Agents', 'Approvals'])
      await expect(fullSearch).toBeVisible()
      await expect(compactSearch).toBeHidden()
      return
    }

    await expect(burger).toBeVisible()
    await expect(fullSearch).toBeHidden()
    await expect(compactSearch).toBeVisible()
    if (width >= 720) {
      await expect(primary).toBeVisible()
      await expect(primary.getByRole('link')).toHaveText(['Library', 'Agents', 'Approvals'])
    } else {
      await expect(primary).toBeHidden()
      const tabs = page.getByRole('navigation', { name: 'Mobile primary' })
      await expect(tabs).toBeVisible()
      await expect(tabs.getByRole('link')).toHaveText(['Library', 'Agents', 'Approvals'])
    }
  })

  test('a guest gets only Sign in, in the bar or the mobile tab bar', async ({ page }) => {
    await mockGuestPublicCollection(page)
    await page.goto(GUEST_PAGE)
    await expect(page.getByTestId('public-collection-page')).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toHaveCount(0)
    const signIn = page.getByRole('link', { name: 'Sign in', exact: true })
    if (viewportWidth(page) >= 720) {
      await expect(signIn.first()).toBeVisible()
      await expect(signIn.first()).toHaveAttribute('href', `/login?returnTo=${encodeURIComponent(GUEST_PAGE)}`)
    } else {
      const tabs = page.getByRole('navigation', { name: 'Mobile primary' })
      await expect(tabs.getByRole('link')).toHaveText(['Sign in'])
    }
  })

  test('a guest drawer offers Sign in and no library search', async ({ page }) => {
    await mockGuestPublicCollection(page)
    await page.goto(GUEST_PAGE)
    test.skip(viewportWidth(page) >= 1100, 'full chrome has no drawer')

    await page.getByRole('button', { name: 'Open menu' }).click()
    const drawer = page.getByRole('navigation', { name: 'Mobile', exact: true })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link')).toHaveText(['Sign in'])
    // Site search answers a guest with a sign-in wall, so it is not offered.
    await expect(drawer.locator('.mobile-search')).toHaveCount(0)
    await expect(page.locator('.nav-search-compact')).toHaveCount(0)
  })

  test('the drawer opens from the burger, exposes search, and closes on Escape', async ({ page }) => {
    await mockOwnerLibrary(page)
    await page.goto('/library/col-1')
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    test.skip(viewportWidth(page) >= 1100, 'full chrome has no drawer')

    const burger = page.getByRole('button', { name: 'Open menu' })
    await burger.click()
    const drawer = page.getByRole('navigation', { name: 'Mobile', exact: true })
    await expect(drawer).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true')

    await drawer.locator('.mobile-search').click()
    await expect(page.getByTestId('search-palette-input')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-palette-input')).toBeHidden()
    await expect(drawer).toBeHidden()
  })
})

test.describe('surfaces stay inside the viewport', () => {
  test('/login renders without horizontal overflow', async ({ page }) => {
    await page.route('**/api/v1/session', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
    }))
    await page.route('**/api/v1/auth/registration-state', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ open: false, reason: 'closed' }),
    }))
    await page.goto('/login')
    await expect(page.locator('main')).toBeVisible()
    await assertNoHorizontalOverflow(page)
  })

  test(`${GUEST_PAGE} renders without horizontal overflow`, async ({ page }) => {
    await mockGuestPublicCollection(page)
    await page.goto(GUEST_PAGE)
    await expect(page.getByTestId('public-collection-page')).toBeVisible()
    await assertNoHorizontalOverflow(page)
  })

  test('/library renders without horizontal overflow', async ({ page }) => {
    await mockOwnerLibrary(page)
    await page.goto('/library/col-1')
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    await assertNoHorizontalOverflow(page)
  })
})

test.describe('coarse pointers get the 44px floor', () => {
  test('chrome controls meet the touch target under (pointer: coarse)', async ({ page }) => {
    await mockGuestPublicCollection(page)
    await page.goto(GUEST_PAGE)
    await expect(page.getByTestId('public-collection-page')).toBeVisible()
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    test.skip(!coarse, 'fine-pointer lane')

    const controls = page.locator('.nav-actions > .btn:visible, .nav-actions > .nav-burger:visible')
    const count = await controls.count()
    expect(count).toBeGreaterThan(0)
    for (let i = 0; i < count; i += 1) {
      const box = await controls.nth(i).boundingBox()
      expect(box, `control #${i} must render`).not.toBeNull()
      expect(box!.height, `control #${i} height`).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX - 0.5)
    }
  })
})
