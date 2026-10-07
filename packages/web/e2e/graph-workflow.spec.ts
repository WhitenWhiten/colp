import type { Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const collectionId = 'graph-collection'
const slug = 'graph-notes'
const nodes = [
  { id: 'a', title: 'Graph source', position: 'a' },
  { id: 'b', title: 'Graph evidence', position: 'b' },
  { id: 'c', title: 'Isolated resource', position: 'c' },
]
const initialRelation = { id: 'relation-1', collectionId, fromNodeId: 'a', toNodeId: 'b', type: 'supports', label: 'Evidence', visibility: 'public', revision: 'r1', createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', extensions: {} }
function json(route: Route, body: unknown, status = 200) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }) }

for (const width of [1280, 375]) {
  test(`graph create, edit, delete and return to selected node at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const endpointId = width === 375 ? 'root' : 'b'
    const endpointTitle = width === 375 ? 'Root' : 'Graph evidence'
    let relations: typeof initialRelation[] = []
    await page.route('**/api/v1/session', (route) => json(route, { authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-07-25T01:00:00.000Z', absoluteExpiresAt: '2099-07-26T00:00:00.000Z' }))
    await page.route('**/api/v1/me', (route) => json(route, { account: { id: 'a', email: 'graph@test' }, profile: { id: 'p', handle: 'graph', displayName: 'Graph', avatarUrl: null } }))
    await installPassiveFeatureMocks(page)
    await page.route('**/api/v1/me/community-notifications*', (route) => json(route, { items: [], nextCursor: null, unreadCount: 0 }))
    await page.route('**/api/v1/community/target*', (route) => json(route, { error: { code: 'resource_not_found', message: 'Unavailable', requestId: 'graph-test', recovery: 'none', sameRequestRetrySafe: false, fieldErrors: [] } }, 404))
    await page.route(`**/api/v1/collections/${slug}*`, (route) => json(route, {
      collection: { id: collectionId, slug, title: 'Graph notes', kind: 'knowledge_collection', rootNodeId: 'root', owner: { profileId: 'p', handle: 'graph', displayName: 'Graph', avatarUrl: null }, updatedAt: '2026-09-19T00:00:00.000Z', access: 'member' },
      nodes: [{ id: 'root', parentId: null, kind: 'root', title: 'Root', description: null, url: null, position: null }, ...nodes.map((node) => ({ ...node, kind: 'bookmark', parentId: 'root', description: null, url: `https://${node.id}.example` }))],
      relations, page: { sequence: 1, cursor: null, hasMore: false },
    }))
    await page.route(`**/api/v1/collections/${collectionId}/editor*`, (route) => json(route, {
      collection: { id: collectionId, title: 'Graph notes', kind: 'knowledge_collection', visibility: 'public', publicationSlug: slug, rootNodeId: 'root', revision: 'c', etag: '"c"', contentRevision: 'cc', contentEtag: '"cc"', policyRevision: 'p', policyEtag: '"p"', createdAt: '', updatedAt: '' },
      root: { id: 'root', kind: 'folder', folderRole: 'root', title: 'Root', description: null, tags: [], revision: 'rr', etag: '"rr"' },
      nodes: nodes.map((node) => ({ ...node, kind: 'bookmark', url: `https://${node.id}.example`, description: null, tags: [], visibility: 'inherit', revision: node.id, etag: `"${node.id}"`, parentId: 'root', readOnly: false, readOnlyReason: null })),
      capabilities: { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true },
      page: { snapshotId: 's', contentRevision: 'cc', policyRevision: 'p', comparatorVersion: 'v1', expiresAt: '', returnedCount: 3, hasMore: false, nextCursor: null },
    }))
    await page.route('**/api/v1/collections/*/annotations*', (route) => json(route, { annotations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null } }))
    await page.route(`**/api/v1/collections/${collectionId}/relations**`, (route) => {
      const request = route.request()
      const query = new URL(request.url()).searchParams
      if (request.method() === 'GET') {
        const items = relations.filter((relation) => query.get('direction') === 'incoming' ? relation.toNodeId === query.get('nodeId') : relation.fromNodeId === query.get('nodeId'))
        return json(route, { relations: items, page: { returnedCount: items.length, hasMore: false, nextCursor: null } })
      }
      if (request.method() === 'POST') {
        expect(request.headers()['known-command-id']).toBeTruthy()
        expect(request.postDataJSON()).toMatchObject({ fromNodeId: 'a', toNodeId: endpointId, type: 'supports', visibility: 'public' })
        relations = [{ ...initialRelation, ...request.postDataJSON() }]; return json(route, relations[0], 201) }
      if (request.method() === 'PATCH') {
        expect(request.headers()['if-match']).toBe('"r1"')
        expect(request.postDataJSON()).toMatchObject({ label: 'Updated evidence' })
        relations = [{ ...relations[0]!, ...request.postDataJSON(), revision: 'r2' }]; return json(route, relations[0]) }
      if (request.method() === 'DELETE') {
        expect(request.headers()['if-match']).toBe('"r2"')
        relations = []
        return json(route, { receipt: { resourceType: 'relation', targetId: 'relation-1', collectionId, scope: 'single', deletedAt: '2026-09-19T00:00:00.000Z', deleteRevision: 'r3', operationId: 'op', affectedCount: 1, purgeAfter: '2026-10-19T00:00:00.000Z' }, fence: { contentRevision: 'c3', policyRevision: 'p' } })
      }
      return route.fallback()
    })
    await page.goto(`/graph/${slug}?node=a`)
    await expect(page.getByText('No visible relations yet.', { exact: false })).toBeVisible()
    await expect(page.locator('[data-from]')).toHaveCount(0)
    await page.getByRole('link', { name: 'Manage relations' }).click()
    await page.getByRole('button', { name: 'Add relation' }).click()
    await page.getByLabel('Linked bookmark').selectOption(endpointId)
    await page.getByLabel('New relation type').selectOption('supports')
    await page.getByLabel('New relation label').fill('Evidence')
    await page.getByLabel('New relation visibility').selectOption('public')
    await page.getByRole('button', { name: 'Create relation', exact: true }).click()
    await expect(page.locator('[data-relation-state]')).toContainText('Relation created')
    await page.getByRole('link', { name: 'Back to graph', exact: true }).last().click()
    await expect(page.locator('[data-relation-id]')).toHaveCount(1)
    await expect(page.locator('aside')).toContainText('Evidence')
    await expect(page.locator('[data-node-id="a"]')).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('link', { name: 'Manage relations' }).click()
    await page.getByRole('link', { name: `${endpointTitle} (${width === 375 ? 'folder' : 'b.example'})`, exact: true }).click()
    await expect(page.getByRole('link', { name: 'Back to graph', exact: true }).last()).toHaveAttribute('href', `/graph/${slug}?node=${endpointId}`)
    await page.getByRole('link', { name: 'Back to graph', exact: true }).last().click()
    await expect(page.locator(`[data-node-id="${endpointId}"]`)).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('link', { name: 'Manage relations' }).click()
    await page.getByRole('button', { name: 'Edit relation', exact: true }).click()
    await page.getByLabel('Relation label', { exact: true }).fill('Updated evidence')
    await page.getByRole('button', { name: 'Save relation' }).click()
    await expect(page.locator('[data-relation-state]')).toContainText('Relation saved')
    await page.getByRole('link', { name: 'Back to graph', exact: true }).last().click()
    await expect(page.locator('aside')).toContainText('Updated evidence')
    await page.getByRole('link', { name: 'Manage relations' }).click()
    await page.getByRole('button', { name: 'Delete relation', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete relation', exact: true }).click()
    await expect(page.locator('[data-relation-state]')).toContainText('Relation deleted')
    await page.getByRole('link', { name: 'Back to graph', exact: true }).last().click()
    await expect(page.locator('[data-relation-id]')).toHaveCount(0)
    await expect(page.locator(`[data-node-id="${endpointId}"]`)).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
