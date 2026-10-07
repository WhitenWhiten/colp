import { expect, type Page } from '@playwright/test'

/**
 * Task E3 shared real-stack auth bootstrap.
 *
 * The harness pre-seeds ONE shared account through the REAL Better Auth
 * sign-up endpoint (KNOWN_REAL_STACK_SHARED_EMAIL/PASSWORD/DISPLAY_NAME);
 * every product spec signs in with this shell. 假阳性防护: each successful
 * login asserts the signed session cookie (name/HttpOnly/SameSite/Secure +
 * `token.signature` shape), the product /api/v1/session bootstrap (auth +
 * CSRF) and the /api/v1/me mapped account — a URL redirect alone never
 * counts as a pass. The session cookie is `__Host-known_session` (Secure on
 * the http://localhost origin works through the browser's localhost secure
 * context; the backend sets Secure explicitly via defaultCookieAttributes).
 */
const sharedEmail = process.env.KNOWN_REAL_STACK_SHARED_EMAIL
const sharedPassword = process.env.KNOWN_REAL_STACK_SHARED_PASSWORD
const sharedDisplayName = process.env.KNOWN_REAL_STACK_SHARED_DISPLAY_NAME
if (!sharedEmail || !sharedPassword || !sharedDisplayName) {
  throw new Error('real-stack shared auth credentials are required (KNOWN_REAL_STACK_SHARED_*)')
}

export const REAL_STACK_SHARED_EMAIL = sharedEmail
export const REAL_STACK_SHARED_PASSWORD = sharedPassword
export const REAL_STACK_SHARED_DISPLAY_NAME = sharedDisplayName

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * The browser stores the BA signed cookie value percent-encoded (BA and the
 * product transport both encode on Set-Cookie; server-side parsers decode).
 * Decode before shape assertions so `+`/`=` in the base64 signature are
 * compared against the raw signed value.
 */
function decodeSessionCookieValue(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Password sign-in with the shared account, then assert cookie + session +
 * me (the fake-positive gate shared by every product spec).
 */
export async function signInShared(page: Page, returnTo = '/library/new'): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`)
  await page.locator('#login-email').fill(REAL_STACK_SHARED_EMAIL)
  await page.locator('#login-password').fill(REAL_STACK_SHARED_PASSWORD)
  // Submit the form with Enter: the submit button may sit below the fold on
  // small viewports where Playwright's click hit-test cannot reach it.
  await page.locator('#login-password').press('Enter')
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(returnTo)}$`, 'u'))
  await assertAuthenticated(page)
}

/** Assert the signed BA session cookie + product session bootstrap + me mapping. */
export async function assertAuthenticated(page: Page): Promise<void> {
  const cookies = await page.context().cookies()
  const session = cookies.find((cookie) => cookie.name === '__Host-known_session')
  expect(session, '__Host-known_session must exist after login').toBeDefined()
  expect(session!.httpOnly).toBe(true)
  expect(session!.secure).toBe(true)
  expect(session!.sameSite).toBe('Lax')
  // BA signed cookie value: <32-char token>.<base64 HMAC-SHA256 signature>.
  // The stored value is percent-encoded; decode before the shape check.
  expect(decodeSessionCookieValue(session!.value)).toMatch(/^[A-Za-z0-9]{32}\.[A-Za-z0-9+/=]+$/u)
  const boot = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return {
      status: response.status,
      body: await response.json() as { authenticated?: boolean; csrfToken?: string },
    }
  })
  expect(boot.status).toBe(200)
  expect(boot.body.authenticated).toBe(true)
  expect(typeof boot.body.csrfToken).toBe('string')
  const me = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    return {
      status: response.status,
      body: await response.json() as { account?: { id?: string } },
    }
  })
  expect(me.status).toBe(200)
  expect(typeof me.body.account?.id).toBe('string')
}

/** Read the signed session cookie value for the current origin (null when absent). */
export async function sessionCookieValue(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies()
  const value = cookies.find((cookie) => cookie.name === '__Host-known_session')?.value ?? null
  return value === null ? null : decodeSessionCookieValue(value)
}
