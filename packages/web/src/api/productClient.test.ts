/**
 * P1-13: Canonical Product client — credentials, CSRF, Known-Command-Id,
 * session bootstrap, editor pagination, merge-patch, If-Match, recursive delete.
 *
 * Production: src/api/productClient.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient, ProductApiError } from './productClient'
import {
  clearCommandId,
  getOrCreateCommandId,
} from './commandId'
import { getCsrfToken, getSessionSnapshot } from './sessionStore'
import {
  createMemorySessionStorage,
  editorPageBody,
  installFetchMock,
  installSessionStorage,
  isUuidV4,
  jsonResponse,
  productErrorBody,
  requestHeaders,
  requestMethod,
  requestPathAndSearch,
  resetProductSession,
  seedAuthenticatedSession,
  type FetchCall,
} from './test-helpers'

const {
  bootstrapSession,
  createCollection,
  createCollectionNode,
  deleteCollectionNode,
  deleteSession,
  getCollectionEditorPage,
  getPublicCollectionPage,
  getPublicProfilePage,
  getMe,
  getSession,
  loadPublicCollectionSnapshot,
  moveCollectionNode,
  updateCollection,
  updateCollectionNode,
  updateMe,
  uploadAvatar,
} = productClient

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

const publicCollection = {
  id: 'col-public', slug: 'research-notes', title: 'Research notes', summary: null,
  kind: 'bookmarks' as const, rootNodeId: 'root-public',
  updatedAt: '2026-07-24T00:00:00.000Z', access: 'public' as const,
}

const publicRoot = {
  id: 'root-public', parentId: null, kind: 'root' as const, title: 'Contents',
  description: null, url: null, position: null,
}

function publicNode(id: string) {
  return {
    id, parentId: 'root-public', kind: 'bookmark' as const, title: id,
    description: null, url: `https://${id}.example`, position: id,
  }
}

describe('canonical productClient', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    restoreFetch = undefined
    resetProductSession()
  })

  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
    clearCommandId('create-collection:draft-1')
    clearCommandId('retry-create')
    clearCommandId('expired-create')
    clearCommandId('delete-folder:n-folder')
    clearCommandId('delete-node:n-leaf')
    clearCommandId('patch-collection:col-1')
    clearCommandId('create-node:col-1')
    clearCommandId('update-node:n-new')
    clearCommandId('move-node:n-new')
    clearCommandId('update-me:success')
    clearCommandId('update-me:conflict')
    clearCommandId('update-me:invalid')
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  // ---------------------------------------------------------------------------
  // Session bootstrap
  // ---------------------------------------------------------------------------

  it('getSession bootstraps with credentials and no CSRF/command headers', async () => {
    const mock = installFetchMock(() =>
      jsonResponse({
        authenticated: true,
        csrfToken: 'csrf-session-1',
        idleExpiresAt: '2026-07-23T00:00:00.000Z',
        absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
      }),
    )
    restoreFetch = mock.restore

    const session = await getSession({ maxRetries: 0 })
    expect(session.authenticated).toBe(true)
    if (session.authenticated) {
      expect(session.csrfToken).toBe('csrf-session-1')
    }
    expect(getCsrfToken()).toBe('csrf-session-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/session')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
  })

  it('getMe requires credentials and hits /api/v1/me', async () => {
    seedAuthenticatedSession()
    const mock = installFetchMock(() =>
      jsonResponse({
        account: { id: 'acc-1', email: 'ada@example.com' },
        profile: {
          id: 'prof-1',
          handle: 'ada',
          displayName: 'Ada',
          avatarUrl: null,
          about: '',
        },
      }),
    )
    restoreFetch = mock.restore

    const me = await getMe({ maxRetries: 0 })
    expect(me.account.id).toBe('acc-1')
    expect(me.profile.about).toBe('')
    expect(getSessionSnapshot().me?.account.id).toBe('acc-1')
    expect(getSessionSnapshot().me?.profile.about).toBe('')

    const call = lastCall(mock.calls)
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me')
    expect(call.init?.credentials).toBe('include')
  })

  it('keeps the explicit local mock session flow on the canonical client', async () => {
    vi.stubEnv('VITE_MOCK_SESSION', 'true')
    const mock = installFetchMock(() => {
      throw new Error('mock session must not call the backend')
    })
    restoreFetch = mock.restore

    const session = await getSession({ maxRetries: 0 })
    const me = await getMe({ maxRetries: 0 })

    expect(session).toMatchObject({
      authenticated: true,
      csrfToken: 'mock-csrf-token',
    })
    expect(me).toMatchObject({
      account: { id: 'mock-account-1' },
      profile: { id: 'mock-profile-1', handle: 'dev', about: '' },
    })
    expect(getSessionSnapshot()).toMatchObject({
      authenticated: true,
      csrfToken: 'mock-csrf-token',
      me,
    })

    await deleteSession()
    expect(getSessionSnapshot().authenticated).toBe(false)
    expect(mock.calls).toHaveLength(0)
  })

  it('bootstrapSession returns me=null when unauthenticated without calling getMe', async () => {
    const mock = installFetchMock(() => jsonResponse({ authenticated: false }))
    restoreFetch = mock.restore

    const result = await bootstrapSession({ maxRetries: 0 })
    expect(result.session.authenticated).toBe(false)
    expect(result.me).toBeNull()
    expect(mock.calls).toHaveLength(1)
  })

  it('bootstrapSession records occupancy without calling getMe', async () => {
    const mock = installFetchMock(() => jsonResponse({ authenticated: false, verificationRequired: true }))
    restoreFetch = mock.restore

    const result = await bootstrapSession({ maxRetries: 0 })
    expect(result.session.authenticated).toBe(false)
    expect(result.me).toBeNull()
    expect(getSessionSnapshot().verificationRequired).toBe(true)
    expect(mock.calls).toHaveLength(1)
  })

  it('deleteSession sends X-CSRF-Token + credentials without Known-Command-Id', async () => {
    seedAuthenticatedSession('csrf-logout')
    const mock = installFetchMock(() => new Response(null, { status: 204 }))
    restoreFetch = mock.restore

    await deleteSession()
    expect(getCsrfToken()).toBeNull()

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('DELETE')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/session')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-logout')
    expect(headers.get('Known-Command-Id')).toBeNull()
  })

  it('deleteSession surfaces a failed DELETE instead of reporting success (R15-21)', async () => {
    seedAuthenticatedSession('csrf-logout')
    const unavailable = installFetchMock(() => jsonResponse(productErrorBody({ code: 'internal_error' }), { status: 503 }))
    restoreFetch = unavailable.restore
    await expect(deleteSession()).rejects.toMatchObject({ status: 503 })
    unavailable.restore()

    seedAuthenticatedSession('csrf-logout')
    const offline = installFetchMock(() => {
      throw new TypeError('Failed to fetch')
    })
    restoreFetch = offline.restore
    await expect(deleteSession()).rejects.toBeInstanceOf(ProductApiError)
  })

  it('deleteSession re-reads the session when no CSRF token is in memory (R15-21)', async () => {
    const mock = installFetchMock((_input, init) => (
      requestMethod({ input: _input, init }) === 'GET'
        ? jsonResponse({ authenticated: true, csrfToken: 'csrf-fresh' })
        : new Response(null, { status: 204 })
    ))
    restoreFetch = mock.restore

    await deleteSession()
    expect(mock.calls.map(requestMethod)).toEqual(['GET', 'DELETE'])
    expect(requestHeaders(lastCall(mock.calls)).get('X-CSRF-Token')).toBe('csrf-fresh')
  })

  it('deleteSession retries exactly once after a CSRF 403 (R15-21)', async () => {
    seedAuthenticatedSession('csrf-stale')
    const mock = installFetchMock((_input, init) => (
      requestMethod({ input: _input, init }) === 'GET'
        ? jsonResponse({ authenticated: true, csrfToken: 'csrf-fresh' })
        : jsonResponse(productErrorBody({ code: 'csrf_failed' }), { status: 403 })
    ))
    restoreFetch = mock.restore

    await expect(deleteSession()).rejects.toMatchObject({ code: 'csrf_failed' })
    expect(mock.calls.map(requestMethod)).toEqual(['DELETE', 'GET', 'DELETE'])
    expect(requestHeaders(mock.calls[2]!).get('X-CSRF-Token')).toBe('csrf-fresh')
  })

  it('updateMe sends the authenticated mutation and immediately updates the session handle', async () => {
    seedAuthenticatedSession('csrf-profile')
    const mock = installFetchMock(() => jsonResponse({
      account: { id: 'acc-1', email: 'ada@example.com' },
      profile: { id: 'prof-1', handle: 'ada_new', displayName: 'Ada New', avatarUrl: 'https://cdn.example.test/ada.png', about: 'I collect bookmarks.' },
    }))
    restoreFetch = mock.restore

    const updated = await updateMe(
      { handle: 'Ada_New', displayName: 'Ada New', avatarUrl: 'https://cdn.example.test/ada.png', about: 'I collect bookmarks.' },
      { intentId: 'update-me:success', maxRetries: 0 },
    )
    expect(updated.profile.handle).toBe('ada_new')
    expect(updated.profile.avatarUrl).toBe('https://cdn.example.test/ada.png')
    expect(updated.profile.about).toBe('I collect bookmarks.')
    expect(getSessionSnapshot().me?.profile.handle).toBe('ada_new')
    expect(getSessionSnapshot().me?.profile.avatarUrl).toBe('https://cdn.example.test/ada.png')
    expect(getSessionSnapshot().me?.profile.about).toBe('I collect bookmarks.')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('PATCH')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me')
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({ handle: 'Ada_New', displayName: 'Ada New', avatarUrl: 'https://cdn.example.test/ada.png', about: 'I collect bookmarks.' })
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-profile')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
  })

  it('uploadAvatar sends the raw image to /api/v1/me/avatar and applies the returned me', async () => {
    seedAuthenticatedSession('csrf-avatar')
    const mock = installFetchMock(() => jsonResponse({
      account: { id: 'acc-1', email: 'ada@example.com' },
      profile: { id: 'prof-1', handle: 'ada', displayName: 'Ada', avatarUrl: 'https://cdn.example.test/avatars/abc.png' },
    }))
    restoreFetch = mock.restore

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    const updated = await uploadAvatar(
      file,
      { intentId: 'update-avatar:success', maxRetries: 0 },
    )
    expect(updated.profile.avatarUrl).toBe('https://cdn.example.test/avatars/abc.png')
    expect(getSessionSnapshot().me?.profile.avatarUrl).toBe('https://cdn.example.test/avatars/abc.png')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/avatar')
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.body).toBe(file)
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-avatar')
    expect(headers.get('Content-Type')).toBe('image/png')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
  })

  it('updateMe preserves 409 handle conflict and 422 field errors for Settings', async () => {
    seedAuthenticatedSession('csrf-profile-errors')
    let request = 0
    const mock = installFetchMock(() => {
      request += 1
      if (request === 1) return jsonResponse(productErrorBody({ code: 'handle_taken' }), { status: 409 })
      if (request === 2) {
        return jsonResponse(productErrorBody({
          code: 'invalid_handle',
          fieldErrors: [{ path: '/handle', code: 'invalid_handle', message: 'invalid handle' }],
        }), { status: 422 })
      }
      return jsonResponse(productErrorBody({
        code: 'invalid_about',
        fieldErrors: [{ path: '/about', code: 'invalid_about', message: 'invalid about' }],
      }), { status: 422 })
    })
    restoreFetch = mock.restore

    await expect(updateMe(
      { handle: 'taken', displayName: 'Ada' },
      { intentId: 'update-me:conflict', maxRetries: 0 },
    )).rejects.toMatchObject({ status: 409, code: 'handle_taken' })
    await expect(updateMe(
      { handle: '*', displayName: 'Ada' },
      { intentId: 'update-me:invalid', maxRetries: 0 },
    )).rejects.toMatchObject({
      status: 422,
      code: 'invalid_handle',
      fieldErrors: [{ path: '/handle', code: 'invalid_handle', message: 'invalid handle' }],
    })
    await expect(updateMe(
      { handle: 'ada', displayName: 'Ada', about: '   ' },
      { intentId: 'update-me:invalid-about', maxRetries: 0 },
    )).rejects.toMatchObject({
      status: 422,
      code: 'invalid_about',
      fieldErrors: [{ path: '/about', code: 'invalid_about', message: 'invalid about' }],
    })
  })

  it('does not let a session bootstrap repopulate the store after logout starts', async () => {
    seedAuthenticatedSession('csrf-race')
    let resolveSession!: (response: Response) => void
    const sessionResponse = new Promise<Response>((resolve) => { resolveSession = resolve })
    const mock = installFetchMock((input, init) => {
      const path = requestPathAndSearch({ input, init }).pathname
      if (path === '/api/v1/session' && requestMethod({ input, init }) === 'GET') return sessionResponse
      if (path === '/api/v1/me') throw new Error('stale bootstrap must not request /me')
      return new Response(null, { status: 204 })
    })
    restoreFetch = mock.restore
    const staleBootstrap = bootstrapSession({ maxRetries: 0 })
    await Promise.resolve()
    await deleteSession({ maxRetries: 0 })
    expect(getSessionSnapshot()).toMatchObject({ authenticated: false, csrfToken: null, me: null })
    resolveSession(jsonResponse({ authenticated: true, csrfToken: 'stale-csrf', idleExpiresAt: '2026-07-25T00:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' }))
    await expect(staleBootstrap).rejects.toMatchObject({ name: 'AbortError' })
    expect(getSessionSnapshot()).toMatchObject({ authenticated: false, csrfToken: null, me: null })
    expect(mock.calls.filter((call) => requestPathAndSearch(call).pathname === '/api/v1/me')).toHaveLength(0)
  })

  it('keeps both views when an interleaved /me read finishes after /session', async () => {
    // The two reads are independent and the session read is a prerequisite of
    // the me read, so a caller legitimately starts /me while /session is still
    // in flight. A single shared generation counter made whichever started
    // later cancel the other's write, leaving the view on 'loading' with a null
    // user even though both responses arrived.
    seedAuthenticatedSession('csrf-interleaved')
    let resolveSession!: (response: Response) => void
    const sessionResponse = new Promise<Response>((resolve) => { resolveSession = resolve })
    installFetchMock((input, init) => {
      const path = requestPathAndSearch({ input, init }).pathname
      if (path === '/api/v1/session' && requestMethod({ input, init }) === 'GET') return sessionResponse
      if (path === '/api/v1/me') {
        return jsonResponse({ account: { id: 'interleaved-account', email: 'interleaved@test' },
          profile: { id: 'interleaved-profile', handle: 'interleaved', displayName: 'Interleaved', avatarUrl: null } })
      }
      return new Response(null, { status: 204 })
    })
    const session = productClient.getSession({ maxRetries: 0 })
    const me = productClient.getMe({ maxRetries: 0 })
    resolveSession(jsonResponse({ authenticated: true, csrfToken: 'csrf-interleaved',
      idleExpiresAt: '2026-07-25T00:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' }))
    expect((await session).authenticated).toBe(true)
    expect((await me).profile.handle).toBe('interleaved')
    // The session write must have survived the interleaving.
    expect(getSessionSnapshot()).toMatchObject({ authenticated: true })
  })

  it('discards a late /me response when logout starts after /session completes', async () => {
    seedAuthenticatedSession('csrf-me-race')
    let resolveMe!: (response: Response) => void
    const meResponse = new Promise<Response>((resolve) => { resolveMe = resolve })
    const mock = installFetchMock((input, init) => {
      const path = requestPathAndSearch({ input, init }).pathname
      if (path === '/api/v1/session' && requestMethod({ input, init }) === 'GET') {
        return jsonResponse({ authenticated: true, csrfToken: 'refreshed-csrf', idleExpiresAt: '2026-07-25T00:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
      }
      if (path === '/api/v1/me') return meResponse
      return new Response(null, { status: 204 })
    })
    restoreFetch = mock.restore
    const staleBootstrap = bootstrapSession({ maxRetries: 0 })
    await vi.waitFor(() => expect(mock.calls.some((call) => requestPathAndSearch(call).pathname === '/api/v1/me')).toBe(true))
    await deleteSession({ maxRetries: 0 })
    resolveMe(jsonResponse({ account: { id: 'stale-account', email: 'stale@test' }, profile: { id: 'stale-profile', handle: 'stale', displayName: 'Stale', avatarUrl: null } }))
    await expect(staleBootstrap).rejects.toMatchObject({ name: 'AbortError' })
    expect(getSessionSnapshot()).toMatchObject({ authenticated: false, csrfToken: null, me: null })
  })

  // ---------------------------------------------------------------------------
  // createCollection: command id + CSRF + credentials
  // ---------------------------------------------------------------------------

  it('createCollection sends Known-Command-Id + X-CSRF-Token + credentials', async () => {
    seedAuthenticatedSession('csrf-write')
    const commandId = getOrCreateCommandId('create-collection:draft-1')
    const mock = installFetchMock(() =>
      jsonResponse(
        {
          collection: {
            id: 'col-1',
            kind: 'bookmarks',
            title: 'Reading',
            summary: null,
            visibility: 'private',
            rootNodeId: 'root-1',
            revision: 1,
            etag: '"c-1"',
            contentRevision: 1,
            contentEtag: '"cc-1"',
            policyRevision: 1,
            policyEtag: '"p-1"',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
          },
          root: {
            id: 'root-1',
            kind: 'folder',
            folderRole: 'root',
            title: 'Root',
            description: null,
            tags: [],
            visibility: 'inherit',
            revision: 1,
            etag: '"r-1"',
            childrenRevision: 1,
          },
        },
        {
          status: 201,
          headers: {
            Location: '/api/v1/collections/col-1',
            ETag: '"c-1"',
          },
        },
      ),
    )
    restoreFetch = mock.restore

    const result = await createCollection(
      { kind: 'bookmarks', title: 'Reading', summary: null },
      { intentId: 'create-collection:draft-1', maxRetries: 0 },
    )
    expect(result.collection.id).toBe('col-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/collections')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-write')
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
  })

  it('createCollection fails closed when CSRF is missing (no fake success)', async () => {
    // No seedAuthenticatedSession → requireCsrf re-bootstraps session; still unauthenticated → 401
    const mock = installFetchMock(() => jsonResponse({ authenticated: false }))
    restoreFetch = mock.restore

    await expect(
      createCollection(
        { kind: 'bookmarks', title: 'X', summary: null },
        { intentId: 'create-collection:draft-1', maxRetries: 0 },
      ),
    ).rejects.toMatchObject({ status: 401 })
    // Must not POST /collections with a synthetic success
    expect(
      mock.calls.some((c) => requestPathAndSearch(c).pathname === '/api/v1/collections'),
    ).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // command_in_progress: auto-retry reuses same Known-Command-Id
  // ---------------------------------------------------------------------------

  it('auto-retry after command_in_progress reuses the same Known-Command-Id', async () => {
    seedAuthenticatedSession('csrf-write')
    const intentKey = 'retry-create'
    const commandId = getOrCreateCommandId(intentKey)
    let attempts = 0

    const mock = installFetchMock(() => {
      attempts += 1
      if (attempts === 1) {
        return jsonResponse(
          productErrorBody({
            code: 'command_in_progress',
            recovery: 'same_request',
            sameRequestRetrySafe: true,
            retryAfterSeconds: 0,
          }),
          {
            status: 409,
            headers: { 'Retry-After': '0' },
          },
        )
      }
      return jsonResponse(
        {
          collection: {
            id: 'col-2',
            kind: 'mixed',
            title: 'Retry',
            summary: null,
            visibility: 'private',
            rootNodeId: 'root-2',
            revision: 1,
            etag: '"c-2"',
            contentRevision: 1,
            contentEtag: '"cc-2"',
            policyRevision: 1,
            policyEtag: '"p-2"',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
          },
          root: {
            id: 'root-2',
            kind: 'folder',
            folderRole: 'root',
            title: 'Root',
            description: null,
            tags: [],
            visibility: 'inherit',
            revision: 1,
            etag: '"r-2"',
            childrenRevision: 1,
          },
        },
        { status: 201, headers: { ETag: '"c-2"' } },
      )
    })
    restoreFetch = mock.restore

    const result = await createCollection(
      { kind: 'mixed', title: 'Retry', summary: null },
      { intentId: intentKey, maxRetries: 2 },
    )
    expect(result.collection.id).toBe('col-2')
    expect(mock.calls.length).toBeGreaterThanOrEqual(2)

    const firstHeaders = requestHeaders(mock.calls[0]!)
    const secondHeaders = requestHeaders(mock.calls[1]!)
    expect(firstHeaders.get('Known-Command-Id')).toBe(commandId)
    expect(secondHeaders.get('Known-Command-Id')).toBe(commandId)
  })

  // ---------------------------------------------------------------------------
  // Editor pagination — opaque cursor only after first page
  // ---------------------------------------------------------------------------

  it('getCollectionEditorPage first page may send limit and must not send cursor', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() =>
      jsonResponse(
        editorPageBody({
          page: {
            snapshotId: 'snap-1',
            contentRevision: 1,
            policyRevision: 1,
            comparatorVersion: 'v1',
            expiresAt: '2026-07-22T12:00:00.000Z',
            returnedCount: 0,
            hasMore: true,
            nextCursor: 'opaque-page-2',
          },
        }),
      ),
    )
    restoreFetch = mock.restore

    const page = await getCollectionEditorPage('col-1', { limit: 200 }, { maxRetries: 0 })
    expect(page.page.nextCursor).toBe('opaque-page-2')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(call.init?.credentials).toBe('include')
    const { pathname, searchParams } = requestPathAndSearch(call)
    expect(pathname).toBe('/api/v1/collections/col-1/editor')
    expect(searchParams.get('limit')).toBe('200')
    expect(searchParams.has('cursor')).toBe(false)
  })

  it('getCollectionEditorPage subsequent pages send only opaque cursor (no limit)', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(
        editorPageBody({
          nodes: [{ id: 'n-1', kind: 'bookmark', title: 'A', url: 'https://a.example' }],
          page: {
            snapshotId: 'snap-1',
            contentRevision: 1,
            policyRevision: 1,
            comparatorVersion: 'v1',
            expiresAt: '2026-07-22T12:00:00.000Z',
            returnedCount: 1,
            hasMore: false,
            nextCursor: null,
          },
        }),
      ),
    )
    restoreFetch = mock.restore

    await getCollectionEditorPage('col-1', { cursor: 'opaque-page-2' }, { maxRetries: 0 })

    const { pathname, searchParams } = requestPathAndSearch(lastCall(mock.calls))
    expect(pathname).toBe('/api/v1/collections/col-1/editor')
    expect(searchParams.get('cursor')).toBe('opaque-page-2')
    expect(searchParams.has('limit')).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // recursive delete requires If-Content-Match; If-Match always
  // ---------------------------------------------------------------------------

  it('deleteCollectionNode recursive=true sends If-Match and If-Content-Match', async () => {
    seedAuthenticatedSession('csrf-write')
    const intentKey = 'delete-folder:n-folder'
    const commandId = getOrCreateCommandId(intentKey)
    const mock = installFetchMock(() =>
      jsonResponse(
        {
          receipt: {
            resourceType: 'node',
            targetId: 'n-folder',
            collectionId: 'col-1',
            scope: 'subtree',
            deletedAt: '2026-07-22T00:00:00.000Z',
            deleteRevision: 2,
            operationId: 'op-1',
            affectedCount: 3,
            purgeAfter: '2026-08-22T00:00:00.000Z',
          },
          parent: { id: 'root-1', childrenRevision: 2, childrenEtag: '"ch-2"' },
          fence: {
            contentRevision: 2,
            contentEtag: '"cc-2"',
            policyRevision: 1,
            policyEtag: '"p-1"',
          },
        },
        { status: 200 },
      ),
    )
    restoreFetch = mock.restore

    await deleteCollectionNode('col-1', 'n-folder', '"node-etag-1"', {
      intentId: intentKey,
      recursive: true,
      ifContentMatch: '"content-etag-9"',
      maxRetries: 0,
    })

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('DELETE')
    const { pathname, searchParams } = requestPathAndSearch(call)
    expect(pathname).toBe('/api/v1/collections/col-1/nodes/n-folder')
    expect(searchParams.get('recursive')).toBe('true')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-write')
    expect(headers.get('If-Match')).toBe('"node-etag-1"')
    expect(headers.get('If-Content-Match')).toBe('"content-etag-9"')
  })

  it('deleteCollectionNode recursive=true without ifContentMatch fails closed', async () => {
    seedAuthenticatedSession('csrf-write')
    const mock = installFetchMock(() => jsonResponse({}, { status: 200 }))
    restoreFetch = mock.restore

    await expect(
      deleteCollectionNode('col-1', 'n-folder', '"node-etag-1"', {
        intentId: 'delete-folder:n-folder',
        recursive: true,
        maxRetries: 0,
      }),
    ).rejects.toMatchObject({ status: 428 })
    expect(mock.calls).toHaveLength(0)
  })

  it('deleteCollectionNode recursive=false does not send If-Content-Match', async () => {
    seedAuthenticatedSession('csrf-write')
    const intentKey = 'delete-node:n-leaf'
    getOrCreateCommandId(intentKey)
    const mock = installFetchMock(() =>
      jsonResponse(
        {
          receipt: {
            resourceType: 'node',
            targetId: 'n-leaf',
            collectionId: 'col-1',
            scope: 'single',
            deletedAt: '2026-07-22T00:00:00.000Z',
            deleteRevision: 2,
            operationId: 'op-2',
            affectedCount: 1,
            purgeAfter: '2026-08-22T00:00:00.000Z',
          },
          parent: { id: 'root-1', childrenRevision: 2, childrenEtag: '"ch-2"' },
          fence: {
            contentRevision: 2,
            contentEtag: '"cc-2"',
            policyRevision: 1,
            policyEtag: '"p-1"',
          },
        },
        { status: 200 },
      ),
    )
    restoreFetch = mock.restore

    await deleteCollectionNode('col-1', 'n-leaf', '"node-etag-2"', {
      intentId: intentKey,
      recursive: false,
      maxRetries: 0,
    })

    const headers = requestHeaders(lastCall(mock.calls))
    expect(headers.get('If-Match')).toBe('"node-etag-2"')
    expect(headers.get('If-Content-Match')).toBeNull()
    const { searchParams } = requestPathAndSearch(lastCall(mock.calls))
    expect(searchParams.get('recursive')).not.toBe('true')
  })

  // ---------------------------------------------------------------------------
  // merge-patch + If-Match + mutations
  // ---------------------------------------------------------------------------

  it('updateCollection sends merge-patch, If-Match, command id, and CSRF', async () => {
    seedAuthenticatedSession('csrf-write')
    const intentKey = 'patch-collection:col-1'
    const commandId = getOrCreateCommandId(intentKey)
    const mock = installFetchMock(() =>
      jsonResponse(
        {
          collection: {
            id: 'col-1',
            kind: 'bookmarks',
            title: 'Renamed',
            summary: null,
            visibility: 'private',
            rootNodeId: 'root-1',
            revision: 2,
            etag: '"c-2"',
            contentRevision: 1,
            contentEtag: '"cc-1"',
            policyRevision: 1,
            policyEtag: '"p-1"',
            createdAt: '2026-07-22T00:00:00.000Z',
            updatedAt: '2026-07-22T01:00:00.000Z',
          },
        },
        { status: 200, headers: { ETag: '"c-2"' } },
      ),
    )
    restoreFetch = mock.restore

    await updateCollection(
      'col-1',
      { title: 'Renamed' },
      '"c-1"',
      { intentId: intentKey, maxRetries: 0 },
    )

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('PATCH')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/collections/col-1')
    const headers = requestHeaders(call)
    expect(headers.get('Content-Type')).toMatch(/application\/merge-patch\+json/i)
    expect(headers.get('If-Match')).toBe('"c-1"')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-write')
    expect(call.init?.credentials).toBe('include')
  })

  it('create/update/move node attach command + CSRF headers; update/move send If-Match', async () => {
    seedAuthenticatedSession('csrf-write')
    const mock = installFetchMock(() =>
      jsonResponse(
        {
          node: {
            id: 'n-new',
            kind: 'folder',
            title: 'Folder',
            description: null,
            tags: [],
            visibility: 'inherit',
            revision: 1,
            etag: '"n-1"',
            childrenRevision: 0,
            parentId: 'root-1',
          },
          parent: { id: 'root-1', childrenRevision: 2, childrenEtag: '"ch-2"' },
          fence: {
            contentRevision: 2,
            contentEtag: '"cc-2"',
            policyRevision: 1,
            policyEtag: '"p-1"',
          },
        },
        { status: 201, headers: { ETag: '"n-1"' } },
      ),
    )
    restoreFetch = mock.restore

    const createIntent = 'create-node:col-1'
    const createId = getOrCreateCommandId(createIntent)
    await createCollectionNode(
      'col-1',
      {
        parentId: 'root-1',
        afterId: null,
        beforeId: null,
        node: {
          kind: 'folder',
          title: 'Folder',
          description: null,
          tags: [],
          visibility: 'inherit',
        },
      },
      { intentId: createIntent, maxRetries: 0 },
    )
    expect(requestMethod(mock.calls[0]!)).toBe('POST')
    expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe(
      '/api/v1/collections/col-1/nodes',
    )
    expect(requestHeaders(mock.calls[0]!).get('Known-Command-Id')).toBe(createId)

    // Switch handler body for update/move (status 200)
    restoreFetch()
    const mock2 = installFetchMock(() =>
      jsonResponse(
        {
          node: {
            id: 'n-new',
            kind: 'folder',
            title: 'Folder 2',
            description: null,
            tags: [],
            visibility: 'inherit',
            revision: 2,
            etag: '"n-2"',
            childrenRevision: 0,
            parentId: 'root-1',
          },
          parent: { id: 'root-1', childrenRevision: 3, childrenEtag: '"ch-3"' },
          sourceParent: { id: 'root-1', childrenRevision: 3, childrenEtag: '"ch-3"' },
          targetParent: { id: 'root-1', childrenRevision: 3, childrenEtag: '"ch-3"' },
          fence: {
            contentRevision: 2,
            contentEtag: '"cc-2"',
            policyRevision: 1,
            policyEtag: '"p-1"',
          },
        },
        { status: 200 },
      ),
    )
    restoreFetch = mock2.restore

    const updateIntent = 'update-node:n-new'
    const updateId = getOrCreateCommandId(updateIntent)
    await updateCollectionNode(
      'col-1',
      'n-new',
      { title: 'Folder 2' },
      '"n-1"',
      { intentId: updateIntent, maxRetries: 0 },
    )
    expect(requestMethod(mock2.calls[0]!)).toBe('PATCH')
    expect(requestPathAndSearch(mock2.calls[0]!).pathname).toBe(
      '/api/v1/collections/col-1/nodes/n-new',
    )
    expect(requestHeaders(mock2.calls[0]!).get('Known-Command-Id')).toBe(updateId)
    expect(requestHeaders(mock2.calls[0]!).get('If-Match')).toBe('"n-1"')
    expect(requestHeaders(mock2.calls[0]!).get('Content-Type')).toMatch(
      /application\/merge-patch\+json/i,
    )

    const moveIntent = 'move-node:n-new'
    const moveId = getOrCreateCommandId(moveIntent)
    await moveCollectionNode(
      'col-1',
      'n-new',
      {
        newParentId: 'root-1',
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: '1',
        baseTargetParentRevision: '1',
      },
      '"n-2"',
      { intentId: moveIntent, maxRetries: 0 },
    )
    expect(requestMethod(mock2.calls[1]!)).toBe('POST')
    expect(requestPathAndSearch(mock2.calls[1]!).pathname).toBe(
      '/api/v1/collections/col-1/nodes/n-new/move',
    )
    expect(requestHeaders(mock2.calls[1]!).get('Known-Command-Id')).toBe(moveId)
    expect(requestHeaders(mock2.calls[1]!).get('If-Match')).toBe('"n-2"')
  })

  // ---------------------------------------------------------------------------
  // Error propagation — no silent re-execute / reauth mapping
  // ---------------------------------------------------------------------------

  it('propagates command_result_expired without auto re-executing a new command', async () => {
    seedAuthenticatedSession('csrf-write')
    const intentKey = 'expired-create'
    getOrCreateCommandId(intentKey)
    const mock = installFetchMock(() =>
      jsonResponse(
        productErrorBody({
          code: 'command_result_expired',
          recovery: 'user_action',
        }),
        { status: 410 },
      ),
    )
    restoreFetch = mock.restore

    await expect(
      createCollection(
        { kind: 'bookmarks', title: 'Old', summary: null },
        { intentId: intentKey, maxRetries: 3 },
      ),
    ).rejects.toMatchObject({
      code: 'command_result_expired',
    })
    // Not auto-retried as same_request
    expect(mock.calls).toHaveLength(1)
  })

  it('propagates authentication_required from getMe', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(
        productErrorBody({
          code: 'authentication_required',
          recovery: 'user_action',
        }),
        { status: 401 },
      ),
    )
    restoreFetch = mock.restore

    await expect(getMe({ maxRetries: 0 })).rejects.toMatchObject({
      code: 'authentication_required',
      isAuthRequired: true,
    })
  })

  it('maps snapshot_expired on editor page load (no fake empty tree)', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(
        productErrorBody({
          code: 'snapshot_expired',
          recovery: 'restart_from_first_page',
        }),
        { status: 409 },
      ),
    )
    restoreFetch = mock.restore

    await expect(
      getCollectionEditorPage('col-1', { cursor: 'stale-cursor' }, { maxRetries: 0 }),
    ).rejects.toMatchObject({
      code: 'snapshot_expired',
      isSnapshotExpired: true,
    })
  })

  it('loads a public collection page with credentials and Product paging parameters', async () => {
    const mock = installFetchMock(() => jsonResponse({
      collection: {
        id: 'col-public', slug: 'research-notes', title: 'Research notes', summary: null,
        kind: 'bookmarks', rootNodeId: 'root-public', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
      },
      nodes: [],
      page: { cursor: null, hasMore: false, sequence: 1 },
    }))
    restoreFetch = mock.restore

    await getPublicCollectionPage('research notes', { limit: 75 }, { maxRetries: 0 })

    const call = lastCall(mock.calls)
    const request = requestPathAndSearch(call)
    expect(request.pathname).toBe('/api/v1/collections/research%20notes')
    expect(request.searchParams.get('limit')).toBe('75')
    expect(call.init?.credentials).toBe('omit')
    expect(requestHeaders(call).get('Known-Command-Id')).toBeNull()
    expect(requestHeaders(call).get('X-CSRF-Token')).toBeNull()
  })

  it('loads generated public Profile pages with an encoded handle and bound cursor', async () => {
    const mock = installFetchMock(() => jsonResponse({
      profile: { handle: 'mira chen', displayName: 'Mira Chen', avatarUrl: null, about: 'I collect bookmarks.' },
      collections: [],
      page: { cursor: null, hasMore: false },
    }))
    restoreFetch = mock.restore

    await getPublicProfilePage('mira chen', { limit: 24 }, { maxRetries: 0 })
    const continuationPage = await getPublicProfilePage(
      'mira chen',
      { limit: 24, cursor: 'profile-cursor-2' },
      { maxRetries: 0 },
    )
    expect(continuationPage.profile.about).toBe('I collect bookmarks.')

    const first = requestPathAndSearch(mock.calls[0]!)
    expect(first.pathname).toBe('/api/v1/profiles/mira%20chen')
    expect(first.searchParams.get('limit')).toBe('24')
    expect(first.searchParams.has('cursor')).toBe(false)
    const continuation = requestPathAndSearch(mock.calls[1]!)
    expect(continuation.pathname).toBe('/api/v1/profiles/mira%20chen')
    expect(continuation.searchParams.get('limit')).toBe('24')
    expect(continuation.searchParams.get('cursor')).toBe('profile-cursor-2')
    expect(mock.calls.every((call) => call.init?.credentials === 'omit')).toBe(true)
    expect(mock.calls.every((call) => requestHeaders(call).get('Known-Command-Id') === null)).toBe(true)
  })

  it('atomically restarts public collection pagination and discards stale partial nodes', async () => {
    const restarts: Array<{ reason: string; attempt: number }> = []
    let request = 0
    const collection = {
      id: 'col-public', slug: 'research-notes', title: 'Research notes', summary: null,
      kind: 'bookmarks', rootNodeId: 'root-public', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
    }
    const root = {
      id: 'root-public', parentId: null, kind: 'root', title: 'Contents',
      description: null, url: null, position: null,
    }
    const node = (id: string) => ({
      id, parentId: 'root-public', kind: 'bookmark', title: id,
      description: null, url: `https://${id}.example`, position: id,
    })
    const mock = installFetchMock(() => {
      request += 1
      if (request === 1) return jsonResponse({
        collection, nodes: [root, node('stale-partial')],
        page: { cursor: 'stale-cursor', hasMore: true, sequence: 1 },
      })
      if (request === 2) return jsonResponse(productErrorBody({
        code: 'snapshot_expired', recovery: 'restart_from_first_page',
      }), { status: 409 })
      if (request === 3) return jsonResponse({
        collection, nodes: [root, node('fresh-first')],
        page: { cursor: 'fresh-cursor', hasMore: true, sequence: 1 },
      })
      return jsonResponse({
        collection, nodes: [node('fresh-second')],
        page: { cursor: null, hasMore: false, sequence: 2 },
      })
    })
    restoreFetch = mock.restore

    const snapshot = await loadPublicCollectionSnapshot('research-notes', {
      limit: 2,
      maxRetries: 0,
      onCursorRestart: (event) => restarts.push(event),
    })

    expect(snapshot.nodes.map((item) => item.id)).toEqual([
      'root-public', 'fresh-first', 'fresh-second',
    ])
    expect(snapshot.nodes.some((item) => item.id === 'stale-partial')).toBe(false)
    expect(restarts).toEqual([{ reason: 'snapshot_expired', attempt: 1 }])
    expect(requestPathAndSearch(mock.calls[1]!).searchParams.get('cursor')).toBe('stale-cursor')
    expect(requestPathAndSearch(mock.calls[1]!).searchParams.get('limit')).toBe('2')
    expect(requestPathAndSearch(mock.calls[2]!).searchParams.get('limit')).toBe('2')
    expect(requestPathAndSearch(mock.calls[3]!).searchParams.get('cursor')).toBe('fresh-cursor')
    expect(requestPathAndSearch(mock.calls[3]!).searchParams.get('limit')).toBe('2')
  })

  it('assembles a public snapshot with the Product page max of 100', async () => {
    const mock = installFetchMock(() => jsonResponse({
      collection: publicCollection,
      nodes: [publicRoot],
      page: { cursor: null, hasMore: false, sequence: 1 },
    }))
    restoreFetch = mock.restore

    await loadPublicCollectionSnapshot('research-notes', { maxRetries: 0 })

    const first = requestPathAndSearch(mock.calls[0]!)
    expect(first.pathname).toBe('/api/v1/collections/research-notes')
    expect(first.searchParams.get('limit')).toBe('100')
  })

  it('bounds invalid public cursor restarts instead of looping forever', async () => {
    const mock = installFetchMock(() => jsonResponse({
      collection: {
        id: 'col-public', slug: 'broken-pages', title: 'Broken pages', summary: null,
        kind: 'bookmarks', rootNodeId: 'root-public', updatedAt: '2026-07-24T00:00:00.000Z', access: 'public',
      },
      nodes: [],
      page: { cursor: null, hasMore: true, sequence: 1 },
    }))
    restoreFetch = mock.restore

    await expect(loadPublicCollectionSnapshot('broken-pages', {
      maxRetries: 0,
      maxSnapshotRestarts: 1,
    })).rejects.toMatchObject({ code: 'invalid_cursor' })
    expect(mock.calls).toHaveLength(2)
  })

  it('restarts a bad first-page sequence once and publishes only the complete retry', async () => {
    let request = 0
    const mock = installFetchMock(() => {
      request += 1
      if (request === 1) return jsonResponse({
        collection: publicCollection,
        nodes: [publicRoot, publicNode('discarded')],
        page: { cursor: null, hasMore: false, sequence: 2 },
      })
      return jsonResponse({
        collection: publicCollection,
        nodes: [publicRoot, publicNode('ready')],
        page: { cursor: null, hasMore: false, sequence: 1 },
      })
    })
    restoreFetch = mock.restore

    const snapshot = await loadPublicCollectionSnapshot('research-notes', {
      maxRetries: 0,
      maxSnapshotRestarts: 1,
    })

    expect(snapshot.nodes.map(({ id }) => id)).toEqual(['root-public', 'ready'])
    expect(snapshot.nodes.some(({ id }) => id === 'discarded')).toBe(false)
    expect(mock.calls).toHaveLength(2)
  })

  it.each([
    ['skipped', 3],
    ['replayed', 1],
  ])('rejects a %s continuation sequence without exposing partial nodes', async (_label, sequence) => {
    let request = 0
    const mock = installFetchMock(() => {
      request += 1
      return jsonResponse(request === 1 ? {
        collection: publicCollection,
        nodes: [publicRoot, publicNode('partial')],
        page: { cursor: 'page-2', hasMore: true, sequence: 1 },
      } : {
        collection: publicCollection,
        nodes: [publicNode('continuation')],
        page: { cursor: null, hasMore: false, sequence },
      })
    })
    restoreFetch = mock.restore

    await expect(loadPublicCollectionSnapshot('research-notes', {
      maxRetries: 0,
      maxSnapshotRestarts: 0,
    })).rejects.toMatchObject({ code: 'invalid_cursor' })
    expect(mock.calls).toHaveLength(2)
  })

  it('rejects duplicate node ids within and across public pages', async () => {
    for (const continuationNodes of [
      [publicNode('duplicate'), publicNode('duplicate')],
      [publicNode('first-page-node')],
    ]) {
      let request = 0
      const mock = installFetchMock(() => {
        request += 1
        return jsonResponse(request === 1 ? {
          collection: publicCollection,
          nodes: [publicRoot, publicNode('first-page-node')],
          page: { cursor: 'page-2', hasMore: true, sequence: 1 },
        } : {
          collection: publicCollection,
          nodes: continuationNodes,
          page: { cursor: null, hasMore: false, sequence: 2 },
        })
      })
      await expect(loadPublicCollectionSnapshot('research-notes', {
        maxRetries: 0,
        maxSnapshotRestarts: 0,
      })).rejects.toMatchObject({ code: 'invalid_cursor' })
      mock.restore()
    }
    restoreFetch = undefined
  })

  it.each([
    ['id', 'other-id'],
    ['slug', 'other-slug'],
    ['title', 'Other title'],
    ['summary', 'Other summary'],
    ['kind', 'reading_path'],
    ['rootNodeId', 'other-root'],
    ['updatedAt', '2026-07-24T00:00:01.000Z'],
    ['access', 'member'],
  ] as const)('rejects continuation collection drift in %s', async (field, value) => {
    let request = 0
    const mock = installFetchMock(() => {
      request += 1
      return jsonResponse(request === 1 ? {
        collection: publicCollection,
        nodes: [publicRoot],
        page: { cursor: 'page-2', hasMore: true, sequence: 1 },
      } : {
        collection: { ...publicCollection, [field]: value },
        nodes: [publicNode('page-2-node')],
        page: { cursor: null, hasMore: false, sequence: 2 },
      })
    })
    restoreFetch = mock.restore

    await expect(loadPublicCollectionSnapshot('research-notes', {
      maxRetries: 0,
      maxSnapshotRestarts: 0,
    })).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it.each([
    ['missing continuation cursor', { cursor: null, hasMore: true, sequence: 1 }],
    ['terminal cursor', { cursor: 'unexpected', hasMore: false, sequence: 1 }],
    ['empty terminal cursor', { cursor: '', hasMore: false, sequence: 1 }],
  ])('rejects page state with %s', async (_label, page) => {
    const mock = installFetchMock(() => jsonResponse({
      collection: publicCollection,
      nodes: [publicRoot],
      page,
    }))
    restoreFetch = mock.restore

    await expect(loadPublicCollectionSnapshot('research-notes', {
      maxRetries: 0,
      maxSnapshotRestarts: 0,
    })).rejects.toMatchObject({ code: 'invalid_cursor' })
  })

  it('fails stably when a restarted assembly is invalid again', async () => {
    const mock = installFetchMock(() => jsonResponse({
      collection: publicCollection,
      nodes: [publicRoot, publicNode('never-published')],
      page: { cursor: null, hasMore: false, sequence: 0 },
    }))
    restoreFetch = mock.restore

    await expect(loadPublicCollectionSnapshot('research-notes', {
      maxRetries: 0,
      maxSnapshotRestarts: 1,
    })).rejects.toMatchObject({ code: 'invalid_cursor' })
    expect(mock.calls).toHaveLength(2)
  })

  it('does not treat network failure as mutation success', async () => {
    seedAuthenticatedSession('csrf-write')
    const mock = installFetchMock(() => {
      throw new TypeError('Failed to fetch')
    })
    restoreFetch = mock.restore

    await expect(
      createCollection(
        { kind: 'bookmarks', title: 'Offline', summary: null },
        { intentId: 'create-collection:draft-1', maxRetries: 0 },
      ),
    ).rejects.toMatchObject({
      code: 'transport_error',
      status: 0,
    })
  })
})
