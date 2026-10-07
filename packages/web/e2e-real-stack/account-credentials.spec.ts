import { expect, test } from '@playwright/test'
import { signInShared } from './auth-bootstrap'

test('ordinary accounts cannot discover or manage official bot credentials', async ({ page }) => {
  await signInShared(page, '/library?settings=credentials')
  for (const section of ['credentials', 'grants']) {
    await page.goto(`/library?settings=${section}`)
    await expect(page.locator('[data-settings-nav] [aria-current="true"]')).toHaveText('Profile')
    await expect(page.getByRole('button', { name: 'Credentials', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Grants', exact: true })).toHaveCount(0)
  }
  const statuses = await page.evaluate(async () => Promise.all([
    ['/api/v1/me/credential-parents', 'POST'], ['/api/v1/me/credentials', 'GET'],
    ['/api/v1/me/credential-grants', 'GET'], ['/api/v1/auth/credential-children', 'GET'],
  ].map(async ([url, method]) => (await fetch(url!, { method, credentials: 'include' })).status)))
  expect(statuses).toEqual([404, 404, 404, 404])
})
