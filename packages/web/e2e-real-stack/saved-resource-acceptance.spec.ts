import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { signInShared } from './auth-bootstrap'
import { createDeskBookmark, openCollectionEditorAfterDeskCreate } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) throw new Error('Saved Resource real-stack infrastructure is required')
const screenshotDirectory = process.env.KNOWN_REAL_STACK_SCREENSHOT_DIR
  ? resolve(process.env.KNOWN_REAL_STACK_SCREENSHOT_DIR)
  : resolve(process.cwd(), '../../Known-Backend/docs/evidence/screenshots')
async function evidenceScreenshot(page: Page, name: string) {
  await mkdir(screenshotDirectory, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await page.screenshot({ path: resolve(screenshotDirectory, name), fullPage: true })
}

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
async function login(page: Page) { await signInShared(page) }
async function fixture(page: Page, resourceTitle: string) {
  await page.getByLabel('Title').fill('Saved acceptance collection'); await page.getByRole('button', { name: 'Create', exact: true }).click()
  const collectionId = await openCollectionEditorAfterDeskCreate(page)
  await createDeskBookmark(page, resourceTitle, 'https://saved.acceptance.test')
  const nodeId = await page.evaluate(async ({ id, resourceTitle }) => {
    const response = await fetch(`/api/v1/collections/${id}/editor?limit=20`)
    if (!response.ok) throw new Error(`authoritative editor read failed: ${response.status}`)
    const body = await response.json() as { nodes?: Array<{ id: string; title: string }> }
    const node = body.nodes?.find((candidate) => candidate.title === resourceTitle)
    if (!node) throw new Error('created Saved Resource target missing from authoritative editor read')
    return node.id
  }, { id: collectionId, resourceTitle })
  return { collectionId, nodeId }
}
async function secondSession(context: BrowserContext, collectionId: string) {
  const session = await control<{ cookieValue: string }>('/saved-resource/second-session', { collectionId })
  const url = new URL(webBaseUrl); url.protocol = 'https:'
  await context.addCookies([{ name: '__Host-known_session', value: session.cookieValue, url: url.origin, httpOnly: true, secure: true, sameSite: 'Lax' }])
}

test('real browser saves, survives refresh and API restart, lists, isolates accounts, and unsaves once', async ({ page, browser }) => {
  const resourceTitle = 'Saved persistence acceptance resource'
  await login(page); const { collectionId, nodeId } = await fixture(page, resourceTitle)
  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const put = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/saved-resources/'))
  await expect(save).toBeEnabled(); await save.focus(); await expect(save).toBeFocused(); await expect(save).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Enter'); expect((await put).status()).toBe(201)
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await evidenceScreenshot(page, 'p2b17-resource-detail-desktop.png')
  await page.setViewportSize({ width: 375, height: 720 }); await evidenceScreenshot(page, 'p2b17-resource-detail-mobile.png')
  await page.setViewportSize({ width: 1280, height: 800 })
  await control('/saved-resource/assert-live-unique', { nodeId, expectedReceipts: 1 })
  await page.reload(); await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
  await control('/api-and-worker/restart-and-await', { aggregateId: collectionId })
  await page.reload(); await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
  await page.goto('/library?view=reading'); await expect(page.getByText(resourceTitle, { exact: true })).toBeVisible()

  const other = await browser.newContext()
  try {
    await secondSession(other, collectionId); const otherPage = await other.newPage(); await otherPage.goto(`${webBaseUrl}/library?view=reading`)
    await expect(otherPage.getByText(resourceTitle, { exact: true })).toHaveCount(0)
  } finally { await other.close() }

  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  const del = page.waitForResponse((response) => response.request().method() === 'DELETE' && response.url().includes('/saved-resources/'))
  await page.getByRole('button', { name: 'Saved', exact: true }).click(); expect((await del).status()).toBe(204)
  await control('/saved-resource/assert-deleted', { nodeId })
})

test('unavailable target is private, layout has no overflow, and no legacy mock fallback occurs', async ({ page }) => {
  const resourceTitle = 'Saved unavailable acceptance resource'
  await login(page); const { collectionId, nodeId } = await fixture(page, resourceTitle)
  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
  await control('/saved-resource/revoke-target', { nodeId })
  for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 720 }]) {
    await page.setViewportSize(viewport); await page.goto('/library?view=reading')
    await expect(page.getByText('Unavailable resource', { exact: true })).toBeVisible()
    await expect(page.getByText(resourceTitle, { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => ({ document: document.documentElement.scrollWidth <= innerWidth, elements: [...document.querySelectorAll('*')].every((node) => (node as HTMLElement).scrollWidth <= Math.max((node as HTMLElement).clientWidth, innerWidth)) }))).toEqual({ document: true, elements: true })
    await evidenceScreenshot(page, viewport.width === 1280 ? 'p2b17-library-desktop.png' : 'p2b17-library-mobile.png')
  }
  await page.route('**/api/v1/saved-resources**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'feature_temporarily_unavailable', message: 'down', recovery: 'same_request', sameRequestRetrySafe: true } }) }))
  // Reading Progress is an independent authority merged into this pane. Keep
  // it empty so this assertion proves the failed Saved Resource read cannot
  // repopulate rows from a legacy/mock source, regardless of earlier tests.
  await page.route('**/api/v1/reading-progress**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }) }))
  await page.reload(); await expect(page.getByTestId('saved-resources-error')).toContainText('Temporarily unavailable. Retry shortly.'); await expect(page.locator('.lib-link-row')).toHaveCount(0)
})

test('committed response loss replays the same browser command without duplicate side effects', async ({ page }) => {
  await login(page); const { collectionId, nodeId } = await fixture(page, 'Saved replay acceptance resource')
  const commands: string[] = []
  let dropped = false
  await page.route(`**/api/v1/saved-resources/node/${nodeId}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    commands.push(route.request().headers()['known-command-id'] ?? '')
    if (!dropped) { dropped = true; await route.fetch(); await route.abort('failed'); return }
    await route.continue()
  })
  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
  expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0])
  await control('/saved-resource/assert-live-unique', { nodeId, expectedReceipts: 1 })
})
