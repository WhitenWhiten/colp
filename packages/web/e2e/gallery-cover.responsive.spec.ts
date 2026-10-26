import { expect, test } from './fixtures'
import { installProductApiMocks, MOCK_COLLECTION_ID, MOCK_ROOT_ID } from './helpers/product-api-mock'

const ID = '123e4567-e89b-42d3-a456-426614174000'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082', 'hex')

test('bookmark and folder covers use the existing upload and source controls without overflowing the drawer', async ({ page }) => {
  const mock = await installProductApiMocks(page, { nodes: [
    { id: 'cover-bookmark', parentId: MOCK_ROOT_ID, kind: 'bookmark', title: 'Cover bookmark', url: 'https://example.org', etag: '"b-1"', coverMode: 'auto', coverRevision: '0', coverImage: null },
    { id: 'cover-folder', parentId: MOCK_ROOT_ID, kind: 'folder', title: 'Cover folder', etag: '"f-1"', coverMode: 'auto', coverRevision: '0', coverImage: null },
  ] })
  await page.route('**/api/v1/images/*', route => route.fulfill({ contentType: 'image/png', body: PNG }))
  await page.route(`**/api/v1/collections/${MOCK_COLLECTION_ID}/images`, route => route.fulfill({ status: 201, json: {
    assetId: ID, image: { url: new URL(`/api/v1/images/${ID}`, page.url()).href, width: 800, height: 400 },
  } }))
  await page.route(`**/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/*/cover`, async route => {
    const nodeId = new URL(route.request().url()).pathname.split('/').at(-2)!
    const node = mock.state.nodes.find(candidate => candidate.id === nodeId)!
    expect(route.request().headers()['if-match']).toBe(`"cover:${node.coverRevision}"`)
    const { mode } = route.request().postDataJSON()
    node.coverMode = mode
    node.coverRevision = String(Number(node.coverRevision) + 1)
    node.coverImage = mode === 'custom'
      ? { url: new URL(`/api/v1/images/${ID}`, page.url()).href, width: 800, height: 400 } : null
    await route.fulfill({ json: { mode, revision: node.coverRevision, image: node.coverImage } })
  })
  mock.expectBootstrap().expectDeskMount()
  await page.goto('/library')
  await expect(page.getByRole('button', { name: 'Actions for Cover bookmark' })).toBeVisible()
  for (const kind of ['bookmark', 'folder'] as const) {
    await page.getByRole('button', { name: `Actions for Cover ${kind}` }).click()
    await page.getByRole('menuitem', { name: 'Edit details' }).click()
    const drawer = page.getByTestId('node-drawer')
    const cover = drawer.getByRole('region', { name: 'Gallery cover' })
    await cover.scrollIntoViewIfNeeded()
    await expect(cover.getByRole('radio', { name: kind === 'folder' ? 'Automatic mosaic' : 'Website image' })).toBeChecked()
    const geometry = await cover.evaluate(element => {
      const card = element.querySelector('.file-drop-card')!
      const radio = element.querySelector('input[type="radio"]')!
      const file = element.querySelector('input[type="file"]')!
      return { width: element.clientWidth, scrollWidth: element.scrollWidth,
        height: element.getBoundingClientRect().height, cardBorder: getComputedStyle(card).borderTopStyle,
        radioHeight: radio.getBoundingClientRect().height, fileOpacity: getComputedStyle(file).opacity }
    })
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
    expect(geometry.height).toBeLessThan(300)
    expect(geometry.cardBorder).toBe('dashed')
    expect(geometry.fileOpacity).toBe('0')
    expect(geometry.radioHeight).toBeLessThan(24)
    await expect(cover.getByRole('combobox')).toHaveCount(0)
    mock.expectEditor({ optional: true })
    await cover.locator('input[type="file"]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG })
    await expect(cover.getByRole('radio', { name: 'Uploaded image' })).toBeChecked()
    await expect(cover.getByText('Replace cover', { exact: true })).toBeVisible()
    await expect(cover.locator('img')).toHaveAttribute('src', /\/api\/v1\/images\//)
    await expect(cover.getByRole('status')).toHaveCount(0)
    await cover.scrollIntoViewIfNeeded()
    await drawer.screenshot({ path: test.info().outputPath(`cover-${kind}.png`) })
    mock.expectEditor({ optional: true })
    await cover.getByRole('radio', { name: 'No cover' }).click()
    await expect(cover.getByRole('radio', { name: 'No cover' })).toBeChecked()
    await expect(cover.locator('img')).toHaveCount(0)
    await drawer.getByRole('button', { name: 'Close editor' }).click()
  }
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
  mock.verify()
})
