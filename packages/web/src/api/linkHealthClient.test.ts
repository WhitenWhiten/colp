import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCommandId, getOrCreateCommandId } from './commandId'
import { productClient } from './productClient'
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
import type { LinkHealthItem, LinkHealthPage } from './types'

const INTENT = 'link-health-checks:client-retry'

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

function healthItem(overrides: Partial<LinkHealthItem> = {}): LinkHealthItem {
  return {
    nodeId: 'node-1',
    collectionId: 'col-1',
    collectionTitle: 'Reading list',
    title: 'Example',
    url: 'https://example.test/path',
    status: 'pending',
    duplicateOfNodeId: null,
    host: 'example.test',
    ...overrides,
  }
}

function healthPage(items: LinkHealthItem[] = [healthItem()]): LinkHealthPage {
  return { items, nextCursor: null }
}

describe('LH-04 link-health Product client', () => {
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

  it('lists link health with canonical query order and without mutation headers', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse(healthPage()))
    restoreFetch = mock.restore
    const signal = new AbortController().signal

    const page = await productClient.getMyLinkHealth(
      { status: 'pending', collectionId: 'col-1', duplicate: true, limit: 50 },
      { signal, maxRetries: 0 },
    )
    expect(page.items[0]?.nodeId).toBe('node-1')
    expect(page.nextCursor).toBeNull()

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    const request = requestPathAndSearch(call)
    expect(request.pathname).toBe('/api/v1/me/link-health')
    expect([...request.searchParams.keys()]).toEqual(['status', 'collectionId', 'duplicate', 'limit'])
    expect(request.searchParams.get('status')).toBe('pending')
    expect(request.searchParams.get('collectionId')).toBe('col-1')
    expect(request.searchParams.get('duplicate')).toBe('true')
    expect(request.searchParams.get('limit')).toBe('50')
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('accepts optional errorClass and duplicate review fields on list items', async () => {
    const mock = installFetchMock(() => jsonResponse(healthPage([healthItem({
      errorClass: 'timeout',
      duplicateRelationId: 'rel-1',
      duplicateRelationEtag: '"rel-r1"',
    })])))
    restoreFetch = mock.restore

    const page = await productClient.getMyLinkHealth({ limit: 50 }, { maxRetries: 0 })
    expect(page.items[0]?.errorClass).toBe('timeout')
    expect(page.items[0]?.duplicateRelationId).toBe('rel-1')
    expect(page.items[0]?.duplicateRelationEtag).toBe('"rel-r1"')
  })

  it('lists shared link health with scope first in the canonical query order', async () => {
    const mock = installFetchMock(() => jsonResponse(healthPage()))
    restoreFetch = mock.restore

    await productClient.getMyLinkHealth(
      { status: 'pending', collectionId: 'col-1', duplicate: true, limit: 50, scope: 'shared' },
      { maxRetries: 0 },
    )
    const request = requestPathAndSearch(lastCall(mock.calls))
    expect(request.pathname).toBe('/api/v1/me/link-health')
    expect([...request.searchParams.keys()]).toEqual(['scope', 'status', 'collectionId', 'duplicate', 'limit'])
    expect(request.searchParams.get('scope')).toBe('shared')
    expect(request.searchParams.get('status')).toBe('pending')
    expect(request.searchParams.get('collectionId')).toBe('col-1')
    expect(request.searchParams.get('duplicate')).toBe('true')
    expect(request.searchParams.get('limit')).toBe('50')
  })

  it('sends cursor as the only query parameter on continuation', async () => {
    const mock = installFetchMock(() => jsonResponse(healthPage()))
    restoreFetch = mock.restore

    await productClient.getMyLinkHealth(
      { status: 'broken', collectionId: 'col-1', duplicate: true, limit: 50, cursor: 'signed+cursor' },
      { maxRetries: 0 },
    )
    const request = requestPathAndSearch(lastCall(mock.calls))
    expect(request.pathname).toBe('/api/v1/me/link-health')
    expect([...request.searchParams.keys()]).toEqual(['cursor'])
    expect(request.searchParams.get('cursor')).toBe('signed+cursor')
  })

  it('keeps signal on ReadOptions rather than the query object', async () => {
    const mock = installFetchMock(() => jsonResponse(healthPage()))
    restoreFetch = mock.restore
    const signal = new AbortController().signal
    await productClient.getMyLinkHealth({ limit: 50 }, { signal, maxRetries: 0 })
    expect(lastCall(mock.calls).init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    expect(requestPathAndSearch(lastCall(mock.calls)).searchParams.get('limit')).toBe('50')
    expect(requestPathAndSearch(lastCall(mock.calls)).searchParams.has('signal')).toBe(false)
  })

  it('enqueues checks with CSRF and Known-Command-Id and without If-Match', async () => {
    seedAuthenticatedSession('csrf-link-health')
    const commandId = getOrCreateCommandId(INTENT)
    const mock = installFetchMock(() => jsonResponse({ queued: 4 }))
    restoreFetch = mock.restore

    const receipt = await productClient.enqueueMyLinkHealthChecks(
      {},
      { intentId: INTENT, maxRetries: 0 },
    )
    expect(receipt.queued).toBe(4)

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/link-health/checks')
    expect(JSON.parse(String(call.init?.body))).toEqual({})
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-link-health')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBeNull()
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused', async () => {
    seedAuthenticatedSession('csrf-link-health')
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

    await expect(productClient.enqueueMyLinkHealthChecks({}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.enqueueMyLinkHealthChecks({}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(INTENT))
    expect(ids[1]).toBe(ids[0])
  })

  it('does not rotate Known-Command-Id on 429 rate_limited', async () => {
    seedAuthenticatedSession('csrf-link-health')
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

    await expect(productClient.enqueueMyLinkHealthChecks({}, options))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' })
    const firstId = requestHeaders(mock.calls[0]!).get('Known-Command-Id')
    await expect(productClient.enqueueMyLinkHealthChecks({}, options))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[1]).toBe(firstId)
    expect(ids[1]).toBe(getOrCreateCommandId(INTENT))
  })
})
