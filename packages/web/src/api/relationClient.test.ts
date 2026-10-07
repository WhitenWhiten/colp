import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import {
  createMemorySessionStorage, installFetchMock, installSessionStorage, jsonResponse,
  productErrorBody, requestHeaders, requestMethod, requestPathAndSearch,
  resetProductSession, seedAuthenticatedSession, type FetchCall,
} from './test-helpers'

const relation = (overrides: Record<string, unknown> = {}) => ({
  id: 'relation-1', collectionId: 'collection-1', fromNodeId: 'node-1', toNodeId: 'node-2',
  type: 'related' as const, label: 'Plain <script>alert(1)</script>', visibility: 'private' as const,
  revision: 'relation-revision-1', createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z', extensions: {}, ...overrides,
})

function pathAndSearch(call: FetchCall): string {
  const { pathname, searchParams } = requestPathAndSearch(call)
  const search = searchParams.toString()
  return `${pathname}${search ? `?${search}` : ''}`
}

describe('canonical Relation Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession()
    seedAuthenticatedSession('relation-csrf')
  })
  afterEach(() => {
    restoreFetch?.(); restoreStorage(); resetProductSession(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  })

  it('loads incoming and outgoing pages through the generated Relation contract', async () => {
    const mock = installFetchMock(() => jsonResponse({
      relations: [relation()], page: { returnedCount: 1, hasMore: false, nextCursor: null },
    }))
    restoreFetch = mock.restore
    await productClient.loadRelations('collection-1', { nodeId: 'node-1', direction: 'incoming' }, { limit: 25, maxRetries: 0 })
    await productClient.loadRelations('collection-1', { nodeId: 'node-1', direction: 'outgoing' }, { limit: 25, maxRetries: 0 })
    expect(pathAndSearch(mock.calls[0]!)).toBe('/api/v1/collections/collection-1/relations?nodeId=node-1&direction=incoming&limit=25')
    expect(pathAndSearch(mock.calls[1]!)).toBe('/api/v1/collections/collection-1/relations?nodeId=node-1&direction=outgoing&limit=25')
  })

  it('maps create, patch, and delete with strong preconditions and separate intents', async () => {
    const mock = installFetchMock((_input, init) => requestMethod({ input: _input, init }) === 'DELETE'
      ? jsonResponse({ receipt: { resourceType: 'relation', targetId: 'relation-1', collectionId: 'collection-1', scope: 'single', deletedAt: '2026-07-25T00:01:00.000Z', deleteRevision: 'r3', operationId: 'op-1', affectedCount: 1, purgeAfter: '2026-08-24T00:01:00.000Z' }, fence: { contentRevision: 'c3', policyRevision: 'p1' } })
      : jsonResponse(relation({ revision: requestMethod({ input: _input, init }) === 'PATCH' ? 'relation-revision-2' : 'relation-revision-1' }), { status: requestMethod({ input: _input, init }) === 'POST' ? 201 : 200 }))
    restoreFetch = mock.restore
    await productClient.createRelation('collection-1', { fromNodeId: 'node-1', toNodeId: 'node-2', type: 'related', label: 'Evidence', visibility: 'private' }, { intentId: 'create-edge', maxRetries: 0 })
    await productClient.updateRelation('collection-1', 'relation-1', { label: 'Updated' }, '"relation-revision-1"', { intentId: 'patch-edge', maxRetries: 0 })
    await productClient.deleteRelation('collection-1', 'relation-1', '"relation-revision-2"', { intentId: 'delete-old-endpoint', maxRetries: 0 })
    expect(requestHeaders(mock.calls[0]!).get('content-type')).toBe('application/json')
    expect(requestHeaders(mock.calls[1]!).get('content-type')).toBe('application/merge-patch+json')
    expect(requestHeaders(mock.calls[1]!).get('if-match')).toBe('"relation-revision-1"')
    expect(requestHeaders(mock.calls[2]!).get('if-match')).toBe('"relation-revision-2"')
    expect(new Set(mock.calls.map((call) => requestHeaders(call).get('known-command-id'))).size).toBe(3)
  })

  it('replays unknown outcome with the same command and leaves 409 reuse for explicit recovery', async () => {
    const mock = installFetchMock(() => {
      if (mock.calls.length === 1) throw new TypeError('response lost')
      if (mock.calls.length === 2) return jsonResponse(relation(), { status: 201 })
      return jsonResponse(productErrorBody({ code: 'command_id_reused', message: 'reuse', recovery: 'user_action', sameRequestRetrySafe: false }), { status: 409 })
    })
    restoreFetch = mock.restore
    const options = { intentId: 'stable-relation-create', maxRetries: 0, clearIntentOnSuccess: false }
    const body = { fromNodeId: 'node-1', toNodeId: 'node-2', type: 'related' as const, visibility: 'private' as const }
    await expect(productClient.createRelation('collection-1', body, options)).rejects.toMatchObject({ code: 'transport_error' })
    await productClient.createRelation('collection-1', body, options)
    await expect(productClient.createRelation('collection-1', { ...body, label: 'changed' }, options)).rejects.toMatchObject({ code: 'command_id_reused' })
    expect(requestHeaders(mock.calls[1]!).get('known-command-id')).toBe(requestHeaders(mock.calls[0]!).get('known-command-id'))
    expect(requestHeaders(mock.calls[2]!).get('known-command-id')).toBe(requestHeaders(mock.calls[0]!).get('known-command-id'))
  })
})
