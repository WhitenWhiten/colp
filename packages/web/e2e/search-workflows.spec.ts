import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const result = {
  query: 'systems', types: ['collection'],
  items: [{ resourceType: 'collection', resourceId: 'collection-1', title: 'Systems without overflow', snippet: '中文 mixed with مرحبا and Supercalifragilisticexpialidocious'.repeat(3), rank: 0.9 }],
  page: { returnedCount: 1, hasMore: false, nextCursor: null },
  consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
}

test.beforeEach(async ({ page }) => installPassiveFeatureMocks(page))

async function installSearchRoutes(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }))
  await page.route('**/api/v1/search**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(result),
  }))
}

const emptyResult = {
  ...result,
  items: [],
  page: { returnedCount: 0, hasMore: false, nextCursor: null },
}

function productError(status: number) {
  return {
    error: {
      code: status === 429 ? 'rate_limited' : 'feature_temporarily_unavailable',
      message: 'Search is temporarily unavailable.',
      requestId: 'req_search_visual_acceptance',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: status === 429 ? 2 : null,
      fieldErrors: [],
    },
  }
}

function createDeferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((next) => { resolve = next })
  return { promise, resolve: () => resolve() }
}

async function installVisualSearchRoutes(
  page: import('@playwright/test').Page,
  gates: { loading: ReturnType<typeof createDeferred>; more: ReturnType<typeof createDeferred> },
) {
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }))
  await page.route('**/api/v1/search**', async (route) => {
    const url = new URL(route.request().url())
    const query = url.searchParams.get('q')
    const cursor = url.searchParams.get('cursor')
    if (query === 'loading') await gates.loading.promise
    if (query === 'error') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(productError(503)) })
      return
    }
    if (query === 'empty') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...emptyResult, query }) })
      return
    }
    if (query === 'paged') {
      if (cursor) await gates.more.promise
      const pageResult = cursor
        ? { ...result, query, items: [{ resourceType: 'profile', resourceId: 'profile-2', handle: 'second', displayName: 'مرحبا 第二项', avatarUrl: null, snippet: 'Appended result', rank: 0.8 }], page: { returnedCount: 1, hasMore: false, nextCursor: null } }
        : { ...result, query, page: { returnedCount: 1, hasMore: true, nextCursor: 'cursor-2' } }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageResult) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...result, query }) })
  })
}

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const measurements = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const selectors = ['[data-testid="search-workspace"]', '.search-palette', '.search-product-result', '.search-result']
    const boxes = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)].map((element) => {
      const rect = element.getBoundingClientRect()
      return { selector, left: rect.left, right: rect.right, width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
    }))
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.search-product-page button, .search-palette button')]
      .filter((button) => button.offsetParent !== null)
      .map((button) => ({ text: button.textContent?.trim() ?? '', scrollWidth: button.scrollWidth, clientWidth: button.clientWidth }))
    return { viewportWidth, documentScrollWidth: document.documentElement.scrollWidth, boxes, buttons }
  })
  expect(measurements.documentScrollWidth).toBeLessThanOrEqual(measurements.viewportWidth)
  for (const box of measurements.boxes) {
    expect(box.left, box.selector).toBeGreaterThanOrEqual(-1)
    expect(box.right, box.selector).toBeLessThanOrEqual(measurements.viewportWidth + 1)
    expect(box.scrollWidth, box.selector).toBeLessThanOrEqual(box.clientWidth + 1)
  }
  for (const button of measurements.buttons) {
    expect(button.scrollWidth, button.text).toBeLessThanOrEqual(button.clientWidth + 1)
  }
  return measurements
}

test.describe('mocked Search browser flow', () => {
  test('opens the TopNav palette, navigates with the keyboard, and restores focus', async ({ page }) => {
    await installSearchRoutes(page)
    await page.goto('/')
    // The nav search trigger's accessible name is the placeholder copy
    // ("Search Know-N…"), not the long-gone "Open search" label.
    const trigger = page.locator('.nav-search:visible, .nav-search-compact:visible').first()
    await trigger.focus()
    await trigger.click()
    const input = page.getByTestId('search-palette-input')
    await expect(input).toBeFocused()
    await input.fill('systems')
    await expect(page.getByRole('option', { name: /Systems without overflow/u })).toBeVisible()
    await input.press('ArrowDown')
    await expect(input).toHaveAttribute('aria-activedescendant', /search-palette-option-/u)
    await input.press('Escape')
    await expect(trigger).toBeFocused()
  })

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test(`keeps the Search workspace usable at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.addInitScript(() => localStorage.setItem('known.search-history', JSON.stringify(['private marker'])))
      await installSearchRoutes(page)
      await page.goto('/search?q=systems')
      await expect(page.getByText('Systems without overflow')).toBeVisible()
      await expect(page.locator('[data-testid="search-result-list"]')).toBeVisible()
      const metrics = await page.locator('[data-testid="search-workspace"]').evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
      expect(await page.evaluate(() => localStorage.getItem('known.search-history'))).toBe(JSON.stringify(['private marker']))
    })
  }

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`visually accepts Search states at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      const gates = { loading: createDeferred(), more: createDeferred() }
      await installVisualSearchRoutes(page, gates)

      await page.goto('/')
      if (viewport.width <= 640) {
        await page.getByRole('button', { name: 'Open menu' }).click()
        await page.locator('.mobile-search').click()
      } else {
        await page.locator('.nav-search:visible, .nav-search-compact:visible').first().click()
      }
      const paletteInput = page.getByTestId('search-palette-input')
      await paletteInput.fill('systems')
      await expect(page.getByRole('option', { name: /Systems without overflow/u })).toBeVisible()
      await assertNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`${viewport.width}x${viewport.height}-palette.png`), fullPage: true })
      await paletteInput.press('Escape')

      await page.goto('/search?q=systems')
      await expect(page.getByText('Systems without overflow')).toBeVisible()
      await assertNoHorizontalOverflow(page)
      await expect(page.locator('[data-testid="search-workspace"]')).toHaveScreenshot(
        `search-results-${viewport.width}.png`,
      )
      await page.screenshot({ path: testInfo.outputPath(`${viewport.width}x${viewport.height}-results.png`), fullPage: true })

      await page.goto('/search?q=loading')
      await expect(page.locator('[data-search-state="loading"]')).toBeVisible()
      await assertNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`${viewport.width}x${viewport.height}-loading.png`), fullPage: true })
      gates.loading.resolve()

      await page.goto('/search?q=empty')
      await expect(page.locator('[data-search-state="empty"]')).toBeVisible()
      await assertNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`${viewport.width}x${viewport.height}-empty.png`), fullPage: true })

      await page.goto('/search?q=error')
      await expect(page.locator('[data-search-state="error"]')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled()
      await assertNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`${viewport.width}x${viewport.height}-error.png`), fullPage: true })

      await page.goto('/search?q=paged')
      await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible()
      await page.getByRole('button', { name: 'Load more' }).click()
      await expect(page.locator('[data-search-state="loading-more"]')).toBeVisible()
      await assertNoHorizontalOverflow(page)
      await page.screenshot({ path: testInfo.outputPath(`${viewport.width}x${viewport.height}-pagination.png`), fullPage: true })
      gates.more.resolve()
      await expect(page.getByText('مرحبا 第二项')).toBeVisible()
      await assertNoHorizontalOverflow(page)
    })
  }
})
