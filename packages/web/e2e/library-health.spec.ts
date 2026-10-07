import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const CSRF = 'member-csrf'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MOCK_SEED_TITLES = [
  'Old layout systems roundup',
  'Radix UI documentation',
  'Design token pipeline notes',
  'Inventing on Principle',
  'Spacing as a system',
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  })
}

function productError(status: number) {
  return {
    error: {
      code: status === 503 ? 'feature_temporarily_unavailable' : 'internal_error',
      message: 'Link health is temporarily unavailable.',
      requestId: 'req_link_health_e2e',
      recovery: 'same_request',
      sameRequestRetrySafe: true,
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: null,
      fieldErrors: [],
    },
  }
}

const healthItems = [
  {
    nodeId: 'node-pending',
    collectionId: 'col-owned',
    collectionTitle: 'Owned reading list',
    title: 'Owned pending bookmark',
    url: 'https://bookmarks.test/pending',
    status: 'pending',
    duplicateOfNodeId: null,
    host: 'bookmarks.test',
  },
  {
    nodeId: 'node-redirect',
    collectionId: 'col-owned',
    collectionTitle: 'Owned reading list',
    title: 'Owned redirect bookmark',
    url: 'https://bookmarks.test/from',
    status: 'redirect',
    duplicateOfNodeId: null,
    host: 'bookmarks.test',
    finalUrl: 'https://bookmarks.test/to',
    httpStatus: 200,
    etag: '"node-redirect-1"',
  },
  {
    nodeId: 'node-duplicate',
    collectionId: 'col-owned',
    collectionTitle: 'Owned reading list',
    title: 'Owned duplicate bookmark',
    url: 'https://bookmarks.test/pending',
    status: 'pending',
    duplicateOfNodeId: 'node-pending',
    host: 'bookmarks.test',
  },
]

async function mockMemberSession(page: Page) {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => json(route, {
    authenticated: true,
    csrfToken: CSRF,
    idleExpiresAt: '2026-08-23T01:00:00.000Z',
    absoluteExpiresAt: '2026-08-24T00:00:00.000Z',
  }))
  await page.route('**/api/v1/me', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path !== '/api/v1/me') return route.fallback()
    return json(route, {
      account: { id: 'account-member', email: 'member@known.test' },
      profile: { id: 'profile-member', handle: 'member', displayName: 'Member Reader', avatarUrl: null },
    })
  })
}

async function enableLinkHealth(page: Page, enabled = true) {
  await page.addInitScript((value) => {
    const w = window as Window & { __KNOWN_FLAGS__?: Record<string, boolean> }
    w.__KNOWN_FLAGS__ = { ...(w.__KNOWN_FLAGS__ ?? {}), linkHealth: value }
  }, enabled)
}

function trackLinkHealth(page: Page) {
  const requests: { method: string; url: string }[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (!url.includes('/api/v1/me/link-health')) return
    requests.push({ method: request.method(), url })
  })
  return requests
}

function isLinkHealthList(url: string, method: string): boolean {
  if (method !== 'GET') return false
  const path = new URL(url).pathname
  return path === '/api/v1/me/link-health'
}

function isLinkHealthChecks(url: string, method: string): boolean {
  if (method !== 'POST') return false
  return new URL(url).pathname === '/api/v1/me/link-health/checks'
}

test.describe('library health with mocked Product API', () => {
  test('flag off shows a gated empty and never calls link-health', async ({ page }) => {
    await enableLinkHealth(page, false)
    await mockMemberSession(page)
    const requests = trackLinkHealth(page)
    await page.goto('/library/health', { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('link-health-flag-off')).toBeVisible()
    await expect(page.getByText(/not available/i)).toBeVisible()
    expect(requests.filter((item) => item.url.includes('/api/v1/me/link-health'))).toEqual([])
  })

  test('flag on lists Product facts, posts Check all with CSRF and command id, then refetches', async ({ page }) => {
    await enableLinkHealth(page)
    await mockMemberSession(page)
    const requests = trackLinkHealth(page)
    const posts: { csrf?: string; commandId?: string; ifMatch?: string }[] = []

    await page.route('**/api/v1/me/link-health**', async (route) => {
      const request = route.request()
      const url = request.url()
      if (isLinkHealthChecks(url, request.method())) {
        const headers = request.headers()
        posts.push({
          csrf: headers['x-csrf-token'],
          commandId: headers['known-command-id'],
          ifMatch: headers['if-match'],
        })
        return json(route, { queued: 3 })
      }
      if (isLinkHealthList(url, request.method())) {
        return json(route, { items: healthItems, nextCursor: null })
      }
      return route.fallback()
    })

    await page.goto('/library/health', { waitUntil: 'domcontentloaded' })
    expect(new URL(page.url()).pathname).toBe('/library/health')
    await expect(page.getByText('Owned pending bookmark')).toBeVisible()
    await expect(page.getByText('Owned redirect bookmark')).toBeVisible()
    await expect(page.getByText('Owned duplicate bookmark')).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'Owned pending bookmark' })
      .getByRole('cell', { name: 'Not checked yet', exact: true })).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'Owned redirect bookmark' })
      .getByRole('cell', { name: /^Redirected/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Stale\b/i })).toHaveCount(0)
    await expect(page.getByText('Apply suggested fixes')).toHaveCount(0)
    await expect(page.getByText('Checking 842')).toHaveCount(0)
    await expect(page.getByText('Interface Systems')).toHaveCount(0)
    for (const title of MOCK_SEED_TITLES) {
      await expect(page.getByText(title)).toHaveCount(0)
    }
    expect(requests.some((item) => isLinkHealthList(item.url, item.method))).toBe(true)

    const getsBeforeCheck = requests.filter((item) => isLinkHealthList(item.url, item.method)).length
    await expect(page.getByRole('button', { name: /Check all/i })).toBeEnabled()
    await page.getByRole('button', { name: /Check all/i }).click()
    await expect.poll(() => posts.length).toBe(1)
    expect(posts[0]?.csrf).toBe(CSRF)
    expect(posts[0]?.commandId).toMatch(UUID_V4)
    expect(posts[0]?.ifMatch).toBeUndefined()
    await expect.poll(
      () => requests.filter((item) => isLinkHealthList(item.url, item.method)).length,
    ).toBeGreaterThan(getsBeforeCheck)

    await page.goto('/library/health', { waitUntil: 'domcontentloaded' })
    expect(new URL(page.url()).pathname).toBe('/library/health')
    await expect(page.getByText('Owned pending bookmark')).toBeVisible()
  })

  test('GET 500 shows an alert EmptyState and Try again issues another GET', async ({ page }) => {
    await enableLinkHealth(page)
    await mockMemberSession(page)
    let fail = true
    const gets: string[] = []

    await page.route('**/api/v1/me/link-health**', async (route) => {
      const request = route.request()
      const url = request.url()
      if (isLinkHealthChecks(url, request.method())) {
        return json(route, { queued: 0 })
      }
      if (!isLinkHealthList(url, request.method())) return route.fallback()
      gets.push(url)
      if (fail) return json(route, productError(500), 500)
      return json(route, { items: healthItems, nextCursor: null })
    })

    await page.goto('/library/health', { waitUntil: 'domcontentloaded' })
    const alert = page.getByRole('alert').filter({ hasText: /Couldn't load link health/i })
    await expect(alert).toBeVisible({ timeout: 25_000 })
    await expect(alert).toContainText(/Couldn't load link health/i)
    const failedGets = gets.length
    expect(failedGets).toBeGreaterThan(0)
    fail = false
    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect.poll(() => gets.length).toBeGreaterThan(failedGets)
    await expect(alert).toHaveCount(0)
    await expect(page.getByText('Owned pending bookmark')).toBeVisible()
  })
})
