import type { Page, Route } from '@playwright/test'

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
}

const emptyPage = { items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }
const missingResource = {
  error: {
    code: 'resource_not_found',
    message: 'Resource is unavailable.',
    requestId: 'e2e-passive-feature',
    recovery: 'none',
    sameRequestRetrySafe: false,
    precondition: null,
    currentEtag: null,
    retryAfterSeconds: null,
    fieldErrors: [],
  },
}

export async function fulfillPassiveFeatureRequest(route: Route): Promise<boolean> {
  const request = route.request()
  const url = new URL(request.url())
  const path = url.pathname
  // App chrome polls only the unread badge here. Inbox workflows still own
  // their larger pages, filters and write requests in the strict API mock.
  if (request.method() === 'GET' && path === '/api/v1/me/community-notifications'
    && url.searchParams.size === 2 && url.searchParams.get('read') === 'all'
    && url.searchParams.get('limit') === '1') {
    await json(route, { items: [], nextCursor: null, unreadCount: 0 })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/collections') {
    await json(route, emptyPage)
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/explore/collections') {
    await json(route, { items: [], nextCursor: null })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/me/library-order') {
    await json(route, { sections: { mine: [], shared: [], following: [] } })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/me/shared-collections') {
    await json(route, emptyPage)
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/me/collaboration-invites') {
    await json(route, emptyPage)
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/me/followed-collections') {
    await json(route, { items: [], nextCursor: null })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/me/followed-reports') {
    await json(route, { items: [], nextCursor: null })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/me/reports'
    && url.searchParams.size === 1 && url.searchParams.get('limit') === '20') {
    await json(route, { items: [], nextCursor: null })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/community/target'
    && url.searchParams.get('id')
    && ((url.searchParams.size === 3 && url.searchParams.get('kind') === 'bookmark'
      && url.searchParams.get('collectionId'))
      || (url.searchParams.size === 2 && url.searchParams.get('kind') === 'collection'))) {
    await json(route, missingResource, 404)
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/public-reports') {
    await json(route, { items: [], nextCursor: null })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/saved-resources') {
    await json(route, emptyPage)
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/reading-progress') {
    await json(route, emptyPage)
    return true
  }
  /* The desk's comfort rows lazily pull note/TL;DR snippets per visible
     bookmark; an empty page keeps that sidecar silent under strict mocks. */
  if (request.method() === 'GET' && /^\/api\/v1\/collections\/[^/]+\/annotations$/u.test(path)) {
    await json(route, { annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } })
    return true
  }
  if (request.method() === 'GET' && /^\/api\/v1\/collections\/[^/]+\/catalog$/u.test(path)
    && url.searchParams.size === 0) {
    await json(route, { tags: [], language: null, revision: 'catalog-e2e-1' })
    return true
  }
  if (request.method() === 'GET' && path === '/api/v1/notifications') {
    await json(route, { items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null }, unreadCount: 0 })
    return true
  }
  if (request.method() === 'GET' && /^\/api\/v1\/collections\/[^/]+\/follow$/u.test(path)) {
    await json(route, { following: false, followerCount: 0, followedAt: null })
    return true
  }
  if (request.method() === 'POST' && /^\/api\/v1\/public-collections\/[^/]+\/insight-events$/u.test(path)) {
    await route.fulfill({ status: 204, body: '' })
    return true
  }
  if (request.method() === 'GET' && path.startsWith('/api/v1/reading-progress/')) {
    await json(route, missingResource, 404)
    return true
  }
  if (request.method() === 'PUT' && path.startsWith('/api/v1/reading-progress/')) {
    const body = request.postDataJSON() as { status: string; progress: number }
    await json(route, {
      status: body.status,
      progress: body.progress,
      completedAt: body.status === 'completed' ? '2026-07-25T00:00:00.000Z' : null,
      updatedAt: '2026-07-25T00:00:00.000Z',
    }, 200, { ETag: '"e2e-reading-progress"' })
    return true
  }
  if (request.method() === 'DELETE' && path.startsWith('/api/v1/reading-progress/')) {
    await route.fulfill({ status: 204, body: '' })
    return true
  }
  if (request.method() === 'GET' && /^\/api\/v1\/collections\/[^/]+\/nodes\/[^/]+\/readable$/u.test(path)) {
    const segments = path.split('/')
    await json(route, {
      nodeId: segments[6],
      collectionId: segments[4],
      status: 'unsupported',
      sourceUrl: 'https://e2e.passive.test',
      title: null,
      byline: null,
      wordCount: 0,
      extractedAt: null,
      failureCode: 'not_html',
      sections: [],
      etag: null,
    })
    return true
  }
  return false
}

export async function installPassiveFeatureMocks(page: Page): Promise<void> {
  await page.context().route('**/api/v1/**', async (route) => {
    if (!await fulfillPassiveFeatureRequest(route)) await route.fallback()
  })
}
