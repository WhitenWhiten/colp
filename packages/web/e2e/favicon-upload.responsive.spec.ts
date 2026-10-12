import { expect, test } from './fixtures'
import { installProductApiMocks, MOCK_COLLECTION_ID, MOCK_ROOT_ID, MOCK_CSRF } from './helpers/product-api-mock'

const ID = '123e4567-e89b-42d3-a456-426614174000'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082', 'hex')

test('the bookmark drawer uploads bytes, refreshes the icon and removes it', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes: [{ id: 'icon-node', parentId: MOCK_ROOT_ID, kind: 'bookmark', title: 'Icon bookmark', url: 'https://example.org', etag: '"n-1"' }] })
  const target = `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/icon-node`
  let iconUrl: string | null = null
  let removed = false
  const methods: string[] = []
  await page.route('**/.well-known/collection-protocol', route => route.fulfill({ status: 404, json: {} }))
  await page.route(`**${target}/favicon-source`, route => route.fulfill({ json: {
    collectionId: MOCK_COLLECTION_ID, nodeId: 'icon-node', nodeResourceRevision: '1', revision: iconUrl || removed ? '2' : '1',
    policyRevision: '1', sourceMode: iconUrl ? 'uploaded' : removed ? 'none' : 'inherit',
    effectiveMode: iconUrl ? 'uploaded' : removed ? 'none' : 'capture',
    iconUrl, iconVersion: iconUrl ? ID : null, directUrl: null, status: iconUrl ? 'ready' : 'missing',
    restorable: false, updatedAt: '2026-07-22T00:00:00.000Z',
  }, headers: { ETag: '"favicon-source:1:2"' } }))
  await page.route(`**/api/v1/favicon/${ID}`, route => route.fulfill({ contentType: 'image/png', body: PNG }))
  await page.route(`**${target}/favicon`, async route => {
    const request = route.request()
    expect(request.headers()['x-csrf-token']).toBe(MOCK_CSRF)
    expect(request.headers()['known-command-id']).toMatch(/^[a-f0-9-]{36}$/)
    methods.push(request.method())
    if (request.method() === 'POST') {
      expect(request.postDataBuffer()).toEqual(PNG)
      expect(request.headers()['content-type']).toBe('image/png')
      iconUrl = new URL(`/api/v1/favicon/${ID}`, page.url()).href
    } else {
      expect(request.method()).toBe('DELETE')
      iconUrl = null
      removed = true
    }
    mock.state.nodes[0]!.iconUrl = iconUrl
    await route.fulfill({ json: {
      id: 'icon-node', collectionId: MOCK_COLLECTION_ID, parentId: MOCK_ROOT_ID, kind: 'bookmark',
      position: 'icon-node', title: 'Icon bookmark', url: 'https://example.org', description: null,
      tags: [], visibility: 'inherit', revision: '1', etag: '"n-1"', readOnly: false,
      readOnlyReason: null, createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z', iconUrl,
    } })
  })
  mock.expectBootstrap().expectDeskMount()
  await page.goto('/library')
  const row = page.locator('.library-bookmark-row', { hasText: 'Icon bookmark' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Actions for Icon bookmark' }).click()
  await page.getByRole('menuitem', { name: 'Edit details' }).click()
  const drawer = page.getByTestId('node-drawer')
  await expect(drawer.locator('#nd-favicon')).toBeEnabled()
  mock.expectEditor({ optional: true })
  await drawer.locator('#nd-favicon').setInputFiles({ name: 'site.png', mimeType: 'image/png', buffer: PNG })
  await expect(drawer.getByTestId('favicon-drop-preview').locator('img')).toHaveAttribute('src', /\/api\/v1\/favicon\//)
  await expect(drawer.getByRole('button', { name: 'Remove favicon', exact: true })).toBeEnabled()
  mock.expectEditor({ optional: true })
  await drawer.getByRole('button', { name: 'Remove favicon', exact: true }).click()
  await expect(drawer.getByTestId('favicon-drop-preview').locator('img')).toHaveCount(0)
  expect(methods).toEqual(['POST', 'DELETE'])
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
  mock.verify()
})
