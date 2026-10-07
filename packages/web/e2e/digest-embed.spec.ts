import { test, expect } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

for (const fixed of [false, true]) {
  test(`digest ${fixed ? 'issue' : 'series'} embed matches the shared card and keeps footer visible`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 360 })
    await page.addInitScript(() => { window.__KNOWN_FLAGS__ = { reports: true, community: false } })
    await installPassiveFeatureMocks(page)
    await page.route('**/api/v1/session', route => route.fulfill({ json: { authenticated: false } }))
    const issue = { id: 'ed-1', title: 'First issue', summary: 'Issue summary', publishedAt: '2026-09-22T00:00:00Z', url: '/reports/weekly/issues/ed-1', sourceCollectionSlug: 'edition-source' }
    await page.route('**/api/v1/public-reports/weekly', route => route.fulfill({ json: { id: 'series-1', slug: 'weekly', title: 'Weekly digest', summary: 'Series summary', visibility: 'public', indexable: true, updatedAt: issue.publishedAt, issues: [issue] } }))
    await page.route('**/api/v1/public-reports/weekly/issues/ed-1', route => route.fulfill({ json: issue }))
    await page.route('**/api/v1/collections/edition-source*', route => route.fulfill({ json: {
      collection: { id: 'col-1', slug: 'edition-source', title: 'Source', kind: 'bookmarks', rootNodeId: 'root', updatedAt: issue.publishedAt, access: 'public' },
      nodes: [{ id: 'root', parentId: null, kind: 'root', title: 'Root', url: null, description: null, position: null }, ...Array.from({ length: 6 }, (_, i) => ({ id: `node-${i}`, parentId: 'root', kind: 'bookmark', title: `Reference ${i}`, url: `https://example.com/${i}`, description: null, position: String(i) }))],
      page: { cursor: null, hasMore: false, sequence: 1 },
    } }))
    const path = fixed ? '/reports/weekly/issues/ed-1' : '/reports/weekly'
    await page.goto(`${path}?embed=1&bg=%23ffffff&text=%23ffffff&font=mono&divider=dotted&fontSize=18&padding=28&density=comfortable`)
    await expect(page.getByRole('heading', { name: fixed ? 'First issue' : 'Weekly digest', exact: true })).toBeVisible()
    await expect(page.locator('.site-header, .site-footer')).toHaveCount(0)
    const brand = page.locator('.share-embed-foot-brand')
    await expect(brand).toHaveCSS('color', 'rgb(0, 0, 0)')
    const box = await brand.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(360)
    const open = page.locator('.share-embed-foot-open')
    await expect(open).toHaveAttribute('href', `https://know-n.com${path}`)
    await expect(open).toHaveAttribute('target', '_blank')
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('share-embed-page').locator(':focus')).toHaveCSS('outline-style', 'solid')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    // No scrollbar painted inside the host's page — the overflowing list
    // still scrolls, it just never shows a bar the host cannot restyle.
    const list = page.getByTestId('share-embed-list')
    await expect(list).toHaveCSS('scrollbar-width', 'none')
    await expect(page.locator('html')).toHaveCSS('scrollbar-width', 'none')
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await list.hover()
    await page.mouse.wheel(0, 200)
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  })
}

test('a one-issue digest shows keyboard focus on its issue row (R15-47)', async ({ page }) => {
  await page.addInitScript(() => { window.__KNOWN_FLAGS__ = { reports: true, community: false } })
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', route => route.fulfill({ json: { authenticated: false } }))
  const issue = { id: 'ed-1', title: 'First issue', summary: 'Issue summary', publishedAt: '2026-09-22T00:00:00Z', url: '/reports/weekly/issues/ed-1', sourceCollectionSlug: 'edition-source' }
  await page.route('**/api/v1/public-reports/weekly', route => route.fulfill({ json: { id: 'series-1', slug: 'weekly', title: 'Weekly digest', summary: 'Series summary', visibility: 'public', indexable: true, updatedAt: issue.publishedAt, issues: [issue] } }))
  await page.goto('/reports/weekly')
  const row = page.locator('a.report-issue-row').first()
  await expect(row).toBeVisible()
  await row.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(row).toBeFocused()
  // Drawn inside the row, so the list's overflow: hidden cannot clip it.
  await expect(row).toHaveCSS('outline-offset', '-2px')
  await expect(row).not.toHaveCSS('outline-style', 'none')
})
