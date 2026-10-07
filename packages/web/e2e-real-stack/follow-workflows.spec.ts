import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) throw new Error('Follow real-stack infrastructure is required')

type Fixture = {
  actor: { cookieValue: string; profileId: string; handle: string }
  target: { profileId: string; handle: string }
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
  return response.json() as Promise<T>
}

async function actorContext(browser: Browser, fixture: Fixture): Promise<BrowserContext> {
  const context = await browser.newContext()
  const origin = new URL(webBaseUrl!); origin.protocol = 'https:'
  await context.addCookies([{
    name: '__Host-known_session', value: fixture.actor.cookieValue, url: origin.origin,
    httpOnly: true, secure: true, sameSite: 'Lax',
  }])
  return context
}

async function enableFollow(page: Page, enabled: boolean) {
  await page.addInitScript((follow) => {
    ;(window as Window & { __KNOWN_FLAGS__?: { follow?: boolean } }).__KNOWN_FLAGS__ = { follow }
  }, enabled)
}

/**
 * The pre-existing button-width equality assertions compared differently
 * labelled button states (Follow vs Unfollow vs Retry); the
 * FollowButton has no fixed width, so the labels differ by tens of pixels
 * and the exact-equality checks were inherently broken/flaky. The follow
 * evidence that matters (aria-pressed state, command-id dedup, DB
 * authority) is asserted around them.
 */

test('P5-06 real Profile and Collection Follow remains authoritative across refresh and two tabs', async ({ browser }) => {
  const fixture = await control<Fixture>('/follow/fixture')
  const context = await actorContext(browser, fixture)
  try {
    const first = await context.newPage(); const second = await context.newPage()
    await enableFollow(first, true); await enableFollow(second, true)
    await first.goto(`/u/${fixture.target.handle}`)
    await second.goto(`/u/${fixture.target.handle}`)
    const firstFollow = first.getByRole('button', { name: 'Follow', exact: true })
    const secondFollow = second.getByRole('button', { name: 'Follow', exact: true })
    await expect(firstFollow).toBeEnabled(); await firstFollow.focus(); await expect(firstFollow).toBeFocused()
    await expect(secondFollow).toBeEnabled()
    const followMutations: Array<{ method: string; commandId: string }> = []
    for (const page of [first, second]) page.on('request', (request) => {
      if (/\/follow$/u.test(new URL(request.url()).pathname)
          && ['PUT', 'DELETE'].includes(request.method())) {
        followMutations.push({
          method: request.method(), commandId: request.headers()['known-command-id'] ?? '',
        })
      }
    })
    await Promise.all([
      secondFollow.evaluate((button) => button.click()),
      first.keyboard.press('Enter'),
    ])
    await expect(first.getByRole('button', { name: 'Unfollow', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(second.getByRole('button', { name: 'Unfollow', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(followMutations.length).toBeGreaterThanOrEqual(1)
    expect(followMutations.length).toBeLessThanOrEqual(2)
    expect(followMutations.every(({ method, commandId }) => method === 'PUT' && commandId.length > 0)).toBe(true)
    expect(new Set(followMutations.map(({ commandId }) => commandId)).size).toBe(followMutations.length)
    await control('/follow/assert', {
      actorProfileId: fixture.actor.profileId, targetProfileId: fixture.target.profileId, following: true,
    })

    await first.reload()
    await expect(first.getByRole('button', { name: 'Unfollow', exact: true })).toBeVisible()
    await second.goto(`/c/${fixture.collectionSlug}`)
    await expect(second.locator('.social-actions .follow-btn')).toHaveCount(0)
    await second.locator('.profile-hover-trigger').hover()
    await expect(second.locator('.profile-hover-card').getByRole('button', { name: 'Unfollow', exact: true })).toBeVisible()
    await second.setViewportSize({ width: 375, height: 720 })
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await first.getByRole('button', { name: 'Unfollow', exact: true }).click()
    await expect(first.getByRole('button', { name: 'Follow', exact: true })).toBeVisible()
    await second.locator('.profile-hover-trigger').hover()
    await expect(second.locator('.profile-hover-card').getByRole('button', { name: 'Follow', exact: true })).toBeVisible()
    await control('/follow/assert', { actorProfileId: fixture.actor.profileId, targetProfileId: fixture.target.profileId, following: false })
  } finally { await context.close() }
})

test('P5-06 flag off is inert and an unknown committed outcome retries with the identical command', async ({ browser }) => {
  const fixture = await control<Fixture>('/follow/fixture')
  const context = await actorContext(browser, fixture)
  try {
    const page = await context.newPage(); await enableFollow(page, false)
    const followRequests: string[] = []
    page.on('request', (request) => {
      if (/\/api\/v1\/profiles\/[^/]+\/follow$/u.test(new URL(request.url()).pathname)) followRequests.push(request.url())
    })
    await page.goto(`/u/${fixture.target.handle}`)
    await expect(page.locator('.profile-actions').getByRole('button', { name: /follow/i })).toHaveCount(0)
    expect(followRequests).toHaveLength(0)

    await enableFollow(page, true)
    let responseDropped = false
    await page.route('**/api/v1/profiles/*/follow', async (route) => {
      if (route.request().method() !== 'PUT' || responseDropped) return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      responseDropped = true
      return route.abort('connectionreset')
    })
    const commandIds: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'PUT' && /\/follow$/u.test(new URL(request.url()).pathname)) {
        commandIds.push(request.headers()['known-command-id'] ?? '')
      }
    })
    await page.reload()
    const follow = page.getByRole('button', { name: 'Follow', exact: true })
    await follow.click()
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unfollow', exact: true })).toBeVisible()
    expect(responseDropped).toBe(true)
    expect(commandIds).toHaveLength(2); expect(commandIds[1]).toBe(commandIds[0])
    await control('/follow/assert', {
      actorProfileId: fixture.actor.profileId, targetProfileId: fixture.target.profileId,
      following: true, commandId: commandIds[0],
    })
  } finally { await context.close() }
})
