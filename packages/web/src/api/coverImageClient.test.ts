import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { clearCommandId } from './commandId'
import { createMemorySessionStorage, installFetchMock, installSessionStorage, jsonResponse,
  requestHeaders, requestMethod, requestPathAndSearch, resetProductSession,
  seedAuthenticatedSession, type FetchCall } from './test-helpers'

const image = { url: 'https://known.example/api/v1/images/12345678-1234-4234-8234-123456789abc', width: 800, height: 400 }
const UPLOAD_INTENT = 'test-cover-upload'
const BIND_INTENT = 'test-cover-bind'

describe('cover image Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined
  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession()
    seedAuthenticatedSession('cover-csrf')
  })
  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
    clearCommandId(UPLOAD_INTENT)
    clearCommandId(BIND_INTENT)
    vi.unstubAllEnvs()
  })

  it('uploads raw bytes then updates the node with a separate revision and command', async () => {
    const mock = installFetchMock((input, init) => requestMethod({ input, init }) === 'POST'
      ? jsonResponse({ assetId: 'asset', image }, { status: 201 })
      : jsonResponse({ mode: 'custom', revision: '5', image }))
    restoreFetch = mock.restore
    const file = new File(['image'], 'cover.png', { type: 'image/png' })
    const uploaded = await productClient.uploadCollectionImage('col', file, { intentId: UPLOAD_INTENT })
    await productClient.updateNodeCover('col', 'node', { mode: 'custom', assetId: uploaded.assetId }, '4', { intentId: BIND_INTENT })
    const [upload, bind] = mock.calls as [FetchCall, FetchCall]
    expect(requestPathAndSearch(upload).pathname).toBe('/api/v1/collections/col/images')
    expect(upload.init?.body).toBe(file)
    expect(requestHeaders(upload).get('Content-Type')).toBe('image/png')
    expect(requestMethod(bind)).toBe('PUT')
    expect(requestPathAndSearch(bind).pathname).toBe('/api/v1/collections/col/nodes/node/cover')
    expect(requestHeaders(bind).get('If-Match')).toBe('"cover:4"')
    expect(requestHeaders(bind).get('X-CSRF-Token')).toBe('cover-csrf')
    expect(requestHeaders(bind).get('Known-Command-Id')).not.toBe(requestHeaders(upload).get('Known-Command-Id'))
    expect(JSON.parse(String(bind.init?.body))).toEqual({ mode: 'custom', assetId: 'asset' })
  })

  it('keeps command identity and the original precondition after an unknown result', async () => {
    let attempts = 0
    const mock = installFetchMock(() => {
      if (attempts++ === 0) throw new TypeError('connection closed')
      return jsonResponse({ mode: 'none', revision: '5', image: null })
    })
    restoreFetch = mock.restore
    const update = () => productClient.updateNodeCover('col', 'node', { mode: 'none' }, '4', { intentId: BIND_INTENT, maxRetries: 0 })
    await expect(update()).rejects.toThrow()
    await update()
    expect(mock.calls).toHaveLength(2)
    expect(requestHeaders(mock.calls[1]!).get('Known-Command-Id')).toBe(requestHeaders(mock.calls[0]!).get('Known-Command-Id'))
    expect(requestHeaders(mock.calls[1]!).get('If-Match')).toBe('"cover:4"')
  })
})
