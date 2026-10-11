import type { Route } from '@playwright/test'
import { expect, test } from './fixtures'

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

/* R15-34: a link inside running text is marked by more than colour or
   position (1.4.1); classed links keep their own treatment. */
test('prose links are underlined; classed links are not', async ({ page }) => {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  // A server with no owner yet points sign-in at first-run setup in a sentence.
  await page.route('**/api/v1/auth/registration-state', (route) => json(route, { open: true, reason: 'first-run' }))
  await page.goto('/login')
  const setup = page.getByTestId('login-owner-missing').locator('a[href="/register"]:not([class])')
  await expect(setup).toBeVisible()
  await expect(setup).toHaveCSS('text-decoration-line', 'underline')
  const brand = page.getByRole('link', { name: 'COLP Server home' })
  await expect(brand).toHaveCSS('text-decoration-line', 'none')
})
