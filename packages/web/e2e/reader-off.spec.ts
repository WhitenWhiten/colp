import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const collectionId = 'reader-off-collection'
const nodeId = 'reader-off-bookmark'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installReaderOffState(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, {
    authenticated: true,
    csrfToken: 'reader-off-csrf',
    idleExpiresAt: '2099-09-20T01:00:00.000Z',
    absoluteExpiresAt: '2099-09-21T00:00:00.000Z',
  }))
  await page.route('**/api/v1/me', (route) => json(route, {
    account: { id: 'reader-off-account', email: 'reader-off@known.test' },
    profile: { id: 'reader-off-profile', handle: 'reader-off', displayName: 'Reader Off', avatarUrl: null },
  }))
  await installPassiveFeatureMocks(page)
  await page.route(`**/api/v1/collections/${collectionId}/editor*`, (route) => json(route, {
    collection: {
      id: collectionId, title: 'Saved research', kind: 'bookmarks', summary: null,
      visibility: 'private', allowSearchIndexing: false, rootNodeId: 'reader-off-root',
      publicationSlug: null, publishedAt: null, revision: 'c1', etag: '"c1"',
      contentRevision: 'cc1', contentEtag: '"cc1"', policyRevision: 'p1', policyEtag: '"p1"',
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    },
    root: {
      id: 'reader-off-root', collectionId, kind: 'folder', folderRole: 'root', parentId: null,
      position: null, title: 'Root', description: null, tags: [], visibility: 'inherit',
      revision: 'r1', etag: '"r1"', readOnly: true, readOnlyReason: 'root_immutable',
      childrenRevision: 'cr1', childrenEtag: '"cr1"', createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    },
    nodes: [{
      id: nodeId, collectionId, kind: 'bookmark', parentId: 'reader-off-root', position: 'a',
      title: 'Designing reliable interfaces', description: 'A saved explanation of resilient interface design.',
      url: 'https://example.com/reliable-interfaces', iconUrl: null, tags: ['design', 'reliability'],
      visibility: 'inherit', revision: 'n1', etag: '"n1"', readOnly: false, readOnlyReason: null,
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    }],
    capabilities: {
      updateCollection: true, managePublication: true, createNode: true,
      updateNode: true, moveNode: true, deleteNode: true,
    },
    page: {
      snapshotId: 'reader-off-snapshot', contentRevision: 'cc1', policyRevision: 'p1',
      comparatorVersion: 'v1', expiresAt: '2099-09-21T00:00:00.000Z',
      returnedCount: 1, hasMore: false, nextCursor: null,
    },
  }))
  await page.route(`**/api/v1/collections/${collectionId}/annotations*`, (route) => json(route, {
    annotations: [
      {
        id: 'reader-off-tldr', collectionId, subject: { type: 'node', id: nodeId }, type: 'tldr',
        format: 'markdown', value: '**Resilience starts with explicit states.**', visibility: 'private',
        creator: null, provenance: { kind: 'human' }, revision: 'a1',
        createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', extensions: {},
      },
      {
        id: 'reader-off-note', collectionId, subject: { type: 'node', id: nodeId }, type: 'note',
        format: 'plain', value: 'Keep the recovery path next to the failed action.', visibility: 'private',
        creator: null, provenance: { kind: 'human' }, revision: 'a2',
        createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', extensions: {},
      },
      {
        id: 'reader-off-highlight', collectionId, subject: { type: 'node', id: nodeId }, type: 'highlight',
        format: 'plain', value: 'A complete highlighted passage remains visible.', visibility: 'private',
        creator: null, provenance: { kind: 'human' }, revision: 'a3',
        createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', extensions: {},
      },
    ],
    page: { returnedCount: 3, hasMore: false, nextCursor: null },
  }))
  await page.route(`**/api/v1/collections/${collectionId}/relations*`, (route) => json(route, {
    relations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null },
  }))
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__KNOWN_FLAGS__ = { ...(window.__KNOWN_FLAGS__ ?? {}), readableReplica: false }
  })
  await installReaderOffState(page)
})

test('redirects old Reader links to complete resource details at desktop and mobile widths', async ({ page }, testInfo) => {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    await expect(page).toHaveURL(new RegExp(`/r/${nodeId}\\?collectionId=${collectionId}&subjectType=node$`, 'u'))
    await expect(page.getByRole('heading', { level: 1, name: 'Designing reliable interfaces' })).toBeVisible()
    await expect(page.getByText('Resilience starts with explicit states.')).toBeVisible()
    await expect(page.getByText('Keep the recovery path next to the failed action.')).toBeVisible()
    await expect(page.getByText('A complete highlighted passage remains visible.')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Read in Know-N' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Open reading view' })).toHaveCount(0)
    await expect(page.locator('a[href^="/read/"]')).toHaveCount(0)
    await expect(page.getByRole('link', { name: /Open original/u })).toHaveClass(/btn-primary/u)

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport)

    const screenshot = testInfo.outputPath(`reader-off-details-${viewport.name}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach(`reader-off-details-${viewport.name}`, { path: screenshot, contentType: 'image/png' })
  }
})

test('bookmark detail Tab order follows the one-column visual order on phones (R15-33)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  await expect(page.getByRole('heading', { level: 1, name: 'Designing reliable interfaces' })).toBeVisible()
  // Start inside the page, on the card's first action.
  await page.getByRole('link', { name: /Open original/u }).focus()
  const tops: Array<{ top: number; what: string }> = []
  for (let i = 0; i < 25; i += 1) {
    const where = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      if (!active || !active.closest('#main')) return null
      return { top: Math.round(active.getBoundingClientRect().top + window.scrollY), what: active.textContent?.trim().slice(0, 30) ?? '' }
    })
    if (where === null) break
    tops.push(where)
    await page.keyboard.press('Tab')
  }
  expect(tops.length).toBeGreaterThan(3)
  const backwards = tops.filter((entry, i) => i > 0 && entry.top < tops[i - 1]!.top - 4)
  expect(backwards, JSON.stringify(tops)).toEqual([])

  // Desktop keeps the aside in the second track, level with the card.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => window.scrollTo(0, 0))
  const card = await page.getByRole('heading', { level: 1 }).locator('xpath=ancestor::header[1]').boundingBox()
  const aside = await page.getByRole('complementary', { name: 'Bookmark details' }).boundingBox()
  expect(aside!.x).toBeGreaterThanOrEqual(card!.x + card!.width)
  expect(Math.abs(aside!.y - card!.y)).toBeLessThan(4)
})
