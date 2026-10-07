import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { expectCollectionDeskAfterCreate } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) {
  throw new Error('Collection-follow real-stack infrastructure is required')
}

type Principal = { cookieValue: string; profileId: string; handle: string }
type Fixture = {
  actor: Principal
  target: Principal
  collectionId: string
  collectionSlug: string
}

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`)
  return response.status === 204 ? undefined as T : response.json() as Promise<T>
}

async function principalContext(browser: Browser, principal: Principal): Promise<BrowserContext> {
  const context = await browser.newContext()
  const origin = new URL(webBaseUrl!)
  origin.protocol = 'https:'
  await context.addCookies([{
    name: '__Host-known_session',
    value: principal.cookieValue,
    url: origin.origin,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }])
  return context
}

async function enableCollectionFollow(page: Page) {
  await page.addInitScript(() => {
    ;(window as Window & { __KNOWN_FLAGS__?: { collectionFollow?: boolean } }).__KNOWN_FLAGS__ = {
      collectionFollow: true,
    }
  })
}

function collectionFollowPath(collectionId: string) {
  return `/api/v1/collections/${collectionId}/follow`
}

function mastheadFollow(page: Page) {
  return page.locator('.social-actions').getByRole('button', { name: 'Follow', exact: true })
}

function mastheadUnfollow(page: Page) {
  return page.locator('.social-actions').getByRole('button', { name: 'Unfollow', exact: true })
}

function followedRow(page: Page, slug: string) {
  return page.getByTestId('library-nav-following').locator(`a[href="/library/following/${slug}"]`)
}

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

async function ensureActorLibraryDesk(page: Page) {
  await page.goto('/library/new')
  await page.locator('#cc-title').fill('Collection-follow actor desk')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expectCollectionDeskAfterCreate(page)
}

test('real-stack collection-follow workflows remain authoritative across two tabs, feed, and Library Following', async ({ browser }) => {
  const fixture = await control<Fixture>('/follow/fixture')
  const reader = await principalContext(browser, fixture.actor)
  const writer = await principalContext(browser, fixture.target)
  try {
    const first = await reader.newPage()
    const second = await reader.newPage()
    const editor = await writer.newPage()
    await enableCollectionFollow(first)
    await enableCollectionFollow(second)
    await enableCollectionFollow(editor)
    await ensureActorLibraryDesk(first)

    const collectionUrl = `/c/${fixture.collectionSlug}`
    await first.goto(collectionUrl)
    await second.goto(collectionUrl)
    const firstFollow = mastheadFollow(first)
    const secondFollow = mastheadFollow(second)
    await expect(firstFollow).toBeEnabled()
    await firstFollow.focus()
    await expect(firstFollow).toBeFocused()
    await expect(secondFollow).toBeEnabled()

    const followMutations: Array<{ method: string; commandId: string }> = []
    for (const page of [first, second]) {
      page.on('request', (request) => {
        if (new URL(request.url()).pathname !== collectionFollowPath(fixture.collectionId)) return
        if (!['PUT', 'DELETE'].includes(request.method())) return
        followMutations.push({
          method: request.method(),
          commandId: request.headers()['known-command-id'] ?? '',
        })
      })
    }

    await first.keyboard.press('Enter')
    await expect(mastheadUnfollow(first)).toHaveAttribute('aria-pressed', 'true')
    await expect(mastheadUnfollow(second)).toHaveAttribute('aria-pressed', 'true')
    const puts = followMutations.filter(({ method }) => method === 'PUT')
    expect(puts.length).toBeGreaterThanOrEqual(1)
    expect(puts.length).toBeLessThanOrEqual(2)
    expect(puts.every(({ commandId }) => commandId.length > 0)).toBe(true)
    expect(new Set(puts.map(({ commandId }) => commandId)).size).toBe(puts.length)
    await control('/collection-follow/assert', {
      actorProfileId: fixture.actor.profileId,
      collectionId: fixture.collectionId,
      following: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const publicTitle = `CF-E2E public change ${Date.now()}`
    await editor.goto(`/library/${fixture.collectionId}/edit`)
    await saveCollectionTitle(editor, fixture.collectionId, publicTitle)
    const evidence = await control<{ visible: number; withdrawn: number; completedSources: number }>(
      '/feed/await',
      { recipientProfileId: fixture.actor.profileId, collectionId: fixture.collectionId, minimum: 1 },
    )
    expect(evidence.visible).toBeGreaterThanOrEqual(1)
    expect(evidence.completedSources).toBeGreaterThanOrEqual(evidence.visible)

    await first.goto('/feed')
    const feedItem = first.locator(`[data-feed-collection-id="${fixture.collectionId}"]`)
    await expect(feedItem).toBeVisible()
    await expect(feedItem).toContainText(publicTitle)

    await first.goto('/library')
    const following = first.getByTestId('library-nav-following')
    await expect(following.getByRole('button', { name: 'Following' })).toBeVisible()
    await expect(followedRow(first, fixture.collectionSlug)).toBeVisible()

    // The followed collection opens read-only on the shared library desk.
    await followedRow(first, fixture.collectionSlug).click()
    await expect(first).toHaveURL(new RegExp(`/library/following/${fixture.collectionSlug}(?:\\?.*)?$`, 'u'))
    await expect(first.getByRole('heading', { name: publicTitle })).toBeVisible()
    const deskMore = first.getByRole('button', { name: 'Collection actions' })
    await deskMore.click()
    const deskMenu = first.getByRole('menu')
    await expect(deskMenu.getByRole('menuitem', { name: 'Open public page' })).toBeVisible()
    await expect(deskMenu.getByRole('menuitem', { name: 'Version history' })).toHaveCount(0)
    await expect(deskMenu.getByRole('menuitem', { name: 'Add bookmark' })).toHaveCount(0)
    await first.keyboard.press('Escape')

    await first.goto(collectionUrl)
    await expect(mastheadUnfollow(first)).toBeEnabled()
    await mastheadUnfollow(first).click()
    await expect(mastheadFollow(first)).toBeVisible()
    await expect(mastheadFollow(first)).toHaveAttribute('aria-pressed', 'false')
    await control('/collection-follow/assert', {
      actorProfileId: fixture.actor.profileId,
      collectionId: fixture.collectionId,
      following: false,
    })

    await first.goto('/library')
    await expect(followedRow(first, fixture.collectionSlug)).toHaveCount(0)
    await expect(first.getByTestId('library-nav-following')).toContainText("You aren't following any collections yet.")

    await first.goto(collectionUrl)
    await expect(mastheadFollow(first)).toBeVisible()
    await expect(mastheadFollow(first)).toHaveAttribute('aria-pressed', 'false')
  } finally {
    await reader.close()
    await writer.close()
  }
})
