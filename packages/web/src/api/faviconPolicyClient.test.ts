/**
 * FO-01: favicon policy/source client wrappers on the frozen productClient.
 * Covers the four operations: GET policy (ETag read), PATCH policy
 * (If-Match + CSRF + command id), GET source (ETag read), PUT source
 * (If-Match + CSRF + command id). Verifies exact paths, methods, headers and
 * the replay/conflict semantics of the mutation wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { clearCommandId } from './commandId'
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

const POLICY_INTENT = 'favicon-policy:me'
const SOURCE_INTENT = 'set-favicon-source:col-1:node-1'

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

function iconPolicy(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    revision: '1',
    newDefault: 'capture' as const,
    providerTemplate: 'https://favicone.com/{hostname}',
    fillMissing: false,
    forceAllOnline: false,
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}

function iconSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    collectionId: 'col-1',
    nodeId: 'node-1',
    revision: '1',
    policyRevision: '1',
    sourceMode: 'inherit' as const,
    effectiveMode: 'capture' as const,
    iconUrl: null,
    iconVersion: null,
    directUrl: null,
    status: 'missing' as const,
    restorable: false,
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('productClient favicon policy and source', () => {
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
    clearCommandId(POLICY_INTENT)
    clearCommandId(SOURCE_INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('getMyFaviconPolicy GETs the singleton and returns the server ETag', async () => {
    seedAuthenticatedSession('csrf-fav-pol')
    const mock = installFetchMock(() =>
      jsonResponse(iconPolicy(), { headers: { etag: '"favicon-policy:1"' } }))
    restoreFetch = mock.restore

    const policy = await productClient.getMyFaviconPolicy({ maxRetries: 0 })
    expect(policy.newDefault).toBe('capture')
    expect(policy.etag).toBe('"favicon-policy:1"')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/favicon-policy')
    expect(call.init?.body).toBeUndefined()
    const headers = requestHeaders(call)
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('replays a Cloudflare/nginx W/ ETag as a single strong If-Match', async () => {
    seedAuthenticatedSession('csrf-fav-pol')
    const mock = installFetchMock((_input, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        return jsonResponse(iconPolicy(), { headers: { etag: 'W/"favicon-policy:1"' } })
      }
      return jsonResponse({
        policy: iconPolicy({ revision: '2', newDefault: 'none' }),
        jobId: null,
      }, { headers: { etag: '"favicon-policy:2"' } })
    })
    restoreFetch = mock.restore

    const policy = await productClient.getMyFaviconPolicy({ maxRetries: 0 })
    expect(policy.etag).toBe('"favicon-policy:1"')

    await productClient.updateMyFaviconPolicy(
      { newDefault: 'none' },
      policy.etag,
      { intentId: POLICY_INTENT, maxRetries: 0 },
    )
    const patch = lastCall(mock.calls)
    expect(requestMethod(patch)).toBe('PATCH')
    expect(requestHeaders(patch).get('If-Match')).toBe('"favicon-policy:1"')
  })

  it('updateMyFaviconPolicy PATCHes only newDefault with CSRF, command id and If-Match', async () => {
    seedAuthenticatedSession('csrf-fav-pol')
    const mock = installFetchMock((_input, init) => {
      const body = JSON.parse(String(init?.body ?? '')) as Record<string, unknown>
      if (body.newDefault !== 'none' || Object.keys(body).length !== 1) {
        return new Response(JSON.stringify(productErrorBody({ code: 'invalid_request' })), { status: 400 })
      }
      return jsonResponse({
        policy: iconPolicy({ revision: '2', newDefault: 'none' }),
        jobId: null,
      }, { headers: { etag: '"favicon-policy:2"' } })
    })
    restoreFetch = mock.restore

    const result = await productClient.updateMyFaviconPolicy(
      { newDefault: 'none' },
      '"favicon-policy:1"',
      { intentId: POLICY_INTENT, maxRetries: 0 },
    )
    expect(result.policy.revision).toBe('2')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('PATCH')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/favicon-policy')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-fav-pol')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('If-Match')).toBe('"favicon-policy:1"')
    expect(requestHeaders(call).get('content-type')).toContain('application/json')
  })

  it('getBookmarkFaviconSource GETs the node source and returns the composite ETag', async () => {
    seedAuthenticatedSession('csrf-fav-src')
    const mock = installFetchMock(() =>
      jsonResponse(iconSource(), { headers: { etag: '"favicon-source:node-res-1:1"' } }))
    restoreFetch = mock.restore

    const source = await productClient.getBookmarkFaviconSource('col-1', 'node-1', { maxRetries: 0 })
    expect(source.sourceMode).toBe('inherit')
    expect(source.etag).toBe('"favicon-source:node-res-1:1"')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/nodes/node-1/favicon-source',
    )
  })

  it('setBookmarkFaviconSource PUTs inherit/none with the ETag and surfaces 412 as a ProductApiError', async () => {
    seedAuthenticatedSession('csrf-fav-src')
    const mock = installFetchMock((_input, init) => {
      const body = JSON.parse(String(init?.body ?? '')) as Record<string, unknown>
      if (body.sourceMode !== 'none' || Object.keys(body).length !== 1) {
        return new Response(JSON.stringify(productErrorBody({ code: 'invalid_request' })), { status: 400 })
      }
      return jsonResponse(iconSource({ sourceMode: 'none', effectiveMode: 'none', revision: '2' }))
    })
    restoreFetch = mock.restore

    const updated = await productClient.setBookmarkFaviconSource(
      'col-1', 'node-1', { sourceMode: 'none' }, '"favicon-source:node-res-1:1"',
      { intentId: SOURCE_INTENT, maxRetries: 0 },
    )
    expect(updated.sourceMode).toBe('none')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('PUT')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/nodes/node-1/favicon-source',
    )
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-fav-src')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('If-Match')).toBe('"favicon-source:node-res-1:1"')

    mock.calls.length = 0
    restoreFetch = installFetchMock(() =>
      new Response(JSON.stringify(productErrorBody({
        code: 'precondition_failed',
        recovery: 'refresh_and_retry',
        currentEtag: '"favicon-source:node-res-1:2"',
      })), { status: 412, headers: { 'content-type': 'application/json' } })).restore
    const conflict = await productClient.setBookmarkFaviconSource(
      'col-1', 'node-1', { sourceMode: 'none' }, '"favicon-source:node-res-1:1"',
      { intentId: SOURCE_INTENT, maxRetries: 0 },
    ).then(
      () => { throw new Error('expected ProductApiError') },
      (error: Error & { status?: number; code?: string; currentEtag?: string | null }) => error,
    )
    expect(conflict.status).toBe(412)
    expect(conflict.code).toBe('precondition_failed')
    expect(conflict.currentEtag).toBe('"favicon-source:node-res-1:2"')
  })

  it('feature flag off: GET policy 404 surfaces resource_not_found without throwing a network error', async () => {
    seedAuthenticatedSession('csrf-fav-pol')
    const mock = installFetchMock(() =>
      new Response(JSON.stringify(productErrorBody({ code: 'resource_not_found' })), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }))
    restoreFetch = mock.restore

    const error = await productClient.getMyFaviconPolicy({ maxRetries: 0 }).then(
      () => { throw new Error('expected ProductApiError') },
      (e: Error & { status?: number; code?: string }) => e,
    )
    expect(error.status).toBe(404)
    expect(error.code).toBe('resource_not_found')
  })

  it('refreshBookmarkFavicon POSTs with CSRF + command id + If-Match and returns the jobId', async () => {
    seedAuthenticatedSession('csrf-fav-refresh')
    const mock = installFetchMock(() =>
      jsonResponse({ jobId: '123e4567-e89b-42d3-a456-426614174000' }))
    restoreFetch = mock.restore

    const accepted = await productClient.refreshBookmarkFavicon(
      'col-1', 'node-1', '"favicon-source:node-res-1:2"',
      { intentId: 'refresh-favicon-source:col-1:node-1', maxRetries: 0 },
    )
    expect(accepted.jobId).toBe('123e4567-e89b-42d3-a456-426614174000')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/nodes/node-1/favicon-refresh',
    )
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-fav-refresh')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('If-Match')).toBe('"favicon-source:node-res-1:2"')
    // Empty-body POST: no Content-Type / body is sent.
    expect(headers.get('Content-Type')).toBeNull()
  })

  it('refreshBookmarkFavicon surfaces 412 stale ETag and a 400 non-online rejection', async () => {
    seedAuthenticatedSession('csrf-fav-refresh-2')
    const mock = installFetchMock((_input, init) => {
      if (init?.headers !== undefined) {
        const headers = new Headers(init.headers)
        if (headers.get('If-Match') === '"stale"') {
          return new Response(JSON.stringify(productErrorBody({
            code: 'precondition_failed',
            recovery: 'refresh_and_retry',
            currentEtag: '"favicon-source:node-res-1:2"',
          })), { status: 412, headers: { 'content-type': 'application/json' } })
        }
      }
      return new Response(JSON.stringify(productErrorBody({
        code: 'invalid_request',
        recovery: 'user_action',
      })), { status: 400, headers: { 'content-type': 'application/json' } })
    })
    restoreFetch = mock.restore

    const stale = await productClient.refreshBookmarkFavicon(
      'col-1', 'node-1', '"stale"',
      { intentId: 'refresh-favicon-source:col-1:node-1', maxRetries: 0 },
    ).then(
      () => { throw new Error('expected ProductApiError') },
      (e: Error & { status?: number; code?: string; currentEtag?: string | null }) => e,
    )
    expect(stale.status).toBe(412)
    expect(stale.code).toBe('precondition_failed')
    expect(stale.currentEtag).toBe('"favicon-source:node-res-1:2"')

    const nonOnline = await productClient.refreshBookmarkFavicon(
      'col-1', 'node-1', '"favicon-source:node-res-1:2"',
      { intentId: 'refresh-favicon-source:col-1:node-1', maxRetries: 0 },
    ).then(
      () => { throw new Error('expected ProductApiError') },
      (e: Error & { status?: number; code?: string }) => e,
    )
    expect(nonOnline.status).toBe(400)
    expect(nonOnline.code).toBe('invalid_request')
  })

  it('FO-03: createMyFaviconJob POSTs the body with CSRF + command id and returns jobId', async () => {
    seedAuthenticatedSession('csrf-fav-job')
    const mock = installFetchMock((_input, init) => {
      const body = JSON.parse(String(init?.body ?? '')) as Record<string, unknown>
      if (body.operation !== 'fill_missing' || body.policyRevision !== '2') {
        return new Response(JSON.stringify(productErrorBody({ code: 'invalid_request' })), { status: 400 })
      }
      return jsonResponse({ jobId: '123e4567-e89b-42d3-a456-426614174010' }, { status: 202 })
    })
    restoreFetch = mock.restore

    const accepted = await productClient.createMyFaviconJob(
      { operation: 'fill_missing', policyRevision: '2' },
      { intentId: 'create-favicon-job', maxRetries: 0 },
    )
    expect(accepted.jobId).toBe('123e4567-e89b-42d3-a456-426614174010')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/favicon-jobs')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-fav-job')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('content-type')).toContain('application/json')
  })

  it('FO-03: getMyFaviconJob GETs one owned job with its counters and error list', async () => {
    seedAuthenticatedSession('csrf-fav-job')
    const mock = installFetchMock(() => jsonResponse({
      id: '123e4567-e89b-42d3-a456-426614174011',
      operation: 'refresh_online', policyRevision: '2', status: 'partial',
      total: 10, succeeded: 9, failed: 1, skipped: 0,
      errors: [{ nodeId: 'node-fail', reason: 'fetch_failed' }],
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:01.000Z',
    }))
    restoreFetch = mock.restore

    const job = await productClient.getMyFaviconJob('123e4567-e89b-42d3-a456-426614174011', { maxRetries: 0 })
    expect(job.status).toBe('partial')
    expect(job.failed).toBe(1)
    expect(job.errors[0]?.nodeId).toBe('node-fail')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/favicon-jobs/123e4567-e89b-42d3-a456-426614174011')
    expect(requestHeaders(call).get('Content-Type')).toBeNull()
  })

  it('FO-03: retryMyFaviconJob POSTs the retry path with CSRF + command id and returns the new jobId', async () => {
    seedAuthenticatedSession('csrf-fav-job')
    const mock = installFetchMock(() =>
      jsonResponse({ jobId: '123e4567-e89b-42d3-a456-426614174012' }, { status: 202 }))
    restoreFetch = mock.restore

    const accepted = await productClient.retryMyFaviconJob(
      '123e4567-e89b-42d3-a456-426614174011',
      { intentId: 'retry-favicon-job', maxRetries: 0 },
    )
    expect(accepted.jobId).toBe('123e4567-e89b-42d3-a456-426614174012')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/me/favicon-jobs/123e4567-e89b-42d3-a456-426614174011/retry',
    )
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-fav-job')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('Content-Type')).toBeNull()
  })
})