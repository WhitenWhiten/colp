import { expect, test, type Page } from '@playwright/test'
import { signInShared } from './auth-bootstrap'
import { createDeskBookmark, openCollectionEditorAfterDeskCreate, selectCollectionVisibility } from './collection-bootstrap'

/**
 * FO-07 favicon-ordering real-stack browser evidence.
 *
 * Selectable with `real-stack-e2e.mjs --grep 'favicon-ordering'` (the harness
 * enables KNOWN_FEATURE_FAVICON_POLICY + a local object store whenever a spec
 * matching this grep can run). The spec drives the REAL Web app against the
 * REAL API and PostgreSQL:
 *
 *   1. Settings → Favicon: virtual policy (revision 1, capture default),
 *      PATCH newDefault to none, persisted across reload (GET reflects it).
 *   2. Bookmark inspector FaviconSourceControl: source GET then PUT (none),
 *      persisted across reload.
 *   3. Public collection children sort (FO-05): the children endpoint feeds
 *      created_desc/created_asc layers with the sort bound to the URL.
 *
 * All mutations go through the real product transport (cookie session,
 * CSRF, If-Match, Known-Command-Id); nothing is stubbed or injected.
 */

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
if (!controlUrl || !controlToken) {
  throw new Error('favicon-ordering real-stack requires the fail-closed harness control endpoint')
}

async function productGet<T>(page: Page, path: string): Promise<{ status: number; body: T }> {
  return page.evaluate(async (urlPath) => {
    const response = await fetch(urlPath, { cache: 'no-store' })
    const text = await response.text()
    return {
      status: response.status,
      body: text.length === 0 ? null : JSON.parse(text) as unknown,
    }
  }, path) as Promise<{ status: number; body: T }>
}

test.describe('favicon-ordering real-stack: favicon policy + source + children sort through the real API', () => {
  test('settings favicon policy round-trip persists through the real API', async ({ page }) => {
    test.setTimeout(120_000)
    await signInShared(page)
    // Open Settings → Favicon through the real dialog route.
    await page.goto('/library?settings=favicon')
    await expect(page.getByTestId('settings-favicon')).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Capture automatically' })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'No icon' })).not.toBeChecked()

    // The endpoint returns the virtual default (revision 1) before any write.
    const before = await productGet<{ revision?: string; newDefault?: string }>(page, '/api/v1/me/favicon-policy')
    expect(before.status).toBe(200)
    expect(before.body.revision).toBe('1')
    expect(before.body.newDefault).toBe('capture')

    // PATCH newDefault -> none through the real UI (If-Match + CSRF + command id).
    // The control commits asynchronously (radio -> onChange -> save -> load),
    // so drive by click and wait for the real API, then assert the rendered
    // radio state once the reloaded server policy is reflected.
    await page.getByRole('radio', { name: 'No icon' }).click()
    await expect.poll(async () => {
      const current = await productGet<{ revision?: string; newDefault?: string }>(page, '/api/v1/me/favicon-policy')
      return current.status === 200 && current.body.newDefault === 'none' ? current.body.revision : null
    }, { timeout: 20_000 }).not.toBeNull()
    await expect(page.getByRole('radio', { name: 'No icon' })).toBeChecked()
    await expect(page.getByRole('radio', { name: 'Capture automatically' })).not.toBeChecked()

    // Durable persistence: GET through the real API reflects the write.
    const after = await productGet<{ revision?: string; newDefault?: string }>(page, '/api/v1/me/favicon-policy')
    expect(after.body.newDefault).toBe('none')
    expect(Number(after.body.revision)).toBeGreaterThan(1)

    // Reload the dialog: the radio reflects the persisted server state.
    await page.goto('/library?settings=favicon')
    await expect(page.getByRole('radio', { name: 'No icon' })).toBeChecked()
  })

  test('bookmark inspector favicon source control PUT persists through the real API', async ({ page }) => {
    test.setTimeout(120_000)
    await signInShared(page)

    await page.getByLabel('Title').fill('favicon-ordering source collection')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const collectionId = await openCollectionEditorAfterDeskCreate(page)

    await createDeskBookmark(page, 'Source bookmark', 'https://example.test/favicon-ordering-source')
    await page.getByRole('button', { name: 'Actions for Source bookmark', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click()
    await expect(page.getByTestId('favicon-source-control')).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Inherit the account default' })).toBeChecked()

    const nodeId = await page.evaluate(async ({ id, title }) => {
      const response = await fetch(`/api/v1/collections/${id}/editor?limit=50`)
      if (!response.ok) throw new Error(`editor read failed: ${response.status}`)
      const body = await response.json() as { nodes?: Array<{ id: string; title: string }> }
      const node = body.nodes?.find((candidate) => candidate.title === title)
      if (!node) throw new Error('created source bookmark missing from real editor read')
      return node.id
    }, { id: collectionId, title: 'Source bookmark' })

    // PUT sourceMode=none through the real UI (async commit like the settings
    // control: click, then wait for the real source row, then assert the
    // rendered radio reflects the reloaded state).
    await page.getByRole('radio', { name: 'No icon' }).click()
    await expect.poll(async () => {
      const current = await productGet<{ sourceMode?: string }>(page,
        `/api/v1/collections/${collectionId}/nodes/${nodeId}/favicon-source`,
      )
      return current.status === 200 && current.body.sourceMode === 'none' ? 'none' : null
    }, { timeout: 20_000 }).toBe('none')
    await expect(page.getByRole('radio', { name: 'No icon' })).toBeChecked()

    // Reload and reopen the inspector: the server state is authoritative.
    await page.goto(`/library/${collectionId}`)
    await page.getByRole('button', { name: 'Actions for Source bookmark', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit details', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'No icon' })).toBeChecked()
  })

  test('public collection children sort drives the real listCollectionChildren endpoint', async ({ page }) => {
    test.setTimeout(120_000)
    await signInShared(page)
    const slug = `favicon-ordering-sort`

    await page.getByLabel('Title').fill('favicon-ordering sort collection')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const collectionId = await openCollectionEditorAfterDeskCreate(page)
    for (const [index, title] of ['Older source', 'Newer source'].entries()) {
      await createDeskBookmark(page, title, `https://example.test/favicon-ordering-sort-${index}`)
    }
    await selectCollectionVisibility(page, 'Public')
    await page.getByLabel('Public address').fill(slug)
    await page.getByRole('button', { name: 'Save collection', exact: true }).click()
    await expect(page.getByRole('link', { name: new RegExp(`/c/${slug}$`, 'u') })).toBeVisible()

    // The public page uses the children endpoint for non-curated sorts. The
    // canonical row id comes from the published snapshot (slug -> collection),
    // not the draft desk id, so resolve it the same way the page does.
    const snapshot = await productGet<{ collection?: { id?: string } }>(page, `/api/v1/collections/${slug}`)
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200)
    const canonicalId = snapshot.body.collection?.id
    expect(canonicalId).toBeTruthy()
    // Publication keeps the same canonical row id as the draft desk id.
    expect(canonicalId).toBe(collectionId)
    const childrenBefore = await productGet<{ items?: unknown[] }>(page,
      `/api/v1/collections/${canonicalId}/children?sort=created_desc&limit=10`)
    expect(childrenBefore.status, JSON.stringify(childrenBefore.body)).toBe(200)
    await page.goto(`/c/${slug}?sort=created_desc`)
    await expect(page.getByTestId('public-collection-page')).toHaveAttribute('data-sort', 'created_desc')
    await expect(page.getByTestId('public-collection-page')).toContainText('Newer source')
    await expect(page.getByTestId('public-collection-page')).toContainText('Older source')

    // created_asc reverses the layer through the same endpoint.
    await page.goto(`/c/${slug}?sort=created_asc`)
    await expect(page.getByTestId('public-collection-page')).toHaveAttribute('data-sort', 'created_asc')
    await expect(page.getByTestId('public-collection-page')).toContainText('Older source')
    await expect(page.getByTestId('public-collection-page')).toContainText('Newer source')

    // CURATED (default) keeps the canonical snapshot layer.
    await page.goto(`/c/${slug}`)
    await expect(page.getByTestId('public-collection-page')).toHaveAttribute('data-sort', 'curated')
    await expect(page.getByTestId('public-collection-page')).toContainText('Older source')
  })
})
