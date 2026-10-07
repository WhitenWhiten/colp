import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/**
 * Browser Back/Forward scroll restoration (NavigationScrollManager): the
 * manager records window.scrollY per history entry (mirrored to
 * sessionStorage under known.scroll.v1), restores the saved offset on POP,
 * and tops the page on a PUSH that changes the pathname or pushes a ?folder
 * drill-down.
 *
 * The mocked tree is deliberately tall: 60 root bookmarks make the board
 * several viewports high so a deep scroll position exists, and the single
 * folder holds another 40 so the drill-down layer stays scrollable too —
 * otherwise "topped" would pass vacuously through scroll clamping.
 */

const slug = 'scroll-forest'
const ROOT_BOOKMARK_COUNT = 60
const FOLDER_BOOKMARK_COUNT = 40
const STORAGE_KEY = 'known.scroll.v1'

test.beforeEach(async ({ page }) => installPassiveFeatureMocks(page))

type MockNode = {
  id: string
  parentId: string | null
  kind: 'root' | 'folder' | 'bookmark'
  title: string
  description: string | null
  url: string | null
  position: string | null
}

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

function tallCollectionPayload() {
  const nodes: MockNode[] = [
    {
      id: 'root-scroll', parentId: null, kind: 'root', title: 'Contents',
      description: null, url: null, position: null,
    },
    {
      id: 'folder-deep', parentId: 'root-scroll', kind: 'folder', title: 'Deep shelf',
      description: 'A folder with a tall layer of its own.', url: null, position: 'a00',
    },
  ]
  for (let index = 0; index < ROOT_BOOKMARK_COUNT; index += 1) {
    nodes.push({
      id: `bm-${index}`, parentId: 'root-scroll', kind: 'bookmark',
      title: `Reference ${String(index).padStart(2, '0')}`,
      description: `Mocked bookmark ${index}.`,
      url: `https://example.com/ref-${index}`,
      position: `b${String(index).padStart(3, '0')}`,
    })
  }
  for (let index = 0; index < FOLDER_BOOKMARK_COUNT; index += 1) {
    nodes.push({
      id: `bm-f-${index}`, parentId: 'folder-deep', kind: 'bookmark',
      title: `Shelf reference ${String(index).padStart(2, '0')}`,
      description: null,
      url: `https://shelf.example.com/ref-${index}`,
      position: `c${String(index).padStart(3, '0')}`,
    })
  }
  return {
    collection: {
      id: 'col-scroll', slug, title: 'Scroll forest',
      summary: 'A tall mocked collection for scroll restoration.',
      kind: 'bookmarks', rootNodeId: 'root-scroll',
      updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
    },
    nodes,
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

async function mockTallCollection(page: Page) {
  await page.route(`**/api/v1/collections/${slug}*`, (route) => {
    const request = route.request()
    /* Only the published-snapshot read; insight POSTs and friends fall through. */
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== `/api/v1/collections/${slug}`) {
      return route.fallback()
    }
    return json(route, tallCollectionPayload())
  })
}

function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY)
}

/* The manager mirrors saved positions to sessionStorage; polling the mirror
   resolves exactly when the rAF-throttled record has landed — the
   deterministic stand-in for a fixed "wait one frame" sleep. */
async function savedPositions(page: Page): Promise<Array<readonly [string, number]>> {
  return page.evaluate((key) => {
    try {
      const raw = window.sessionStorage.getItem(key)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed as Array<readonly [string, number]> : []
    } catch {
      return []
    }
  }, STORAGE_KEY)
}

async function scrollToAndWaitForSave(page: Page, target: number) {
  /* window.scrollTo picks up the global smooth scroll-behavior, so poll for
     arrival instead of assuming a synchronous jump. */
  await page.evaluate((y) => window.scrollTo(0, y), target)
  await expect
    .poll(async () => Math.abs(await scrollY(page) - target), { message: `page scrolls to ${target}` })
    .toBeLessThanOrEqual(2)
  await expect
    .poll(async () => (await savedPositions(page)).some(([, y]) => Math.abs(y - target) <= 50), {
      message: `scroll position ${target} is recorded for the current history entry`,
    })
    .toBe(true)
}

/* Playwright's click scrolls the target into view first — that scroll would
   overwrite the position just saved for the current history entry. Picking a
   card already fully inside the viewport keeps the click scroll-neutral. */
async function visibleDetailLinkTitle(page: Page): Promise<string> {
  const title = await page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-resource-detail]')]
    const mid = window.innerHeight / 2
    let best: HTMLAnchorElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const link of links) {
      const rect = link.getBoundingClientRect()
      if (rect.top < 0 || rect.bottom > window.innerHeight) continue
      const distance = Math.abs((rect.top + rect.bottom) / 2 - mid)
      if (distance < bestDistance) {
        bestDistance = distance
        best = link
      }
    }
    return best?.textContent?.trim() ?? null
  })
  if (!title) throw new Error('no resource detail link is fully visible in the viewport')
  return title
}

/* No reduced-motion override: clicks take the View Transitions navigation
   path (headless Chromium supports it), so these tests also guard the
   once-real race where a pre-commit scrollTo(0) inside the transition
   callback recorded y=0 against the OLD history entry and clobbered the
   position Back restores (the reset now lives solely in
   NavigationScrollManager's commit-time layout effect). */
test.describe('scroll restoration across history navigation', () => {
  test('restores the deep collection position on Back and tops again on Forward', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await mockAnonymousSession(page)
    await mockTallCollection(page)

    await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { level: 1, name: 'Scroll forest' })).toBeVisible()
    await expect(page.locator('[data-collection-resource-detail]')).toHaveCount(ROOT_BOOKMARK_COUNT)

    await scrollToAndWaitForSave(page, 1500)
    const title = await visibleDetailLinkTitle(page)

    /* In-SPA navigation: the card's primary link goes to /r/:id (PUSH). */
    await page.getByRole('link', { name: title, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/r/[^?]+\\?subjectType=node&slug=${slug}`, 'u'))
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    /* PUSH to a new pathname tops the page… */
    await expect.poll(() => scrollY(page)).toBe(0)
    /* …and that reset is recorded against the detail entry, so the Forward
       half of this test has a saved position to restore. */
    await expect
      .poll(async () => (await savedPositions(page)).some(([key, y]) => key.includes(':/r/') && y === 0))
      .toBe(true)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/c/${slug}$`, 'u'))
    await expect
      .poll(async () => Math.abs(await scrollY(page) - 1500))
      .toBeLessThanOrEqual(50)

    await page.goForward()
    await expect(page).toHaveURL(/\/r\//u)
    /* The detail page was never scrolled: Forward restores the topped entry. */
    await expect.poll(() => scrollY(page)).toBe(0)
  })

  test('tops a pushed ?folder drill-down and restores the pre-drill position on Back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await mockAnonymousSession(page)
    await mockTallCollection(page)

    await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-collection-resource-detail]')).toHaveCount(ROOT_BOOKMARK_COUNT)

    await scrollToAndWaitForSave(page, 1200)

    const folderCard = page.locator('[data-collection-subfolder]', { hasText: 'Deep shelf' })
    await expect(folderCard).toHaveCount(1)
    /* dispatchEvent, not click(): Playwright's click would scroll the card
       back into view first, and that scroll would overwrite the deep position
       saved for this history entry — the very thing the Back assertion checks.
       The dispatched click still bubbles through the Layout capture-phase
       interceptor, so the navigation takes the real in-SPA path (PUSH). */
    await folderCard.dispatchEvent('click')

    await expect(page).toHaveURL(new RegExp(`/c/${slug}\\?folder=folder-deep$`, 'u'))
    await expect(page.getByRole('link', { name: 'Shelf reference 00', exact: true })).toBeVisible()
    /* PUSH with only ?folder changed tops the page. */
    await expect.poll(() => scrollY(page)).toBe(0)

    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/c/${slug}$`, 'u'))
    await expect
      .poll(async () => Math.abs(await scrollY(page) - 1200))
      .toBeLessThanOrEqual(50)
  })
})
