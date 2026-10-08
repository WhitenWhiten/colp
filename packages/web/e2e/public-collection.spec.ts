import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const slug = 'browser-research'

test.beforeEach(async ({ page }) => installPassiveFeatureMocks(page))

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': status === 200 ? 'public, max-age=60' : 'private, no-store' },
    body: JSON.stringify(body),
  })
}

async function mockAnonymousSession(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
}

async function mockMemberSession(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, {
    authenticated: true,
    csrfToken: 'member-csrf',
    idleExpiresAt: '2026-07-24T01:00:00.000Z',
    absoluteExpiresAt: '2026-07-25T00:00:00.000Z',
  }))
  await page.route('**/api/v1/me', (route) => json(route, {
    account: { id: 'account-member', email: 'member@known.test' },
    profile: { id: 'profile-member', handle: 'member', displayName: 'Member Reader', avatarUrl: null },
  }))
}

test.describe('public collection with mocked Product API', () => {
  test('assembles all pages before rendering and protects external links on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockAnonymousSession(page)
    const requests: string[] = []
    let releasePage2: () => void = () => undefined
    const page2Held = new Promise<void>((resolve) => { releasePage2 = resolve })
    await page.route(`**/api/v1/collections/${slug}*`, async (route) => {
      const url = new URL(route.request().url())
      requests.push(url.search)
      if (url.searchParams.get('cursor') === 'page-2') {
        await page2Held
        return json(route, {
          collection: {
            id: 'col-browser', slug, title: 'Browser research', summary: 'Production projection in a mocked browser.',
            kind: 'bookmarks', rootNodeId: 'root-browser', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
          },
          nodes: [
            {
              id: 'safe-link', parentId: 'folder-browser', kind: 'bookmark', title: 'Safe reference',
              description: 'An external HTTPS source.', url: 'https://example.com/source', position: 'b',
            },
            {
              id: 'unsafe-link', parentId: 'folder-browser', kind: 'bookmark', title: 'Unsafe reference',
              description: null, url: 'javascript:alert(1)', position: 'c',
            },
          ],
          page: { cursor: null, hasMore: false, sequence: 2 },
        })
      }
      return json(route, {
        collection: {
          id: 'col-browser', slug, title: 'Browser research', summary: 'Production projection in a mocked browser.',
          kind: 'bookmarks', rootNodeId: 'root-browser', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
        },
        nodes: [
          {
            id: 'root-browser', parentId: null, kind: 'root', title: 'Contents',
            description: null, url: null, position: null,
          },
          {
            id: 'folder-browser', parentId: 'root-browser', kind: 'folder', title: 'Foundations',
            description: 'Core material.', url: null, position: 'a',
          },
        ],
        page: { cursor: 'page-2', hasMore: true, sequence: 1 },
      })
    })

    await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Loading collection')).toBeAttached()
    releasePage2()
    // Drill-down: the root layer shows the Foundations folder card only —
    // a folders-only layer previews the titles inside the card, but no
    // bookmark card or link renders until the folder is entered.
    const folderCard = page.locator('[data-collection-subfolder]', { hasText: 'Foundations' })
    await expect(folderCard).toBeVisible()
    await expect(folderCard.locator('[data-collection-folder-peek]')).toHaveText(['Safe reference', 'Unsafe reference'])
    await expect(page.getByRole('link', { name: 'Safe reference', exact: true })).toHaveCount(0)
    await expect(page.locator('[data-collection-resource-link]')).toHaveCount(0)
    await folderCard.click()
    await expect(page.getByText('Safe reference', { exact: true })).toBeVisible()
    await expect(page.getByText('Unsafe reference', { exact: true })).toBeVisible()
    await expect(page.getByText('Link unavailable')).toBeVisible()

    // Primary click = in-app resource detail carrying the public slug; the
    // original URL is a separate ↗ affordance with the safety attributes.
    const safeDetail = page.getByRole('link', { name: 'Safe reference', exact: true })
    await expect(safeDetail).toHaveAttribute(
      'href',
      `/r/safe-link?subjectType=node&slug=${slug}`,
    )
    const external = page.locator('[data-collection-resource-link]')
    await expect(external).toHaveCount(1)
    await expect(external).toHaveAttribute('href', 'https://example.com/source')
    await expect(external).toHaveAttribute('target', '_blank')
    await expect(external).toHaveAttribute('rel', /noopener/u)
    await expect(external).toHaveAttribute('rel', /noreferrer/u)
    // R15-25: user-submitted URLs are not editorial endorsements.
    await expect(external).toHaveAttribute('rel', /\bnofollow ugc\b/u)
    // The unsafe URL never becomes an external link — only the detail link.
    await expect(page.getByRole('link', { name: 'Unsafe reference', exact: true }))
      .toHaveAttribute('href', /^\/r\/unsafe-link/u)
    await expect(page.locator('[data-testid="public-collection-page"]')).toHaveCount(1)
    expect(requests.some((query) => query.includes('limit=100'))).toBe(true)
    expect(requests.some((query) => query.includes('cursor=page-2'))).toBe(true)

    const bodyWidth = await page.locator('body').evaluate((body) => body.scrollWidth)
    expect(bodyWidth).toBeLessThanOrEqual(390)

    // Guest reachability: the detail page resolves from the public snapshot
    // (no login, no collectionId) and keeps a way back to the collection.
    await safeDetail.click()
    await expect(page).toHaveURL(new RegExp(`/r/safe-link\\?subjectType=node&slug=${slug}`, 'u'))
    await expect(page.getByRole('heading', { level: 1, name: 'Safe reference' })).toBeVisible()
    const original = page.getByRole('link', { name: 'Open original' })
    await expect(original).toHaveAttribute('href', 'https://example.com/source')
    await expect(original).toHaveAttribute('target', '_blank')
    await expect(page.getByRole('link', { name: 'View on board' })).toHaveAttribute('href', `/c/${slug}`)
  })

  test('compacts the masthead inside a folder and keeps a visible filter focus ring', async ({ page }) => {
    await mockAnonymousSession(page)
    await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
      collection: {
        id: 'col-browser', slug, title: 'Browser research', summary: 'Production projection in a mocked browser.',
        kind: 'bookmarks', rootNodeId: 'root-browser', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
      },
      nodes: [
        {
          id: 'root-browser', parentId: null, kind: 'root', title: 'Contents',
          description: null, url: null, position: null,
        },
        {
          id: 'folder-browser', parentId: 'root-browser', kind: 'folder', title: 'Foundations',
          description: 'Core material.', url: null, position: 'a',
        },
        {
          id: 'safe-link', parentId: 'folder-browser', kind: 'bookmark', title: 'Safe reference',
          description: 'An external HTTPS source.', url: 'https://example.com/source', position: 'b',
        },
      ],
      page: { cursor: null, hasMore: false, sequence: 1 },
    }))

    await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
    const masthead = page.locator('.collection-masthead')
    await expect(page.getByText('Production projection in a mocked browser.')).toBeVisible()
    const rootHeight = await masthead.evaluate((element) => element.getBoundingClientRect().height)

    // Inside the folder the masthead collapses: summary and chips disappear,
    // the title drops to one clamped line, and the block loses real height.
    await page.locator('[data-collection-subfolder]', { hasText: 'Foundations' }).click()
    await expect(page.locator('[data-testid="public-collection-page"]')).toHaveAttribute('data-in-folder', 'true')
    await expect(page.getByText('Production projection in a mocked browser.')).toBeHidden()
    await expect(page.locator('.collection-live-tags')).toBeHidden()
    const folderHeight = await masthead.evaluate((element) => element.getBoundingClientRect().height)
    expect(folderHeight).toBeLessThan(rootHeight)

    // The filter field keeps a visible focus treatment through the
    // .search-field shell: focus-within flips the border to full ink and
    // paints the ring shadow. toHaveCSS retries across the 180ms
    // border-color transition.
    const field = page.locator('.collection-inline-search')
    const blurredShadow = await field.evaluate((element) => getComputedStyle(element).boxShadow)
    await page.getByLabel('Filter bookmarks').focus()
    await expect(field).toHaveCSS('border-top-color', 'rgb(6, 7, 10)')
    const focusedShadow = await field.evaluate((element) => getComputedStyle(element).boxShadow)
    expect(focusedShadow).not.toBe(blurredShadow)
    expect(focusedShadow).not.toBe('none')
  })

  test('conceals unknown and withdrawn slugs behind one unavailable state', async ({ page }) => {
    await mockAnonymousSession(page)
    await page.route('**/api/v1/collections/withdrawn*', (route) => json(route, {
      error: {
        code: 'resource_not_found', message: 'not found', requestId: 'e2e-public',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }, 404))

    await page.goto('/c/withdrawn', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Collection unavailable' })).toBeVisible()
    await expect(page.getByText(/not found, has been withdrawn, or is not available/u)).toBeVisible()
    await expect(page.getByText('withdrawn', { exact: true })).toHaveCount(0)
    const stage = page.getByTestId('absence-stage')
    const title = stage.getByRole('heading', { name: 'Collection unavailable' })
    await expect(title).toHaveCSS('font-style', 'italic')
    await expect(title).toHaveCSS('text-align', 'center')
    const exit = stage.getByRole('link', { name: 'Back home' })
    await expect(exit).toBeVisible()
    await expect(exit).not.toHaveClass(/btn/)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(title).toHaveCSS('font-style', 'italic')
    await expect(title).toHaveCSS('text-align', 'center')
  })

  test('discards browser-visible partial data when a continuation snapshot expires', async ({ page }) => {
    await mockAnonymousSession(page)
    let expired = false
    await page.route('**/api/v1/collections/restarting*', (route) => {
      const url = new URL(route.request().url())
      const cursor = url.searchParams.get('cursor')
      if (cursor === 'expiring') {
        expired = true
        return json(route, {
          error: {
            code: 'snapshot_expired', message: 'expired', requestId: 'e2e-restart',
            recovery: 'restart_from_first_page', sameRequestRetrySafe: false,
          },
        }, 409)
      }
      const collection = {
        id: 'col-restarting', slug: 'restarting', title: 'Restarted collection', summary: null,
        kind: 'bookmarks', rootNodeId: 'root-restarting', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
      }
      if (cursor === 'fresh-page') return json(route, {
        collection,
        nodes: [{
          id: 'fresh-second', parentId: 'root-restarting', kind: 'bookmark', title: 'Fresh second page',
          description: null, url: 'https://fresh.example/second', position: 'b',
        }],
        page: { cursor: null, hasMore: false, sequence: 2 },
      })
      return json(route, {
        collection,
        nodes: [
          {
            id: 'root-restarting', parentId: null, kind: 'root', title: 'Contents',
            description: null, url: null, position: null,
          },
          {
            id: expired ? 'fresh-first' : 'stale-partial', parentId: 'root-restarting', kind: 'bookmark',
            title: expired ? 'Fresh first page' : 'Stale partial page', description: null,
            url: 'https://fresh.example/first', position: 'a',
          },
        ],
        page: { cursor: expired ? 'fresh-page' : 'expiring', hasMore: true, sequence: 1 },
      })
    })

    await page.goto('/c/restarting', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Fresh first page', { exact: true })).toBeVisible()
    await expect(page.getByText('Fresh second page', { exact: true })).toBeVisible()
    await expect(page.getByText('Stale partial page', { exact: true })).toHaveCount(0)
  })

  test('renders the member projection without exposing private Product fields', async ({ page }) => {
    await mockMemberSession(page)
    await page.route('**/api/v1/collections/member-notes*', (route) => json(route, {
      collection: {
        id: 'col-member', slug: 'member-notes', title: 'Member notes', summary: 'Authorized projection.',
        kind: 'knowledge_collection', rootNodeId: 'root-member', updatedAt: '2026-07-24T00:00:00.000Z', access: 'member',
      },
      nodes: [
        {
          id: 'root-member', parentId: null, kind: 'root', title: 'Member contents',
          description: null, url: null, position: null,
        },
        {
          id: 'member-source', parentId: 'root-member', kind: 'bookmark', title: 'Authorized source',
          description: null, url: 'https://member.example/source', position: 'a',
        },
      ],
      page: { cursor: null, hasMore: false, sequence: 1 },
    }))

    await page.goto('/c/member-notes', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Member view')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: 'Member notes' })).toBeVisible()
    // Primary detail link plus the external ↗ affordance both render.
    await expect(page.getByRole('link', { name: 'Authorized source', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: /Open Authorized source on member\.example/u })).toBeVisible()
    await expect(page.getByText(/policyRevision|contentRevision|visibility/iu)).toHaveCount(0)
  })
})

test('shows the owner\'s pins on a public collection', async ({ page }, testInfo) => {
  await mockAnonymousSession(page)
  await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
    collection: {
      id: 'col-browser', slug, title: 'Browser research', summary: 'Pinned in the owner\'s browser.',
      kind: 'bookmarks', rootNodeId: 'root-browser', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
    },
    nodes: [
      { id: 'root-browser', parentId: null, kind: 'root', title: 'Contents', description: null, url: null, position: null },
      { id: 'pinned-link', parentId: 'root-browser', kind: 'bookmark', title: 'Start here', description: 'The one to read first.', url: 'https://example.com/start', position: 'a', pinned: true },
      { id: 'other-link', parentId: 'root-browser', kind: 'bookmark', title: 'Further reading', description: null, url: 'https://example.com/more', position: 'b' },
    ],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }))
  for (const [name, width] of [['desktop', 1280], ['mobile', 390]] as const) {
    await page.setViewportSize({ width, height: 800 })
    await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Start here', { exact: true })).toBeVisible()
    const marks = page.locator('[data-testid="bookmark-pinned"]')
    await expect(marks).toHaveCount(1)
    await expect(page.locator('[data-node-id="pinned-link"] [data-testid="bookmark-pinned"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`public-pin-${name}.png`) })
  }
})
