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
  await page.route('**/api/v1/auth/sign-in/email', (route) => json(route, {
    error: {
      code: 'invalid_credentials',
      message: 'Invalid email or password',
      requestId: 'req-login-toast',
      recovery: 'user_action',
      sameRequestRetrySafe: false,
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: null,
      fieldErrors: [],
    },
  }, 401))
}

test('server sign-in failures toast and leave the login card height alone', async ({ page }) => {
  await mockSignedOutLogin(page)
  await page.goto('/login')
  const card = page.locator('.auth-card')
  await expect(card).toBeVisible()

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('#login-email-error')).toHaveText('Enter your email.')
  await expect(page.locator('.toast--error')).toHaveCount(0)

  await page.locator('#login-email').fill('ada@example.com')
  await page.locator('#login-password').fill('wrong-password')
  await expect(page.locator('#login-email-error')).toHaveCount(0)
  const filled = (await card.boundingBox())!.height

  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const toast = page.getByRole('alert')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('Incorrect email or password.')
  await expect(toast).toHaveClass(/toast--error/)
  await expect(toast.locator('.toast-icon [data-icon="alert"]')).toBeVisible()
  await expect(toast.getByRole('button', { name: 'Dismiss notification' }).locator('[data-icon="cross"]')).toBeVisible()
  await expect(card).not.toContainText('Incorrect email or password.')
  await expect(page.locator('#login-server-error')).toHaveCount(0)
  expect(Math.abs((await card.boundingBox())!.height - filled)).toBeLessThanOrEqual(2)

  await expect(page.locator('.toast--error')).toHaveCount(0, { timeout: 15_000 })

  await page.setViewportSize({ width: 375, height: 720 })
  const mobileBefore = (await card.boundingBox())!.height
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.locator('.toast--error')).toBeVisible()
  await expect(page.locator('.toast--error')).toContainText('Incorrect email or password.')
  await expect(card).not.toContainText('Incorrect email or password.')
  expect(Math.abs((await card.boundingBox())!.height - mobileBefore)).toBeLessThanOrEqual(2)
})
