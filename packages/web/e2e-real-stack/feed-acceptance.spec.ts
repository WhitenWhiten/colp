import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { selectCollectionVisibility } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) throw new Error('P5-14 real-stack infrastructure is required')

type Principal = { cookieValue: string; profileId: string; handle: string }
type Fixture = { actor: Principal; target: Principal; collectionId: string; collectionSlug: string }
type FeedEvidence = { visible: number; withdrawn: number; completedSources: number }
async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}
async function principalContext(browser: Browser, principal: Principal): Promise<BrowserContext> {
  const context = await browser.newContext(); const origin = new URL(webBaseUrl!); origin.protocol = 'https:'
  await context.addCookies([{ name: '__Host-known_session', value: principal.cookieValue, url: origin.origin, httpOnly: true, secure: true, sameSite: 'Lax' }])
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webBaseUrl! })
  return context
}
async function enableFeed(page: Page, feed: boolean) { await page.addInitScript((value) => { (window as Window & { __KNOWN_FLAGS__?: { feed?: boolean } }).__KNOWN_FLAGS__ = { feed: value } }, feed) }
async function saveCollectionTitle(page: Page, collectionId: string, title: string) {
  const titleInput = page.locator('#ce-title')
  const saveButton = page.getByRole('button', { name: 'Save collection' })
  await expect(saveButton).toBeEnabled()
  await titleInput.fill(title)
  await expect(titleInput).toHaveValue(title)
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'PATCH'
      && url.pathname === `/api/v1/collections/${collectionId}`
  }, { timeout: 15_000 })
  await titleInput.press('Enter')
  const response = await responsePromise
  expect(response.status()).toBe(200)
  await expect(titleInput).toHaveValue(title)
  await expect(saveButton).toBeEnabled()
}
async function expectFeedLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>('.feed-controls button, [data-feed-item] a, [data-feed-item] button')]
      .filter((element) => element.offsetParent !== null)
      .map((element) => {
        const rect = element.getBoundingClientRect().toJSON()
        // A clamped title's link can have a larger layout box than its visible
        // hit area. Intersect clipping ancestors before comparing controls.
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent); const clip = parent.getBoundingClientRect()
          if (style.overflowX !== 'visible') { rect.left = Math.max(rect.left, clip.left); rect.right = Math.min(rect.right, clip.right) }
          if (style.overflowY !== 'visible') { rect.top = Math.max(rect.top, clip.top); rect.bottom = Math.min(rect.bottom, clip.bottom) }
        }
        return { label: element.textContent?.trim() ?? '', rect }
      })
      .filter(({ rect }) => rect.right > rect.left && rect.bottom > rect.top)
    const overlaps: string[] = []
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left]!; const b = controls[right]!
        if (a.rect.left < b.rect.right && a.rect.right > b.rect.left && a.rect.top < b.rect.bottom && a.rect.bottom > b.rect.top) {
          overlaps.push(`${a.label} / ${b.label}`)
        }
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, overlaps }
  })
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.overlaps).toEqual([])
}

test('P5-14 real Product mutation crosses Outbox and production Worker into the browser Feed', async ({ browser }, testInfo) => {
  const fixture = await control<Fixture>('/feed/fixture')
  const reader = await principalContext(browser, fixture.actor); const writer = await principalContext(browser, fixture.target)
  try {
    const feed = await reader.newPage(); await enableFeed(feed, true)
    await feed.goto(`/u/${fixture.target.handle}`); await feed.getByRole('button', { name: 'Follow', exact: true }).click()
    const editor = await writer.newPage(); await editor.goto(`/library/${fixture.collectionId}/edit`)
    await saveCollectionTitle(editor, fixture.collectionId, 'P5-14 first public change')
    const firstEvidence = await control<FeedEvidence>('/feed/await', { recipientProfileId: fixture.actor.profileId, collectionId: fixture.collectionId, minimum: 1 })
    expect(firstEvidence.completedSources).toBeGreaterThanOrEqual(firstEvidence.visible)
    const feedResponses: number[] = []; feed.on('response', (response) => { if (new URL(response.url()).pathname === '/api/v1/feed') feedResponses.push(response.status()) })
    await feed.goto('/feed'); await expect(feed.getByText('Follow Target', { exact: false }).first()).toBeVisible()
    expect(feedResponses).toContain(200)
    const item = feed.locator('[data-feed-item]').first(); await expect(item).toBeVisible()
    const copy = item.getByRole('button', { name: 'Copy public link' }); await copy.focus(); await expect(copy).toBeFocused(); await copy.click()
    expect(await feed.evaluate(() => navigator.clipboard.readText())).toBe(new URL(`/c/${fixture.collectionSlug}`, webBaseUrl!).href)
    await expectFeedLayout(feed)
    await feed.screenshot({ path: testInfo.outputPath('feed-desktop.png'), fullPage: true })
    await feed.setViewportSize({ width: 375, height: 720 }); await expectFeedLayout(feed)
    await feed.screenshot({ path: testInfo.outputPath('feed-mobile-375.png'), fullPage: true })

    await saveCollectionTitle(editor, fixture.collectionId, 'P5-14 new item')
    await control('/feed/await', { recipientProfileId: fixture.actor.profileId, collectionId: fixture.collectionId, minimum: 2 })
    await feed.getByRole('button', { name: 'Check for new items' }).click(); await expect(feed.getByRole('button', { name: /Show 1 new item/ })).toBeVisible()
    await feed.getByRole('button', { name: /Show 1 new item/ }).press('Enter')

    for (let index = 0; index < 20; index += 1) {
      await saveCollectionTitle(editor, fixture.collectionId, `P5-14 page ${index}`)
      await control('/feed/await', { recipientProfileId: fixture.actor.profileId, collectionId: fixture.collectionId, minimum: index + 3 })
    }
    await feed.getByRole('button', { name: 'Refresh' }).click(); await expect(feed.locator('[data-feed-item]')).toHaveCount(20)
    await expect(feed.getByRole('button', { name: 'Load more' })).toBeVisible(); await feed.getByRole('button', { name: 'Load more' }).click()
    await expect(feed.locator('[data-feed-item]')).toHaveCount(22)

    await feed.goto(`/u/${fixture.target.handle}`); await feed.getByRole('button', { name: 'Unfollow', exact: true }).click()
    await feed.goto('/feed'); await expect(feed.locator('[data-feed-item]')).toHaveCount(0)
  } finally { await reader.close(); await writer.close() }
})

test('P5-14 flag rollout, tightened authority, and real outage retry fail closed', async ({ browser }, testInfo) => {
  const fixture = await control<Fixture>('/feed/fixture'); const context = await principalContext(browser, fixture.actor); const writer = await principalContext(browser, fixture.target)
  try {
    const page = await context.newPage(); await enableFeed(page, false); await page.goto('/feed')
    await expect(page.getByTestId('feed-flag-off')).toBeVisible(); await expect(page.locator('[data-feed-item]')).toHaveCount(0)
    await enableFeed(page, true); await page.goto(`/u/${fixture.target.handle}`); await page.getByRole('button', { name: 'Follow', exact: true }).click()
    const editor = await writer.newPage(); await editor.goto(`/library/${fixture.collectionId}/edit`)
    await saveCollectionTitle(editor, fixture.collectionId, 'P5-14 authority item')
    await control('/feed/await', { recipientProfileId: fixture.actor.profileId, collectionId: fixture.collectionId, minimum: 1 })
    await page.goto('/feed'); await expect(page.locator(`[data-feed-collection-id="${fixture.collectionId}"]`)).toBeVisible()
    await selectCollectionVisibility(editor, 'Private'); await editor.getByRole('button', { name: 'Save collection' }).click()
    await control('/feed/await', { recipientProfileId: fixture.actor.profileId, collectionId: fixture.collectionId, minimum: 0, withdrawn: true })
    await page.getByRole('button', { name: 'Refresh' }).click(); await expect(page.locator(`[data-feed-collection-id="${fixture.collectionId}"]`)).toHaveCount(0)
    await control('/api/stop'); await page.reload(); await expect(page.locator('[data-feed-state="error"]')).toBeVisible(); await expect(page.locator('[data-feed-state="error"]')).toContainText("Couldn't load your feed")
    await expect(page.locator('[data-feed-state="error"]')).toBeVisible(); await expectFeedLayout(page); await page.screenshot({ path: testInfo.outputPath('feed-real-api-error.png'), fullPage: true })
    await control('/api/start'); await page.getByRole('button', { name: 'Try again' }).click(); await expect(page.locator('[data-feed-state="error"]')).toHaveCount(0)
  } finally { await context.close(); await writer.close(); await control('/api/start').catch(() => undefined) }
})
