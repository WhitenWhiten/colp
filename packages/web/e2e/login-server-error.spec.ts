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

test('server sign-in failures toast, mark both fields and leave the card height alone', async ({ page }) => {
  await mockSignedOutLogin(page)
  await page.goto('/login')
  const card = page.locator('.auth-card')
  await expect(card).toBeVisible()

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('#login-identifier-error')).toHaveText('Enter your username or email.')
  await expect(page.locator('#login-password-error')).toHaveText('Enter your password.')
  await expect(page.locator('.toast--error')).toHaveCount(0)

  await page.locator('#login-identifier').fill('ada')
  await page.locator('#login-password').fill('wrong-password')
  await expect(page.locator('#login-identifier-error')).toHaveCount(0)
  const filled = (await card.boundingBox())!.height

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const toast = page.locator('.toast--error')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Incorrect username or password.')
  await expect(toast.locator('.toast-icon [data-icon="alert"]')).toBeVisible()
  await expect(card).not.toContainText('Incorrect username or password.')
  await expect(card.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('#login-identifier')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#login-password')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#login-identifier')).toHaveValue('ada')
  await expect(page.locator('#login-password')).toBeFocused()
  expect(Math.abs((await card.boundingBox())!.height - filled)).toBeLessThanOrEqual(2)

  await page.setViewportSize({ width: 375, height: 720 })
  const mobileBefore = (await card.boundingBox())!.height
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.toast--error')).toContainText('Incorrect username or password.')
  expect(Math.abs((await card.boundingBox())!.height - mobileBefore)).toBeLessThanOrEqual(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('the password reset help opens with the typed username in a copyable command', async ({ page }) => {
  await mockSignedOutLogin(page)
  await page.goto('/login')
  await page.locator('#login-identifier').fill('ada')
  await page.getByText('Forgot your password?').click()
  const command = page.getByTestId('login-reset-hint').getByTestId('command-block')
  await expect(command).toBeVisible()
  await expect(command.locator('code')).toHaveText('docker compose exec server colp-server reset-password --username ada')
  await expect(command.getByRole('button', { name: 'Copy password reset command' })).toBeVisible()
})
