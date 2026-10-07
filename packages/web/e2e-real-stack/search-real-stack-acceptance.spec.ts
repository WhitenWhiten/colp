import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { signInShared } from './auth-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
if (!controlUrl || !controlToken) throw new Error('Search real-stack infrastructure is required')
const screenshotDirectory = process.env.KNOWN_REAL_STACK_SCREENSHOT_DIR
  ? resolve(process.env.KNOWN_REAL_STACK_SCREENSHOT_DIR)
  : resolve(process.cwd(), '../../Known-Backend/docs/evidence/screenshots')

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${controlToken}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

async function screenshot(page: Page, name: string) {
  await mkdir(screenshotDirectory, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>((done) =>
    requestAnimationFrame(() => requestAnimationFrame(() => done()))) })
  await page.screenshot({ path: resolve(screenshotDirectory, name), fullPage: true })
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    return document.documentElement.scrollWidth <= width
      && [...document.querySelectorAll<HTMLElement>('[data-search-result], [data-search-snippet]')]
        .every((element) => element.getBoundingClientRect().right <= width + 1
          && element.scrollWidth <= element.clientWidth + 1)
  })).toBe(true)
}

test('anonymous and member Chromium use the real generated Search endpoint with current authority', async ({ page }) => {
  const anonymousResponse = page.waitForResponse((response) =>
    response.url().includes('/api/v1/search') && response.request().method() === 'GET')
  await page.goto('/search?q=phase2bfinalneedle')
  const anonymous = await anonymousResponse
  expect(anonymous.status()).toBe(200)
  expect(anonymous.headers()['cache-control']).toContain('public')
  const anonymousBody = await anonymous.json() as { items: Array<{ resourceType: string }> }
  expect(new Set(anonymousBody.items.map((item) => item.resourceType))).toEqual(
    new Set(['profile', 'collection', 'node', 'annotation']),
  )
  await expect(page.getByText('phase2bfinalneedle Profile', { exact: true })).toBeVisible()
  await expect(page.getByText('phase2bfinalneedle Collection', { exact: true })).toBeVisible()
  await expect(page.getByText('phase2bfinalneedle Node', { exact: true })).toBeVisible()
  await expect(page.getByText('phase2bfinalneedle Annotation', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('phase2bfinalneedle')
  await noOverflow(page)
  await screenshot(page, 'p2b26-search-real-desktop.png')

  await page.locator('.nav-search:visible, .nav-search-compact:visible').first().click()
  const paletteResponse = page.waitForResponse((response) => response.url().includes('/api/v1/search')
    && response.request().method() === 'GET')
  await page.getByTestId('search-palette-input').fill('phase2bfinalneedle')
  expect((await paletteResponse).status()).toBe(200)
  await expect(page.getByRole('dialog', { name: 'Search Know-N' })).toBeVisible()
  await expect(page.getByRole('option').first()).toBeVisible()
  await noOverflow(page)
  await screenshot(page, 'p2b26-search-palette-desktop.png')
  await page.keyboard.press('Escape')

  await page.goto('/search?q=phase2blayoutneedle')
  await expect(page.locator('[data-search-result-id="phase2b-search-layout-long"] strong')).toBeVisible()
  await expect(page.locator('[data-search-result-id="phase2b-search-layout-cjk"] strong')).toBeVisible()
  await expect(page.locator('[data-search-result-id="phase2b-search-layout-rtl"] strong')).toBeVisible()
  await noOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await noOverflow(page)
  await screenshot(page, 'p2b26-search-layout-mobile.png')

  await page.getByRole('button', { name: 'Open menu' }).click({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Search Know-N…' }).click({ timeout: 15_000 })
  const mobilePaletteResponse = page.waitForResponse((response) => response.url().includes('/api/v1/search')
    && response.request().method() === 'GET')
  await page.getByTestId('search-palette-input').fill('phase2blayoutneedle')
  expect((await mobilePaletteResponse).status()).toBe(200)
  await noOverflow(page)
  await screenshot(page, 'p2b26-search-palette-mobile.png')
  await page.keyboard.press('Escape')

  const firstPage = await page.evaluate(async () => {
    const response = await fetch('/api/v1/search?q=phase2bcursorneedle&limit=1')
    return response.json() as Promise<{ page: { nextCursor: string | null } }>
  })
  expect(firstPage.page.nextCursor).not.toBeNull()
  await control('/search/revoke-public')
  const continued = await page.evaluate(async (cursor) => {
    const response = await fetch(`/api/v1/search?q=phase2bcursorneedle&cursor=${encodeURIComponent(cursor!)}`)
    return { status: response.status, body: await response.json() as { items: unknown[] } }
  }, firstPage.page.nextCursor)
  expect(continued.status).toBe(200)
  expect(continued.body.items).toHaveLength(0)

  await signInShared(page, '/search?q=phase2bmemberneedle')
  const accountId = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    const body = await response.json() as { account: { id: string } }
    return body.account.id
  })
  await control('/search/grant-member', { accountId })
  const memberResponse = page.waitForResponse((response) => response.url().includes('/api/v1/search')
    && response.request().method() === 'GET')
  await page.reload()
  const member = await memberResponse
  expect(member.status()).toBe(200)
  expect(member.headers()['cache-control']).toBe('private, no-store')
  await expect(page.getByText('phase2bmemberneedle Collection', { exact: true })).toBeVisible()
  await expect(page.getByText('phase2bmemberneedle Node', { exact: true })).toBeVisible()
})
