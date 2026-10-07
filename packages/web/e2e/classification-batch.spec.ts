import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'
import { installClassificationCreditMocks } from './helpers/classification-credit-mocks'
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
const provider = { providerId: 'fixture', model: 'fixture', policyVersion: 'v1', promptVersion: 'v1' }
const decision = (nodeId: string) => ({ contractVersion: '1.0.0', collectionId: 'library', source: { kind: 'node', nodeId }, taxonomyRevision: 'c1', provider,
  folder: { decision: 'l1_root', folderId: 'folder', parentFolderId: null, l1FolderId: 'folder', depth: 1, confidence: 0.9, l1Confidence: 0.9, l2Specificity: null, probabilities: [] },
  candidateCoverage: { policyVersion: 'v1', l1Total: 1, l1Included: 1, descendantTotal: 0, descendantIncluded: 0, tagTotal: 1, tagIncluded: 1 },
  tags: { mode: 'suggest', maxAutoTags: 3, candidates: [{ tag: 'AI', noul: 0.9, selected: true }] } })
function run(status: string, count = 50) {
  return { runId: 'run', etag: `"${status}"`, status, taxonomyRevision: 'c1', failureCode: null, provider,
    createdAt: '2026-09-19T00:00:00Z', deadlineAt: '2099-01-01T00:04:00Z', expiresAt: '2099-01-01T00:30:00Z',
    actions: Array.from({ length: count }, (_, i) => ({ actionId: `action-${i}`, nodeId: `node-${i}`, nodeEtag: '"n1"', sourceParentId: 'root',
      status: ['queued', 'running'].includes(status) ? 'pending' : 'succeeded', decision: ['queued', 'running'].includes(status) ? null : decision(`node-${i}`), failureCode: null })) }
}
async function setup(page: Page) {
  await installPassiveFeatureMocks(page)
  await installClassificationCreditMocks(page)
  await page.addInitScript(() => { window.__KNOWN_FLAGS__ = { classificationBatch: true } })
  await page.route('**/api/v1/me/community-notifications?*', route => json(route, { items: [], nextCursor: null, unreadCount: 0 }))
  await page.route('**/api/v1/session', route => json(route, { authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' }))
  await page.route('**/api/v1/me', route => json(route, { account: { id: 'owner', email: null }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } }))
  await page.route('**/api/v1/collections?*', route => json(route, { items: [{ collection: { id: 'library', title: 'Library' }, capabilities: {} }], page: { returnedCount: 1, hasMore: false, nextCursor: null } }))
  await page.route('**/api/v1/collections/library/editor?*', route => json(route, { collection: { id: 'library', rootNodeId: 'root', contentRevision: 'c1' }, root: { id: 'root' },
    nodes: [{ id: 'folder', kind: 'folder', title: 'Technology', parentId: 'root' }, ...Array.from({ length: 50 }, (_, i) => ({ id: `node-${i}`, kind: 'bookmark', title: `Bookmark ${i + 1}`, parentId: 'root' }))],
    capabilities: {}, page: { hasMore: false, nextCursor: null } }))
}
test('batch browser polls, resumes by runId and applies 50 selections in one request', async ({ page }, testInfo) => {
  await setup(page); let creates = 0, reads = 0, applied = false
  const requests: unknown[] = []
  await page.route('**/api/v1/collections/library/classification-runs', route => {
    creates++
    expect(route.request().postDataJSON().billing).toEqual({ priceVersion: 'bookmark-classify.v1', maxPoints: 50 })
    return json(route, run('queued'), 201)
  })
  await page.route('**/api/v1/collections/library/classification-runs/run', route => { reads++; return json(route, run(applied ? 'applied' : reads < 2 ? 'running' : 'open')) })
  await page.route('**/api/v1/collections/library/classification-runs/run/apply', route => {
    requests.push(route.request().postDataJSON()); applied = true
    expect(route.request().headers()['if-match']).toBe('"open"'); expect(route.request().headers()['x-csrf-token']).toBe('csrf')
    return json(route, { runId: 'run', status: 'applied', appliedNodeIds: [], receipts: [] })
  })
  await page.goto('/classify/batch?collectionId=library')
  await page.getByRole('checkbox', { name: /I agree to spend/ }).check()
  await expect(page.getByRole('button', { name: 'Start batch classification', exact: true })).toBeEnabled()
  expect(creates).toBe(0)
  await page.getByRole('button', { name: 'Start batch classification', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Apply 50 selected changes' })).toBeEnabled()
  expect(reads).toBeGreaterThanOrEqual(2); expect(creates).toBe(1)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Apply 50 selected changes' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('classification-batch-review.png') })
  await page.getByRole('button', { name: 'Apply 50 selected changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByText('Selected changes applied.')).toBeVisible()
  expect(requests).toHaveLength(1); expect((requests[0] as { selections: unknown[] }).selections).toHaveLength(50); expect(creates).toBe(1)
})
test('uncertain Apply survives refresh and resends only the same body, command and ETag', async ({ page }) => {
  await setup(page); let applied = false
  const requests: { command: string; etag: string; body: unknown }[] = []
  await page.route('**/api/v1/collections/library/classification-runs/run', route => json(route, run(applied ? 'applied' : 'open', 2)))
  await page.route('**/api/v1/collections/library/classification-runs/run/apply', route => {
    requests.push({ command: route.request().headers()['known-command-id'], etag: route.request().headers()['if-match'], body: route.request().postDataJSON() })
    if (requests.length === 1) return route.abort('failed')
    applied = true; return json(route, { runId: 'run', status: 'applied', appliedNodeIds: [], receipts: [] })
  })
  await page.goto('/classify/batch?collectionId=library&runId=run')
  await page.getByRole('button', { name: 'Apply 2 selected changes' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible()
  expect(requests).toHaveLength(1)
  await page.reload()
  await page.getByRole('button', { name: 'Check result' }).click()
  await expect(page.getByText('Selected changes applied.')).toBeVisible()
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0])
})
