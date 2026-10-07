import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': status === 200 ? 'public, max-age=60' : 'no-store' },
    body: JSON.stringify(body),
  })
}

async function mockAnonymousSession(page: Page): Promise<void> {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
}

function pageBody(input: {
  handle?: string
  displayName?: string
  avatarUrl?: string | null
  about?: string
  collections?: Array<Record<string, unknown>>
  cursor?: string | null
  hasMore?: boolean
} = {}) {
  return {
    profile: {
      handle: input.handle ?? 'mira',
      displayName: input.displayName ?? 'Mira Chen',
      avatarUrl: input.avatarUrl ?? null,
      about: input.about ?? '',
    },
    collections: input.collections ?? [{
      id: 'profile-collection-1', slug: 'systems-notes', title: 'Systems notes',
      summary: 'A public collection.', kind: 'knowledge_collection',
      updatedAt: '2026-07-24T00:00:00.000Z',
    }],
    page: { cursor: input.cursor ?? null, hasMore: input.hasMore ?? false },
  }
}

function productError(code: string, message: string) {
  return {
    error: {
      code, message, requestId: 'profile-e2e', recovery: 'user_action',
      sameRequestRetrySafe: false,
    },
  }
}

test.describe('public Profile with mocked Product API', () => {
  test('uses the generated route, paginates a complete ID set, and supports keyboard navigation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await mockAnonymousSession(page)
    const requests: string[] = []
    await page.route('**/api/v1/profiles/mira*', (route) => {
      const url = new URL(route.request().url())
      requests.push(`${url.pathname}${url.search}`)
      if (url.searchParams.get('cursor') === 'profile-page-2') {
        return json(route, pageBody({ collections: [
          {
            id: 'profile-collection-2', slug: 'database-notes', title: 'Database notes',
            summary: null, kind: 'bookmarks', updatedAt: '2026-07-23T00:00:00.000Z',
          },
          {
            id: 'profile-collection-3', slug: 'protocol-notes', title: 'Protocol notes',
            summary: null, kind: 'reading_path', updatedAt: '2026-07-22T00:00:00.000Z',
          },
        ] }))
      }
      return json(route, pageBody({ cursor: 'profile-page-2', hasMore: true }))
    })

    await page.goto('/u/mira', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: 'Mira Chen' })).toBeVisible()
    await expect(page.locator('[data-profile-field="bio"]')).toHaveCount(0)
    const loadMore = page.getByRole('button', { name: 'Load more' })
    await loadMore.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: /Database notes/u })).toBeFocused()
    await expect(page.getByRole('link', { name: /Protocol notes/u })).toBeVisible()

    const ids = await page.locator('[data-profile-collection-id]').evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-profile-collection-id')),
    )
    expect(ids).toEqual(['profile-collection-1', 'profile-collection-2', 'profile-collection-3'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(requests).toContain('/api/v1/profiles/mira?limit=24')
    expect(requests).toContain('/api/v1/profiles/mira?limit=24&cursor=profile-page-2')
    await expect(page.getByRole('link', { name: /Database notes/u })).toHaveAttribute('href', '/c/database-notes')
  })

  test('keeps not-found, empty, and retryable network failure as separate states on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockAnonymousSession(page)
    await page.route('**/api/v1/profiles/missing*', (route) =>
      json(route, productError('resource_not_found', 'not found'), 404))
    await page.route('**/api/v1/profiles/empty*', (route) =>
      json(route, pageBody({ handle: 'empty', displayName: 'Empty Profile', collections: [] })))
    let retryRequests = 0
    let recoverRetryProfile = false
    await page.route('**/api/v1/profiles/retry*', (route) => {
      retryRequests += 1
      return recoverRetryProfile
        ? json(route, pageBody({ handle: 'retry', displayName: 'Recovered Profile' }))
        : json(route, productError('feature_temporarily_unavailable', 'temporarily unavailable'), 503)
    })

    await page.goto('/u/missing', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Profile unavailable' })).toBeVisible()
    await expect(page.getByText('@missing', { exact: true })).toHaveCount(0)

    await page.goto('/profile/empty', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('No public collections yet')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Empty Profile' })).toBeVisible()

    await page.goto('/u/retry', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load this profile" })).toContainText("Couldn't load this profile")
    const requestsBeforeRetry = retryRequests
    recoverRetryProfile = true
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Recovered Profile' })).toBeVisible()
    expect(retryRequests).toBeGreaterThan(requestsBeforeRetry)
    const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual(390)
  })

  test('falls back after an image error and blocks a late handle response', async ({ page }) => {
    await mockAnonymousSession(page)
    await page.route('https://images.example.test/**', (route) => route.abort('failed'))
    let releaseMira: () => void = () => undefined
    const miraHeld = new Promise<void>((resolve) => { releaseMira = resolve })
    let miraReleasedHandled = false
    await page.route('**/api/v1/profiles/mira*', async (route) => {
      await miraHeld
      miraReleasedHandled = true
      await json(route, pageBody({
        handle: 'mira', displayName: 'Late Mira', avatarUrl: 'https://images.example.test/mira.png',
      })).catch(() => undefined)
    })
    await page.route('**/api/v1/profiles/kai*', (route) => json(route, pageBody({
      handle: 'kai', displayName: 'Kai Ito', avatarUrl: 'https://images.example.test/kai.png',
    })))

    const miraUrl = (url: string): boolean => {
      try {
        return new URL(url).pathname.endsWith('/api/v1/profiles/mira')
      } catch {
        return false
      }
    }
    const miraStarted = page.waitForRequest((request) => miraUrl(request.url()))
    await page.goto('/u/mira', { waitUntil: 'domcontentloaded' })
    await miraStarted
    const lateMira = page.waitForResponse((response) => miraUrl(response.url()))
    await page.evaluate(() => {
      window.history.pushState({}, '', '/u/kai')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByRole('heading', { level: 1, name: 'Kai Ito' })).toBeVisible()
    await expect(page.locator('.profile-public-avatar-fallback')).toHaveText('KI')
    releaseMira()
    await Promise.race([
      lateMira,
      expect.poll(() => miraReleasedHandled).toBe(true),
    ])
    await expect(page.getByRole('heading', { level: 1, name: 'Kai Ito' })).toBeVisible()
    await expect(page.getByText('Late Mira')).toHaveCount(0)
  })

  test('refreshes both direct Profile routes through the Product endpoint', async ({ page }) => {
    await mockAnonymousSession(page)
    let requests = 0
    await page.route('**/api/v1/profiles/deep-link*', (route) => {
      requests += 1
      return json(route, pageBody({ handle: 'deep-link', displayName: 'Deep Link Profile' }))
    })

    await page.goto('/profile/deep-link', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Deep Link Profile' })).toBeVisible()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Deep Link Profile' })).toBeVisible()
    await page.goto('/u/deep-link', { waitUntil: 'domcontentloaded' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Deep Link Profile' })).toBeVisible()
    expect(requests).toBeGreaterThanOrEqual(4)
  })

  test('renders a stored about on the public Profile hero', async ({ page }) => {
    await mockAnonymousSession(page)
    await page.route('**/api/v1/profiles/mira*', (route) =>
      json(route, pageBody({ about: 'I collect bookmarks.' })))

    await page.goto('/u/mira', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: 'Mira Chen' })).toBeVisible()
    await expect(page.locator('[data-profile-field="bio"]')).toHaveText('I collect bookmarks.')
  })
})
