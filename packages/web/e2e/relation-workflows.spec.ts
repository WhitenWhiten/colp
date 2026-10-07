import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const collectionId = 'relation-e2e-collection'
const nodeId = 'medium'
const relationPath = `/api/v1/collections/${collectionId}/relations`
const nodes = [
  { id: nodeId, title: 'Current resource', position: 'a' },
  { id: 'same-a', title: 'Same title', position: 'b' },
  { id: 'same-b', title: 'Same title', position: 'c' },
]
const view = (overrides = {}) => ({ id: 'relation-1', collectionId, fromNodeId: nodeId, toNodeId: 'same-b', type: 'related', label: '<script>unsafe()</script>', visibility: 'private', revision: 'r1', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', extensions: {}, ...overrides })
function json(route: Route, body: unknown, status = 200) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }) }
function error(route: Route, status: number, code: string, recovery: string) { return json(route, { error: { code, message: code, requestId: 'relation-request', recovery, sameRequestRetrySafe: recovery === 'same_request', precondition: null, currentEtag: status === 412 ? '"r2"' : null, retryAfterSeconds: null, fieldErrors: [] } }, status) }
async function session(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, { authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-07-25T01:00:00.000Z', absoluteExpiresAt: '2026-07-26T00:00:00.000Z' }))
  await page.route('**/api/v1/me', (route) => json(route, { account: { id: 'a', email: 'e2e@test' }, profile: { id: 'p', handle: 'e2e', displayName: 'E2E', avatarUrl: null } }))
  await page.route(`**/api/v1/collections/${collectionId}/editor*`, (route) => json(route, { collection: { id: collectionId, title: 'Relations', kind: 'bookmarks', summary: '', visibility: 'private', rootNodeId: 'root', revision: 'c', etag: '"c"', contentRevision: 'cc', contentEtag: '"cc"', policyRevision: 'p', policyEtag: '"p"', createdAt: '', updatedAt: '' }, root: { id: 'root', kind: 'folder', folderRole: 'root', title: 'Root', description: null, tags: [], visibility: 'inherit', revision: 'rr', etag: '"rr"', childrenRevision: 'cr' }, nodes: nodes.map((node) => ({ ...node, kind: 'bookmark', url: `https://${node.id}.test`, description: null, tags: [], visibility: 'inherit', revision: node.id, etag: `"${node.id}"`, parentId: 'root', readOnly: false, readOnlyReason: null })), capabilities: { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true }, page: { snapshotId: 's', contentRevision: 'cc', policyRevision: 'p', comparatorVersion: 'v1', expiresAt: '', returnedCount: 3, hasMore: false, nextCursor: null } }))
  await page.route('**/api/v1/collections/*/annotations*', (route) => json(route, { annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }))
  await installPassiveFeatureMocks(page)
}
test.beforeEach(async ({ page }) => session(page))

test('uses node ids for duplicate titles, text rendering, keyboard navigation, and stable tree order', async ({ page }) => {
  await page.route(`**${relationPath}*`, (route) => {
    const incoming = new URL(route.request().url()).searchParams.get('direction') === 'incoming'
    const relations = incoming ? [view({ id: 'relation-in', fromNodeId: 'same-a', toNodeId: nodeId, label: 'Incoming edge' })] : [view()]
    return json(route, { relations, page: { returnedCount: 1, hasMore: false, nextCursor: null } })
  })
  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  await page.getByRole('button', { name: 'Add relation' }).click()
  const endpoint = page.getByLabel('Linked bookmark')
  await expect(endpoint.locator('option', { hasText: 'Same title' })).toHaveCount(2)
  await endpoint.selectOption('same-b'); await expect(endpoint).toHaveValue('same-b')
  await expect(page.getByText('<script>unsafe()</script>', { exact: true })).toBeVisible()
  await expect(page.locator('script', { hasText: 'unsafe' })).toHaveCount(0)
  await page.getByRole('link', { name: /Same title.*same-b/u }).focus(); await page.keyboard.press('Enter')
  const leavePrompt = page.getByRole('dialog')
  await expect(leavePrompt).toContainText('You have unsaved changes on this page.')
  await leavePrompt.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/r/${nodeId}\\?`, 'u'))
  await expect(endpoint).toHaveValue('same-b')
  await page.getByRole('link', { name: /Same title.*same-b/u }).focus(); await page.keyboard.press('Enter')
  await leavePrompt.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('/r/same-b', 'u'))
  expect(nodes.map((node) => node.position)).toEqual(['a', 'b', 'c'])
})

test('replays unknown result, refreshes stale revision, and starts a new command after reuse', async ({ page }) => {
  let relation = view(); let phase: 'unknown' | 'stale' | 'reuse' | 'ok' = 'unknown'; const commands: string[] = []
  await page.route(`**${relationPath}**`, async (route) => {
    const request = route.request(); const url = new URL(request.url())
    if (request.method() === 'GET') return json(route, { relations: url.searchParams.get('direction') === 'outgoing' ? [relation] : [], page: { returnedCount: url.searchParams.get('direction') === 'outgoing' ? 1 : 0, hasMore: false, nextCursor: null } })
    if (request.method() === 'PATCH') {
      commands.push(request.headers()['known-command-id'] ?? '')
      if (phase === 'unknown') { phase = 'stale'; return route.abort('connectionreset') }
      if (phase === 'stale') { phase = 'reuse'; relation = view({ revision: 'r2' }); return error(route, 412, 'precondition_failed', 'refresh_and_retry') }
      if (phase === 'reuse') { phase = 'ok'; return error(route, 409, 'command_id_reused', 'user_action') }
      relation = view({ revision: 'r3', label: 'Recovered' }); return json(route, relation)
    }
    return route.fallback()
  })
  await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  await page.getByRole('button', { name: 'Edit relation' }).click(); await page.getByLabel('Relation label', { exact: true }).fill('Recovered')
  const status = page.locator('[data-relation-state]')
  await page.getByRole('button', { name: 'Save relation' }).click(); await expect(status).toContainText('The relation may not have been saved')
  await page.getByRole('button', { name: 'Retry save' }).click(); await expect(status).toContainText('changed on the server')
  await page.getByRole('button', { name: 'Save relation' }).click(); await expect(status).toContainText('conflicts with an earlier request')
  await page.getByRole('button', { name: 'Start new change' }).click(); await expect(status).toContainText('Relation saved')
  expect(commands[1]).toBe(commands[0]); expect(commands[2]).not.toBe(commands[1]); expect(commands[3]).not.toBe(commands[2])
})

test('captures desktop and narrow Relation layouts without horizontal overflow', async ({ page }, testInfo) => {
  await page.route(`**${relationPath}*`, (route) => {
    const relations = new URL(route.request().url()).searchParams.get('direction') === 'outgoing' ? [view()] : []
    return json(route, { relations, page: { returnedCount: relations.length, hasMore: false, nextCursor: null } })
  })
  for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'narrow', width: 375, height: 720 }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    await expect(page.getByTestId('relation-workspace')).toBeVisible()
    const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client)
    const path = testInfo.outputPath(`relation-resource-detail-${viewport.name}.png`)
    await page.screenshot({ path, fullPage: true })
    await testInfo.attach(`relation-resource-detail-${viewport.name}`, { path, contentType: 'image/png' })
  }
})

test.describe('375px Relation workspace', () => {
  test.use({ viewport: { width: 375, height: 720 } })
  test('keeps labels, controls, focus restoration and navigation prompt operable', async ({ page }) => {
    await page.route(`**${relationPath}*`, (route) => {
      const relations = new URL(route.request().url()).searchParams.get('direction') === 'outgoing' ? [view()] : []
      return json(route, { relations, page: { returnedCount: relations.length, hasMore: false, nextCursor: null } })
    })
    await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    const edit = page.getByRole('button', { name: 'Edit relation' }); await edit.click(); await page.getByLabel('Relation label', { exact: true }).fill('Unsaved label')
    await expect.poll(() => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })).toBe(true)
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Relations' }).click()
    const prompt = page.getByRole('dialog')
    await expect(prompt).toContainText('You have unsaved changes on this page.')
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel relation edit' }).click(); await expect(edit).toBeFocused()
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    expect(width.scroll).toBeLessThanOrEqual(width.client)
  })
})
