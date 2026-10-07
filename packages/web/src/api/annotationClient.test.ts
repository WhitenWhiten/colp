import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import {
  createMemorySessionStorage,
  installFetchMock,
  installSessionStorage,
  jsonResponse,
  productErrorBody,
  requestHeaders,
  requestMethod,
  requestPathAndSearch,
  resetProductSession,
  seedAuthenticatedSession,
  type FetchCall,
} from './test-helpers'

const annotation = (overrides: Record<string, unknown> = {}) => ({
  id: 'annotation-note-1',
  collectionId: 'collection-1',
  subject: { type: 'node' as const, id: 'node-1' },
  type: 'note' as const,
  format: 'plain' as const,
  value: 'A private note',
  visibility: 'private' as const,
  creator: { id: 'https://known.test/profiles/mira', name: 'Mira' },
  provenance: { kind: 'human' as const },
  revision: 'revision-1',
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
  extensions: {},
  ...overrides,
})

function pathAndSearch(call: FetchCall): string {
  const { pathname, searchParams } = requestPathAndSearch(call)
  const search = searchParams.toString()
  return `${pathname}${search ? `?${search}` : ''}`
}

describe('canonical Annotation Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    restoreFetch = undefined
    resetProductSession()
    seedAuthenticatedSession('annotation-csrf')
  })

  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('traverses the independent subject cursor without leaking a partial page', async () => {
    const mock = installFetchMock(() => {
      return jsonResponse(mock.calls.length === 1
        ? { annotations: [annotation()], page: { returnedCount: 1, hasMore: true, nextCursor: 'annotation-cursor-2' } }
        : { annotations: [annotation({ id: 'annotation-highlight-1', type: 'highlight', value: 'section-1-0' })], page: { returnedCount: 1, hasMore: false, nextCursor: null } })
    })
    restoreFetch = mock.restore

    const result = await productClient.loadAnnotations(
      'collection-1',
      { resourceType: 'node', resourceId: 'node-1' },
      { limit: 1, maxRetries: 0 },
    )

    expect(result.map((item) => item.id)).toEqual(['annotation-note-1', 'annotation-highlight-1'])
    expect(pathAndSearch(mock.calls[0]!)).toBe(
      '/api/v1/collections/collection-1/annotations?resourceType=node&resourceId=node-1&limit=1',
    )
    expect(pathAndSearch(mock.calls[1]!)).toBe(
      '/api/v1/collections/collection-1/annotations?resourceType=node&resourceId=node-1&cursor=annotation-cursor-2',
    )
    expect(requestMethod(mock.calls[0]!)).toBe('GET')
    expect(requestHeaders(mock.calls[0]!).has('known-command-id')).toBe(false)
  })

  it('maps create, item read, merge patch, and delete through generated DTOs', async () => {
    const mock = installFetchMock((input, init) => {
      const method = requestMethod({ input, init })
      if (method === 'DELETE') {
        return jsonResponse({
          receipt: {
            resourceType: 'annotation', targetId: 'annotation-note-1', collectionId: 'collection-1',
            scope: 'single', deletedAt: '2026-07-25T00:10:00.000Z', deleteRevision: 'revision-3',
            operationId: 'operation-1', affectedCount: 1, purgeAfter: '2026-08-24T00:10:00.000Z',
          },
          fence: { contentRevision: 'content-3', policyRevision: 'policy-1' },
        })
      }
      return jsonResponse(annotation({ revision: method === 'PATCH' ? 'revision-2' : 'revision-1' }), {
        status: method === 'POST' ? 201 : 200,
        headers: { ETag: method === 'PATCH' ? '"revision-2"' : '"revision-1"' },
      })
    })
    restoreFetch = mock.restore

    await productClient.createAnnotation('collection-1', {
      resourceType: 'node', resourceId: 'node-1',
    }, {
      type: 'note', format: 'plain', value: 'A private note', visibility: 'private',
    }, { intentId: 'annotation-create-intent', maxRetries: 0 })
    await productClient.getAnnotation('collection-1', 'annotation-note-1', { maxRetries: 0 })
    await productClient.updateAnnotation('collection-1', 'annotation-note-1', {
      value: 'Updated note',
    }, '"revision-1"', { intentId: 'annotation-update-intent', maxRetries: 0 })
    await productClient.deleteAnnotation(
      'collection-1', 'annotation-note-1', '"revision-2"',
      { intentId: 'annotation-delete-intent', maxRetries: 0 },
    )

    expect(pathAndSearch(mock.calls[0]!)).toBe('/api/v1/collections/collection-1/annotations?resourceType=node&resourceId=node-1')
    expect(requestHeaders(mock.calls[0]!).get('content-type')).toBe('application/json')
    expect(requestHeaders(mock.calls[0]!).get('x-csrf-token')).toBe('annotation-csrf')
    expect(pathAndSearch(mock.calls[1]!)).toBe('/api/v1/collections/collection-1/annotations/annotation-note-1')
    expect(requestMethod(mock.calls[1]!)).toBe('GET')
    expect(requestHeaders(mock.calls[2]!).get('content-type')).toBe('application/merge-patch+json')
    expect(requestHeaders(mock.calls[2]!).get('if-match')).toBe('"revision-1"')
    expect(requestHeaders(mock.calls[3]!).get('if-match')).toBe('"revision-2"')
    expect(requestMethod(mock.calls[3]!)).toBe('DELETE')
  })

  it('replays an unknown create with the same command id and does not rotate a 409 reuse', async () => {
    const mock = installFetchMock(() => {
      if (mock.calls.length === 1) throw new TypeError('connection reset after write')
      if (mock.calls.length === 2) return jsonResponse(annotation(), { status: 201 })
      return jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'command id was reused with a different fingerprint',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 })
    })
    restoreFetch = mock.restore
    const input = ['collection-1', { resourceType: 'node' as const, resourceId: 'node-1' }, {
      type: 'note' as const, format: 'plain' as const, value: 'A private note', visibility: 'private' as const,
    }, { intentId: 'stable-annotation-create', maxRetries: 0, clearIntentOnSuccess: false }] as const

    await expect(productClient.createAnnotation(...input)).rejects.toMatchObject({ code: 'transport_error' })
    await productClient.createAnnotation(...input)
    const firstCommandId = requestHeaders(mock.calls[0]!).get('known-command-id')
    expect(requestHeaders(mock.calls[1]!).get('known-command-id')).toBe(firstCommandId)

    await expect(productClient.createAnnotation(
      'collection-1', { resourceType: 'node', resourceId: 'node-1' },
      { type: 'note', format: 'plain', value: 'changed fingerprint', visibility: 'private' },
      { intentId: 'stable-annotation-create', maxRetries: 0, clearIntentOnSuccess: false },
    )).rejects.toMatchObject({ status: 409, code: 'command_id_reused' })
    expect(requestHeaders(mock.calls[2]!).get('known-command-id')).toBe(firstCommandId)
  })
})
