import type { Route } from '@playwright/test'
import { expect, test } from './fixtures'

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
}

/* R15-34: a link inside running text is marked by more than colour or
   position (1.4.1); classed links keep their own treatment. */
test('prose links are underlined; classed links are not', async ({ page }) => {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: false }))
  await page.route('**/health', (route) => json(route, { status: 'ok', version: { server: '0.1.0', colp: '0.1.2', protocols: ['0.1'] } }))
  // About lists the changelog as a bare link in a list item (running text).
  // The first-run note on /login used to be the sample; it is a button now.
  await page.goto('/about')
  const changelog = page.getByTestId('self-hosted-about').locator('a[href="/CHANGELOG.md"]:not([class])')
  await expect(changelog).toBeVisible()
  await expect(changelog).toHaveCSS('text-decoration-line', 'underline')
  const setup = page.getByRole('link', { name: 'Connect an agent' })
  await expect(setup).toHaveCSS('text-decoration-line', 'underline')
  const brand = page.getByRole('link', { name: 'COLP Server home' })
  await expect(brand).toHaveCSS('text-decoration-line', 'none')
})
