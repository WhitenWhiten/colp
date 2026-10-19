import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { fulfillPassiveFeatureRequest } from './helpers/passive-feature-mocks'

const collection = { id: 'library', library: true, kind: 'bookmarks', title: 'Bookmarks', summary: null,
  visibility: 'private', allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: 'root',
  revision: 'r1', etag: '"r1"', contentRevision: 'c1', contentEtag: '"c1"', policyRevision: 'p1', policyEtag: '"p1"',
  createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' }
const capabilities = { updateCollection: true, managePublication: false, createNode: true, updateNode: true, moveNode: true, deleteNode: true }

function folder(id: string, parentId: string, title: string, position: number, folderRole: string | null = null) {
  return { id, collectionId: 'library', kind: 'folder', folderRole, parentId, title, description: null, tags: [], visibility: 'inherit',
    position: String(position), revision: 'r1', etag: '"r1"', childrenRevision: 'c1', childrenEtag: '"c1"', readOnly: false, readOnlyReason: null,
    createdAt: collection.createdAt, updatedAt: collection.updatedAt }
}

function browserRoots() {
  return [
    folder('bar', 'root', 'Bookmarks bar', 0, 'bookmarks-bar'),
    folder('other', 'root', 'Other bookmarks', 1, 'other-bookmarks'),
    folder('mobile', 'root', 'Mobile bookmarks', 2, 'mobile-bookmarks'),
  ]
}

/** The owner's one-tree library holding `nodes`; folder creates append to it and land in `writes`. */
async function routeLibrary(page: Page, nodes: ReturnType<typeof folder>[], writes: Record<string, unknown>[] = []) {
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname
    const json = (body: unknown) => route.fulfill({ json: body })
    if (path === '/api/v1/session') return json({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
    if (path === '/api/v1/me') return json({ account: { id: 'owner', email: 'owner@example.test' }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } })
    if (path === '/api/v1/me/library') return json({ id: 'library', title: 'Bookmarks', rootNodeId: 'root', library: true, bookmarksBarId: 'bar', otherBookmarksId: 'other' })
    if (path === '/api/v1/collections/library/editor') return json({ collection, capabilities,
      root: { ...folder('root', '', 'Bookmarks', 0, 'root'), parentId: null, position: null }, nodes,
      page: { snapshotId: 'snapshot', contentRevision: 'c1', policyRevision: 'p1', comparatorVersion: '1', expiresAt: '2099-01-01T00:00:00Z', returnedCount: nodes.length, hasMore: false, nextCursor: null } })
    if (path === '/api/v1/collections/library/nodes' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); writes.push(body)
      const node = { ...nodes[0]!, ...body.node, id: `folder-${writes.length}`, parentId: body.parentId }
      nodes.push(node); return json({ node, collection })
    }
    if (await fulfillPassiveFeatureRequest(route)) return
    return route.fallback()
  })
  await page.route('**/.well-known/collection-protocol', route => route.fulfill({ status: 404, json: {} }))
}

test('a library with a synced Mobile root chooses every creation destination', async ({ page }) => {
  const writes: Record<string, unknown>[] = []
  await routeLibrary(page, browserRoots(), writes)
  await page.goto('/library')
  const nav = page.getByTestId('library-nav')
  await expect(nav.getByRole('link', { name: /Bookmarks bar/ })).toBeVisible()
  await expect(nav.getByRole('link', { name: /Other bookmarks/ })).toBeVisible()
  await expect(page.getByText('New collection', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/colp-w1-library-desktop.png', fullPage: true })
  await nav.getByRole('button', { name: 'New folder', exact: true }).click()
  // The library root holds only browser folders: the dialog starts in the first one.
  await expect(page.locator('#lc-parent')).toHaveAttribute('value', 'bar')
  await page.locator('#lc-title').fill('Research')
  await page.locator('#lc-parent').click()
  await page.locator('#lc-parent-panel').getByRole('option', { name: 'Bookmarks bar', exact: true }).click()
  await page.getByTestId('library-compose').getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]?.parentId).toBe('bar')
  await nav.getByRole('link', { name: /Bookmarks bar/ }).click()
  await nav.getByRole('button', { name: 'New folder', exact: true }).click()
  await expect(page.locator('#lc-parent')).toHaveAttribute('value', 'bar')
  await page.locator('#lc-title').fill('Reading')
  await page.getByTestId('library-compose').getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]?.parentId).toBe('bar')
  await nav.getByRole('link', { name: /Mobile bookmarks/ }).click()
  await nav.getByRole('button', { name: 'New folder', exact: true }).click()
  await page.locator('#lc-title').fill('On the go')
  await page.getByTestId('library-compose').getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect.poll(() => writes.length).toBe(3)
  expect(writes[2]?.parentId).toBe('mobile')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('library-mobile-switcher-trigger').click()
  await expect(page.getByTestId('library-mobile-switcher').getByRole('button', { name: /Other bookmarks/ })).toBeVisible()
  await expect(page.getByTestId('library-mobile-switcher').getByRole('button', { name: /^Mobile bookmarks/ })).toBeVisible()
  await page.screenshot({ path: '/tmp/colp-w1-library-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('opening and closing a folder never flashes the rail scrollbar', async ({ page }) => {
  // The Collapse motion is the subject here, so let it play.
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const nodes = browserRoots()
  for (let i = 0; i < 3; i++) {
    nodes.push(folder(`f${i}`, 'bar', `Folder ${i}`, i))
    for (let j = 0; j < 3; j++) nodes.push(folder(`f${i}-${j}`, `f${i}`, `Sub ${i}.${j}`, j))
  }
  await routeLibrary(page, nodes)
  await page.goto('/library')
  const nav = page.getByTestId('library-nav')
  await expect(nav.getByRole('link', { name: /Bookmarks bar/ })).toBeVisible()

  // Every frame of the motion, the rail must fit its content box.
  const overflowFrames = async (toggle: string) => {
    await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="library-nav"]')!
      const samples: number[] = []
      Object.assign(window, { railOverflow: samples })
      const sample = () => {
        samples.push(rail.scrollHeight - rail.clientHeight)
        if (samples.length < 40) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await nav.getByRole('button', { name: toggle, exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { railOverflow: number[] }).railOverflow.length)).toBe(40)
    return page.evaluate(() => (window as unknown as { railOverflow: number[] }).railOverflow.filter((d) => d > 0))
  }
  expect(await overflowFrames('Expand Bookmarks bar')).toEqual([])
  await expect(nav.getByRole('link', { name: /Folder 2/ })).toBeVisible()
  expect(await overflowFrames('Collapse Bookmarks bar')).toEqual([])
})
