import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { signInShared } from './auth-bootstrap'
import { enableReaderAcceptance } from './reader-bootstrap'
import { createDeskBookmark, openCollectionEditorAfterDeskCreate, selectCollectionVisibility } from './collection-bootstrap'

const controlUrl = process.env.KNOWN_REAL_STACK_CONTROL_URL
const controlToken = process.env.KNOWN_REAL_STACK_CONTROL_TOKEN
const apiOrigin = process.env.KNOWN_REAL_STACK_API_ORIGIN
const webBaseUrl = process.env.KNOWN_REAL_STACK_WEB_BASE_URL ?? ''
if (!controlUrl || !controlToken || !apiOrigin || !webBaseUrl) throw new Error('real-stack endpoints are required')

async function control<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`control ${path} failed (${response.status}): ${await response.text()}`)
  return response.json() as Promise<T>
}

async function login(page: Page): Promise<void> {
  await enableReaderAcceptance(page.context())
  await signInShared(page)
}

async function ensureProfileHandle(page: Page): Promise<void> {
  const accountId = await page.evaluate(async () => {
    const response = await fetch('/api/v1/me')
    if (!response.ok) throw new Error(`current account read failed: ${response.status}`)
    const body = await response.json() as { account: { id: string } }
    return body.account.id
  })
  await control('/annotation/ensure-profile-handle', {
    accountId,
    handle: 'phase2b-annotation-owner',
  })
}

async function createCollectionAndNode(page: Page): Promise<{ collectionId: string; nodeId: string }> {
  await page.getByLabel('Title').fill('Annotation acceptance collection')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  const collectionId = await openCollectionEditorAfterDeskCreate(page)
  await createDeskBookmark(page, 'Annotation acceptance resource', 'https://example.test/annotation-resource')
  const nodeId = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/collections/${id}/editor?limit=20`)
    const body = await response.json() as { nodes: Array<{ id: string; title: string }> }
    const node = body.nodes.find((candidate) => candidate.title === 'Annotation acceptance resource')
    if (!node) throw new Error('created node missing from authoritative editor read')
    return node.id
  }, collectionId)
  return { collectionId, nodeId }
}

async function installSecondSession(context: BrowserContext, collectionId: string): Promise<void> {
  await enableReaderAcceptance(context)
  const session = await control<{ cookieValue: string }>('/annotation/second-session', { collectionId })
  const secureCookieUrl = new URL(webBaseUrl)
  secureCookieUrl.protocol = 'https:'
  await context.addCookies([{
    name: '__Host-known_session', value: session.cookieValue,
    url: secureCookieUrl.origin, httpOnly: true, secure: true, sameSite: 'Lax',
  }])
}

test('real browser performs canonical Annotation CRUD, persistence, isolation, and public projection', async ({ page, browser }) => {
  await login(page)
  await ensureProfileHandle(page)
  const { collectionId, nodeId } = await createCollectionAndNode(page)
  await selectCollectionVisibility(page, 'Public')
  await page.getByLabel('Public address').fill(`annotation-e2e-${Date.now().toString(36)}`)
  await page.getByRole('button', { name: 'Save collection', exact: true }).click()
  await expect(page.getByText('Collection settings saved').first()).toBeVisible()
  const annotationResponses: Array<{ method: string; status: number }> = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.includes('/annotations')) {
      annotationResponses.push({ method: response.request().method(), status: response.status() })
    }
  })

  await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  const note = page.getByRole('textbox', { name: 'Private note' })
  await expect(note).toHaveValue('')
  await note.fill('Persisted private browser note')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  const created = await control<{ id: string; value: unknown; visibility: string; deletedAt: string | null }>(
    '/annotation/assert-live', { collectionId, nodeId, type: 'note', value: 'Persisted private browser note' },
  )
  expect(created.visibility).toBe('private')
  expect(created.deletedAt).toBeNull()

  await page.reload()
  await expect(note).toHaveValue('Persisted private browser note')
  await note.fill('Updated after authoritative refresh')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  const updated = await control<{ id: string; value: unknown; visibility: string; deletedAt: string | null }>(
    '/annotation/assert-live', { collectionId, nodeId, type: 'note', value: 'Updated after authoritative refresh' },
  )
  expect(updated.id).toBe(created.id)
  await page.reload()
  await expect(note).toHaveValue('Updated after authoritative refresh')

  // This bookmark has no readable-replica paragraphs, so the Reader correctly
  // exposes no paragraph Highlight button. Exercise the same real browser/API
  // boundary directly instead of waiting for a control that cannot exist.
  const createdHighlight = await page.evaluate(async ({ collectionId: id, nodeId: subjectId }) => {
    const sessionResponse = await fetch('/api/v1/session')
    const session = await sessionResponse.json() as { csrfToken: string }
    const response = await fetch(`/api/v1/collections/${id}/annotations?resourceType=node&resourceId=${subjectId}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken,
        'Known-Command-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({ type: 'highlight', format: 'json', value: { quote: 'orientation-0' }, visibility: 'private' }),
    })
    if (response.status !== 201) throw new Error(`highlight create failed: ${response.status}`)
    return response.json() as Promise<{ id: string; revision: string }>
  }, { collectionId, nodeId })
  await control(
    '/annotation/assert-live', { collectionId, nodeId, type: 'highlight', value: { quote: 'orientation-0' } },
  )
  const highlightDeleteStatus = await page.evaluate(async ({ collectionId: id, annotationId, revision }) => {
    const sessionResponse = await fetch('/api/v1/session')
    const session = await sessionResponse.json() as { csrfToken: string }
    const response = await fetch(`/api/v1/collections/${id}/annotations/${annotationId}`, {
      method: 'DELETE', headers: {
        'X-CSRF-Token': session.csrfToken, 'Known-Command-Id': crypto.randomUUID(),
        'If-Match': `"${revision}"`,
      },
    })
    return response.status
  }, { collectionId, annotationId: createdHighlight.id, revision: createdHighlight.revision })
  expect(highlightDeleteStatus).toBe(200)
  await control('/annotation/assert-deleted', { annotationId: createdHighlight.id })

  const secondContext = await browser.newContext()
  try {
    await installSecondSession(secondContext, collectionId)
    const secondPage = await secondContext.newPage()
    await secondPage.goto(`${webBaseUrl}/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    const secondNote = secondPage.getByRole('textbox', { name: 'Private note' })
    await expect(secondPage.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
    await expect(secondNote).toHaveValue('')
    await expect(secondPage.getByText('Updated after authoritative refresh')).toHaveCount(0)
    await secondNote.fill('Second user private browser note')
    await secondPage.getByRole('button', { name: 'Save note', exact: true }).click()
    await expect(secondPage.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
    await control('/annotation/assert-live', {
      collectionId, nodeId, type: 'note', value: 'Second user private browser note',
    })
    await secondPage.reload()
    await expect(secondNote).toHaveValue('Second user private browser note')
  } finally {
    await secondContext.close()
  }
  await page.reload()
  await expect(note).toHaveValue('Updated after authoritative refresh')

  const publicAnnotation = await page.evaluate(async ({ collectionId: id, nodeId: subjectId }) => {
    const sessionResponse = await fetch('/api/v1/session')
    const session = await sessionResponse.json() as { authenticated: boolean; csrfToken: string }
    const response = await fetch(`/api/v1/collections/${id}/annotations?resourceType=node&resourceId=${subjectId}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken,
        'Known-Command-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({ type: 'note', format: 'plain', value: 'public-annotation-evidence', visibility: 'public' }),
    })
    if (!response.ok) throw new Error(`public Annotation create failed: ${response.status} ${await response.text()}`)
    return response.json() as Promise<{ id: string }>
  }, { collectionId, nodeId })

  const anonymousContext = await browser.newContext()
  try {
    const anonymous = await anonymousContext.newPage()
    const projection = await anonymous.request.get(
      `${apiOrigin}/colp/v0.1/collections/${collectionId}/snapshot?include=annotations`,
      { headers: {
        Accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
        'Collection-Protocol-Version': '0.1',
      } },
    )
    expect(projection.status()).toBe(200)
    const body = await projection.json() as { annotations: Array<{ id: string; value: unknown }> }
    expect(body.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: publicAnnotation.id, value: 'public-annotation-evidence' }),
    ]))
    expect(body.annotations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.id }),
    ]))
  } finally {
    await anonymousContext.close()
  }

  await page.getByRole('button', { name: 'Delete note', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(note).toHaveValue('')
  await control('/annotation/assert-deleted', { annotationId: created.id })
  await page.reload()
  await expect(note).toHaveValue('')

  expect(annotationResponses).toEqual(expect.arrayContaining([
    { method: 'POST', status: 201 }, { method: 'PATCH', status: 200 }, { method: 'DELETE', status: 200 },
  ]))
})

test('controlled real HTTP produces request-not-arrived, commit-unknown, 412, and 409 recovery', async ({ page }) => {
  await login(page)
  await ensureProfileHandle(page)
  const { collectionId, nodeId } = await createCollectionAndNode(page)
  await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  const note = page.getByRole('textbox', { name: 'Private note' })
  await note.fill('Recovery baseline')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')

  const itemPattern = new RegExp(`/api/v1/collections/${collectionId}/annotations/[^/?]+$`, 'u')
  let requestNotArrived = true
  const requestNotArrivedCommands: string[] = []
  await page.route(itemPattern, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    requestNotArrivedCommands.push(route.request().headers()['known-command-id'] ?? '')
    if (requestNotArrived) {
      requestNotArrived = false
      return route.abort('connectionrefused')
    }
    return route.continue()
  })
  await note.fill('Request never arrived recovery')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'unknown')
  await control('/annotation/assert-live', {
    collectionId, nodeId, type: 'note', value: 'Recovery baseline',
  })
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  expect(requestNotArrivedCommands[1]).toBe(requestNotArrivedCommands[0])
  await page.unroute(itemPattern)

  let committedButHidden = true
  const commitUnknownCommands: string[] = []
  await page.route(itemPattern, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    commitUnknownCommands.push(route.request().headers()['known-command-id'] ?? '')
    if (committedButHidden) {
      committedButHidden = false
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      return route.abort('connectionreset')
    }
    return route.continue()
  })
  await note.fill('Commit succeeded but response was lost')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'unknown')
  await control('/annotation/assert-live', {
    collectionId, nodeId, type: 'note', value: 'Commit succeeded but response was lost',
  })
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  expect(commitUnknownCommands[1]).toBe(commitUnknownCommands[0])
  await page.unroute(itemPattern)

  let injectStale = true
  await page.route(itemPattern, async (route) => {
    if (route.request().method() !== 'PATCH' || !injectStale) return route.continue()
    injectStale = false
    const headers = { ...route.request().headers(), 'known-command-id': crypto.randomUUID() }
    const concurrent = await route.fetch({ headers, postData: JSON.stringify({ value: 'Concurrent real update', format: 'plain' }) })
    expect(concurrent.status()).toBe(200)
    return route.continue()
  })
  await note.fill('Stale recovery draft')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'stale')
  await page.getByRole('button', { name: 'Save my version', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  await page.unroute(itemPattern)

  let injectReuse = true
  await page.route(itemPattern, async (route) => {
    if (route.request().method() !== 'PATCH' || !injectReuse) return route.continue()
    injectReuse = false
    const first = await route.fetch({ postData: JSON.stringify({ value: 'Different fingerprint', format: 'plain' }) })
    expect(first.status()).toBe(200)
    const conflict = await route.fetch()
    expect(conflict.status()).toBe(409)
    return route.fulfill({ response: conflict })
  })
  await note.fill('Command reuse recovery draft')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'conflict')
  await page.getByRole('button', { name: 'Start new save', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
})
