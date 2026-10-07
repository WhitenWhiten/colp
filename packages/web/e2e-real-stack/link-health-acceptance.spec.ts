import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) {
  throw new Error('LH-real-stack infrastructure is required')
}

type Principal = { cookieValue: string; profileId: string; handle: string }
type BookmarkFact = { nodeId: string; title: string; url: string; finalUrl?: string }
type Fixture = {
  owner: Principal
  collectionId: string
  collectionTitle: string
  bookmarks: {
    healthy: BookmarkFact
    redirect: BookmarkFact
    broken: BookmarkFact
    duplicate: BookmarkFact
    timeout: BookmarkFact
  }
}

const MOCK_SEED_TITLES = [
  'Old layout systems roundup',
  'Radix UI documentation',
  'Design token pipeline notes',
  'Inventing on Principle',
  'Spacing as a system',
]

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

async function setLinkHealthFlag(page: Page, enabled: boolean) {
  await page.addInitScript((value) => {
    const w = window as Window & { __KNOWN_FLAGS__?: { linkHealth?: boolean } }
    w.__KNOWN_FLAGS__ = { ...(w.__KNOWN_FLAGS__ ?? {}), linkHealth: value }
  }, enabled)
}

function nodeIds(fixture: Fixture): string[] {
  return [
    fixture.bookmarks.healthy.nodeId,
    fixture.bookmarks.redirect.nodeId,
    fixture.bookmarks.broken.nodeId,
    fixture.bookmarks.duplicate.nodeId,
    fixture.bookmarks.timeout.nodeId,
  ]
}

test('LH-real-stack Product GET/POST and worker facts replace the mock health seed', async ({ browser }, testInfo) => {
  const fixture = await control<Fixture>('/link-health/fixture')
  const gated = await principalContext(browser, fixture.owner)
  const live = await principalContext(browser, fixture.owner)
  try {
    const off = await gated.newPage()
    await setLinkHealthFlag(off, false)
    const gatedRequests: string[] = []
    off.on('request', (request) => {
      if (request.url().includes('/api/v1/me/link-health')) gatedRequests.push(request.url())
    })
    await off.goto('/library/health')
    await expect(off.getByTestId('link-health-flag-off')).toBeVisible()
    await expect(off.getByText(/not available/i)).toBeVisible()
    expect(gatedRequests).toEqual([])

    const firstProbe = await control<{ pending: number; probed: number }>('/link-health/await', {
      nodeIds: nodeIds(fixture),
      phase: 'probed',
    })
    expect(firstProbe.pending).toBe(0)
    expect(firstProbe.probed).toBe(5)

    const page = await live.newPage()
    await setLinkHealthFlag(page, true)
    const list = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' && url.pathname === '/api/v1/me/link-health'
    })
    await page.goto('/library/health')
    expect((await list).status()).toBe(200)
    await expect(page.getByText(fixture.bookmarks.healthy.title)).toBeVisible()
    await expect(page.getByText(fixture.bookmarks.redirect.title)).toBeVisible()
    await expect(page.getByText(fixture.bookmarks.broken.title)).toBeVisible()
    await expect(page.getByText(fixture.bookmarks.duplicate.title)).toBeVisible()
    await expect(page.getByText(fixture.bookmarks.timeout.title)).toBeVisible()
    await expect(page.getByText(fixture.collectionTitle).first()).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Healthy', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('cell', { name: /^Redirected/ }).first()).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Broken', exact: true }).first()).toBeVisible()
    await expect(page.getByText('Could not check').first()).toBeVisible()
    await expect(page.getByText('The checker could not reach this link. Retry the check.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry check' })).toBeVisible()
    await expect(page.getByRole('link', { name: fixture.bookmarks.redirect.finalUrl! })).toBeVisible()
    await expect(page.getByRole('button', { name: /stale/i })).toHaveCount(0)
    for (const title of MOCK_SEED_TITLES) {
      await expect(page.getByText(title)).toHaveCount(0)
    }

    await page.getByRole('combobox', { name: 'Filter link health' }).selectOption('duplicate')
    await expect(page.getByText(fixture.bookmarks.duplicate.title)).toBeVisible()
    await expect(page.getByText(fixture.bookmarks.healthy.title)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Mark as duplicate' })).toBeVisible()
    const marked = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST'
        && url.pathname === `/api/v1/collections/${fixture.collectionId}/relations`
    })
    await page.getByRole('button', { name: 'Mark as duplicate' }).click()
    expect((await marked).status()).toBe(201)
    await expect(page.getByRole('button', { name: 'Undo review' })).toBeVisible()
    await expect(page.getByText(fixture.bookmarks.duplicate.title)).toBeVisible()
    const undone = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'DELETE' && url.pathname.includes('/relations/')
    })
    const undoneList = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET' && url.pathname === '/api/v1/me/link-health'
    })
    await page.getByRole('button', { name: 'Undo review' }).click()
    expect((await undone).status()).toBe(200)
    const listed = await undoneList
    expect(listed.status()).toBe(200)
    const listedBody = await listed.json() as {
      items: Array<{ nodeId: string; duplicateRelationId?: string | null }>
    }
    expect(
      listedBody.items.find((item) => item.nodeId === fixture.bookmarks.duplicate.nodeId)
        ?.duplicateRelationId ?? null,
    ).toBeNull()
    await expect(page.getByRole('button', { name: 'Mark as duplicate' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Filter link health' }).selectOption('all')

    const check = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST' && url.pathname === '/api/v1/me/link-health/checks'
    })
    await page.getByRole('button', { name: 'Check all links' }).click()
    const posted = await check
    expect(posted.status()).toBe(200)
    expect(posted.request().headers()['x-csrf-token']?.length).toBeGreaterThan(0)
    expect(posted.request().headers()['known-command-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(posted.request().headers()['if-match']).toBeUndefined()
    await control('/link-health/await', {
      nodeIds: nodeIds(fixture),
      phase: 'requeued-then-probed',
    })
    await page.reload()
    await expect(page.getByText(fixture.bookmarks.healthy.title)).toBeVisible()
    await expect(page.getByRole('cell', { name: 'Healthy', exact: true }).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('link-health-desktop.png'), fullPage: true })

    await control('/api/stop')
    await page.reload()
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load link health" })).toBeVisible()
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load link health" })).toContainText("Couldn't load link health")
    await control('/api/start')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't load link health" })).toHaveCount(0)
    await expect(page.getByText(fixture.bookmarks.healthy.title)).toBeVisible()
    await page.goto('/library/health')
    await expect(page.getByText(fixture.bookmarks.redirect.title)).toBeVisible()
  } finally {
    await gated.close()
    await live.close()
    await control('/api/start').catch(() => undefined)
  }
})
