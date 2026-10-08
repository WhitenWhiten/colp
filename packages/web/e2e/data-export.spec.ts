import { readFile } from 'node:fs/promises'
import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const json = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json',
  headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': 'export-e2e' },
  body: JSON.stringify(body),
})
const job = { jobId: 'export-e2e', createdAt: '2026-09-20T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' }
const document = { exportedAt: '2026-09-20T00:00:00.000Z', collections: [{
  id: 'collection-1', title: 'Private reading 私人', visibility: 'private', publicationSlug: null,
  nodes: [
    { id: 'root', parentId: null, kind: 'folder', isRoot: true, title: 'Reading', visibility: 'inherit' },
    { id: 'bookmark', parentId: 'root', kind: 'bookmark', isRoot: false, title: 'Example',
      url: 'https://example.com/', description: 'My saved link', tags: ['reading'], visibility: 'inherit' },
  ],
}] }

async function setup(page: Page, failJob = false) {
  await installPassiveFeatureMocks(page)
  await page.addInitScript(() => { window.__KNOWN_FLAGS__ = { exportJobs: true } })
  await page.route('**/api/v1/session', route => json(route, {
    authenticated: true, csrfToken: 'export-csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z',
  }))
  await page.route('**/api/v1/me', route => json(route, {
    account: { id: 'owner', email: null }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null },
  }))
  let created = false
  let polls = 0
  await page.route('**/api/v1/me/export-jobs', route => {
    if (route.request().method() === 'POST') {
      created = true
      return json(route, { ...job, status: 'pending' }, 201)
    }
    if (!created) return json(route, { items: [] })
    const status = ++polls === 1 ? 'running' : failJob ? 'failed' : 'ready'
    return json(route, { items: [{ ...job, status, ...(status === 'failed' ? { errorClass: 'internal' } : {}) }] })
  })
  await page.route('**/api/v1/me/export-jobs/export-e2e/download', route => json(route, document))
}

for (const [format, extension] of [['JSON', 'json'], ['Markdown', 'md'], ['HTML', 'html']] as const) {
  test(`creates an export and downloads a real ${format} file automatically`, async ({ page }) => {
    await setup(page)
    await page.goto('/export')
    await page.getByRole('radio', { name: new RegExp(`^${format}`) }).click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Create export' }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(`known-library-export-e2e.${extension}`)
    expect(await download.failure()).toBeNull()
    const content = await readFile((await download.path())!, 'utf8')
    expect(content).toContain('Private reading 私人')
    expect(content).toContain('https://example.com/')
    if (format === 'JSON') expect(JSON.parse(content)).toEqual(document)
    if (format === 'Markdown') expect(content).toContain('[Example](<https://example.com/>)')
    if (format === 'HTML') expect(content).toContain('<!doctype html>')
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible()
  })
}

test('shows an error toast when the asynchronous job fails', async ({ page }) => {
  await setup(page, true)
  await page.goto('/export')
  await page.getByRole('button', { name: 'Create export' }).click()
  await expect(page.getByText('Your export failed. Please create a new export.')).toBeVisible()
  await expect(page.getByTestId('export-history')).toContainText('Failed')
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create export' })).toBeEnabled()
})
