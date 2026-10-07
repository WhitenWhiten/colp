import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/* R15-28: a large public collection must lay out cheaply in Board and
   Gallery views without breaking the masonry or keyboard reach. */

const slug = 'large-collection'
const COUNT = 300

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function openLargeCollection(page: Page, view: 'board' | 'gallery' | 'compact') {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
    collection: {
      id: 'col-large', slug, title: 'Large collection', summary: 'Many links.',
      kind: 'bookmarks', rootNodeId: 'root', updatedAt: '2026-09-20T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'root', parentId: null, kind: 'root', title: 'Contents', description: null, url: null, position: null },
      ...Array.from({ length: COUNT }, (_, i) => ({
        id: `bm-${i}`, parentId: 'root', kind: 'bookmark', title: `Reference ${i}`,
        // Uneven descriptions give the masonry uneven card heights.
        description: 'A line of description. '.repeat(1 + (i % 5)),
        url: `https://example.com/${i}`, position: `b${String(i).padStart(3, '0')}`,
      })),
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/c/${slug}?view=${view}`)
  // Compact windows its rows, so only the first is sure to be mounted.
  await expect(page.getByText(view === 'compact' ? 'Reference 0' : `Reference ${COUNT - 1}`, { exact: true }).first()).toBeAttached()
}

test('Gallery spans every card by its height and cards never overlap', async ({ page }) => {
  await openLargeCollection(page, 'gallery')
  const report = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('.gallery-board > [data-gallery-card]')]
    const missing = cards.filter((card) => !card.style.getPropertyValue('--gallery-span')).length
    const boxes = cards.map((card) => card.getBoundingClientRect())
    let overlaps = 0
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < Math.min(boxes.length, i + 12); j += 1) {
        const a = boxes[i]!, b = boxes[j]!
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps += 1
      }
    }
    return { cards: cards.length, missing, overlaps }
  })
  expect(report).toEqual({ cards: 300, missing: 0, overlaps: 0 })
})

test('Board cards skip off-screen rendering yet stay reachable', async ({ page }) => {
  await openLargeCollection(page, 'board')
  const card = page.locator('.result-board .result-card').last()
  await expect(card).toHaveCSS('content-visibility', 'auto')
  const link = card.getByRole('link').first()
  await link.focus()
  await expect(link).toBeFocused()
  await expect(link).toBeInViewport()
})

test('the long virtual list keeps a thin scrollbar as its length cue (R15-46)', async ({ page }) => {
  await openLargeCollection(page, 'compact')
  const list = page.locator('.virtual-list').first()
  await expect(list).toBeAttached()
  await expect(list).toHaveCSS('scrollbar-width', 'thin')
})
