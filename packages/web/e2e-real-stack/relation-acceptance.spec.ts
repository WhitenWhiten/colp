import { expect, test, type Page } from '@playwright/test'
import { signInShared } from './auth-bootstrap'
import { createDeskBookmark, openCollectionEditorAfterDeskCreate, openCollectionSettings, selectCollectionVisibility } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const apiOrigin = process.env.KNOWN_REAL_STACK_API_ORIGIN
if (!controlUrl || !controlToken || !apiOrigin) throw new Error('real-stack endpoints are required')
async function control<T>(path: string, body?: unknown): Promise<T> { const response = await fetch(`${controlUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }); if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`); return response.json() as Promise<T> }
async function login(page: Page) { await signInShared(page) }
async function createFixture(page: Page) {
  await page.getByLabel('Title').fill('Relation acceptance collection'); await page.getByRole('button', { name: 'Create', exact: true }).click()
  const collectionId = await openCollectionEditorAfterDeskCreate(page)
  for (const [title, url] of [['Current relation resource', 'https://current.relation.test'], ['Same endpoint title', 'https://same-a.relation.test'], ['Same endpoint title', 'https://same-b.relation.test'], ['Replacement endpoint', 'https://replacement.relation.test']] as const) {
    await createDeskBookmark(page, title, url)
  }
  await openCollectionSettings(page, collectionId)
  const snapshot = await page.evaluate(async (id) => { const response = await fetch(`/api/v1/collections/${id}/editor?limit=20`); if (!response.ok) throw new Error(`editor ${response.status}`); return response.json() as Promise<{ nodes: Array<{ id: string; title: string; url?: string; position: string; etag: string }>; collection: { etag: string } }> }, collectionId)
  const byUrl = (url: string) => { const node = snapshot.nodes.find((item) => item.url === url); if (!node) throw new Error(`missing ${url}`); return node }
  return { collectionId, currentNodeId: byUrl('https://current.relation.test').id, sameTitleAId: byUrl('https://same-a.relation.test').id, sameTitleBId: byUrl('https://same-b.relation.test').id, replacementId: byUrl('https://replacement.relation.test').id, positions: snapshot.nodes.map((item) => item.position) }
}

test('real PG/Fastify/generated client completes Relation CRUD without changing tree order and projects only public edges', async ({ page, browser }) => {
  await login(page)
  const fixture = await createFixture(page)
  await selectCollectionVisibility(page, 'Public'); await page.getByLabel('Public address').fill(`relation-e2e-${Date.now().toString(36)}`); await page.getByRole('button', { name: 'Save collection', exact: true }).click(); await expect(page.getByText('Collection settings saved').first()).toBeVisible()
  const responses: string[] = []; page.on('response', (response) => { if (new URL(response.url()).pathname.includes('/relations')) responses.push(`${response.request().method()} ${response.status()}`) })
  await page.goto(`/r/${fixture.currentNodeId}?collectionId=${fixture.collectionId}&subjectType=node`)
  await page.getByRole('button', { name: 'Add relation', exact: true }).click()
  const endpoint = page.getByLabel('Linked bookmark'); await expect(endpoint.locator('option', { hasText: 'Same endpoint title' })).toHaveCount(2); await endpoint.selectOption(fixture.sameTitleBId)
  await page.getByLabel('New relation label').fill('private real edge'); await page.getByRole('button', { name: 'Create relation' }).click(); await expect(page.locator('[data-relation-state]')).toContainText('Relation created')
  const created = await control<{ id: string }>('/relation/assert-live', { collectionId: fixture.collectionId, fromNodeId: fixture.currentNodeId, toNodeId: fixture.sameTitleBId, label: 'private real edge' })
  await page.reload(); await expect(page.getByText('private real edge', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit relation' }).click(); await page.getByLabel('Relation label', { exact: true }).fill('updated real edge'); await page.getByRole('button', { name: 'Save relation' }).click(); await expect(page.locator('[data-relation-state]')).toContainText('Relation saved')
  await control('/relation/assert-live', { collectionId: fixture.collectionId, fromNodeId: fixture.currentNodeId, toNodeId: fixture.sameTitleBId, label: 'updated real edge' })
  await page.getByRole('button', { name: 'Edit relation' }).click(); await page.getByLabel('Relation visibility', { exact: true }).selectOption('public'); await page.getByRole('button', { name: 'Save relation' }).click(); await expect(page.locator('[data-relation-state]')).toContainText('Relation saved')
  const publicRelation = created
  await page.getByRole('button', { name: 'Add relation', exact: true }).click()
  await page.getByLabel('Linked bookmark').selectOption(fixture.replacementId); await page.getByLabel('New relation type').selectOption('supports'); await page.getByLabel('New relation label').fill('private projection exclusion'); await page.getByLabel('New relation visibility').selectOption('private'); await page.getByRole('button', { name: 'Create relation' }).click(); await expect(page.locator('[data-relation-state]')).toContainText('Relation created')
  const privateRelation = await control<{ id: string }>('/relation/assert-live', { collectionId: fixture.collectionId, fromNodeId: fixture.currentNodeId, toNodeId: fixture.replacementId, label: 'private projection exclusion' })
  await page.reload(); await expect(page.getByRole('heading', { name: 'Incoming relations' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Outgoing relations' })).toBeVisible()
  expect(await control<string[]>('/relation/tree-positions', { collectionId: fixture.collectionId })).toEqual(fixture.positions)
  const anonymous = await browser.newContext()
  try {
    const response = await anonymous.request.get(`${apiOrigin}/colp/v0.1/collections/${fixture.collectionId}/snapshot?include=relations`, { headers: { Accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1', 'Collection-Protocol-Version': '0.1' } })
    expect(response.status()).toBe(200); const body = await response.json() as { relations: Array<{ id: string }> }
    expect(body.relations.map((item) => item.id)).toContain(publicRelation.id); expect(body.relations.map((item) => item.id)).not.toContain(privateRelation.id)
  } finally { await anonymous.close() }
  const publicRow = page.locator('.relation-direction li').filter({ hasText: 'updated real edge' })
  await publicRow.getByRole('button', { name: 'Delete relation' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByText('updated real edge', { exact: true })).toHaveCount(0)
  await control('/relation/assert-deleted', { relationId: created.id }); await page.reload(); await expect(page.getByText('updated real edge', { exact: true })).toHaveCount(0)
  expect(responses).toEqual(expect.arrayContaining(['POST 201', 'PATCH 200', 'DELETE 200']))
})

test('real endpoint deletion is rejected and replacement emits distinct delete/create command ids', async ({ page }) => {
  await login(page); const fixture = await createFixture(page)
  await page.evaluate(async ({ collectionId, nodeId }) => {
    const [sessionResponse, editorResponse] = await Promise.all([fetch('/api/v1/session'), fetch(`/api/v1/collections/${collectionId}/editor?limit=20`)]); const session = await sessionResponse.json() as { csrfToken: string }; const editor = await editorResponse.json() as { nodes: Array<{ id: string; etag: string }> }; const node = editor.nodes.find((item) => item.id === nodeId); if (!node) throw new Error('endpoint missing')
    const response = await fetch(`/api/v1/collections/${collectionId}/nodes/${nodeId}`, { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken, 'Known-Command-Id': crypto.randomUUID(), 'If-Match': node.etag } }); if (!response.ok) throw new Error(`endpoint delete ${response.status}: ${await response.text()}`)
  }, { collectionId: fixture.collectionId, nodeId: fixture.sameTitleAId })
  await page.goto(`/r/${fixture.currentNodeId}?collectionId=${fixture.collectionId}&subjectType=node`)
  await page.getByRole('button', { name: 'Add relation', exact: true }).click()
  await expect(page.getByLabel('Linked bookmark').locator(`option[value="${fixture.sameTitleAId}"]`)).toHaveCount(0)
  await page.getByLabel('Linked bookmark').selectOption(fixture.sameTitleBId); await page.getByRole('button', { name: 'Create relation' }).click(); await expect(page.locator('[data-relation-state]')).toContainText('Relation created')
  const commandIds: string[] = []; page.on('request', (request) => { if (request.method() === 'DELETE' || request.method() === 'POST') { const id = request.headers()['known-command-id']; if (id) commandIds.push(id) } })
  await page.getByRole('button', { name: 'Edit relation' }).click(); await expect(page.getByLabel('Replace with').locator(`option[value="${fixture.sameTitleAId}"]`)).toHaveCount(0)
  await page.getByLabel('Replace with').selectOption(fixture.replacementId)
  await page.getByRole('button', { name: 'Replace linked bookmark' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(page.locator('[data-relation-state]')).toContainText('Linked bookmark replaced')
  expect(commandIds).toHaveLength(2); expect(commandIds[0]).not.toBe(commandIds[1])
})
