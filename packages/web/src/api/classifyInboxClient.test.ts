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
import type {
  ClassifyInboxAcceptReceipt,
  ClassifyInboxDecisionReceipt,
  ClassifyInboxItem,
  ClassifyInboxPage,
} from './types'

const SKIP_INTENT = 'classify-inbox-skip:client-retry'
const ACCEPT_INTENT = 'classify-inbox-accept:client-retry'

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

function inboxItem(overrides: Partial<ClassifyInboxItem> = {}): ClassifyInboxItem {
  return {
    nodeId: 'node-1',
    collectionId: 'col-1',
    collectionTitle: 'Reading list',
    title: 'Root bookmark',
    url: 'https://example.test/path',
    host: 'example.test',
    etag: '"etag-1"',
    createdAt: '2026-08-24T00:00:00.000Z',
    suggestions: [
      {
        suggestionId: 'folder-1',
        folderId: 'folder-1',
        folderTitle: 'Design systems',
        score: 92,
        reason: 'Title/host overlap with "Design systems".',
        kind: 'existing',
      },
    ],
    ...overrides,
  }
}

function inboxPage(items: ClassifyInboxItem[] = [inboxItem()]): ClassifyInboxPage {
  return { items, nextCursor: null }
}

describe('CL-FE-02 classify inbox Product client', () => {
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
    clearCommandId(SKIP_INTENT)
    clearCommandId(ACCEPT_INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps productClient frozen', () => {
    expect(Object.isFrozen(productClient)).toBe(true)
  })

  it('lists classify inbox with credentials and without mutation headers', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse(inboxPage()))
    restoreFetch = mock.restore
    const signal = new AbortController().signal

    const page = await productClient.getMyClassifyInbox({ limit: 20 }, { signal, maxRetries: 0 })
    expect(page.items[0]?.nodeId).toBe('node-1')
    expect(page.nextCursor).toBeNull()

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    const request = requestPathAndSearch(call)
    expect(request.pathname).toBe('/api/v1/me/classify-inbox')
    expect([...request.searchParams.keys()]).toEqual(['limit'])
    expect(request.searchParams.get('limit')).toBe('20')
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('sends cursor as the only query parameter on continuation', async () => {
    const mock = installFetchMock(() => jsonResponse(inboxPage()))
    restoreFetch = mock.restore

    await productClient.getMyClassifyInbox(
      { limit: 20, cursor: 'signed+cursor' },
      { maxRetries: 0 },
    )
    const request = requestPathAndSearch(lastCall(mock.calls))
    expect(request.pathname).toBe('/api/v1/me/classify-inbox')
    expect([...request.searchParams.keys()]).toEqual(['cursor'])
    expect(request.searchParams.get('cursor')).toBe('signed+cursor')
  })

  it('keeps signal on ReadOptions rather than the query object', async () => {
    const mock = installFetchMock(() => jsonResponse(inboxPage()))
    restoreFetch = mock.restore
    const signal = new AbortController().signal
    await productClient.getMyClassifyInbox({ limit: 20 }, { signal, maxRetries: 0 })
    expect(lastCall(mock.calls).init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    expect(requestPathAndSearch(lastCall(mock.calls)).searchParams.get('limit')).toBe('20')
    expect(requestPathAndSearch(lastCall(mock.calls)).searchParams.has('signal')).toBe(false)
  })

  it('surfaces AbortError from GET', async () => {
    const mock = installFetchMock(() => Promise.reject(new DOMException('Aborted', 'AbortError')))
    restoreFetch = mock.restore
    await expect(productClient.getMyClassifyInbox({ limit: 20 }, { maxRetries: 0 }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('skips an item with CSRF, Known-Command-Id, and an empty JSON body', async () => {
    seedAuthenticatedSession('csrf-classify')
    const commandId = getOrCreateCommandId(SKIP_INTENT)
    const receipt: ClassifyInboxDecisionReceipt = { nodeId: 'node-1', decision: 'skipped' }
    const mock = installFetchMock(() => jsonResponse(receipt))
    restoreFetch = mock.restore

    const result = await productClient.skipMyClassifyInboxItem('node-1', {
      intentId: SKIP_INTENT,
      maxRetries: 0,
    })
    expect(result).toEqual(receipt)

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/classify-inbox/node-1/skip')
    expect(JSON.parse(String(call.init?.body))).toEqual({})
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-classify')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBeNull()
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('accepts an item with If-Match, CSRF, Known-Command-Id, and suggestionId', async () => {
    seedAuthenticatedSession('csrf-classify')
    const commandId = getOrCreateCommandId(ACCEPT_INTENT)
    const receipt: ClassifyInboxAcceptReceipt = {
      nodeId: 'node-1',
      decision: 'accepted',
      folderId: 'folder-1',
    }
    const mock = installFetchMock(() => jsonResponse(receipt))
    restoreFetch = mock.restore

    const result = await productClient.acceptMyClassifyInboxItem(
      'node-1',
      { suggestionId: 'folder-1' },
      '"etag-1"',
      { intentId: ACCEPT_INTENT, maxRetries: 0 },
    )
    expect(result).toEqual(receipt)

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/me/classify-inbox/node-1/accept')
    expect(JSON.parse(String(call.init?.body))).toEqual({ suggestionId: 'folder-1' })
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-classify')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBe('"etag-1"')
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('does not rotate Known-Command-Id on skip 409 command_id_reused', async () => {
    seedAuthenticatedSession('csrf-classify')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const options = { intentId: SKIP_INTENT, maxRetries: 0 }

    await expect(productClient.skipMyClassifyInboxItem('node-1', options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.skipMyClassifyInboxItem('node-1', options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(SKIP_INTENT))
    expect(ids[1]).toBe(ids[0])
  })
})
