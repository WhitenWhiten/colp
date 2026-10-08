import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCommandId, getOrCreateCommandId } from './commandId'
import { productClient, ProductApiError } from './productClient'
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
import type { ReadableReplicaView } from './types'

const COL = 'col-1'
const NODE = 'node-1'
const ENCODED_COLLECTION = 'col/a+b'
const ENCODED_NODE = 'nd/x+y'
const INTENT = productClient.mutationIntentKey('readable-replica-extract', `${COL}:${NODE}`)

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

function requestHref(call: FetchCall): string {
  if (typeof call.input === 'string') return call.input
  if (call.input instanceof URL) return call.input.href
  return call.input.url
}

function replicaView(overrides: Partial<ReadableReplicaView> = {}): ReadableReplicaView {
  return {
    nodeId: NODE,
    collectionId: COL,
    status: 'ready',
    sourceUrl: 'https://example.test/article',
    title: 'Extracted title',
    byline: 'Ada',
    wordCount: 400,
    extractedAt: '2026-08-25T00:00:00.000Z',
    failureCode: null,
    sections: [{
      id: 'sec-1',
      heading: 'Opening',
      paragraphs: [{ id: 'p-1', text: 'Hello reader.' }],
    }],
    etag: '"rr-1"',
    ...overrides,
  }
}

describe('RX-FE-02 readable-replica Product client', () => {
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
    clearCommandId(INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps productClient frozen', () => {
    expect(Object.isFrozen(productClient)).toBe(true)
    expect(typeof productClient.getNodeReadableReplica).toBe('function')
    expect(typeof productClient.enqueueNodeReadableExtract).toBe('function')
  })

  it('gets a replica without CSRF, command id, or If-Match and sends Accept', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse(replicaView({ status: 'none', sections: [], wordCount: 0 })))
    restoreFetch = mock.restore
    const signal = new AbortController().signal

    const view = await productClient.getNodeReadableReplica(COL, NODE, { signal, maxRetries: 0 })
    expect(view.status).toBe('none')
    expect(view.sections).toEqual([])

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe(
      `/api/v1/collections/${COL}/nodes/${NODE}/readable`,
    )
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    const headers = requestHeaders(call)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('enqueues extract with CSRF and Known-Command-Id and without If-Match', async () => {
    seedAuthenticatedSession('csrf-readable')
    const commandId = getOrCreateCommandId(INTENT)
    const mock = installFetchMock(() => jsonResponse(replicaView({ status: 'pending', sections: [], wordCount: 0 })))
    restoreFetch = mock.restore

    const view = await productClient.enqueueNodeReadableExtract(
      COL,
      NODE,
      {},
      { intentId: INTENT, maxRetries: 0 },
    )
    expect(view.status).toBe('pending')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      `/api/v1/collections/${COL}/nodes/${NODE}/readable`,
    )
    expect(JSON.parse(String(call.init?.body))).toEqual({})
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-readable')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBeNull()
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
  })

  it('sends force: true on an explicit retry extract', async () => {
    seedAuthenticatedSession('csrf-readable-force')
    getOrCreateCommandId(INTENT)
    const mock = installFetchMock(() => jsonResponse(replicaView({ status: 'pending', sections: [], wordCount: 0 })))
    restoreFetch = mock.restore

    await productClient.enqueueNodeReadableExtract(
      COL,
      NODE,
      { force: true },
      { intentId: INTENT, maxRetries: 0 },
    )
    expect(JSON.parse(String(lastCall(mock.calls).init?.body))).toEqual({ force: true })
    expect(requestHeaders(lastCall(mock.calls)).get('If-Match')).toBeNull()
  })

  it('encodes reserved characters in collectionId and nodeId', async () => {
    seedAuthenticatedSession('csrf-readable-encode')
    getOrCreateCommandId(INTENT)
    const mock = installFetchMock((input) => {
      const href = requestHref({ input })
      if (href.includes('/readable') && !href.endsWith('/readable')) return jsonResponse(replicaView())
      return jsonResponse(replicaView({ status: 'none', sections: [], wordCount: 0 }))
    })
    restoreFetch = mock.restore

    await productClient.getNodeReadableReplica(ENCODED_COLLECTION, ENCODED_NODE, { maxRetries: 0 })
    expect(requestHref(mock.calls[0]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ENCODED_COLLECTION)}/nodes/${encodeURIComponent(ENCODED_NODE)}/readable`,
    )

    await productClient.enqueueNodeReadableExtract(
      ENCODED_COLLECTION,
      ENCODED_NODE,
      { force: true },
      { intentId: INTENT, maxRetries: 0 },
    )
    expect(requestHref(mock.calls[1]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ENCODED_COLLECTION)}/nodes/${encodeURIComponent(ENCODED_NODE)}/readable`,
    )
  })

  it('does not wrap AbortError from getNodeReadableReplica as ProductApiError', async () => {
    const mock = installFetchMock(() => Promise.reject(new DOMException('Aborted', 'AbortError')))
    restoreFetch = mock.restore

    const error = await productClient.getNodeReadableReplica(COL, NODE, { maxRetries: 0 })
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

    await expect(productClient.getNodeReadableReplica(COL, NODE, { maxRetries: 0 }))
      .rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused', async () => {
    seedAuthenticatedSession('csrf-readable-conflict')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const options = { intentId: INTENT, maxRetries: 0 }

    await expect(productClient.enqueueNodeReadableExtract(COL, NODE, {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.enqueueNodeReadableExtract(COL, NODE, {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(INTENT))
    expect(ids[1]).toBe(ids[0])
  })

  it('does not rotate Known-Command-Id on 429 rate_limited', async () => {
    seedAuthenticatedSession('csrf-readable-rate')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'rate_limited',
        message: 'in progress',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
        retryAfterSeconds: 2,
      }), { status: 429 }),
    )
    restoreFetch = mock.restore
    const options = { intentId: INTENT, maxRetries: 0 }

    await expect(productClient.enqueueNodeReadableExtract(COL, NODE, {}, options))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' })
    const firstId = requestHeaders(mock.calls[0]!).get('Known-Command-Id')
    await expect(productClient.enqueueNodeReadableExtract(COL, NODE, {}, options))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[1]).toBe(firstId)
    expect(ids[1]).toBe(getOrCreateCommandId(INTENT))
  })
})
