import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/**
 * Cross-viewport chrome contract. Runs on every Playwright lane (desktop,
 * mobile 390, tablet 768, tablet landscape 1024) — see playwright.config.ts —
 * so the assertions branch on the lane's viewport rather than pin one size.
 *
 * Breakpoints under test (src/styles/breakpoints.contract.test.ts):
 *   nav      — 720 shows the primary links, 1100 shows the full search box
 *              and drops the burger; compact search stays visible below 1100.
 *   content  — 640 / 900 column cuts on the discovery grid.
 *   touch    — 44px (2.75rem) floor for chrome controls under (pointer: coarse).
 */

const TOUCH_FLOOR_PX = 44

test.beforeEach(async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: false }),
  }))
})

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
    await page.goto('/')
    const width = viewportWidth(page)
    const burger = page.getByRole('button', { name: 'Open menu' })
    const primary = page.getByRole('navigation', { name: 'Primary', exact: true })
    const fullSearch = page.locator('.nav-search')
    // Both search triggers share the "Search Know-N" name; pick by class.
    const compactSearch = page.locator('.nav-search-compact')

    if (width >= 1100) {
      await expect(burger).toBeHidden()
      await expect(primary).toBeVisible()
      await expect(fullSearch).toBeVisible()
      await expect(compactSearch).toBeHidden()
      return
    }

    await expect(burger).toBeVisible()
    await expect(fullSearch).toBeHidden()
    if (width >= 720) {
      // Mid-range keeps the core links in the bar; the rest live in the drawer.
      await expect(primary).toBeVisible()
      await expect(page.locator('.nav-links .nav-link-core').first()).toBeVisible()
      await expect(page.locator('.nav-links .nav-link-rest').first()).toBeHidden()
      await expect(compactSearch).toBeVisible()
    } else {
      await expect(primary).toBeHidden()
      const tabs = page.getByRole('navigation', { name: 'Mobile primary' })
      await expect(tabs).toBeVisible()
      await expect(tabs.getByRole('link', { name: 'Explore' })).toBeVisible()
      await expect(tabs.getByRole('link', { name: 'Log in' })).toBeVisible()
      await expect(compactSearch).toBeVisible()
    }
  })

  test('the drawer opens from the burger, exposes search, and closes on Escape', async ({ page }) => {
    await page.goto('/')
    test.skip(viewportWidth(page) >= 1100, 'full chrome has no drawer')

    const burger = page.getByRole('button', { name: 'Open menu' })
    await burger.click()
    const drawer = page.getByRole('navigation', { name: 'Mobile', exact: true })
    await expect(drawer).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer.getByRole('link', { name: 'Explore' })).toHaveCount(0)
    await expect(drawer.getByRole('link', { name: 'Log in' })).toBeVisible()

    await drawer.locator('.mobile-search').click()
    await expect(page.getByTestId('search-palette-input')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-palette-input')).toBeHidden()
    await expect(drawer).toBeHidden()
  })
})

test.describe('surfaces stay inside the viewport', () => {
  for (const path of ['/', '/explore', '/login']) {
    test(`${path} renders without horizontal overflow`, async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('main')).toBeVisible()
      await assertNoHorizontalOverflow(page)
    })
  }
})

test.describe('coarse pointers get the 44px floor', () => {
  test('chrome controls meet the touch target under (pointer: coarse)', async ({ page }) => {
    await page.goto('/')
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
