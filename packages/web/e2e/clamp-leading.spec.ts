import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { fulfillPassiveFeatureRequest } from './helpers/passive-feature-mocks'

/**
 * Clamp-leading audit.
 *
 * Every element clipped by line-clamp (or single-line ellipsis) must have a
 * computed line-height at least as tall as its font's natural line box.
 * Tighter leading lets glyph ink escape the line box: overflow:hidden then
 * shears the first line's ascenders, and the next line's ink bleeds a few
 * pixels past the clamp boundary (reported on journal entry titles and the
 * resource-detail "Show full title" boundary). The natural box is measured
 * at runtime per font stack (line-height: normal probe), so the invariant
 * stays true when fonts change. --leading-clamp documents the safe value.
 */

const LONG_TITLE = 'Typography Blends Dignity: Grid Systems, Glyph Metrics, And The Long Display Title Test With Tall Letters'
const LONG_TEXT = 'A running set of notes on how distributed systems actually fail in production: partitions that heal before anyone notices, clocks that drift just far enough to corrupt a ledger, and queues that silently become databases. '.repeat(4)
const LONG_BIO = 'Independent researcher and occasional engineer. I keep notes on distributed systems, the history of computing, typography, and the small design decisions that make tools feel inevitable. '.repeat(3)

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  })
}

const profilePage = {
  profile: { handle: 'mira', displayName: 'Mira Chen', avatarUrl: null, about: LONG_BIO },
  collections: [
    { id: 'pc-1', slug: 'systems-notes', title: LONG_TITLE, summary: LONG_TEXT, kind: 'knowledge_collection', updatedAt: '2026-08-20T00:00:00.000Z' },
    { id: 'pc-2', slug: 'grid-notes', title: 'Grid notes', summary: null, kind: 'bookmarks', updatedAt: '2026-07-22T00:00:00.000Z' },
  ],
  page: { cursor: null, hasMore: false },
}

const publicCollection = {
  collection: {
    id: 'col-pub', slug: 'browser-research', title: LONG_TITLE,
    summary: LONG_TEXT, kind: 'bookmarks', rootNodeId: 'root-pub',
    updatedAt: '2026-08-20T00:00:00.000Z', access: 'public',
  },
  nodes: [
    { id: 'root-pub', parentId: null, kind: 'root', title: 'Contents', description: null, url: null, position: null },
    { id: 'p-1', parentId: 'root-pub', kind: 'bookmark', title: LONG_TITLE, description: LONG_TEXT, url: 'https://chromium.org', position: 'a' },
    { id: 'p-2', parentId: 'root-pub', kind: 'bookmark', title: 'WebKit blog', description: null, url: 'https://webkit.org/blog', position: 'b' },
  ],
  page: { cursor: null, hasMore: false, sequence: 1 },
}

const searchPage = {
  query: 'systems', types: ['collection', 'node', 'profile', 'annotation'],
  items: [
    { resourceType: 'collection', resourceId: 'c1', title: LONG_TITLE, snippet: LONG_TEXT, rank: 0.9 },
    { resourceType: 'node', resourceId: 'n2', collectionId: 'c1', title: LONG_TITLE, urlHost: 'oreilly.com', snippet: LONG_TEXT, rank: 0.8 },
    { resourceType: 'profile', resourceId: 'p1', handle: 'mira', displayName: 'Mira Chen', avatarUrl: null, snippet: LONG_TEXT, rank: 0.7 },
  ],
  page: { returnedCount: 3, hasMore: false, nextCursor: null },
  consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
}

const feedPage = {
  items: [
    {
      feedItemId: 'f1', kind: 'collection_change', collectionId: 'col-pub',
      publicationSlug: 'browser-research', collectionTitle: LONG_TITLE,
      actor: { profileId: 'p1', handle: 'mira', displayName: 'Mira Chen', avatarUrl: null },
      publishedAt: '2026-08-21T08:00:00.000Z',
    },
  ],
  nextCursor: null,
}

const libraryList = {
  items: [{
    collection: {
      id: 'col-1', kind: 'bookmarks', title: LONG_TITLE, summary: LONG_TEXT,
      visibility: 'public', publicationSlug: 'browser-research', publishedAt: '2026-07-22T00:00:00.000Z',
      rootNodeId: 'root-1', revision: '1', etag: '"c-1"', contentRevision: '1', contentEtag: '"cc-1"',
      policyRevision: '1', policyEtag: '"p-1"', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    },
    capabilities: { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true },
    bookmarkCount: 2,
  }],
  page: { returnedCount: 1, hasMore: false, nextCursor: null },
}

async function installMocks(page: Page): Promise<string[]> {
  const misses: string[] = []
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (route.request().method() !== 'GET') return json(route, {}, 204)
    if (path === '/api/v1/session') return json(route, { authenticated: true, csrfToken: 'clamp-csrf', idleExpiresAt: '2026-08-23T00:00:00.000Z', absoluteExpiresAt: '2026-08-24T00:00:00.000Z' })
    if (path === '/api/v1/me') return json(route, { account: { id: 'acc-1', email: 'mira@known.test' }, profile: { id: 'prof-1', handle: 'mira', displayName: 'Mira Chen', avatarUrl: null, about: LONG_BIO } })
    if (path === '/api/v1/profiles/mira') return json(route, profilePage)
    if (path === '/api/v1/profiles/mira/following' || path === '/api/v1/profiles/mira/followers') return json(route, { items: [], nextCursor: null })
    if (path === '/api/v1/search') return json(route, searchPage)
    if (path === '/api/v1/feed') return json(route, feedPage)
    if (path === '/api/v1/collections') return json(route, libraryList)
    if (path === '/api/v1/collections/browser-research') return json(route, {
      ...publicCollection,
      ...(url.searchParams.get('include') === 'relations' ? { relations: [] } : {}),
    })
    if (path.startsWith('/api/v1/public-collections/')) return json(route, publicCollection)
    if (path === '/api/v1/me/shared-collections' || path === '/api/v1/me/collaboration-invites' || path === '/api/v1/saved-resources' || path === '/api/v1/reading-progress') {
      return json(route, { items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } })
    }
    if (path === '/api/v1/notifications') return json(route, { items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null }, unreadCount: 0 })
    if (await fulfillPassiveFeatureRequest(route)) return
    if (path === '/api/v1/me/community-notifications') return json(route, { items: [], nextCursor: null, unreadCount: 0 })
    if (path === '/api/v1/community/target') {
      return json(route, { error: { code: 'resource_not_found', message: 'not mocked', requestId: 'clamp', recovery: 'user_action', sameRequestRetrySafe: false } }, 404)
    }
    if (/^\/api\/v1\/collections\/[^/]+\/annotations$/u.test(path)) {
      return json(route, { annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } })
    }
    misses.push(path)
    return json(route, { error: { code: 'resource_not_found', message: 'not mocked', requestId: 'clamp', recovery: 'user_action', sameRequestRetrySafe: false } }, 404)
  })
  return misses
}

type Violation = { where: string; lineHeight: number; natural: number; clamp: string | null; ellipsis: boolean; text: string }

async function auditClampLeading(page: Page): Promise<Violation[]> {
  await page.evaluate(() => document.fonts.ready)
  return page.evaluate(() => {
    const naturalCache = new Map<string, number>()
    const naturalFor = (fontFamily: string): number => {
      const cached = naturalCache.get(fontFamily)
      if (cached != null) return cached
      const probe = document.createElement('div')
      probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;font-family:${fontFamily};font-size:100px;line-height:normal;white-space:nowrap`
      probe.textContent = 'TÁg jyq'
      document.body.appendChild(probe)
      const value = probe.offsetHeight / 100
      probe.remove()
      naturalCache.set(fontFamily, value)
      return value
    }
    const describe = (el: Element): string => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      const parent = el.parentElement
      const parentCls = parent && typeof parent.className === 'string' ? parent.className.trim().split(/\s+/)[0] : ''
      return `${parentCls ? `${parentCls} > ` : ''}${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
    }
    const violations: Violation[] = []
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.overflow !== 'hidden' && cs.overflowY !== 'hidden') continue
      const clamp = cs.getPropertyValue('line-clamp') || cs.getPropertyValue('-webkit-line-clamp')
      const isClamp = Boolean(clamp) && clamp !== 'none'
      const isEllipsis = cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap'
      if (!isClamp && !isEllipsis) continue
      if (el.getClientRects().length === 0) continue
      const fontSize = parseFloat(cs.fontSize)
      const lineHeight = parseFloat(cs.lineHeight)
      if (!fontSize || Number.isNaN(lineHeight)) continue
      const natural = naturalFor(cs.fontFamily)
      const ratio = lineHeight / fontSize
      if (ratio < natural + 0.005) {
        violations.push({
          where: describe(el), lineHeight: Math.round(ratio * 1000) / 1000,
          natural: Math.round(natural * 1000) / 1000,
          clamp: isClamp ? clamp : null, ellipsis: isEllipsis,
          text: (el.textContent ?? '').trim().slice(0, 40),
        })
      }
    }
    return violations
  })
}

type Stop = {
  name: string
  path: string
  ready: string
  prep?: (page: Page) => Promise<void>
  /** Mobile-only stops skip the desktop pass and vice versa. */
  only?: 'desktop' | 'mobile'
}

const stops: Stop[] = [
  { name: 'profile', path: '/u/mira', ready: '[data-testid="public-profile-page"]' },
  {
    name: 'profile-journal',
    path: '/u/mira',
    ready: '[data-testid="public-profile-page"]',
    prep: async (page) => {
      await page.evaluate(() => window.localStorage.setItem('known.profileMode', 'journal'))
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(page.locator('.journal-entry h2').first()).toBeVisible()
    },
  },
  { name: 'resource-detail', path: '/r/p-1?slug=browser-research', ready: '.resource-detail' },
  { name: 'collection-board', path: '/c/browser-research', ready: '[data-testid="public-collection-page"]' },
  { name: 'collection-list', path: '/c/browser-research?view=list', ready: '[data-testid="public-collection-page"]' },
  { name: 'feed', path: '/feed', ready: '[data-testid="product-feed"]' },
  { name: 'search', path: '/search?q=systems', ready: '[data-testid="search-result-list"]' },
  { name: 'library', path: '/library', ready: '[data-testid="library-workspace"]' },
  { name: 'share', path: '/share/browser-research', ready: '.share-page' },
  {
    name: 'graph-side',
    path: '/graph/browser-research',
    ready: '.graph-side',
    prep: async (page) => {
      const node = page.locator('[role="link"][tabindex="0"]').first()
      if (await node.count()) await node.click()
      await expect(page.locator('.graph-side h3').first()).toBeVisible()
    },
  },
  {
    name: 'search-palette',
    path: '/library',
    ready: '[data-testid="library-workspace"]',
    prep: async (page) => {
      await page.evaluate(() => window.dispatchEvent(new Event('known:open-search-palette')))
      const input = page.getByTestId('search-palette-input')
      await expect(input).toBeVisible()
      const searchResponse = page.waitForResponse((response) => {
        try {
          const url = new URL(response.url())
          return url.pathname === '/api/v1/search' && url.searchParams.get('q') === 'systems'
        } catch {
          return false
        }
      })
      await input.fill('systems')
      await expect(input).toHaveValue('systems')
      await expect(page.locator('.search-palette')).toBeVisible()
      await searchResponse
      await expect(
        page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first(),
      ).toBeVisible()
    },
  },
]

for (const viewport of [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
] as const) {
  test.describe(`clamp leading (${viewport.name})`, () => {
    for (const stop of stops) {
      if (stop.only && stop.only !== viewport.name) continue
      test(`${stop.name} keeps clipped text inside its line boxes`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        const misses = await installMocks(page)
        await page.goto(stop.path, { waitUntil: 'domcontentloaded' })
        await expect(page.locator(stop.ready).first()).toBeVisible()
        if (stop.prep) await stop.prep(page)
        await page.evaluate(async () => {
          await document.fonts.ready
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        })
        const violations = await auditClampLeading(page)
        expect(violations, `unmocked endpoints: ${[...new Set(misses)].join(', ')}`).toEqual([])
      })
    }
  })
}
