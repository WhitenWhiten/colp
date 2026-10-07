/**
 * ED-01: bookmark favicon write wrappers on the frozen productClient.
 * Path, raw File body, CSRF + Known-Command-Id, no If-Match, 429 does not rotate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { clearCommandId, getOrCreateCommandId } from './commandId'
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

const INTENT = 'upload-favicon:col-1:node-1'
const DELETE_INTENT = 'delete-favicon:col-1:node-1'
const OBJECT_ICON = 'https://known.example/api/v1/favicon/01234567-89ab-4cde-8f01-23456789abcd'

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

function bookmarkView(iconUrl: string | null = OBJECT_ICON) {
  return {
    id: 'node-1',
    collectionId: 'col-1',
    kind: 'bookmark' as const,
    parentId: 'root-1',
    position: 'a',
    title: 'Example',
    url: 'https://example.test',
    description: null,
    tags: [],
    visibility: 'inherit' as const,
    revision: '1',
    etag: '"n-1"',
    readOnly: false,
    readOnlyReason: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    iconUrl,
  }
}

describe('productClient bookmark favicon writes', () => {
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
    clearCommandId(DELETE_INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uploadBookmarkFavicon POSTs the raw File with CSRF and Known-Command-Id and without If-Match', async () => {
    seedAuthenticatedSession('csrf-favicon')
    const mock = installFetchMock(() => jsonResponse(bookmarkView()))
    restoreFetch = mock.restore

    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'icon.png', { type: 'image/png' })
    const updated = await productClient.uploadBookmarkFavicon(
      'col-1',
      'node-1',
      file,
      { intentId: INTENT, maxRetries: 0 },
    )
    expect(updated.iconUrl).toBe(OBJECT_ICON)

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/nodes/node-1/favicon',
    )
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.body).toBe(file)
    expect(call.init?.body instanceof FormData).toBe(false)
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-favicon')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('Content-Type')).toBe('image/png')
    expect(headers.get('If-Match')).toBeNull()
  })

  it('deleteBookmarkFavicon DELETEs the same path without If-Match or a body', async () => {
    seedAuthenticatedSession('csrf-favicon-del')
    const mock = installFetchMock(() => jsonResponse(bookmarkView(null)))
    restoreFetch = mock.restore

    const updated = await productClient.deleteBookmarkFavicon(
      'col-1',
      'node-1',
      { intentId: DELETE_INTENT, maxRetries: 0 },
    )
    expect(updated.iconUrl).toBeNull()

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('DELETE')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/nodes/node-1/favicon',
    )
    expect(call.init?.body).toBeUndefined()
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-favicon-del')
    expect(isUuidV4(headers.get('Known-Command-Id')!)).toBe(true)
    expect(headers.get('If-Match')).toBeNull()
  })

  it('sends application/octet-stream when the File has no declared type', async () => {
    seedAuthenticatedSession('csrf-favicon')
    const mock = installFetchMock(() => jsonResponse(bookmarkView()))
    restoreFetch = mock.restore
    const file = new File([new Uint8Array([1])], 'icon.bin')
    await productClient.uploadBookmarkFavicon(
      'col-1',
      'node-1',
      file,
      { intentId: INTENT, maxRetries: 0 },
    )
    expect(requestHeaders(lastCall(mock.calls)).get('Content-Type')).toBe('application/octet-stream')
    expect(lastCall(mock.calls).init?.body).toBe(file)
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused', async () => {
    seedAuthenticatedSession('csrf-favicon')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const file = new File([new Uint8Array([1])], 'icon.png', { type: 'image/png' })
    const options = { intentId: INTENT, maxRetries: 0 }

    await expect(productClient.uploadBookmarkFavicon('col-1', 'node-1', file, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.uploadBookmarkFavicon('col-1', 'node-1', file, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(INTENT))
    expect(ids[1]).toBe(ids[0])
  })

  it('does not rotate Known-Command-Id on 429 rate_limited as if it were 409', async () => {
    seedAuthenticatedSession('csrf-favicon')
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
    const file = new File([new Uint8Array([1])], 'icon.png', { type: 'image/png' })
    const options = { intentId: INTENT, maxRetries: 0 }

    await expect(productClient.uploadBookmarkFavicon('col-1', 'node-1', file, options))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' })
    const firstId = requestHeaders(mock.calls[0]!).get('Known-Command-Id')
    await expect(productClient.uploadBookmarkFavicon('col-1', 'node-1', file, options))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[1]).toBe(firstId)
    expect(ids[1]).toBe(getOrCreateCommandId(INTENT))
  })
})
