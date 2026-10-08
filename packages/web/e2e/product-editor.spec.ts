import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  installProductApiMocks,
  MOCK_COLLECTION_ID,
  MOCK_CSRF,
  MOCK_ROOT_ID,
  type ProductApiMock,
} from './helpers/product-api-mock'

const editorPath = `/library/${MOCK_COLLECTION_ID}?collection=edit`

async function openEditor(page: Page, mock: ProductApiMock) {
  mock.expectBootstrap().expectDeskMount().expectEditorMount()
  await page.goto(editorPath, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('collection-settings')).toBeVisible()
  // Do not race mutations against React StrictMode's replacement load effect.
  await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
}

test.describe('Product editor with strict mocked API', () => {
  let mock: ProductApiMock | undefined

  test.afterEach(() => {
    mock?.verify()
    mock = undefined
  })

  test('mock harness rejects wrong sequence, malformed admission, and unconsumed requests', async ({ page }) => {
    mock = await installProductApiMocks(page, { authenticated: false })
    mock.expectBootstrap(false)
    await page.goto('/login', { waitUntil: 'domcontentloaded' })

    const unexpected = await page.evaluate(async () => (await fetch('/api/v1/not-expected')).status)
    expect(unexpected).toBe(599)
    mock.acknowledgeExpectedViolations(/unexpected Product API request/u)

    mock.expect({ method: 'POST', path: '/api/v1/collections', label: 'create command' })
    const wrongSequence = await page.evaluate(async () =>
      (await fetch('/api/v1/not-expected')).status,
    )
    expect(wrongSequence).toBe(599)
    mock.acknowledgeExpectedViolations(/wrong Product API sequence: expected create command/u)

    mock.expect({ method: 'POST', path: '/api/v1/collections', label: 'missing csrf' })
    const missingCsrf = await page.evaluate(async () =>
      (await fetch('/api/v1/collections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174000',
        },
        body: JSON.stringify({ kind: 'bookmarks', title: 'Valid', summary: null }),
      })).status,
    )
    expect(missingCsrf).toBe(403)
    mock.acknowledgeExpectedViolations(/missing or invalid X-CSRF-Token/u)

    mock.expect({ method: 'POST', path: '/api/v1/collections', label: 'uppercase command id' })
    const uppercaseCommand = await page.evaluate(async (csrf) => {
      const response = await fetch('/api/v1/collections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123E4567-E89B-42D3-A456-426614174000',
        },
        body: JSON.stringify({ kind: 'bookmarks', title: 'Valid', summary: null }),
      })
      return { status: response.status, code: (await response.json()).error.code }
    }, MOCK_CSRF)
    expect(uppercaseCommand).toEqual({ status: 400, code: 'invalid_request' })
    mock.acknowledgeExpectedViolations(/canonical lowercase UUID v4/u)

    mock.expect({
      method: 'POST',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes`,
      label: 'malformed create-node body',
    })
    const malformedBody = await page.evaluate(async ({ csrf, collectionId }) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174001',
        },
        body: JSON.stringify({
          parentId: 'root-e2e-1',
          afterId: null,
          beforeId: null,
          node: { kind: 'bookmark', title: 42, url: 'javascript:bad', description: null, tags: [], visibility: 'inherit' },
        }),
      })
      return { status: response.status, code: (await response.json()).error.code }
    }, { csrf: MOCK_CSRF, collectionId: MOCK_COLLECTION_ID })
    expect(malformedBody).toEqual({ status: 422, code: 'invalid_document' })
    mock.acknowledgeExpectedViolations(/node.title must be a valid string/u)

    mock.expect({
      method: 'DELETE',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/n-bookmark-1`,
      label: 'delete carrying a payload',
    })
    const deletePayload = await page.evaluate(async ({ csrf, collectionId }) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/nodes/n-bookmark-1`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174002',
          'If-Match': '"n-1"',
        },
        body: '{malformed',
      })
      return { status: response.status, code: (await response.json()).error.code }
    }, { csrf: MOCK_CSRF, collectionId: MOCK_COLLECTION_ID })
    expect(deletePayload).toEqual({ status: 415, code: 'unsupported_media_type' })
    mock.acknowledgeExpectedViolations(/Content-Type must be application\/json/u)

    mock.expect({ method: 'POST', path: '/api/v1/collections', label: 'parameterized JSON media type' })
    const parameterizedJson = await page.evaluate(async (csrf) => {
      const response = await fetch('/api/v1/collections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174003',
        },
        body: JSON.stringify({ kind: 'bookmarks', title: 'Parameterized JSON', summary: null }),
      })
      return response.status
    }, MOCK_CSRF)
    expect(parameterizedJson).toBe(201)

    mock.expect({ method: 'POST', path: '/api/v1/collections', label: 'unsupported JSON-like media type' })
    const unsupportedMediaType = await page.evaluate(async (csrf) => {
      const response = await fetch('/api/v1/collections', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/json; charset=utf-8',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174004',
        },
        body: JSON.stringify({ kind: 'bookmarks', title: 'Wrong media type', summary: null }),
      })
      return { status: response.status, code: (await response.json()).error.code }
    }, MOCK_CSRF)
    expect(unsupportedMediaType).toEqual({ status: 415, code: 'unsupported_media_type' })
    mock.acknowledgeExpectedViolations(/Content-Type must be application\/json/u)

    mock.expect({
      method: 'POST',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes`,
      label: 'empty create-node anchor',
    })
    const emptyAnchor = await page.evaluate(async ({ csrf, collectionId }) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174005',
        },
        body: JSON.stringify({
          parentId: 'root-e2e-1',
          afterId: '',
          beforeId: null,
          node: {
            kind: 'folder',
            title: 'Folder',
            description: null,
            tags: [],
            visibility: 'inherit',
          },
        }),
      })
      return { status: response.status, code: (await response.json()).error.code }
    }, { csrf: MOCK_CSRF, collectionId: MOCK_COLLECTION_ID })
    expect(emptyAnchor).toEqual({ status: 422, code: 'invalid_document' })
    mock.acknowledgeExpectedViolations(/node anchors must be null or non-empty strings/u)

    mock.expect({
      method: 'POST',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes`,
      label: 'content mutation',
    })
    const contentMutation = await page.evaluate(async ({ csrf, collectionId }) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174006',
        },
        body: JSON.stringify({
          parentId: 'root-e2e-1',
          afterId: null,
          beforeId: null,
          node: {
            kind: 'folder',
            title: 'Fence folder',
            description: null,
            tags: [],
            visibility: 'inherit',
          },
        }),
      })
      return { status: response.status, body: await response.json() }
    }, { csrf: MOCK_CSRF, collectionId: MOCK_COLLECTION_ID })
    expect(contentMutation.status).toBe(201)
    expect(contentMutation.body.fence).toMatchObject({ contentRevision: '2', contentEtag: '"cc-2"' })

    mock.expectEditor({ label: 'authoritative fence refresh' })
    const refreshedFence = await page.evaluate(async (collectionId) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/editor?limit=200`)
      return (await response.json()).collection.contentEtag
    }, MOCK_COLLECTION_ID)
    expect(refreshedFence).toBe('"cc-2"')

    mock.expect({
      method: 'DELETE',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/n-new-2`,
      query: { recursive: 'true' },
      label: 'stale content fence',
    })
    const staleFence = await page.evaluate(async ({ csrf, collectionId }) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/nodes/n-new-2?recursive=true`, {
        method: 'DELETE',
        headers: {
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174007',
          'If-Match': '"n-new"',
          'If-Content-Match': '"cc-1"',
        },
      })
      return { status: response.status, body: await response.json() }
    }, { csrf: MOCK_CSRF, collectionId: MOCK_COLLECTION_ID })
    expect(staleFence.status).toBe(412)
    expect(staleFence.body.error).toMatchObject({ code: 'precondition_failed', currentEtag: '"cc-2"' })
    mock.acknowledgeExpectedViolations(/If-Content-Match is stale/u)

    mock.expect({
      method: 'DELETE',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/n-new-2`,
      query: { recursive: 'true' },
      label: 'current content fence',
    })
    const currentFence = await page.evaluate(async ({ csrf, collectionId }) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/nodes/n-new-2?recursive=true`, {
        method: 'DELETE',
        headers: {
          'X-CSRF-Token': csrf,
          'Known-Command-Id': '123e4567-e89b-42d3-a456-426614174008',
          'If-Match': '"n-new"',
          'If-Content-Match': '"cc-2"',
        },
      })
      return { status: response.status, body: await response.json() }
    }, { csrf: MOCK_CSRF, collectionId: MOCK_COLLECTION_ID })
    expect(currentFence.status).toBe(200)
    expect(currentFence.body.fence).toMatchObject({ contentRevision: '3', contentEtag: '"cc-3"' })

    mock.expectEditor({ label: 'post-delete authoritative fence refresh' })
    const postDeleteFence = await page.evaluate(async (collectionId) => {
      const response = await fetch(`/api/v1/collections/${collectionId}/editor?limit=200`)
      return (await response.json()).collection.contentEtag
    }, MOCK_COLLECTION_ID)
    expect(postDeleteFence).toBe('"cc-3"')

    mock.expectEditor({ label: 'deliberately unconsumed editor request' })
    mock.acknowledgeExpectedViolations(/unconsumed deliberately unconsumed editor request/u)
  })

  test('login starts Google OAuth with the exact safe returnTo', async ({ page }) => {
    mock = await installProductApiMocks(page, { authenticated: false })
    mock.expectBootstrap(false).expect({
      method: 'POST',
      path: '/api/v1/auth/sign-in/social',
      body: {
        provider: 'google',
        callbackURL: '/library',
        errorCallbackURL: '/auth/recovery?returnTo=%2Flibrary',
        newUserCallbackURL: '/onboarding',
      },
      label: 'Google OAuth start',
    })

    await page.goto('/login?returnTo=%2Flibrary', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Continue with Google', exact: true }).click()
    await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
  })

  test('creates a collection through the Product UI with admitted command traffic', async ({ page }) => {
    mock = await installProductApiMocks(page)
    mock
      .expectBootstrap()
      .expect({ method: 'POST', path: '/api/v1/collections', label: 'create collection' })
      .expectDeskMount()

    await page.goto('/library/new', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('Title').fill('Created in browser')
    await page.getByRole('button', { name: 'Create', exact: true }).click()

    await expect(page).toHaveURL(`/library/${MOCK_COLLECTION_ID}`)
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Created in browser' })).toBeVisible()
    await expect(page.getByTestId('collection-settings')).toHaveCount(0)
    await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
  })

  test('loads collection settings and catalog fields over the desk', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)

    await expect(page.getByTestId('collection-settings')).toBeVisible()
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    await expect(page.getByTestId('collection-settings-loading')).toHaveCount(0)
    await expect(page.getByLabel('Tags', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Language', { exact: true })).toBeVisible()
    await expect(page.getByLabel(/cover|paid|collaborators/iu)).toHaveCount(0)
  })

  test('re-bootstraps session on refresh and fails closed after authentication loss', async ({ page }) => {
    mock = await installProductApiMocks(page)
    mock.expectBootstrap()
    await page.goto('/library', { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('E2E User').first()).toBeVisible()

    mock.expectBootstrap()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByText('E2E User').first()).toBeVisible()

    mock.state.authenticated = false
    mock.expectBootstrap(false)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible()
    mock.expectBootstrap(false)
    await page.goto(editorPath, { waitUntil: 'domcontentloaded' })

    await expect(page.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible()
    await expect(page.getByTestId('collection-settings')).toHaveCount(0)
  })

  test('surfaces a metadata precondition conflict and refreshes authoritative state', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)
    mock
      .expect({
        method: 'PATCH',
        path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
        outcome: 'precondition_failed',
        captureCommandAs: 'conflicting-metadata',
        label: 'conflicting metadata command',
      })
      .expectEditor({ label: 'authoritative conflict refresh' })

    await page.locator('#ce-title').fill('Stale browser title')
    await page.getByRole('button', { name: 'Save collection' }).click()

    await expect(page.getByText('Conflict — refreshed. Re-apply your change.').first()).toBeVisible()
    await expect(page.locator('#ce-title')).toHaveValue('E2E Collection')
    await expect(page.getByText('Collection settings saved')).toHaveCount(0)

    mock.expect({
      method: 'PATCH',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
      differentCommandFrom: 'conflicting-metadata',
      label: 're-applied metadata as new intent',
    })
    await page.locator('#ce-title').fill('Re-applied browser title')
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(page.locator('#ce-title')).toHaveValue('Re-applied browser title')
    await expect(page.getByText('Collection settings saved').first()).toBeVisible()
  })

  test('publishes with an immutable canonical slug and can withdraw the collection', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)

    mock.expect({
      method: 'PATCH',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
      body: {
        title: 'E2E Collection', summary: null, visibility: 'public', publicationSlug: 'e2e-research',
      },
      ifMatch: '"c-1"',
      csrfToken: MOCK_CSRF,
      label: 'publish collection',
    })
    await page.getByRole('radio', { name: 'Public', exact: true }).check()
    await page.getByLabel('Public address').fill('e2e-research')
    await page.getByRole('button', { name: 'Save collection' }).click()

    const canonical = page.getByRole('link', { name: /\/c\/e2e-research$/u })
    await expect(canonical).toHaveAttribute('href', '/c/e2e-research')
    await expect(page.getByLabel('Public address')).toBeDisabled()
    await expect(page.getByText('Listed and publicly accessible')).toBeVisible()
    expect(mock.state.collectionVisibility).toBe('public')
    expect(mock.state.publicationSlug).toBe('e2e-research')

    mock.expect({
      method: 'PATCH',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
      body: { title: 'E2E Collection', summary: null, visibility: 'private' },
      ifMatch: '"c-2"',
      csrfToken: MOCK_CSRF,
      label: 'withdraw collection',
    })
    await page.getByRole('radio', { name: 'Private', exact: true }).check()
    await page.getByRole('button', { name: 'Save collection' }).click()

    await expect(page.getByText('Not publicly accessible')).toBeVisible()
    await expect(page.getByLabel('Public address')).toHaveCount(0)
    expect(mock.state.collectionVisibility).toBe('private')
    expect(mock.state.publicationSlug).toBe('e2e-research')
    await expect(page.getByRole('link', { name: /\/c\/e2e-research$/u })).toHaveCount(0)
    await expect(page.getByText('Public address (currently private)')).toBeVisible()
  })

  test('publishes unlisted with a real PATCH and server-confirmed canonical URL', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)
    mock.expect({
      method: 'PATCH',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
      body: {
        title: 'E2E Collection', summary: null, visibility: 'unlisted', publicationSlug: 'direct-notes',
      },
      ifMatch: '"c-1"',
      csrfToken: MOCK_CSRF,
      label: 'unlisted publication PATCH',
    })
    await page.getByRole('radio', { name: 'Unlisted', exact: true }).check()
    await page.getByLabel('Public address').fill('direct-notes')
    await expect(page.getByRole('link', { name: /\/c\/direct-notes$/u })).toHaveCount(0)
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(page.getByRole('link', { name: /\/c\/direct-notes$/u })).toBeVisible()
    await expect(page.getByText('Available by direct link')).toBeVisible()
  })

  test('hides publication controls from an editor who can still save metadata', async ({ page }) => {
    mock = await installProductApiMocks(page, { managePublication: false })
    await openEditor(page, mock)
    await expect(page.locator('.publication-controls')).toHaveCount(0)

    mock.expect({
      method: 'PATCH',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
      body: { title: 'Editor metadata', summary: null },
      ifMatch: '"c-1"',
      csrfToken: MOCK_CSRF,
      label: 'ordinary editor metadata PATCH',
    })
    await page.locator('#ce-title').fill('Editor metadata')
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(page.locator('#ce-title')).toHaveValue('Editor metadata')
  })

  test('shows a server slug conflict inline and keeps the publication draft', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)
    mock.expect({
      method: 'PATCH',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
      outcome: 'slug_conflict',
      body: {
        title: 'E2E Collection', summary: null, visibility: 'public', publicationSlug: 'claimed-slug',
      },
      ifMatch: '"c-1"',
      csrfToken: MOCK_CSRF,
      label: 'conflicting publication PATCH',
    })
    await page.getByRole('radio', { name: 'Public', exact: true }).check()
    const slug = page.getByLabel('Public address')
    await slug.fill('claimed-slug')
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(slug).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('#ce-publication-slug-error')).toHaveRole('alert')
    await expect(page.locator('#ce-publication-slug-error')).toContainText('This slug is already in use.')
    await expect(slug).toBeFocused()
    await expect(slug).toHaveValue('claimed-slug')
    await expect(page.getByRole('link', { name: /\/c\/claimed-slug$/u })).toHaveCount(0)
  })

  test('refreshes after CSRF failure, preserves publication draft, and explicitly retries', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)
    const body = {
      title: 'CSRF draft', summary: null, visibility: 'unlisted', publicationSlug: 'csrf-draft',
    }
    mock
      .expect({
        method: 'PATCH', path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
        outcome: 'csrf_failed', body, ifMatch: '"c-1"', csrfToken: MOCK_CSRF,
        captureCommandAs: 'csrf-publication', label: 'CSRF-rejected publication PATCH',
      })
      .expect({ method: 'GET', path: '/api/v1/session', label: 'CSRF session refresh' })
      .expect({ method: 'GET', path: '/api/v1/me', label: 'CSRF profile refresh' })
      .expectEditor({ label: 'CSRF editor fence refresh' })
      .expect({
        method: 'PATCH', path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
        body, ifMatch: '"c-1"', csrfToken: MOCK_CSRF,
        differentCommandFrom: 'csrf-publication', label: 'explicit publication retry',
      })
    await page.locator('#ce-title').fill('CSRF draft')
    await page.getByRole('radio', { name: 'Unlisted', exact: true }).check()
    await page.getByLabel('Public address').fill('csrf-draft')
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(page.getByText(/Session refreshed\. Your unsaved form values were kept/u)).toBeVisible()
    await expect(page.locator('#ce-title')).toHaveValue('CSRF draft')
    await expect(page.getByLabel('Public address')).toHaveValue('csrf-draft')
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(page.getByRole('link', { name: /\/c\/csrf-draft$/u })).toBeVisible()
  })

  test('retries publication command_in_progress with the exact same command and request', async ({ page }) => {
    mock = await installProductApiMocks(page)
    await openEditor(page, mock)
    const body = {
      title: 'E2E Collection', summary: null, visibility: 'public', publicationSlug: 'replayed-publication',
    }
    mock
      .expect({
        method: 'PATCH', path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
        outcome: 'command_in_progress', body, ifMatch: '"c-1"', csrfToken: MOCK_CSRF,
        captureCommandAs: 'publication-command', label: 'in-progress publication PATCH',
      })
      .expect({
        method: 'PATCH', path: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
        body, ifMatch: '"c-1"', csrfToken: MOCK_CSRF,
        sameCommandAs: 'publication-command', label: 'same-command publication PATCH retry',
      })
    await page.getByRole('radio', { name: 'Public', exact: true }).check()
    await page.getByLabel('Public address').fill('replayed-publication')
    await page.getByRole('button', { name: 'Save collection' }).click()
    await expect(page.getByRole('link', { name: /\/c\/replayed-publication$/u })).toBeVisible()
  })

  test('retries node creation command_in_progress with the same command id', async ({ page }) => {
    mock = await installProductApiMocks(page)
    mock.expectBootstrap().expectDeskMount()
    await page.goto(`/library/${MOCK_COLLECTION_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
    mock
      .expect({
        method: 'POST',
        path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes`,
        outcome: 'command_in_progress',
        captureCommandAs: 'create-node',
        label: 'in-progress create command',
      })
      .expect({
        method: 'POST',
        path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes`,
        sameCommandAs: 'create-node',
        label: 'same-command retry',
      })
      .expectEditor({ label: 'post-create editor refresh' })

    await page.getByRole('button', { name: 'Add bookmark', exact: true }).click()
    await page.getByLabel('URL').fill('https://retry.example')
    await page.getByLabel('Title').fill('Retried bookmark')
    await page.locator('[data-testid="library-compose"] button[type="submit"]').click()

    await expect(page.getByTestId('library-bookmarks')).toContainText('Retried bookmark')
    await expect(page.getByText('Bookmark created').first()).toBeVisible()
  })

  test('restarts editor pagination after cursor expiry without publishing partial nodes', async ({ page }) => {
    const firstPageNode = {
      id: 'n-first-page',
      kind: 'bookmark' as const,
      title: 'Partial page node',
      url: 'https://partial.example',
      etag: '"n-partial"',
      parentId: MOCK_ROOT_ID,
    }
    mock = await installProductApiMocks(page)
    mock
      .expectBootstrap()
      .expectDeskMount({
        editor: { hasMore: true, nextCursor: 'cursor-e2e', nodes: [firstPageNode] },
        label: 'initial paged editor request',
      })
      .expect({
        method: 'GET',
        path: `/api/v1/collections/${MOCK_COLLECTION_ID}/editor`,
        query: { cursor: 'cursor-e2e' },
        outcome: 'snapshot_expired',
        label: 'expired continuation',
      })
      .expectEditor({ label: 'first-page restart' })

    await page.goto(`/library/${MOCK_COLLECTION_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    await expect(page.getByTestId('library-bookmarks')).toContainText('Example')
    await expect(page.getByTestId('library-bookmarks')).not.toContainText('Partial page node')
  })

  test('requires explicit confirmation and content fencing for recursive folder deletion', async ({ page }) => {
    const folder = {
      id: 'n-folder-1',
      kind: 'folder' as const,
      title: 'Folder to delete',
      etag: '"folder-1"',
      parentId: MOCK_ROOT_ID,
    }
    const child = {
      id: 'n-folder-child',
      kind: 'bookmark' as const,
      title: 'Nested bookmark',
      url: 'https://nested.example',
      etag: '"child-1"',
      parentId: folder.id,
    }
    mock = await installProductApiMocks(page, { nodes: [folder, child] })
    mock.expectBootstrap().expectDeskMount()
    await page.goto(`/library/${MOCK_COLLECTION_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('library-workspace')).toBeVisible()
    await expect.poll(() => mock.pendingExpectationCount()).toBe(0)
    mock
      .expect({
        method: 'DELETE',
        path: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/${folder.id}`,
        query: { recursive: 'true' },
        label: 'recursive folder delete',
      })
      .expectEditor({ label: 'post-delete editor refresh' })

    await page.getByRole('button', { name: 'Actions for Folder to delete' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const confirmDialog = page.getByRole('dialog', { name: 'Delete folder' })
    await expect(confirmDialog).toContainText("and everything in it: 1 bookmark. This can't be undone.")
    await confirmDialog.getByRole('button', { name: 'Delete folder', exact: true }).click()

    await expect(page.getByText('Folder to delete')).toHaveCount(0)
    await expect(page.getByText('Folder deleted').first()).toBeVisible()
  })
})
