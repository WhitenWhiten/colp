import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { signInShared } from './auth-bootstrap'

const handle = 'phase2b-browser-profile'
const fixtureId = (seed: string) => createHash('sha256').update(seed).digest().subarray(0, 16).toString('base64url')
const expectedPublicIds = [
  fixtureId('phase2b-browser-public'),
  ...Array.from(
    { length: 24 },
    (_, index) => fixtureId(`phase2b-browser-public-${String(index + 1).padStart(2, '0')}`),
  ),
]

test('opens and refreshes a real public Profile without enumerating hidden Collections', async ({ page }) => {
  const profileResponses: Array<{ url: string; status: number }> = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname === `/api/v1/profiles/${handle}`) {
      profileResponses.push({ url: response.url(), status: response.status() })
    }
  })

  await page.goto(`/u/${handle}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Phase 2B Browser Profile' })).toBeVisible()
  const primaryPublicLink = page.locator(
    `[data-profile-collection-id="${expectedPublicIds[0]}"] a`,
  )
  await expect(primaryPublicLink).toHaveAttribute(
    'href',
    '/c/phase2b-browser-public',
  )
  await expect(page.getByText('Phase 2B unlisted Collection')).toHaveCount(0)
  await expect(page.getByText('Phase 2B private Collection')).toHaveCount(0)
  expect(profileResponses).toHaveLength(1)
  const firstPageUrl = new URL(profileResponses[0]!.url)
  expect(firstPageUrl.searchParams.get('limit')).toBe('24')
  expect(firstPageUrl.searchParams.has('cursor')).toBe(false)
  expect([...firstPageUrl.searchParams.keys()]).toEqual(['limit'])

  const loadMore = page.getByRole('button', { name: 'Load more' })
  await expect(loadMore).toBeVisible()
  await loadMore.click()
  await expect(loadMore).toHaveCount(0)

  const publicIds = await page.locator('[data-profile-collection-id]').evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-profile-collection-id')),
  )
  expect(publicIds).toEqual(expectedPublicIds)
  expect(new Set(publicIds).size).toBe(publicIds.length)
  expect(publicIds).toHaveLength(expectedPublicIds.length)
  await expect(page.getByText('Phase 2B unlisted Collection')).toHaveCount(0)
  await expect(page.getByText('Phase 2B private Collection')).toHaveCount(0)
  const continuationResponses = profileResponses.filter(({ url }) =>
    new URL(url).searchParams.has('cursor'),
  )
  expect(continuationResponses).toHaveLength(1)
  const continuationUrl = new URL(continuationResponses[0]!.url)
  expect(continuationUrl.searchParams.get('limit')).toBe('24')
  expect(continuationUrl.searchParams.get('cursor')).toBeTruthy()
  expect([...continuationUrl.searchParams.keys()]).toEqual(['limit', 'cursor'])
  expect(new Set(profileResponses.map(({ url }) => url)).size).toBe(2)
  expect(continuationUrl.href).not.toBe(firstPageUrl.href)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Phase 2B Browser Profile' })).toBeVisible()
  expect(profileResponses.length).toBeGreaterThanOrEqual(2)
  expect(profileResponses.every((response) => response.status === 200)).toBe(true)
  expect(profileResponses.every((response) =>
    new URL(response.url).pathname === `/api/v1/profiles/${handle}`,
  )).toBe(true)

  const projection = await page.evaluate(async (profileHandle) => {
    const response = await fetch(`/api/v1/profiles/${profileHandle}?limit=24`)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }, handle)
  expect(projection.status).toBe(200)
  expect(JSON.stringify(projection.body)).not.toMatch(/account|owner|email|subject|membership|revision/iu)
  expect((projection.body.collections as Array<{ id: string }>).map(({ id }) => id))
    .toEqual(expectedPublicIds.slice(0, 24))

  await page.goto(`/profile/${handle}`, { waitUntil: 'domcontentloaded' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { level: 1, name: 'Phase 2B Browser Profile' })).toBeVisible()

  const publicLink = page.locator(`[data-profile-collection-id="${expectedPublicIds[0]}"] a`)
  await publicLink.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/c\/phase2b-browser-public$/u)
  await expect(page.getByRole('heading', { level: 1, name: 'Phase 2B public Collection' })).toBeVisible()
})

test('default BA user opens its persisted empty Profile and handle changes propagate', async ({ page }) => {
  await signInShared(page, '/library')
  await expect(page.getByRole('button', { name: /Phase 1 Real Stack/u }).first()).toBeVisible()

  const me = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    return { status: response.status, body: await response.json() as { profile: { handle: string } } }
  })
  expect(me.status).toBe(200)
  expect(me.body.profile.handle).toMatch(/^[a-z0-9._~-]{1,64}$/u)

  await page.getByRole('button', { name: /Phase 1 Real Stack/u }).first().click()
  await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Profile', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/u/${me.body.profile.handle}$`, 'u'))
  await expect(page.getByRole('heading', { level: 1, name: 'Phase 1 Real Stack' })).toBeVisible()
  await expect(page.getByText(/profile unavailable/i)).toHaveCount(0)

  const uniqueHandle = `phase1-${Date.now().toString(36)}`
  await page.goto('/settings#profile', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(page.getByLabel('Display name')).toHaveValue('Phase 1 Real Stack')
  await page.getByLabel('Handle').fill(uniqueHandle)
  await page.getByRole('button', { name: 'Save profile', exact: true }).click()
  // The dialog opens over Library, whose empty state is also role="status".
  await expect(page.getByRole('status').filter({ hasText: 'Profile saved' })).toBeVisible()
  // Close the dialog before reaching for TopNav; its overlay intercepts clicks.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  await page.getByRole('button', { name: /Phase 1 Real Stack/u }).first().click()
  await expect(
    page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Profile', exact: true }),
  ).toHaveAttribute('href', `/u/${uniqueHandle}`)
})
