/**
 * Canonical Product client — public collection insight ingest.
 *
 * Production: src/api/productClient.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { clearCommandId } from './commandId'
import {
  createMemorySessionStorage,
  installFetchMock,
  installSessionStorage,
  jsonResponse,
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


  it('records anonymous public collection insight events without CSRF or command ids', async () => {
    const mock = installFetchMock(() => jsonResponse(null, { status: 204 }))
    restoreFetch = mock.restore

    await productClient.recordPublicCollectionInsightEvent(
      { slug: 'research-notes', eventType: 'collection_view' },
      {},
    )

    expect(mock.calls).toHaveLength(1)
    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/public-collections/research-notes/insight-events',
    )
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('content-type')).toMatch(/application\/json/i)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(JSON.parse(String(call.init?.body))).toEqual({ eventType: 'collection_view' })
  })

  it('sends a present CSRF token on insight ingest and never allocates a command id', async () => {
    seedAuthenticatedSession('csrf-insight')
    const mock = installFetchMock(() => jsonResponse(null, { status: 204 }))
    restoreFetch = mock.restore

    await productClient.recordPublicCollectionInsightEvent(
      { slug: 'research-notes', eventType: 'preview_open' },
      {},
    )

    const headers = requestHeaders(lastCall(mock.calls))
    expect(headers.get('X-CSRF-Token')).toBe('csrf-insight')
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(JSON.parse(String(lastCall(mock.calls).init?.body))).toEqual({ eventType: 'preview_open' })
  })

  it('keeps resource_open beacons alive across click-away navigation', async () => {
    const mock = installFetchMock(() => jsonResponse(null, { status: 204 }))
    restoreFetch = mock.restore

    await productClient.recordPublicCollectionInsightEvent(
      { slug: 'research-notes', eventType: 'resource_open', nodeId: 'node-1' },
      { keepalive: true },
    )

    const call = lastCall(mock.calls)
    expect(call.init?.keepalive).toBe(true)
    expect(JSON.parse(String(call.init?.body))).toEqual({
      eventType: 'resource_open',
      nodeId: 'node-1',
    })
  })
})
