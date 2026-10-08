import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient, ProductApiError } from './productClient'
import {
  clearCommandId,
  getOrCreateCommandId,
} from './commandId'
import {
  createMemorySessionStorage,
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

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

const CREATE_INTENT = 'create-collection-version'
const RESTORE_INTENT = 'restore-collection-version'
const ENCODED_COLLECTION = 'col/a+b'
const ENCODED_VERSION = 'ver/x+y'
const CONTENT_ETAG = '"content-1"'

function versionBody(overrides: Record<string, unknown> = {}) {
  return {
    versionId: 'ver-1',
    etag: '"version-1"',
    collectionId: 'col-1',
    contentRevision: 'rev-1',
    kind: 'manual',
    label: 'Snapshot 2026-08-01T00:00:00Z',
    nodeCount: 2,
    createdAt: '2026-08-01T00:00:00.000Z',
    changeCounts: { added: 0, removed: 0, moved: 0, renamed: 0, retargeted: 0 },
    ...overrides,
  }
}

function restoreReceipt() {
  return {
    versionId: 'ver-1',
    noop: false,
    updatedNodeIds: ['n1'],
    movedNodeIds: [],
    deletedNodeIds: [],
    preRestoreVersionId: 'ver-pre',
  }
}

function requestHref(call: FetchCall): string {
  if (typeof call.input === 'string') return call.input
  if (call.input instanceof URL) return call.input.href
  return call.input.url
}

describe('HV-FE-02 collection-version Product client', () => {
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
    clearCommandId(CREATE_INTENT)
    clearCommandId(RESTORE_INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps productClient frozen', () => {
    expect(Object.isFrozen(productClient)).toBe(true)
  })

  it('creates a version with POST, CSRF, command id, JSON body, and contentEtag If-Match', async () => {
    seedAuthenticatedSession('csrf-version')
    const commandId = getOrCreateCommandId(CREATE_INTENT)
    const mock = installFetchMock(() => jsonResponse(versionBody(), { status: 201 }))
    restoreFetch = mock.restore

    const result = await productClient.createCollectionVersion(
      'col-1',
      { label: 'Manual snapshot' },
      { intentId: CREATE_INTENT, ifMatch: CONTENT_ETAG, maxRetries: 0 },
    )
    expect(result.versionId).toBe('ver-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/collections/col-1/versions')
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({ label: 'Manual snapshot' })
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-version')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
    expect(headers.get('If-Match')).toBe(CONTENT_ETAG)
    expect(headers.get('If-Match')).not.toBe(versionBody().etag)
  })

  it('lists versions without CSRF, command id, or If-Match and keeps continuation cursor-only', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse({ items: [versionBody()], nextCursor: null }))
    restoreFetch = mock.restore
    const signal = new AbortController().signal

    const first = await productClient.listCollectionVersions('col-1', { limit: 20 }, {
      signal,
      maxRetries: 0,
    })
    expect(first.items[0]?.versionId).toBe('ver-1')

    const firstCall = mock.calls[0]!
    expect(requestMethod(firstCall)).toBe('GET')
    expect(requestPathAndSearch(firstCall).pathname).toBe('/api/v1/collections/col-1/versions')
    expect(firstCall.init?.credentials).toBe('include')
    expect(firstCall.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    const firstQuery = requestPathAndSearch(firstCall).searchParams
    expect(firstQuery.get('limit')).toBe('20')
    expect(firstQuery.get('cursor')).toBeNull()
    const firstHeaders = requestHeaders(firstCall)
    expect(firstHeaders.get('Accept')).toBe('application/json')
    expect(firstHeaders.get('X-CSRF-Token')).toBeNull()
    expect(firstHeaders.get('Known-Command-Id')).toBeNull()
    expect(firstHeaders.get('If-Match')).toBeNull()

    await productClient.listCollectionVersions('col-1', { cursor: 'cur-1', limit: 20 }, { maxRetries: 0 })
    const nextQuery = requestPathAndSearch(mock.calls[1]!).searchParams
    expect(nextQuery.get('cursor')).toBe('cur-1')
    expect(nextQuery.get('limit')).toBeNull()
  })

  it('gets a version by id without CSRF, command id, or If-Match', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse(versionBody({
      changes: [{ type: 'added', nodeId: 'n1', title: 'Inbox' }],
    })))
    restoreFetch = mock.restore

    const result = await productClient.getCollectionVersion('col-1', 'ver-1', { maxRetries: 0 })
    expect(result.versionId).toBe('ver-1')
    expect(result.changes?.[0]?.title).toBe('Inbox')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/collections/col-1/versions/ver-1')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('restores a version with POST, CSRF, command id, empty body, and contentEtag If-Match', async () => {
    seedAuthenticatedSession('csrf-restore')
    const commandId = getOrCreateCommandId(RESTORE_INTENT)
    const mock = installFetchMock(() => jsonResponse(restoreReceipt()))
    restoreFetch = mock.restore

    const result = await productClient.restoreCollectionVersion(
      'col-1',
      'ver-1',
      {},
      { intentId: RESTORE_INTENT, ifMatch: CONTENT_ETAG, maxRetries: 0 },
    )
    expect(result.versionId).toBe('ver-1')
    expect(result.noop).toBe(false)
    expect(result.updatedNodeIds).toEqual(['n1'])

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/versions/ver-1/restore',
    )
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({})
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-restore')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBe(CONTENT_ETAG)
    expect(headers.get('If-Match')).not.toBe(versionBody().etag)
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
  })

  it('encodes reserved characters in collectionId and versionId', async () => {
    seedAuthenticatedSession('csrf-version-encode')
    getOrCreateCommandId(CREATE_INTENT)
    getOrCreateCommandId(RESTORE_INTENT)
    const mock = installFetchMock((input) => {
      const href = requestHref({ input })
      if (href.includes('/restore')) return jsonResponse(restoreReceipt())
      if (href.includes(encodeURIComponent(ENCODED_VERSION))) return jsonResponse(versionBody())
      if (new URL(href, 'http://localhost').pathname.endsWith('/versions')) {
        return href.includes('GET') || true
          ? jsonResponse({ items: [versionBody()], nextCursor: null })
          : jsonResponse(versionBody())
      }
      return jsonResponse(versionBody())
    })
    restoreFetch = mock.restore

    await productClient.createCollectionVersion(
      ENCODED_COLLECTION,
      {},
      { intentId: CREATE_INTENT, ifMatch: CONTENT_ETAG, maxRetries: 0 },
    )
    expect(requestHref(mock.calls[0]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ENCODED_COLLECTION)}/versions`,
    )

    await productClient.listCollectionVersions(ENCODED_COLLECTION, {}, { maxRetries: 0 })
    expect(requestHref(mock.calls[1]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ENCODED_COLLECTION)}/versions`,
    )

    await productClient.getCollectionVersion(ENCODED_COLLECTION, ENCODED_VERSION, { maxRetries: 0 })
    expect(requestHref(mock.calls[2]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ENCODED_COLLECTION)}/versions/${encodeURIComponent(ENCODED_VERSION)}`,
    )

    await productClient.restoreCollectionVersion(
      ENCODED_COLLECTION,
      ENCODED_VERSION,
      {},
      { intentId: RESTORE_INTENT, ifMatch: CONTENT_ETAG, maxRetries: 0 },
    )
    expect(requestHref(mock.calls[3]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ENCODED_COLLECTION)}/versions/${encodeURIComponent(ENCODED_VERSION)}/restore`,
    )
  })

  it('does not wrap AbortError from getCollectionVersion as ProductApiError', async () => {
    const mock = installFetchMock(() => Promise.reject(new DOMException('Aborted', 'AbortError')))
    restoreFetch = mock.restore

    const error = await productClient.getCollectionVersion('col-1', 'ver-1', { maxRetries: 0 })
      .then(() => {
        throw new Error('expected AbortError')
      }, (reason: unknown) => reason)

    expect(error).toMatchObject({ name: 'AbortError' })
    expect(error).not.toBeInstanceOf(ProductApiError)
  })

  it('maps a 404 envelope to ProductApiError code resource_not_found', async () => {
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'resource_not_found',
        message: 'not found',
        recovery: 'none',
      }), { status: 404 }),
    )
    restoreFetch = mock.restore

    await expect(productClient.listCollectionVersions('col-1', {}, { maxRetries: 0 }))
      .rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused for create', async () => {
    seedAuthenticatedSession('csrf-version-conflict')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const options = { intentId: CREATE_INTENT, ifMatch: CONTENT_ETAG, maxRetries: 0 }

    await expect(productClient.createCollectionVersion('col-1', {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.createCollectionVersion('col-1', {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(CREATE_INTENT))
    expect(ids[1]).toBe(ids[0])
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused for restore', async () => {
    seedAuthenticatedSession('csrf-restore-conflict')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const options = { intentId: RESTORE_INTENT, ifMatch: CONTENT_ETAG, maxRetries: 0 }

    await expect(productClient.restoreCollectionVersion('col-1', 'ver-1', {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.restoreCollectionVersion('col-1', 'ver-1', {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(RESTORE_INTENT))
    expect(ids[1]).toBe(ids[0])
  })
})
