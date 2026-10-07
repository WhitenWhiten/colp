import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

/* Shared bootstrap for the community-social real-stack specs: control
   fixture calls, session-cookie contexts minted by /community/fixture,
   the __KNOWN_FLAGS__ exposure init, community target probes, and the
   durable inbox/ranking polls every spec reuses. No test bodies live here —
   the granularity gate only counts *.spec.ts files. */

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) {
  throw new Error('community-social real-stack infrastructure is required')
}

export const REAL_STACK_WEB_BASE_URL = webBaseUrl

export type Principal = {
  cookieValue: string
  csrfToken: string
  profileId: string
  handle: string
}
export type CommunityFixture = {
  actor: Principal
  target: Principal
  collectionId: string
  collectionSlug: string
  collectionTitle: string
  bookmarkNodeId: string
  bookmarkTitle: string
  seriesId: string
  seriesSlug: string
  seriesTitle: string
  editionId: string
  editionTitle: string
}
export type CommunityTargetQuery = {
  kind: 'collection' | 'bookmark' | 'digest_series' | 'digest_edition'
  id: string
  collectionId?: string
  seriesId?: string
}
export type CommunityResolvedTarget = {
  kind: string
  id: string
  collectionId: string | null
  seriesId: string | null
  generation: string
}
export type CommunityTargetView = {
  target: CommunityResolvedTarget
  title: string
  href: string
  canVote: boolean
  canComment: boolean
  canCurateComments: boolean
  votes: { up: number; down: number; myVote: number | null }
}
export type CommunityInboxItem = {
  id: string
  kind: string
  commentId: string
  actor: { displayName: string }
  preview: string | null
  href: string
  read: boolean
}
export type CommunityInbox = {
  items: CommunityInboxItem[]
  nextCursor: string | null
  unreadCount: number
}
export type CommunityRankingItem = {
  position: number
  target: { kind: string; id: string }
  title: string
  href: string
  up: number
  down: number
  hot: number
}
export type CommunityRankingPage = {
  items: CommunityRankingItem[]
  nextCursor: string | null
  scoreVersion: string | null
}

export async function control<T>(path: string, body?: unknown): Promise<T> {
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

export function createCommunityFixture(): Promise<CommunityFixture> {
  return control<CommunityFixture>('/community/fixture')
}

/* Rotates the fixture bookmark's URL through the REAL node PATCH (the nodes
   trigger mints the next community_bookmark_generations row). The spec uses
   the returned generation to prove the superseded-generation fence: the vote
   control re-resolves live and the old-generation thread is concealed. */
export function rotateBookmarkUrl(
  fixture: CommunityFixture,
  url: string,
): Promise<{ generation: string }> {
  return control<{ generation: string }>('/community/rotate-bookmark-url', {
    collectionId: fixture.collectionId,
    nodeId: fixture.bookmarkNodeId,
    url,
    cookieValue: fixture.target.cookieValue,
    csrfToken: fixture.target.csrfToken,
  })
}

export async function principalContext(browser: Browser, principal: Principal): Promise<BrowserContext> {
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

export async function enableCommunity(page: Page) {
  await page.addInitScript(() => {
    ;(window as Window & {
      __KNOWN_FLAGS__?: { community?: boolean; notifications?: boolean; reports?: boolean }
    }).__KNOWN_FLAGS__ = { community: true, notifications: true, reports: true }
  })
}

/* Deployment gate: KNOWN_FEATURE_COMMUNITY is always set by the real-stack
   runner, so a 404 resolve is a product failure — assert, never skip. */
export async function expectCommunityTarget(
  query: CommunityTargetQuery,
  cookieValue: string,
): Promise<void> {
  const params = new URLSearchParams({ kind: query.kind, id: query.id })
  if (query.collectionId !== undefined) params.set('collectionId', query.collectionId)
  if (query.seriesId !== undefined) params.set('seriesId', query.seriesId)
  const probe = await fetch(`${webBaseUrl}/api/v1/community/target?${params.toString()}`, {
    headers: { cookie: `__Host-known_session=${encodeURIComponent(cookieValue)}` },
  })
  expect(probe.status).toBe(200)
}

function targetQueryParams(query: CommunityTargetQuery): string {
  const params = new URLSearchParams({ kind: query.kind, id: query.id })
  if (query.collectionId !== undefined) params.set('collectionId', query.collectionId)
  if (query.seriesId !== undefined) params.set('seriesId', query.seriesId)
  return params.toString()
}

/** Session-authenticated resolve through the real community target route. */
export async function resolveCommunityTargetView(
  query: CommunityTargetQuery,
  cookieValue: string,
): Promise<CommunityTargetView> {
  const response = await fetch(
    `${webBaseUrl}/api/v1/community/target?${targetQueryParams(query)}`,
    { headers: { cookie: `__Host-known_session=${encodeURIComponent(cookieValue)}` } },
  )
  expect(response.status).toBe(200)
  return response.json() as Promise<CommunityTargetView>
}

/*
 * Real-API write helpers. They send the exact headers the browser mutation
 * path sends (session cookie, Origin, session-bound CSRF, durable command
 * id) — a genuine durable write that appends the same outbox events a page
 * click produces. Page-level vote coverage lives in the per-kind specs;
 * these exist for multi-target seeding (e.g. the ranking board).
 */
function mutationHeaders(principal: Principal, commandId: string, contentType: string) {
  return {
    cookie: `__Host-known_session=${encodeURIComponent(principal.cookieValue)}`,
    origin: webBaseUrl!,
    'x-csrf-token': principal.csrfToken,
    'known-command-id': commandId,
    'content-type': contentType,
  }
}

export async function apiResolveAndVote(
  query: CommunityTargetQuery,
  principal: Principal,
  value: -1 | 0 | 1 = 1,
): Promise<void> {
  const view = await resolveCommunityTargetView(query, principal.cookieValue)
  const response = await fetch(`${webBaseUrl}/api/v1/community/vote`, {
    method: 'PUT',
    headers: mutationHeaders(principal, crypto.randomUUID(), 'application/json'),
    body: JSON.stringify({ target: view.target, value }),
  })
  expect(response.status).toBe(200)
}

export async function apiCreateComment(
  query: CommunityTargetQuery,
  principal: Principal,
  body: string,
): Promise<void> {
  const view = await resolveCommunityTargetView(query, principal.cookieValue)
  const response = await fetch(`${webBaseUrl}/api/v1/community/comments`, {
    method: 'POST',
    headers: mutationHeaders(principal, crypto.randomUUID(), 'application/json'),
    body: JSON.stringify({ target: view.target, body, replyToId: null }),
  })
  expect(response.status).toBe(201)
}

export function bookmarkUrl(fixture: CommunityFixture): string {
  return `/r/${encodeURIComponent(fixture.bookmarkNodeId)}?slug=${encodeURIComponent(fixture.collectionSlug)}`
}

export function seriesUrl(fixture: CommunityFixture): string {
  return `/reports/${encodeURIComponent(fixture.seriesSlug)}`
}

export function editionUrl(fixture: CommunityFixture): string {
  return `/reports/${encodeURIComponent(fixture.seriesSlug)}/issues/${encodeURIComponent(fixture.editionId)}`
}

/** First-level community comment rows carry the whole comment id in the testid. */
export async function firstCommentId(page: Page): Promise<string> {
  const row = page.locator('.community-comments-list > li.community-comment').first()
  await expect(row).toBeVisible()
  const testId = await row.getAttribute('data-testid')
  const match = /^comment-(.+)$/u.exec(testId ?? '')
  if (!match?.[1]) throw new Error(`community comment testid missing: ${testId ?? '(none)'}`)
  return match[1]
}

/** Upvote through the real control and assert the durable PUT receipt. */
export async function upvoteThroughUi(page: Page): Promise<void> {
  const upvote = page.getByTestId('community-vote-up')
  await expect(upvote).toBeEnabled()
  const votePut = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === '/api/v1/community/vote')
  await upvote.click()
  expect((await votePut).status()).toBe(200)
  await expect(upvote).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('community-vote-up-count')).toHaveText('1')
}

/** Post a root comment through the durable create command; returns its id. */
export async function postRootComment(page: Page, body: string): Promise<string> {
  await page.getByTestId('community-comments-input').fill(body)
  const commentPost = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/v1/community/comments')
  await page.getByTestId('community-comments-submit').click()
  expect((await commentPost).status()).toBe(201)
  const commentId = await firstCommentId(page)
  await expect(page.getByTestId(`comment-${commentId}`)).toContainText(body)
  return commentId
}

/** The durable inbox read — the same session-authenticated GET the panel issues. */
export async function readCommunityInbox(page: Page): Promise<CommunityInbox> {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me/community-notifications')
    return { status: response.status, body: await response.json() as CommunityInbox }
  })
  expect(result.status).toBe(200)
  return result.body
}

/**
 * Poll the authority inbox until the worker projection satisfies the
 * predicate. The route rides the publicReads admission family — a 1.5s
 * cadence stays far under its per-minute budget, and a transient 429 is
 * backpressure to wait out, not a terminal failure.
 */
export async function awaitCommunityInbox(
  page: Page,
  predicate: (inbox: CommunityInbox) => boolean,
  timeoutMs = 60_000,
): Promise<CommunityInbox> {
  const deadline = Date.now() + timeoutMs
  let last: CommunityInbox = { items: [], nextCursor: null, unreadCount: 0 }
  let lastStatus = 200
  while (Date.now() < deadline) {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/v1/me/community-notifications')
      return { status: response.status, body: await response.json() as CommunityInbox }
    })
    lastStatus = result.status
    if (result.status === 200) {
      last = result.body
      if (predicate(last)) return last
    } else if (result.status !== 429) {
      expect(result.status).toBe(200)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(
    `community notification inbox did not reach the expected state (last status ${lastStatus}): ${JSON.stringify(last)}`)
}

/**
 * Poll the real hot-ranking endpoint until the worker-produced snapshot
 * satisfies the predicate. Reads ride the public-reads admission family; a
 * 1.5s cadence stays far under its per-minute budget.
 */
export async function awaitCommunityRanking(
  predicate: (page: CommunityRankingPage) => boolean,
  timeoutMs = 90_000,
): Promise<CommunityRankingPage> {
  const deadline = Date.now() + timeoutMs
  let last: CommunityRankingPage = { items: [], nextCursor: null, scoreVersion: null }
  while (Date.now() < deadline) {
    const response = await fetch(`${webBaseUrl}/api/v1/community/ranking?limit=50`)
    if (response.status === 200) {
      last = await response.json() as CommunityRankingPage
      if (predicate(last)) return last
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`community ranking did not reach the expected state: ${JSON.stringify(last)}`)
}
