import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'
import { installClassificationCreditMocks } from './helpers/classification-credit-mocks'
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const problem = (code: string, recovery: string) => ({ error: { code, message: code, requestId: 'classification-browser', recovery,
  sameRequestRetrySafe: recovery === 'same_request', precondition: null, currentEtag: null, retryAfterSeconds: null, fieldErrors: [] } })
const preview = { contractVersion: '1.0.0', collectionId: 'library', source: { kind: 'node', nodeId: 'bookmark' }, taxonomyRevision: 'c1',
  folder: { decision: 'l1_root', folderId: 'folder', parentFolderId: null, l1FolderId: 'folder', depth: 1, confidence: 0.83, l1Confidence: 0.83, l2Specificity: null, probabilities: [] },
  candidateCoverage: { policyVersion: 'candidates.v1', l1Total: 40, l1Included: 32, descendantTotal: 80, descendantIncluded: 64, tagTotal: 1, tagIncluded: 1 },
  tags: { mode: 'suggest', maxAutoTags: 3, candidates: [{ tag: 'AI', noul: 0.9, selected: true }] },
  provider: { providerId: 'cloudflare_jev', model: 'typesafe/jev', policyVersion: 'classification.v2', promptVersion: 'l1-description-c-v2' } }
async function setup(page: Page) {
  await installPassiveFeatureMocks(page)
  await installClassificationCreditMocks(page)
  await page.route('**/api/v1/me/community-notifications?*', route => json(route, { items: [], nextCursor: null, unreadCount: 0 }))
  await page.addInitScript(() => { window.__KNOWN_FLAGS__ = { classification: true } })
  await page.route('**/api/v1/session', route => json(route, { authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' }))
  await page.route('**/api/v1/me', route => json(route, { account: { id: 'owner', email: null }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } }))
  await page.route('**/api/v1/me/classify-inbox?*', route => json(route, { items: [{ nodeId: 'bookmark', collectionId: 'library', collectionTitle: 'Library', title: 'Browser review bookmark',
    url: 'https://example.org', host: 'example.org', etag: '"r1"', createdAt: '2026-09-19T00:00:00Z', suggestions: [] }], nextCursor: null }))
  await page.route('**/api/v1/collections/library/editor?*', route => json(route, { collection: { id: 'library' }, root: { id: 'root' },
    nodes: [{ id: 'folder', kind: 'folder', title: 'Technology', parentId: 'root' }], capabilities: {}, page: { hasMore: false, nextCursor: null } }))
}
test('browser reviews candidates and adds tags without moving the inbox item', async ({ page }, testInfo) => {
  await setup(page); let previews = 0; const confirmations: unknown[] = []
  await page.route('**/api/v1/collections/library/classification/preview', route => {
    previews++
    expect(route.request().postDataJSON().billing).toEqual({ priceVersion: 'bookmark-classify.v1', maxPoints: 1 })
    return json(route, preview)
  })
  await page.route('**/api/v1/collections/library/nodes/bookmark/classification-confirmations', route => {
    confirmations.push(route.request().postDataJSON())
    expect(route.request().headers()['if-match']).toBe('"r1"')
    expect(route.request().headers()['x-csrf-token']).toBe('csrf')
    expect(route.request().headers()['known-command-id']).toMatch(/^[a-f0-9-]{36}$/)
    return json(route, { nodeId: 'bookmark', etag: '"r2"', parentId: 'root', tags: ['AI'], operationIds: ['operation'] })
  })
  await page.goto('/classify')
  await expect(page.getByLabel('Choose any existing folder')).toBeEnabled()
  expect(previews).toBe(0)
  await page.getByRole('checkbox', { name: /I agree to spend/ }).check()
  await page.getByRole('button', { name: 'Suggest a folder', exact: true }).click()
  await expect(page.getByText(/Candidates considered: 32\/40/)).toBeVisible()
  await expect(page.getByText('Model score: 83%')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /AI/ })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('classification-review.png'), fullPage: true })
  await page.getByRole('button', { name: 'Add 1 selected tag only' }).click()
  await expect(page.getByRole('button', { name: 'Suggest a folder', exact: true })).toBeVisible()
  expect(confirmations).toEqual([{ folderId: null, addTags: ['AI'] }])
  await expect(page.getByRole('heading', { name: 'Browser review bookmark' })).toBeVisible()
})
test('unknown provider outcome checks the same command and billing consent in the browser', async ({ page }) => {
  await setup(page); const commands: string[] = []
  const bodies: unknown[] = []
  await page.route('**/api/v1/collections/library/classification/preview', route => {
    commands.push(route.request().headers()['known-command-id'])
    bodies.push(route.request().postDataJSON())
    return commands.length === 1 ? json(route, problem('feature_temporarily_unavailable', 'user_action'), 503) : json(route, preview)
  })
  await page.goto('/classify')
  await page.getByRole('checkbox', { name: /I agree to spend/ }).check()
  await page.getByRole('button', { name: 'Suggest a folder', exact: true }).click()
  await expect(page.getByText('The request may not have completed. Check the result before starting another classification.')).toBeVisible()
  expect(commands).toHaveLength(1)
  await page.getByRole('button', { name: 'Check existing request', exact: true }).click()
  await expect(page.getByText('Model score: 83%')).toBeVisible()
  expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0]); expect(bodies[1]).toEqual(bodies[0])
})
