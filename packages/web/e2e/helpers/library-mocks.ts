import type { Page, Route } from '@playwright/test'
import { installPassiveFeatureMocks } from './passive-feature-mocks'

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

const collection = {
  id: 'col-1', kind: 'bookmarks', title: 'Reading queue', summary: null,
  visibility: 'private', publicationSlug: null, publishedAt: null,
  rootNodeId: 'root-1', revision: '1', etag: '"c-1"', contentRevision: '1', contentEtag: '"cc-1"',
  policyRevision: '1', policyEtag: '"p-1"', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
}
const capabilities = { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true }

/** A signed-in owner with one private collection (`col-1`) holding one bookmark. */
export async function mockOwnerLibrary(page: Page): Promise<void> {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => json(route, {
    authenticated: true, csrfToken: 'e2e-csrf', idleExpiresAt: '2099-01-01T00:00:00.000Z', absoluteExpiresAt: '2099-01-02T00:00:00.000Z',
  }))
  await page.route('**/api/v1/me', (route) => json(route, {
    account: { id: 'acc-1', email: 'owner@colp.test' },
    profile: { id: 'prof-1', handle: 'owner', displayName: 'Owner', avatarUrl: null },
  }))
  // The account's one library is col-1, so the desk loads no other tree.
  await page.route('**/api/v1/me/library', (route) => json(route, {
    id: collection.id, title: collection.title, rootNodeId: collection.rootNodeId, library: true,
    bookmarksBarId: 'bar-1', otherBookmarksId: 'other-1',
  }))
  await page.route('**/api/v1/collections', (route) => json(route, {
    items: [{ collection, capabilities, bookmarkCount: 1 }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
  }))
  await page.route('**/api/v1/collections/col-1/editor*', (route) => json(route, {
    collection,
    root: { id: 'root-1', kind: 'folder', folderRole: 'root', title: 'Reading queue', description: null, tags: [], revision: 'r', etag: '"r"' },
    nodes: [{
      id: 'n-1', parentId: 'root-1', kind: 'bookmark', title: 'Cascade notes', url: 'https://css.example', description: null,
      tags: [], visibility: 'inherit', position: 'a', revision: 'n', etag: '"n"', readOnly: false, readOnlyReason: null,
    }],
    capabilities,
    page: { snapshotId: 's', contentRevision: '1', policyRevision: '1', comparatorVersion: 'v1', expiresAt: '2099-01-01T00:00:00.000Z', returnedCount: 1, hasMore: false, nextCursor: null },
  }))
}

/** A signed-out visitor and one public collection at `/c/{slug}`. */
export async function mockGuestPublicCollection(page: Page, slug = 'reading-notes'): Promise<void> {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
    collection: {
      id: 'col-public', slug, title: 'Reading notes', summary: 'Public reading list.',
      kind: 'bookmarks', rootNodeId: 'root-public', updatedAt: '2026-08-20T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'root-public', parentId: null, kind: 'root', title: 'Contents', description: null, url: null, position: null },
      { id: 'p-1', parentId: 'root-public', kind: 'bookmark', title: 'Chromium blog', description: null, url: 'https://chromium.org', position: 'a' },
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }))
}
