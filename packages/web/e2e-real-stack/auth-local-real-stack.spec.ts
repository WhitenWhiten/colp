import { expect, test, type Page } from '@playwright/test'
import {
  assertAuthenticated,
  REAL_STACK_SHARED_DISPLAY_NAME,
  REAL_STACK_SHARED_EMAIL,
  sessionCookieValue,
  signInShared,
} from './auth-bootstrap'
import { openCollectionEditorAfterDeskCreate } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const apiOrigin = process.env.KNOWN_REAL_STACK_API_ORIGIN
if (!controlUrl || !controlToken || !apiOrigin) throw new Error('real-stack control endpoints are required')

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

type MappingEvidence = {
  found: boolean
  account?: { id: string; subjectId?: string; subject_id?: string; status: string; email: string | null }
  mapping?: { authUserId: string; auth_user_id?: string }
  profile?: { displayName: string; handle: string }
  liveBaSessions: number
  legacySessions: number
}

async function meAccountId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    if (!response.ok) throw new Error(`me read failed: ${response.status}`)
    const body = await response.json() as { account: { id: string } }
    return body.account.id
  })
}

async function createCollection(page: Page): Promise<string> {
  await page.getByLabel('Title').fill('E3 local auth acceptance collection')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  return openCollectionEditorAfterDeskCreate(page)
}

test('real browser registers with password, verifies the digest-only mail contract, mutates product data, and survives reload', async ({ page }) => {
  const email = `e3-local-${Date.now().toString(36)}@example.test`
  const password = 'e3-local-password-1'
  const displayName = 'E3 Local User'

  await page.goto('/register?returnTo=%2Flibrary%2Fnew')
  await page.locator('#register-name').fill(displayName)
  await page.locator('#register-email').fill(email)
  await page.locator('#register-password').fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  // Unverified occupancy is not a Product actor and receives no session.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  expect(await sessionCookieValue(page)).toBeNull()

  // Verification mail is delivered through the REAL C1 sender into the API
  // process mailbox; the token is digest-only (never stored in plaintext).
  const verification = await control<{ found: boolean; entry: { url: string | null; purpose: string } | null }>(
    '/auth-mailbox/last', { email, purpose: 'email-verification' },
  )
  expect(verification.found).toBe(true)
  expect(verification.entry?.purpose).toBe('email-verification')
  const token = verification.entry?.url?.match(/token=([A-Za-z0-9._~-]+)/u)?.[1]
  expect(token).toBeTruthy()
  const digest = await control<{ plaintextMatches: number }>('/auth/assert-verification-digest', { token })
  expect(digest.plaintextMatches).toBe(0)

  const verified = await page.evaluate(async (verificationToken) => {
    const response = await fetch(`/api/v1/auth/verify-email?token=${encodeURIComponent(verificationToken)}`)
    return response.status
  }, token!)
  expect(verified).toBe(200)
  await page.goto('/verify-email?verified=1&returnTo=%2Flibrary%2Fnew')
  await expect(page.getByRole('heading', { name: 'Congratulations' })).toBeVisible()
  await assertAuthenticated(page)

  // Product mutation is available only after the mailbox proof establishes
  // the mapped account and signed session.
  await page.goto('/library/new')
  const collectionId = await createCollection(page)
  await page.reload()
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await assertAuthenticated(page)

  // DB mapping evidence: auth user + 1:1 mapping + BA session rows, zero
  // legacy `sessions` rows for the BA-registered account.
  const accountId = await meAccountId(page)
  const mapping = await control<MappingEvidence>('/auth/assert-mapping', { accountId })
  expect(mapping.found).toBe(true)
  expect(mapping.account?.status).toBe('active')
  expect(mapping.account?.email).toBe(email)
  expect(mapping.mapping?.authUserId ?? mapping.mapping?.auth_user_id).toBeTruthy()
  expect(mapping.profile?.displayName).toBe(displayName)
  expect(mapping.liveBaSessions).toBeGreaterThanOrEqual(1)
  expect(mapping.legacySessions).toBe(0)
})

test('logout revokes the BA session and relogin re-establishes it; desktop and mobile viewports', async ({ page }) => {
  await signInShared(page)
  const accountId = await meAccountId(page)
  const before = await control<{ live_ba_sessions: number; metadata_total: number; revoked_metadata: number }>('/auth/session-count', { accountId })
  expect(before.live_ba_sessions).toBeGreaterThanOrEqual(1)

  // CSRF negative on a product mutation route: a wrong token is rejected
  // with 403 csrf_failed and the session survives untouched.
  const csrf = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session', {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': 'not-the-derived-token' },
    })
    return { status: response.status, body: await response.json() as { error?: { code?: string } } }
  })
  expect(csrf.status).toBe(403)
  expect(csrf.body.error?.code).toBe('csrf_failed')
  const stillValid = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return response.json() as Promise<{ authenticated: boolean }>
  })
  expect(stillValid.authenticated).toBe(true)

  await page.getByRole('button', { name: new RegExp(REAL_STACK_SHARED_DISPLAY_NAME, 'u') }).first().click()
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible()
  // The UI clears local state synchronously while the DELETE /api/v1/session
  // response (whose Set-Cookie clears the session cookie) is still in
  // flight — poll until the cookie is actually gone.
  await expect.poll(async () => sessionCookieValue(page), { timeout: 10_000 }).toBeNull()
  const after = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return response.json() as Promise<{ authenticated: boolean }>
  })
  expect(after.authenticated).toBe(false)
  // The revoked session leaves no live BA session and its product metadata
  // row is FK-cascade removed with the BA session row (auth_session_id ON
  // DELETE CASCADE — BA signOut deletes the row, so the revoked fact is not
  // retained after a clean sign-out). The account may carry live sessions
  // from earlier specs on the shared account, so the assertions are
  // relative: exactly THIS session (and its metadata row) must be gone.
  const revoked = await control<{ live_ba_sessions: number; metadata_total: number; revoked_metadata: number }>(
    '/auth/session-count', { accountId },
  )
  expect(revoked.live_ba_sessions).toBe(before.live_ba_sessions - 1)
  expect(revoked.metadata_total).toBe(before.metadata_total - 1)
  expect(revoked.revoked_metadata).toBe(before.revoked_metadata)

  await page.setViewportSize({ width: 375, height: 720 })
  await signInShared(page)
  const relogged = await control<{ live_ba_sessions: number }>('/auth/session-count', { accountId })
  expect(relogged.live_ba_sessions).toBeGreaterThanOrEqual(1)
  await assertAuthenticated(page)
})

test('sign-in negatives stay non-enumerating and CSRF/Origin/legacy/OAuth surfaces fail closed', async ({ page }) => {
  // Wrong password and unknown email share the identical copy.
  await page.goto('/login')
  await page.locator('#login-email').fill(REAL_STACK_SHARED_EMAIL)
  await page.locator('#login-password').fill('definitely-not-the-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const credentialError = page.getByRole('alert')
  await expect(credentialError).toBeVisible()
  await expect(credentialError).toContainText('Incorrect email or password.')
  await expect(credentialError).toHaveClass(/toast--error/)
  await expect(page.locator('#login-server-error')).toHaveCount(0)
  await expect(page.locator('.auth-card')).not.toContainText('Incorrect email or password.')
  expect(await sessionCookieValue(page)).toBeNull()

  await page.locator('#login-email').fill('nobody@example.test')
  await page.locator('#login-password').fill('whatever-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password.')
  expect(await sessionCookieValue(page)).toBeNull()

  // Legacy OIDC surface is absent in Better Auth mode (zero legacy routes).
  // /api/v1/auth/oidc/start goes through the vite proxy to the API (404);
  // /__test__/oidc/authorize is not an API path, so it must be queried
  // against the API origin directly (the vite dev server would answer the
  // SPA fallback with 200).
  const legacy = await page.evaluate(async (apiOrigin) => {
    const [start, authorize] = await Promise.all([
      fetch('/api/v1/auth/oidc/start'),
      fetch(`${apiOrigin}/__test__/oidc/authorize`),
    ])
    return { start: start.status, authorize: authorize.status }
  }, apiOrigin)
  expect(legacy.start).toBe(404)
  expect(legacy.authorize).toBe(404)

  // Production config negative: test-only flags must fail closed in production.
  const oidcRejected = await control<{ rejected: boolean; message: string }>(
    '/production-config/negative', { variant: 'oidc-test-provider' },
  )
  expect(oidcRejected.rejected).toBe(true)
  expect(oidcRejected.message).toContain('OIDC_ALLOW_TEST_PROVIDER')
  const mailboxRejected = await control<{ rejected: boolean; message: string }>(
    '/production-config/negative', { variant: 'auth-mailbox' },
  )
  expect(mailboxRejected.rejected).toBe(true)
  expect(mailboxRejected.message).toContain('KNOWN_AUTH_MAILBOX_HTTP')

  // OAuth fail-closed: no social provider is configured, so the OAuth start
  // surface is absent — BA answers 404 (empty or BA-style body). The 4xx
  // status is the contract; a JSON envelope, when present, must carry a
  // stable error code. The unauthenticated link route requires a session.
  const oauth = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/sign-in/oauth2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'google', callbackURL: '/library' }),
    })
    let parsed: unknown = null
    try { parsed = await response.json() } catch { /* non-JSON body */ }
    return { status: response.status, body: parsed }
  })
  expect(oauth.status).toBeGreaterThanOrEqual(400)
  expect(oauth.status).toBeLessThan(500)
  if (oauth.body !== null) {
    expect(typeof (oauth.body as { error?: { code?: string } }).error?.code).toBe('string')
  }
  const link = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/oauth2/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'google', callbackURL: '/settings' }),
    })
    return { status: response.status, body: await response.json() as { error?: { code?: string } } }
  })
  expect(link.status).toBe(401)
  expect(link.body.error?.code).toBe('authentication_required')
})

test('cross-origin sign-out is rejected (Origin admission) and the session survives', async ({ page, browser, request }) => {
  await signInShared(page)
  const cookieBefore = await sessionCookieValue(page)
  expect(cookieBefore).toMatch(/^[A-Za-z0-9]{32}\./u)
  const webOrigin = new URL(page.url()).origin

  // Cross-origin sign-out: a foreign browser (control-server origin
  // http://127.0.0.1:3311) sends the sign-out POST with Origin:
  // http://127.0.0.1:3311 and no same-site session cookie. A browser fetch
  // CORS-blocks the response before its status is observable (the API 403
  // carries no Access-Control-Allow-Origin for the foreign origin), so the
  // server-side Origin admission is asserted with a raw cross-origin POST
  // carrying the identical Origin header and no cookie — the API must
  // reject it 403 before the BA bridge.
  const foreign = request
  const cross = await foreign.post(`${webOrigin}/api/v1/auth/sign-out`, {
    headers: { origin: 'http://127.0.0.1:3311' },
  })
  expect(cross.status()).toBe(403)

  // Real cross-origin browser sanity: the same POST from a page on the
  // control-server origin is CORS-blocked in the renderer (the fetch
  // rejects), which is the browser-side consequence of the 403 admission.
  const foreignBrowser = await browser.newContext()
  try {
    const foreignPage = await foreignBrowser.newPage()
    await foreignPage.goto(`${controlUrl}/`)
    const rejected = await foreignPage.evaluate(async (target) => {
      try {
        await fetch(`${target}/api/v1/auth/sign-out`, { method: 'POST', credentials: 'include' })
        return false
      } catch {
        return true
      }
    }, webOrigin)
    expect(rejected).toBe(true)
  } finally {
    await foreignBrowser.close()
  }

  // The same-origin session is untouched and still authoritative.
  await assertAuthenticated(page)
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return response.json() as Promise<{ authenticated: boolean }>
  })
  expect(session.authenticated).toBe(true)
})
