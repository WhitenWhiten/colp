import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { assertAuthenticated } from './auth-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const screenshotDir = process.env.KNOWN_REAL_STACK_SCREENSHOT_DIR
const syncEmail = process.env.KNOWN_REAL_STACK_SYNC_EMAIL
const syncPassword = process.env.KNOWN_REAL_STACK_SYNC_PASSWORD
if (!controlUrl || !controlToken || !screenshotDir || !syncEmail || !syncPassword) {
  throw new Error('Sync Conflict real-stack infrastructure is required')
}

async function assertVisualBounds(page: import('@playwright/test').Page) {
  const bounds = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    offenders: [...document.querySelectorAll<HTMLElement>('main *, header *')].filter((element) => {
      const box = element.getBoundingClientRect()
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1)
    }).map((element) => `${element.tagName}.${element.className}`).slice(0, 10),
  }))
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewport)
  expect(bounds.offenders).toEqual([])
}

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, { method: 'POST', headers: {
    authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}
async function login(page: import('@playwright/test').Page) {
  // Task E3: the P3-37 fixture account is provisioned as a REAL Better Auth
  // user (fixed test credentials; harness-side sign-up + 1:1 mapping), so the
  // browser signs in through the real password flow and the immutable Sync
  // fixture rows are visible under the fixture account id.
  await page.goto('/login?returnTo=%2Fsync')
  await page.locator('#login-email').fill(syncEmail)
  await page.locator('#login-password').fill(syncPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/sync$/u)
  await assertAuthenticated(page)
}

test('two replicas create a real Conflict, the page resolves it, and the second replica pulls the authority effect', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await login(page)
  const fixture = await control<{ conflictId: string; current: string; incoming: string; marker: string }>('/sync/create-conflict')
  await page.reload()
  await expect(page.getByText(fixture.current, { exact: true })).toBeVisible()
  await expect(page.getByText(fixture.incoming, { exact: true })).toBeVisible()
  await expect(page.locator('[data-conflict-id] img, [data-conflict-id] script, [data-conflict-id] svg')).toHaveCount(0)
  await expect(page.locator('[data-conflict-id]')).toContainText(fixture.marker)
  await assertVisualBounds(page)
  await page.screenshot({ path: join(screenshotDir, 'p3-37-sync-desktop-1440x900.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('radio', { name: /^Keep the browser version/ }).focus()
  await expect(page.getByRole('radio', { name: /^Keep the browser version/ })).toBeFocused()
  await assertVisualBounds(page)
  await page.screenshot({ path: join(screenshotDir, 'p3-37-sync-narrow-390x844.png'), fullPage: true })
  await page.getByRole('radio', { name: /^Keep the browser version/ }).check()
  const resolution = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/sync/conflicts/${fixture.conflictId}/resolution`))
  await page.getByRole('button', { name: 'Resolve conflict' }).click()
  expect((await resolution).status()).toBe(200)
  await expect(page.getByText(fixture.incoming, { exact: true })).toHaveCount(0)
  const evidence = await control<{ operationCreated: boolean; secondReplicaPulled: boolean; authorityTitle: string }>('/sync/assert-resolution', { conflictId: fixture.conflictId })
  expect(evidence).toEqual({ operationCreated: true, secondReplicaPulled: true, authorityTitle: fixture.incoming })
})
