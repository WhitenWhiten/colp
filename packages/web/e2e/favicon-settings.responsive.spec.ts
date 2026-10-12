import { expect, test } from '@playwright/test'
import { mockOwnerLibrary } from './helpers/library-mocks'

test('favicon settings use the shared form layout and persist missing-icon filling', async ({ page }) => {
  await mockOwnerLibrary(page)
  let fillMissing = false
  await page.route('**/api/v1/me/favicon-policy', async (route) => {
    if (route.request().method() === 'PATCH') {
      expect(route.request().headers()['if-match']).toBe('"favicon-policy:1"')
      expect(route.request().headers()['x-csrf-token']).toBeTruthy()
      fillMissing = route.request().postDataJSON().fillMissing
      await route.fulfill({ json: { policy: { revision: '2', newDefault: 'capture', providerTemplate: 'https://favicone.com/{hostname}', fillMissing, forceAllOnline: false }, jobId: '11111111-1111-4111-8111-111111111111' }, headers: { ETag: '"favicon-policy:2"' } })
    } else {
      await route.fulfill({ json: { revision: '1', newDefault: 'capture', providerTemplate: 'https://favicone.com/{hostname}', fillMissing, forceAllOnline: false }, headers: { ETag: '"favicon-policy:1"' } })
    }
  })
  await page.route('**/api/v1/me/favicon-jobs/*', (route) => route.fulfill({ json: { status: 'succeeded', succeeded: 1, total: 1, failed: 0, skipped: 0 } }))
  await page.goto('/library?settings=favicon')
  const section = page.getByTestId('settings-favicon')
  await expect(section.getByText('Default for new bookmarks')).toBeVisible()
  await expect(section.getByTestId('favicon-provider-template')).toBeVisible()
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await section.getByTestId('favicon-fill-missing').click()
  await expect.poll(() => fillMissing).toBe(true)
  await expect(section.getByTestId('favicon-fill-missing')).toBeChecked()
  await page.screenshot({ path: test.info().outputPath('favicon-settings.png'), fullPage: true })
})
