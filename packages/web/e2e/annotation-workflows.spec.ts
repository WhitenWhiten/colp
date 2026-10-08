import type { Page, Route } from '@playwright/test'
import { expect, test } from './fixtures'
import { installPassiveFeatureMocks } from './helpers/passive-feature-mocks'

const collectionId = 'annotation-e2e-collection'
const nodeId = 'medium'
const annotationPath = `/api/v1/collections/${collectionId}/annotations`
const itemPath = `${annotationPath}/annotation-note-1`

const view = (value: string, revision = 'revision-1') => ({
  id: 'annotation-note-1', collectionId,
  subject: { type: 'node', id: nodeId },
  type: 'note', format: 'plain', value, visibility: 'private',
  creator: { id: 'https://known.test/profiles/e2e', name: 'E2E User' },
  provenance: { kind: 'human' }, revision,
  createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', extensions: {},
})

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) })
}

function error(route: Route, status: number, code: string, recovery: string, extra = {}) {
  return json(route, { error: {
    code, message: code, requestId: 'annotation-e2e-request', recovery,
    sameRequestRetrySafe: recovery === 'same_request', precondition: null,
    currentEtag: null, retryAfterSeconds: null, fieldErrors: [], ...extra,
  } }, status)
}

async function installSession(page: Page) {
  await page.route('**/api/v1/session', (route) => json(route, {
    authenticated: true, csrfToken: 'annotation-e2e-csrf',
    idleExpiresAt: '2026-07-25T01:00:00.000Z', absoluteExpiresAt: '2026-07-26T00:00:00.000Z',
  }))
  await page.route('**/api/v1/me', (route) => json(route, {
    account: { id: 'account-e2e', email: 'e2e@known.test' },
    profile: { id: 'profile-e2e', handle: 'e2e', displayName: 'E2E User', avatarUrl: null },
  }))
  await installPassiveFeatureMocks(page)
  await page.route(`**/api/v1/collections/${collectionId}/editor*`, (route) => json(route, {
    collection: { id: collectionId, title: 'Annotations', kind: 'bookmarks', summary: null, visibility: 'private', rootNodeId: 'root', revision: '1', etag: '"c"', contentRevision: '1', contentEtag: '"cc"', policyRevision: '1', policyEtag: '"p"', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' },
    root: { id: 'root', collectionId, kind: 'folder', folderRole: 'root', parentId: null, position: null, title: 'Root', description: null, tags: [], visibility: 'inherit', revision: '1', etag: '"root"', readOnly: true, readOnlyReason: 'root_immutable', childrenRevision: '1', childrenEtag: '"children"', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z' },
    nodes: [{
      id: nodeId,
      collectionId,
      kind: 'bookmark',
      parentId: 'root',
      position: 'a',
      title: 'Annotation subject',
      description: null,
      url: 'https://example.com/medium',
      iconUrl: null,
      tags: [],
      visibility: 'inherit',
      revision: '1',
      etag: '"bookmark"',
      readOnly: false,
      readOnlyReason: null,
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
    }],
    capabilities: { updateCollection: true, managePublication: true, createNode: true, updateNode: true, moveNode: true, deleteNode: true },
    page: { snapshotId: 'annotation-e2e-snapshot', contentRevision: '1', policyRevision: '1', comparatorVersion: 'v1', expiresAt: '2026-07-26T00:00:00.000Z', returnedCount: 0, hasMore: false, nextCursor: null },
  }))
  await page.route(`**/api/v1/collections/${collectionId}/relations*`, (route) => json(route, {
    relations: [], page: { returnedCount: 0, hasMore: false, nextCursor: null },
  }))
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }))
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__KNOWN_FLAGS__ = { ...(window.__KNOWN_FLAGS__ ?? {}), readableReplica: true }
  })
  await installSession(page)
})

test('unknown save outcome replays the same command id and persists after refresh', async ({ page }) => {
  let value = 'Initial server note'
  let revision = 'revision-1'
  let patchAttempts = 0
  const commandIds: string[] = []
  await page.route(`**${annotationPath}*`, async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      return json(route, { annotations: [view(value, revision)], page: { returnedCount: 1, hasMore: false, nextCursor: null } })
    }
    return route.fallback()
  })
  await page.route(`**${itemPath}`, async (route) => {
    const request = route.request()
    if (request.method() !== 'PATCH') return route.fallback()
    patchAttempts += 1
    commandIds.push(request.headers()['known-command-id'] ?? '')
    if (patchAttempts === 1) return route.abort('connectionreset')
    value = (request.postDataJSON() as { value: string }).value
    revision = 'revision-2'
    return json(route, view(value, revision), 200, { ETag: `"${revision}"` })
  })

  await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  const note = page.getByRole('textbox', { name: 'Private note' })
  await expect(note).toHaveValue('Initial server note')
  await note.fill('Survives an uncertain commit')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'unknown')
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  expect(commandIds).toHaveLength(2)
  expect(commandIds[0]).toMatch(/^[0-9a-f-]{36}$/u)
  expect(commandIds[1]).toBe(commandIds[0])
  await page.reload()
  await expect(note).toHaveValue('Survives an uncertain commit')
})

test('412 refresh and 409 reuse require explicit recovery without losing the draft', async ({ page }) => {
  let phase: 'stale' | 'reuse' | 'success' = 'stale'
  const commandIds: string[] = []
  await page.route(`**${annotationPath}*`, (route) => json(route, {
    annotations: [view('Initial server note')], page: { returnedCount: 1, hasMore: false, nextCursor: null },
  }))
  await page.route(`**${itemPath}`, async (route) => {
    const request = route.request()
    if (request.method() === 'GET') return json(route, view('Concurrent server note', 'revision-2'))
    if (request.method() !== 'PATCH') return route.fallback()
    commandIds.push(request.headers()['known-command-id'] ?? '')
    if (phase === 'stale') {
      phase = 'reuse'
      return error(route, 412, 'precondition_failed', 'refresh_and_retry', { currentEtag: '"revision-2"' })
    }
    if (phase === 'reuse') {
      phase = 'success'
      return error(route, 409, 'command_id_reused', 'user_action')
    }
    return json(route, view('My reviewed draft', 'revision-3'))
  })

  await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
  const note = page.getByRole('textbox', { name: 'Private note' })
  await note.fill('My reviewed draft')
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'stale')
  await expect(note).toHaveValue('My reviewed draft')
  await page.getByRole('button', { name: 'Save my version', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'conflict')
  await page.getByRole('button', { name: 'Start new save', exact: true }).click()
  await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
  expect(new Set(commandIds).size).toBe(3)
})

test('captures desktop and narrow Annotation layouts without horizontal overflow', async ({ page }, testInfo) => {
  await page.route(`**${annotationPath}*`, (route) => json(route, {
    annotations: [view('A private annotation that remains readable at every supported viewport.')],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
  }))

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'narrow', width: 375, height: 720 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'saved')
    await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    const readerPath = testInfo.outputPath(`annotation-reader-${viewport.name}.png`)
    await page.screenshot({ path: readerPath, fullPage: true })
    await testInfo.attach(`annotation-reader-${viewport.name}`, { path: readerPath, contentType: 'image/png' })

    await page.goto(`/r/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    await expect(page.getByRole('region', { name: 'Annotations' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open reading view' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    const detailPath = testInfo.outputPath(`annotation-resource-detail-${viewport.name}.png`)
    await page.screenshot({ path: detailPath, fullPage: true })
    await testInfo.attach(`annotation-resource-detail-${viewport.name}`, { path: detailPath, contentType: 'image/png' })
  }
})

test.describe('narrow keyboard Annotation inspector', () => {
  test.use({ viewport: { width: 375, height: 720 } })

  test('keeps controls operable, prompts on dirty navigation, and never injects HTML', async ({ page }) => {
    await page.route(`**${annotationPath}*`, (route) => json(route, {
      annotations: [view('<script>window.pwned=true</script>')],
      page: { returnedCount: 1, hasMore: false, nextCursor: null },
    }))
    await page.goto(`/read/${nodeId}?collectionId=${collectionId}&subjectType=node`)
    await expect(page.getByRole('textbox', { name: 'Private note' })).toHaveValue('<script>window.pwned=true</script>')
    expect(await page.locator('script').filter({ hasText: 'window.pwned' }).count()).toBe(0)
    await page.getByRole('textbox', { name: 'Private note' }).focus()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Keyboard draft')
    await expect(page.getByTestId('annotation-save-state')).toHaveAttribute('data-save-state', 'dirty')
    await page.getByRole('link', { name: 'Library', exact: true }).last().click()
    const prompt = page.getByRole('dialog')
    await expect(prompt).toContainText('You have unsaved changes on this page.')
    await prompt.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/read/${nodeId}`, 'u'))
    const workspace = page.getByTestId('annotation-workspace')
    const box = await workspace.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
    await expect(page.getByRole('button', { name: 'Save note', exact: true })).toBeVisible()
  })
})
