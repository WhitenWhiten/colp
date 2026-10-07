import { expect, test, type Browser, type Page } from '@playwright/test'
import { assertAuthenticated, signInShared } from './auth-bootstrap'
import {
  createDeskBookmark,
  openCollectionEditorAfterDeskCreate,
  openCollectionSettings,
} from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
const governanceOn = process.env.KNOWN_FEATURE_CONTENT_GOVERNANCE === 'true'

if (!controlUrl || !controlToken || !webBaseUrl) {
  throw new Error('content-governance real-stack requires the fail-closed harness')
}

test.skip(!governanceOn, 'requires KNOWN_FEATURE_CONTENT_GOVERNANCE on the real API')

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`control ${path} failed (${response.status}): ${await response.text()}`)
  return response.json() as Promise<T>
}

async function meAccountId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    if (!response.ok) throw new Error(`me read failed: ${response.status}`)
    const body = await response.json() as { account: { id: string } }
    return body.account.id
  })
}

async function jsonStatus(page: Page, path: string): Promise<number> {
  return page.evaluate(async (url) => {
    const response = await fetch(url)
    await response.arrayBuffer()
    return response.status
  }, path)
}

async function anonymousCollectionStatus(browser: Browser, slug: string): Promise<number> {
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(webBaseUrl!, { waitUntil: 'domcontentloaded' })
    return jsonStatus(guest, `/api/v1/collections/${slug}`)
  } finally {
    await context.close()
  }
}

async function registerModerator(browser: Browser): Promise<{ page: Page; accountId: string }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const email = `cg08-mod-${Date.now().toString(36)}@example.test`
  const password = 'cg08-moderator-password-1'
  await page.goto('/register?returnTo=%2Fadmin%2Fmoderation%2Fcases')
  await page.locator('#register-name').fill('CG08 Moderator')
  await page.locator('#register-email').fill(email)
  await page.locator('#register-password').fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const verification = await control<{ found: boolean; entry: { url: string | null } | null }>(
    '/auth-mailbox/last',
    { email, purpose: 'email-verification' },
  )
  const token = verification.entry?.url?.match(/token=([A-Za-z0-9._~-]+)/u)?.[1]
  if (!token) throw new Error('moderator verification token missing')
  const verified = await page.evaluate(async (verificationToken) => {
    const response = await fetch(`/api/v1/auth/verify-email?token=${encodeURIComponent(verificationToken)}`)
    return response.status
  }, token)
  expect(verified).toBe(200)
  await page.goto('/verify-email?verified=1&returnTo=%2Fadmin%2Fmoderation%2Fcases')
  await assertAuthenticated(page)
  const accountId = await meAccountId(page)
  await control('/moderation/grant-role', { accountId, role: 'moderator' })
  return { page, accountId }
}

test.describe('content-governance', () => {
  test('content-governance report, official hide, appeal, and restore', async ({ page, browser }) => {
    const slug = 'cg08-gov-hide'
    const title = 'CG-08 governance collection'

    await signInShared(page)
    await page.getByLabel('Title').fill(title)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const collectionId = await openCollectionEditorAfterDeskCreate(page)
    await createDeskBookmark(page, 'Governance bookmark', 'https://example.test/cg08-governance')
    await openCollectionSettings(page, collectionId)
    const settings = page.getByTestId('collection-settings')
    await expect(settings).toBeVisible()
    await expect(page.getByTestId('collection-settings-loading')).toHaveCount(0)
    const publicChoice = settings.getByRole('radio', { name: 'Public', exact: true })
    await expect(publicChoice).toBeEnabled()
    await publicChoice.evaluate((button) => (button as HTMLButtonElement).click())
    await expect(publicChoice).toHaveAttribute('aria-checked', 'true')
    await settings.getByLabel('Public address').fill(slug)
    await settings.getByRole('button', { name: 'Save collection', exact: true }).evaluate((button) => {
      (button as HTMLButtonElement).click()
    })
    await expect(page.getByText('Collection settings saved').first()).toBeVisible()

    await page.goto(`/c/${slug}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('public-collection-page')).toBeVisible()
    await page.getByTestId('report-collection').click()
    await expect(page.getByTestId('report-content-dialog')).toBeVisible()
    await page.getByTestId('report-description').fill('spam on a public collection')
    await page.getByRole('button', { name: 'Submit report' }).click()
    await expect(page.getByTestId('report-content-dialog')).toHaveCount(0)

    await page.goto('/moderation/reports')
    await expect(page.getByTestId('moderation-report-list')).toContainText(/Collection .+ · Spam · Submitted/u)

    const moderator = await registerModerator(browser)
    try {
      await moderator.page.goto('/admin/moderation/cases')
      await expect(moderator.page.getByTestId('admin-moderation-case-list')).toBeVisible()
      await moderator.page.getByRole('link', { name: /collection .+ · spam/iu }).click()
      await expect(moderator.page.getByTestId('admin-moderation-case')).toBeVisible()
      await moderator.page.getByRole('button', { name: 'Hide public' }).click()
      await expect(moderator.page.getByTestId('admin-moderation-actions')).toContainText('Hidden from the public · Active')

      expect(await anonymousCollectionStatus(browser, slug)).toBe(404)

      await control('/api-and-worker/restart-and-await', { aggregateId: collectionId })
      expect(await anonymousCollectionStatus(browser, slug)).toBe(404)

      const actions = await page.evaluate(async () => {
        const response = await fetch('/api/v1/me/moderation-actions')
        return {
          status: response.status,
          body: await response.json() as { items?: Array<{ id: string; action: string; state: string }> },
        }
      })
      expect(actions.status).toBe(200)
      const hide = actions.body.items?.find((item) => item.action === 'hide_public' && item.state === 'active')
      expect(hide?.id).toBeTruthy()

      await page.goto('/moderation/appeals')
      await expect(page.getByTestId('moderation-appeal-action')).toBeVisible()
      await page.getByTestId('moderation-appeal-action').selectOption(hide!.id)
      await page.getByLabel('Description').fill('please restore the public collection')
      await page.getByRole('button', { name: 'Submit appeal' }).click()
      await expect(page.getByTestId('moderation-appeal-list')).toContainText('please restore the public collection')
      await expect(page.getByTestId('moderation-appeal-list')).toContainText('Submitted')

      await moderator.page.goto('/admin/moderation/appeals')
      await expect(moderator.page.getByTestId('admin-moderation-appeal-list')).toContainText('Submitted')
      await moderator.page.getByRole('button', { name: 'Uphold' }).click()
      await expect(moderator.page.getByTestId('admin-moderation-appeal-list')).toContainText('Upheld')

      expect(await anonymousCollectionStatus(browser, slug)).toBe(200)
      const restored = await browser.newContext()
      try {
        const guest = await restored.newPage()
        await guest.goto(new URL(`/c/${slug}`, webBaseUrl).href, { waitUntil: 'domcontentloaded' })
        await expect(guest.getByTestId('public-collection-page')).toBeVisible()
        await expect(guest.getByRole('heading', { name: title, level: 1 })).toBeVisible()
      } finally {
        await restored.close()
      }
    } finally {
      await moderator.page.context().close()
    }
  })

  test('content-governance personal language filter', async ({ page }) => {
    await signInShared(page)
    await page.goto('/library?settings=privacy')
    await expect(page.getByTestId('catalog-preferences-form')).toBeVisible()
    await page.locator('#pref-languages').fill('en')
    await page.getByRole('button', { name: 'Save filters' }).click()
    await expect(page.getByText('Catalog filters saved')).toBeVisible()

    await page.goto('/explore')
    await expect(page.getByTestId('explore-language')).toBeVisible()
    const explore = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return url.pathname === '/api/v1/explore/collections' && url.searchParams.get('language') === 'en'
    })
    await page.getByTestId('explore-language').selectOption('en')
    await explore
  })
})
