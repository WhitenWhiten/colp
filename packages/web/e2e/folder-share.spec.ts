import type { BrowserContext } from '@playwright/test'
import { expect, test } from './fixtures'
import { fulfillPassiveFeatureRequest } from './helpers/passive-feature-mocks'

test('shares a folder, shows only its subtree to a fresh visitor, and stops the link', async ({ page, browser, context }) => {
  const at = '2026-10-16T00:00:00Z'
  const collection = { id: 'library', library: true, kind: 'bookmarks', title: 'Bookmarks', summary: null,
    visibility: 'private', allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: 'root',
    revision: 'r1', etag: '"r1"', contentRevision: 'c1', contentEtag: '"c1"', policyRevision: 'p1', policyEtag: '"p1"', createdAt: at, updatedAt: at }
  const capabilities = { updateCollection: true, managePublication: false, createNode: true, updateNode: true, moveNode: true, deleteNode: true }
  const nodes = [
    { id: 'bar', parentId: 'root', kind: 'folder', title: 'Bookmarks bar' },
    { id: 'other', parentId: 'root', kind: 'folder', title: 'Other bookmarks' },
    { id: 'reading', parentId: 'bar', kind: 'folder', title: 'Reading' },
    { id: 'inside', parentId: 'reading', kind: 'bookmark', title: 'Inside reading', url: 'https://example.test/inside' },
    { id: 'outside', parentId: 'bar', kind: 'bookmark', title: 'Outside reading', url: 'https://example.test/outside' },
  ].map((node, index) => ({ ...node, collectionId: 'library', folderRole: null, description: null, tags: [], visibility: 'inherit', position: String(index),
    revision: 'r1', etag: '"r1"', childrenRevision: 'c1', childrenEtag: '"c1"', readOnly: false, readOnlyReason: null, createdAt: at, updatedAt: at }))
  const share = { id: 'share-reading', collectionId: 'library', nodeId: 'reading', slug: 'folder-0123456789abcdef0123456789abcdef', createdAt: at }
  let active = false
  const unexpected: string[] = []
  async function routes(target: BrowserContext, anonymous = false) {
    await target.route('**/.well-known/collection-protocol', route => route.fulfill({ status: 404, json: {} }))
    await target.route('**/api/v1/**', async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method()
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
      if (path === '/api/v1/session') return json(anonymous ? { authenticated: false } : { authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
      if (path === '/api/v1/me') return json({ account: { id: 'owner', email: 'owner@example.test' }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } })
      if (path === '/api/v1/me/library') return json({ id: 'library', title: 'Bookmarks', rootNodeId: 'root', library: true, bookmarksBarId: 'bar', otherBookmarksId: 'other' })
      if (path === '/api/v1/collections/library/editor') return json({ collection, capabilities,
        root: { ...nodes[0], id: 'root', parentId: null, position: null, folderRole: 'root', title: 'Bookmarks' },
        nodes: nodes.map(node => node.id === 'reading' && active ? { ...node, shared: true } : node),
        page: { snapshotId: 'snapshot', contentRevision: 'c1', policyRevision: 'p1', comparatorVersion: '1', expiresAt: '2099-01-01T00:00:00Z', returnedCount: nodes.length, hasMore: false, nextCursor: null } })
      if (path === '/api/v1/collections/library/nodes/reading/share') {
        if (method !== 'GET') {
          expect(route.request().headers()['x-csrf-token']).toBe('csrf')
          expect(route.request().headers()['known-command-id']).toMatch(/^[\da-f-]{36}$/)
          active = method === 'PUT'
        }
        return json({ share: active ? share : null })
      }
      if (path === `/api/v1/collections/${share.slug}`) {
        if (!active) return json({ error: { code: 'resource_not_found', message: 'Not found', recovery: 'none' } }, 404)
        return json({ collection: { id: 'library', slug: share.slug, folderShare: true, title: 'Reading', summary: null,
          kind: 'bookmarks', rootNodeId: 'reading', updatedAt: at, access: 'public', viewCount: 0, curatorNote: null, faviconCdnAllowed: false,
          owner: { profileId: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } },
          nodes: [{ id: 'reading', parentId: null, kind: 'root', title: 'Reading', description: null, url: null, position: null, iconUrl: null },
            { id: 'inside', parentId: 'reading', kind: 'bookmark', title: 'Inside reading', url: 'https://example.test/inside', description: null, position: 'a', iconUrl: null, faviconCdnAllowed: false }],
          page: { cursor: null, hasMore: false, sequence: 1 } })
      }
      if (await fulfillPassiveFeatureRequest(route)) return
      unexpected.push(`${method} ${path}`); return json({ error: { code: 'resource_not_found', message: 'Unexpected test request' } }, 404)
    })
  }
  await routes(context)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/library?folder=bar')
  await page.locator('[data-folder-actions]', { hasText: 'Reading' }).getByRole('button', { name: 'Actions for Reading', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Share Reading' })
  await dialog.getByRole('button', { name: 'Create link', exact: true }).click()
  await expect(dialog.getByText('Anyone with the link can view this folder.')).toBeVisible()
  await expect(dialog.getByTestId('copy-field-value')).toContainText(share.slug)
  await expect(page.getByTestId('library-nav').getByRole('img', { name: 'Shared by link' })).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Copy Folder link' }).click()
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible()
  const link = await dialog.getByRole('link', { name: 'Open link', exact: true }).getAttribute('href')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)
  await page.screenshot({ path: '/tmp/colp-w2-share-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(dialog.getByRole('button', { name: 'Stop sharing', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/colp-w2-share-mobile.png', fullPage: true })
  const visitor = await browser.newContext()
  try {
    await routes(visitor, true)
    const guest = await visitor.newPage(); await guest.goto(link!)
    await expect(guest.getByRole('heading', { name: 'Reading', exact: true })).toBeVisible()
    await expect(guest.getByRole('link', { name: 'Inside reading', exact: true })).toBeVisible()
    await expect(guest.getByText('Outside reading', { exact: true })).toHaveCount(0)
    await expect(guest.getByText('Shared folder', { exact: true })).toBeVisible()
    await expect(guest.locator('meta[name="robots"][data-page-meta-owned="true"]')).toHaveAttribute('content', 'noindex')
    await expect(guest.getByRole('button', { name: /Subscribe/ })).toHaveCount(0)
    await guest.screenshot({ path: '/tmp/colp-w2-public-folder.png', fullPage: true })
    await dialog.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Create link', exact: true })).toBeVisible()
    await expect(page.getByTestId('library-nav').getByRole('img', { name: 'Shared by link' })).toHaveCount(0)
    await guest.reload(); await expect(guest.getByRole('heading', { name: 'Collection unavailable', exact: true })).toBeVisible()
    await expect(guest.getByText('Inside reading', { exact: true })).toHaveCount(0)
  } finally { await visitor.close() }
  expect(unexpected).toEqual([])
})
