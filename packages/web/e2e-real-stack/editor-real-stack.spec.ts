import { expect, test, type Page } from '@playwright/test'
import { signInShared } from './auth-bootstrap'
import {
  createDeskBookmark,
  openCollectionEditorAfterDeskCreate,
  openCollectionSettings,
  selectCollectionVisibility,
} from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN

if (!controlUrl || !controlToken) {
  throw new Error('real-stack control endpoint is required; run through the fail-closed harness')
}

async function control<T = void>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`real-stack control ${path} failed (${response.status}): ${await response.text()}`)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

async function browserProductRequest<T>(
  page: Page,
  request: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  return page.evaluate(async (input) => {
    const session = await fetch('/api/v1/session')
    const sessionBody = await session.json() as { authenticated?: boolean; csrfToken?: string }
    if (!session.ok || !sessionBody.authenticated || !sessionBody.csrfToken) {
      throw new Error(`session bootstrap failed (${session.status})`)
    }
    const response = await fetch(input.path, {
      method: input.method,
      headers: {
        ...(input.body === undefined ? {} : {
          'Content-Type': input.method === 'PATCH'
            ? 'application/merge-patch+json'
            : 'application/json',
        }),
        ...(input.method === 'GET' ? {} : {
          'X-CSRF-Token': sessionBody.csrfToken,
          'Known-Command-Id': crypto.randomUUID(),
        }),
        ...input.headers,
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${input.method} ${input.path} failed (${response.status}): ${text}`)
    return text === '' ? null : JSON.parse(text)
  }, request) as Promise<T>
}

test('Product editor publishes a browser-readable collection through the real API and PostgreSQL', async ({ page }) => {
  const editorContinuationRequests: string[] = []
  type ProjectionResponse = {
    phase: 'member' | 'anonymous'
    status: number
    cursor: string | null
    cacheControl: string | undefined
    vary: string | undefined
  }
  let projectionPhase: ProjectionResponse['phase'] | null = null
  const projectionResponses: Array<Promise<ProjectionResponse>> = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/editor') && url.searchParams.has('cursor')) {
      editorContinuationRequests.push(url.toString())
    }
  })
  page.on('response', (response) => {
    if (projectionPhase === null) return
    const url = new URL(response.url())
    if (url.pathname !== '/api/v1/collections/phase2-real-stack-collection') return
    const phase = projectionPhase
    projectionResponses.push((async () => {
      const headers = await response.allHeaders()
      return {
        phase,
        status: response.status(),
        cursor: url.searchParams.get('cursor'),
        cacheControl: headers['cache-control'],
        vary: headers.vary,
      }
    })())
  })

  await signInShared(page)
  await expect(page.getByText('Phase 1 Real Stack').first()).toBeVisible()

  await page.getByLabel('Title').fill('Real stack collection')
  await page.getByLabel('Summary (optional)').fill('Created from a real browser session')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const collectionId = await openCollectionEditorAfterDeskCreate(page)

  await page.getByRole('button', { name: 'Collection actions' }).click()
  await page.getByRole('menuitem', { name: 'Add folder' }).click()
  await page.getByLabel('Title').fill('Research folder')
  await page.locator('[data-testid="library-compose"] button[type="submit"]').click()
  await expect(page.getByText('Folder created').first()).toBeVisible()

  await createDeskBookmark(page, 'First bookmark', 'https://example.test/first')
  await createDeskBookmark(page, 'Second bookmark', 'https://example.test/second')

  await page.getByRole('button', { name: 'Actions for First bookmark' }).click()
  await page.getByRole('menuitem', { name: 'Edit details' }).click()
  await page.locator('#nd-title').fill('Edited bookmark')
  await page.locator('#nd-url').fill('https://example.test/edited')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('library-bookmarks')).toContainText('Edited bookmark')
  await page.getByRole('button', { name: 'Close editor', exact: true }).click()

  await page.getByRole('button', { name: 'Actions for Second bookmark' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByTestId('library-bookmarks')).not.toContainText('Second bookmark')

  await openCollectionSettings(page, collectionId)

  const editor = await browserProductRequest<{
    collection: { etag: string }
  }>(page, {
    method: 'GET',
    path: `/api/v1/collections/${collectionId}/editor?limit=1`,
  })
  await browserProductRequest(page, {
    method: 'PATCH',
    path: `/api/v1/collections/${collectionId}`,
    headers: { 'If-Match': editor.collection.etag },
    body: { title: 'Concurrent authoritative title', summary: 'Written by a second browser request' },
  })

  await page.locator('#ce-title').fill('Stale editor title')
  await page.getByRole('button', { name: 'Save collection', exact: true }).click()
  await expect(page.getByText('Conflict — refreshed. Re-apply your change.').first()).toBeVisible()
  await expect(page.locator('#ce-title')).toHaveValue('Concurrent authoritative title')
  await page.locator('#ce-title').fill('Conflict recovered title')
  await page.getByRole('button', { name: 'Save collection', exact: true }).click()
  await expect(page.getByText('Collection settings saved').first()).toBeVisible()

  const rootId = await page.evaluate(async ({ id, count }) => {
    const sessionResponse = await fetch('/api/v1/session')
    const session = await sessionResponse.json() as { authenticated?: boolean; csrfToken?: string }
    if (!session.authenticated || !session.csrfToken) throw new Error('authenticated session required')
    const firstPageResponse = await fetch(`/api/v1/collections/${id}/editor?limit=1`)
    const firstPage = await firstPageResponse.json() as { root: { id: string } }
    for (let index = 0; index < count; index += 1) {
      const response = await fetch(`/api/v1/collections/${id}/nodes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrfToken,
          'Known-Command-Id': crypto.randomUUID(),
        },
        body: JSON.stringify({
          parentId: firstPage.root.id,
          afterId: null,
          beforeId: null,
          node: {
            kind: 'bookmark',
            title: `Paging evidence ${String(index).padStart(3, '0')}`,
            url: `https://paging.example.test/${index}`,
            description: null,
            tags: [],
            visibility: 'inherit',
          },
        }),
      })
      if (!response.ok) {
        throw new Error(`paging seed ${index} failed (${response.status}): ${await response.text()}`)
      }
    }
    return firstPage.root.id
  }, { id: collectionId, count: 201 })

  await browserProductRequest(page, {
    method: 'POST',
    path: `/api/v1/collections/${collectionId}/nodes`,
    body: {
      parentId: rootId,
      afterId: null,
      beforeId: null,
      node: {
        kind: 'bookmark',
        title: 'Member-only paging evidence',
        url: 'https://paging.example.test/member-only',
        description: null,
        tags: [],
        visibility: 'protected',
      },
    },
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('library-workspace')).toBeVisible()
  await page.getByRole('dialog', { name: 'Edit collection', exact: true })
    .getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect.poll(async () => {
    const list = page.getByTestId('library-bookmarks')
    await list.evaluate(element => { element.scrollTop = element.scrollHeight })
    return list.textContent()
  }).toContain('Paging evidence 200')
  expect(editorContinuationRequests.length).toBeGreaterThan(0)
  await expect(page.getByText('Phase 1 Real Stack').first()).toBeVisible()

  const outboxBaseline = await control<{
    aggregateId: string
    commitOrdinal: string
    eventCount: number
  }>('/outbox/baseline', { aggregateId: collectionId })
  expect(outboxBaseline.aggregateId).toBe(collectionId)
  expect(outboxBaseline.eventCount).toBeGreaterThan(0)
  await control('/worker/stop')
  await openCollectionSettings(page, collectionId)
  await page.locator('#ce-summary').fill('Durable across worker restart')
  await page.getByRole('button', { name: 'Save collection', exact: true }).click()
  await expect(page.getByText('Collection settings saved').first()).toBeVisible()
  const pendingEvent = await control<{
    outboxId: string
    domainEventId: string
    eventType: string
    handlerName: string
    aggregateId: string
    commitOrdinal: string
    expectedSummary: string
  }>('/outbox/assert-new-pending-summary', {
    ...outboxBaseline,
    expectedSummary: 'Durable across worker restart',
  })
  expect(pendingEvent.eventType).toBe('collection.updated')
  expect(pendingEvent.handlerName).toBe('collection_updated_projection')
  expect(pendingEvent.aggregateId).toBe(collectionId)
  expect(pendingEvent.expectedSummary).toBe('Durable across worker restart')
  expect(BigInt(pendingEvent.commitOrdinal)).toBeGreaterThan(BigInt(outboxBaseline.commitOrdinal))
  const completion = await control<{
    projected: boolean
    outboxId: string
    domainEventId: string
  }>('/worker/restart-and-await', pendingEvent)
  expect(completion).toEqual({
    projected: true,
    outboxId: pendingEvent.outboxId,
    domainEventId: pendingEvent.domainEventId,
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('#ce-summary')).toHaveValue('Durable across worker restart')

  await control('/api-and-worker/restart-and-await', { aggregateId: collectionId })
  const restartedSession = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session')
    return {
      ok: response.ok,
      body: await response.json() as { authenticated?: boolean },
    }
  })
  expect(restartedSession.ok).toBe(true)
  expect(restartedSession.body.authenticated).toBe(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openCollectionSettings(page, collectionId)
  await expect(page.locator('#ce-title')).toHaveValue('Conflict recovered title')
  await expect(page.locator('#ce-summary')).toHaveValue('Durable across worker restart')
  await expect(page.getByTestId('library-bookmarks')).toContainText('Edited bookmark')
  await page.getByRole('dialog', { name: 'Edit collection', exact: true })
    .getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect.poll(async () => {
    const list = page.getByTestId('library-bookmarks')
    await list.evaluate(element => { element.scrollTop = element.scrollHeight })
    return list.textContent()
  }).toContain('Paging evidence 200')

  const publicationSlug = 'phase2-real-stack-collection'
  await selectCollectionVisibility(page, 'Public')
  await page.getByLabel('Public address').fill(publicationSlug)
  await page.getByRole('button', { name: 'Save collection', exact: true }).click()
  await expect(page.getByRole('link', { name: new RegExp(`/c/${publicationSlug}$`, 'u') })).toBeVisible()

  const membership = await control<{ membershipRole: string }>(
    '/collection/demote-owner-to-member',
    { aggregateId: collectionId },
  )
  expect(membership.membershipRole).toBe('viewer')
  projectionPhase = 'member'
  await page.goto(`/c/${publicationSlug}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('public-collection-page')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Conflict recovered title' })).toBeVisible()
  await expect(page.getByText('Member view', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /^Open Edited bookmark on/u })).toHaveAttribute(
    'href',
    'https://example.test/edited',
  )
  await expect(page.getByText('Paging evidence 200')).toBeVisible()
  await expect(page.getByText('Member-only paging evidence')).toBeVisible()

  const memberResponses = (await Promise.all(projectionResponses))
    .filter((response) => response.phase === 'member')
  expect(memberResponses.length).toBeGreaterThan(1)
  expect(memberResponses.some(({ cursor }) => cursor !== null)).toBe(true)
  for (const response of memberResponses) {
    expect(response.status).toBe(200)
    expect(response.cacheControl).toBe('private, no-store')
    expect(response.vary?.toLowerCase().split(',').map((field) => field.trim())).toContain('cookie')
  }

  await page.getByRole('button', { name: /Phase 1 Real Stack/u }).first().click()
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible()
  projectionPhase = 'anonymous'
  await page.goto(`/c/${publicationSlug}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('public-collection-page')).toBeVisible()
  await expect(page.getByText('Member view', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Edited bookmark')).toBeVisible()
  await expect(page.getByText('Paging evidence 200')).toBeVisible()
  await expect(page.getByText('Member-only paging evidence')).toHaveCount(0)

  const anonymousResponses = (await Promise.all(projectionResponses))
    .filter((response) => response.phase === 'anonymous')
  expect(anonymousResponses.length).toBeGreaterThan(1)
  expect(anonymousResponses.some(({ cursor }) => cursor !== null)).toBe(true)
  for (const response of anonymousResponses) {
    expect(response.status).toBe(200)
    expect(response.cacheControl).toBe('public, max-age=60, stale-while-revalidate=300')
    expect(response.vary?.toLowerCase().split(',').map((field) => field.trim())).toContain('cookie')
  }
  await page.goto(`/library/${collectionId}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('link', { name: 'Log in', exact: true }).first()).toBeVisible()
})
