import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function mockSignedOutLogin(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route('**/api/v1/auth/registration-state', (route) => json(route, { open: false, reason: 'closed' }))
  await page.route('**/api/v1/auth/sign-in/username', (route) => json(route, {
    error: {
      code: 'invalid_credentials',
      message: 'Invalid username or password',
      requestId: 'req-login-error',
      recovery: 'user_action',
      sameRequestRetrySafe: false,
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: null,
      fieldErrors: [],
    },
  }, 401))
}

test('a rejected sign-in shows one inline alert, keeps the username and refocuses the password', async ({ page }) => {
  await mockSignedOutLogin(page)
  await page.goto('/login')
  const card = page.locator('.auth-card')
  await expect(card).toBeVisible()

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByTestId('login-error')).toHaveText('Enter your username or email.')

  await page.locator('#login-identifier').fill('ada')
  await page.locator('#login-password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const alert = page.getByTestId('login-error')
  await expect(alert).toHaveText('Incorrect username or password.')
  await expect(alert).toHaveCount(1)
  await expect(card.getByRole('alert')).toHaveCount(1)
  await expect(page.locator('.toast--error')).toHaveCount(0)
  await expect(page.locator('#login-identifier')).toHaveValue('ada')
  await expect(page.locator('#login-password')).toBeFocused()

  await page.setViewportSize({ width: 375, height: 720 })
  await expect(alert).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
