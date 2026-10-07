import { expect, test, type Page } from '@playwright/test'
import { assertAuthenticated } from './auth-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
if (!controlUrl || !controlToken) throw new Error('real-stack control endpoints are required')

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

async function registerAccount(page: Page, email: string, password: string, name: string): Promise<void> {
  await page.goto('/register')
  await page.locator('#register-name').fill(name)
  await page.locator('#register-email').fill(email)
  await page.locator('#register-password').fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
}

async function verifyRegisteredAccount(page: Page, email: string): Promise<void> {
  const mail = await control<{ found: boolean; entry: { url: string | null } | null }>(
    '/auth-mailbox/last', { email, purpose: 'email-verification' },
  )
  expect(mail.found).toBe(true)
  expect(mail.entry?.url).toBeTruthy()
  const token = mail.entry!.url!.match(/token=([A-Za-z0-9._~-]+)/u)?.[1]
  expect(token).toBeTruthy()
  const status = await page.evaluate(async (verificationToken) => {
    const response = await fetch(`/api/v1/auth/verify-email?token=${encodeURIComponent(verificationToken)}`)
    return response.status
  }, token!)
  expect(status).toBe(200)
  await page.goto('/verify-email?verified=1')
  await expect(page.getByRole('heading', { name: 'Congratulations' })).toBeVisible()
  await assertAuthenticated(page)
}

async function postJson(page: Page, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(async ({ path: url, body: payload }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    let parsed: unknown = null
    try { parsed = await response.json() } catch { /* non-JSON body */ }
    return { status: response.status, body: parsed }
  }, { path, body })
}

function envelope(body: unknown): { code?: string } {
  const record = body as { error?: { code?: string } }
  return record?.error ?? {}
}

test('password-reset request is non-enumerating and the reset mail token stays digest-only', async ({ page }) => {
  const email = `e3-recovery-${Date.now().toString(36)}@example.test`
  await registerAccount(page, email, 'e3-recovery-password-1', 'E3 Recovery User')

  const known = await postJson(page, '/api/v1/auth/recovery/password-reset', { email })
  expect(known.status).toBe(200)
  expect(known.body).toEqual({ status: true })

  const mail = await control<{ found: boolean; entry: { purpose: string; url: string | null } | null }>(
    '/auth-mailbox/last', { email, purpose: 'password-reset' },
  )
  expect(mail.found).toBe(true)
  expect(mail.entry?.purpose).toBe('password-reset')
  // BA 1.6.29 reset links embed the token as a PATH segment
  // (`${baseURL}/reset-password/<token>?callbackURL=...`), unlike the
  // verification link which carries `token=` as a query parameter.
  const token = mail.entry?.url?.match(/\/reset-password\/([A-Za-z0-9._~-]+)/u)?.[1]
  expect(token).toBeTruthy()
  const digest = await control<{ plaintextMatches: number }>('/auth/assert-verification-digest', { token })
  expect(digest.plaintextMatches).toBe(0)

  const ghostEmail = `ghost-${Date.now().toString(36)}@example.test`
  const ghost = await postJson(page, '/api/v1/auth/recovery/password-reset', {
    email: ghostEmail,
  })
  expect(ghost.status).toBe(200)
  expect(ghost.body).toEqual({ status: true })
  const ghostMail = await control<{ found: boolean }>('/auth-mailbox/last', {
    email: ghostEmail,
  })
  expect(ghostMail.found).toBe(false)
})

test('verified-email OTP reset: wrong OTP is rejected, the real code resets the password and revokes old sessions', async ({ page }) => {
  const email = `e3-otp-reset-${Date.now().toString(36)}@example.test`
  const oldPassword = 'e3-old-password-1'
  const newPassword = 'e3-new-password-1'
  await registerAccount(page, email, oldPassword, 'E3 OTP Reset User')
  await verifyRegisteredAccount(page, email)
  const accountId = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    if (!response.ok) throw new Error(`me read failed: ${response.status}`)
    const body = await response.json() as { account: { id: string } }
    return body.account.id
  })

  // The OTP is issued through the REAL better-auth emailOTP plugin and read
  // from the mailbox sink (never guessed).
  const issued = await control<{ sent: boolean; entry: { otp: string; type: string; expiresAt: string } }>(
    '/auth-mailbox/send-otp', { email, type: 'forget-password' },
  )
  expect(issued.sent).toBe(true)
  expect(issued.entry.type).toBe('forget-password')
  expect(issued.entry.otp).toMatch(/^\d{6}$/u)

  // Wrong OTP: stable non-enumerating envelope, nothing changes.
  const wrongOtp = issued.entry.otp === '000000' ? '000001' : '000000'
  const wrong = await postJson(page, '/api/v1/auth/recovery/otp-reset', {
    email, otp: wrongOtp, newPassword,
  })
  expect(wrong.status).toBe(401)
  expect(envelope(wrong.body).code).toBe('invalid_credentials')

  // Correct OTP: password reset + verified-email proof + session revocation.
  const reset = await postJson(page, '/api/v1/auth/recovery/otp-reset', {
    email, otp: issued.entry.otp, newPassword,
  })
  expect(reset.status).toBe(200)
  expect(reset.body).toEqual({ status: true })

  // The OTP row is consumed (digest-only single use) and the OTP proof
  // marked the email verified on the auth user.
  const rows = await control<{ rows: number }>('/auth/otp-row-count', { email, type: 'forget-password' })
  expect(rows.rows).toBe(0)

  // The registration session was revoked by the reset (no new session issued).
  const sessions = await control<{ live_ba_sessions: number }>('/auth/session-count', { accountId })
  expect(sessions.live_ba_sessions).toBe(0)

  // Old password is dead; the new one signs in over the real Login page.
  await page.goto('/login')
  await page.locator('#login-email').fill(email)
  await page.locator('#login-password').fill(oldPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const credentialError = page.getByRole('alert')
  await expect(credentialError).toBeVisible()
  await expect(credentialError).toContainText('Incorrect email or password.')
  await expect(credentialError).toHaveClass(/toast--error/)
  await expect(page.locator('.auth-card')).not.toContainText('Incorrect email or password.')

  await page.locator('#login-password').fill(newPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(/\/library$/u)
  await assertAuthenticated(page)
})

test('expired OTP can no longer reset the password', async ({ page, browser }) => {
  const email = `e3-otp-expiry-${Date.now().toString(36)}@example.test`
  const password = 'e3-expiry-password-1'
  await registerAccount(page, email, password, 'E3 OTP Expiry User')
  await verifyRegisteredAccount(page, email)

  const issued = await control<{ sent: boolean; entry: { otp: string; expiresAt: string } }>(
    '/auth-mailbox/send-otp', { email, type: 'forget-password' },
  )
  expect(issued.sent).toBe(true)

  // Wait past the 60s OTP TTL (expiresAt from the mailbox entry + margin).
  const expiresAt = new Date(issued.entry.expiresAt).getTime()
  await expect.poll(async () => Date.now() > expiresAt + 5_000, { timeout: 90_000 }).toBe(true)

  const expired = await postJson(page, '/api/v1/auth/recovery/otp-reset', {
    email, otp: issued.entry.otp, newPassword: 'e3-should-not-apply-1',
  })
  expect(expired.status).toBe(401)
  expect(envelope(expired.body).code).toBe('invalid_credentials')

  // The old password still works: the expired code changed nothing. A fresh
  // context avoids the surviving registration session (nothing was revoked).
  const fresh = await browser.newContext()
  try {
    const freshPage = await fresh.newPage()
    await freshPage.goto('/login')
    await freshPage.locator('#login-email').fill(email)
    await freshPage.locator('#login-password').fill(password)
    await freshPage.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(freshPage).toHaveURL(/\/library$/u)
    await assertAuthenticated(freshPage)
  } finally {
    await fresh.close()
  }
})
