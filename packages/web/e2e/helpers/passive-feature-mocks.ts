import type { Page, Route } from '@playwright/test'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

const emptyPage = { items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }

/** Background reads the app chrome and the library desk make on every page. */
export async function fulfillPassiveFeatureRequest(route: Route): Promise<boolean> {
  const request = route.request()
  const url = new URL(request.url())
  const path = url.pathname
  if (request.method() !== 'GET') return false
  if (path === '/api/v1/collections'
    || path === '/api/v1/me/shared-collections'
    || path === '/api/v1/me/collaboration-invites') {
    await json(route, emptyPage)
    return true
  }
  /* The login page reads whether first-run registration is open; a closed
     answer keeps the sign-in form on its usual path under strict mocks. */
  if (path === '/api/v1/auth/registration-state') {
    await json(route, { open: false, reason: 'closed' })
    return true
  }
  /* The desk's Get started checklist asks whether a browser syncs and an
     agent is connected; empty answers leave those steps open. */
  if (path === '/api/v1/sync/status') {
    await json(route, { devices: [], replicas: [] })
    return true
  }
  if (path === '/api/v1/me/agents') {
    await json(route, { agents: [] })
    return true
  }
  /* The nav asks once whether this server has automations; the concealed
     answer keeps the Automations entry out of every other spec's chrome. */
  if (path === '/api/v1/me/automations/pause' || path === '/api/v1/me/activity/summary') {
    await json(route, { error: { code: 'resource_not_found', message: 'Not found', recovery: 'user_action' } }, 404)
    return true
  }
  if (path === '/api/v1/me/library-order') {
    await json(route, { sections: { mine: [], shared: [], following: [] } })
    return true
  }
  if (path === '/api/v1/me/favicon-policy') {
    await route.fulfill({ json: { revision: '1', newDefault: 'capture',
      providerTemplate: 'https://favicone.com/{hostname}', fillMissing: false, forceAllOnline: false },
    headers: { ETag: '"favicon-policy:1"' } })
    return true
  }
  /* The desk's comfort rows lazily pull note/TL;DR snippets per visible
     bookmark; an empty page keeps that sidecar silent under strict mocks. */
  if (/^\/api\/v1\/collections\/[^/]+\/annotations$/u.test(path)) {
    await json(route, { annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } })
    return true
  }
  const source = path.match(/^\/api\/v1\/collections\/([^/]+)\/nodes\/([^/]+)\/favicon-source$/u)
  if (source) {
    await route.fulfill({ json: {
      collectionId: source[1], nodeId: source[2], nodeResourceRevision: '1', revision: '1',
      policyRevision: '1', sourceMode: 'inherit', effectiveMode: 'capture', iconUrl: null,
      iconVersion: null, directUrl: null, status: 'missing', restorable: false,
      updatedAt: '2026-07-22T00:00:00.000Z',
    }, headers: { ETag: '"favicon-source:1:1"' } })
    return true
  }
  return false
}

export async function installPassiveFeatureMocks(page: Page): Promise<void> {
  await page.context().route('**/api/v1/**', async (route) => {
    if (!await fulfillPassiveFeatureRequest(route)) await route.fallback()
  })
}
