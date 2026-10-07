import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

/* R15-34: a link inside running text is marked by more than colour or
   position (1.4.1); classed links keep their own treatment. */
test('prose links are underlined; button links are not', async ({ page }) => {
  await installPassiveFeatureMocks(page)
  await page.route('**/api/v1/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: false }),
  }))
  await page.goto('/contact')
  // The help@ address inside the contact text (not the "Email help@" button).
  const help = page.locator('main a[href^="mailto:help@"]:not([class])').first()
  await expect(help).toBeVisible()
  await expect(help).toHaveCSS('text-decoration-line', 'underline')
  const button = page.locator('main a.btn').first()
  if (await button.count()) await expect(button).toHaveCSS('text-decoration-line', 'none')
})
