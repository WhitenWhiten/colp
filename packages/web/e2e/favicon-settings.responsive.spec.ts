import { expect, test } from './fixtures'
import { mockOwnerLibrary } from './helpers/library-mocks'

test('favicon settings use the shared form layout and persist missing-icon filling', async ({ page }) => {
  await mockOwnerLibrary(page)
  await page.route('**/.well-known/collection-protocol', route => route.fulfill({ status: 404, json: {} }))
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
  await expect(page.getByText('No collections yet', { exact: true })).toBeVisible()
  await section.getByTestId('favicon-provider-template').fill('https://draft.example/{hostname}')
  await page.getByRole('button', { name: 'Close settings' }).click()
  const guard = page.getByRole('dialog', { name: 'Discard changes?' })
  await expect(guard).toBeVisible()
  await guard.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(section.getByTestId('favicon-provider-template')).toHaveValue('https://draft.example/{hostname}')
})
