import { expect, test, type Page } from '@playwright/test'
import { signInShared } from './auth-bootstrap'
import { createDeskBookmark, openCollectionEditorAfterDeskCreate } from './collection-bootstrap'

/**
 * LP-07 link preview real-stack browser evidence.
 *
 * Selectable with `real-stack-e2e.mjs --grep 'link-preview'`: the harness
 * enables KNOWN_FEATURE_LINK_PREVIEW on the REAL API and worker, stores
 * objects in its local object server and answers the worker's page/image
 * fetches from a fixture file (lp-og has an og:image, lp-plain has none).
 *
 *   1. A private collection is not fetched until the owner opens Gallery;
 *      then the worker stores the og:image and the desk shows it.
 *   2. Published, the anonymous Gallery shows the same same-origin cover.
 *   3. The owner hides it; the anonymous page drops it on the next read.
 */

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL
if (!controlUrl || !controlToken || !webBaseUrl) {
  throw new Error('link-preview real-stack requires the fail-closed harness control endpoint')
}

type PreviewImage = { url: string; width: number; height: number } | null

async function control<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`control ${path} failed: ${response.status} ${await response.text()}`)
  return response.json() as Promise<T>
}

/** The real editor read: previewImage of the bookmark with this title. */
async function editorNode(page: Page, collectionId: string, title: string): Promise<{ id: string; previewImage: PreviewImage }> {
  return page.evaluate(async ({ id, wanted }) => {
    const response = await fetch(`/api/v1/collections/${id}/editor?limit=50`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`editor read failed: ${response.status}`)
    const body = await response.json() as { nodes?: Array<{ id: string; title: string; previewImage?: PreviewImage }> }
    const node = body.nodes?.find((candidate) => candidate.title === wanted)
    if (!node) throw new Error(`${wanted} missing from the real editor read`)
    return { id: node.id, previewImage: node.previewImage ?? null }
  }, { id: collectionId, wanted: title })
}

test.describe('link-preview real-stack: Gallery covers through the real API and worker', () => {
  test('owner Gallery asks for covers, the public Gallery shows them, and hiding removes them', async ({ page, browser }) => {
    test.setTimeout(240_000)
    await signInShared(page)
    await page.getByLabel('Title').fill('link-preview gallery collection')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const collectionId = await openCollectionEditorAfterDeskCreate(page)
    await createDeskBookmark(page, 'Covered story', 'https://lp-og.example.test/story')
    await createDeskBookmark(page, 'Plain notes', 'https://lp-plain.example.test/notes')

    // 1. Private: nothing is fetched until the owner opens Gallery.
    expect((await editorNode(page, collectionId, 'Covered story')).previewImage).toBeNull()
    await page.getByRole('radiogroup', { name: 'View', exact: true }).getByRole('radio', { name: 'Gallery', exact: true }).click()
    await expect.poll(async () => (await editorNode(page, collectionId, 'Covered story')).previewImage, {
      timeout: 60_000,
    }).toMatchObject({ width: 1200, height: 630 })
    expect((await editorNode(page, collectionId, 'Plain notes')).previewImage).toBeNull()

    await page.reload()
    const deskCover = page.locator('[data-gallery-card]', { hasText: 'Covered story' }).locator('[data-gallery-cover] img')
    await expect(deskCover).toHaveAttribute('src', /\/api\/v1\/link-preview\/[a-f0-9-]{36}$/u)
    await expect.poll(() => deskCover.evaluate((img: HTMLImageElement) => img.complete ? img.naturalWidth : 0)).toBe(1200)
    await expect(page.locator('[data-gallery-card]', { hasText: 'Plain notes' }).locator('[data-gallery-cover] img')).toHaveCount(0)

    // 2. Published: the anonymous Gallery shows the same same-origin object.
    const { slug } = await control<{ slug: string }>('/link-preview/publish', { collectionId })
    const anonymousContext = await browser.newContext({ baseURL: webBaseUrl })
    try {
      const guest = await anonymousContext.newPage()
      await guest.goto(`/c/${slug}?view=gallery`)
      const guestCard = guest.locator('[data-gallery-card]', { hasText: 'Covered story' })
      await expect(guestCard.locator('[data-gallery-cover] img')).toHaveAttribute('src', await deskCover.getAttribute('src') ?? 'missing')
      await expect(guest.locator('[data-gallery-card]', { hasText: 'Plain notes' }).locator('[data-gallery-cover] img')).toHaveCount(0)

      // 3. The owner hides the image; every view drops it.
      await page.getByRole('button', { name: 'Actions for Covered story', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click()
      await expect(page.getByTestId('preview-mode-control')).toBeVisible()
      const { id: nodeId } = await editorNode(page, collectionId, 'Covered story')
      await page.getByRole('radio', { name: 'Hide for this bookmark', exact: true }).click()
      await expect.poll(() => page.evaluate(async (path) => {
        const response = await fetch(path, { cache: 'no-store' })
        return response.ok ? (await response.json() as { mode: string }).mode : `http-${response.status}`
      }, `/api/v1/collections/${collectionId}/nodes/${nodeId}/preview-image-mode`)).toBe('none')
      await guest.reload()
      await expect(guestCard).toBeVisible()
      await expect(guestCard.locator('[data-gallery-cover] img')).toHaveCount(0)
    } finally {
      await anonymousContext.close()
    }
  })
})
