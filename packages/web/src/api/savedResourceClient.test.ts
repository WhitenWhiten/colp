import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import generatedBridgeSource from '../generated/product-v1.ts?raw'
import pathReaderSource from '../pages/PathReader.tsx?raw'
import readerSource from '../pages/Reader.tsx?raw'
import resourceDetailSource from '../pages/ResourceDetail.tsx?raw'
import { productClient } from './productClient'
import featureFlagsSource from './featureFlags.ts?raw'
import { isLive } from './featureFlags'
import transportSource from './product-transport.ts?raw'

const transportDomainSources = Object.values(import.meta.glob('./product-transport*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const transportSources = [transportSource, ...transportDomainSources].join('\n')
import typesSource from './types.ts?raw'
import {
  createMemorySessionStorage, installFetchMock, installSessionStorage, jsonResponse,
  productErrorBody, requestHeaders, requestMethod, requestPathAndSearch,
  resetProductSession, seedAuthenticatedSession,
} from './test-helpers'

const page = (nextCursor: string | null = null) => ({
  items: [{ resourceType: 'node', resourceId: 'node-1', savedAt: '2026-07-25T00:00:00.000Z',
    target: { availability: 'available', title: 'Saved node', url: 'https://saved.test', collectionId: 'collection-1' } }],
  page: { returnedCount: 1, hasMore: nextCursor !== null, nextCursor },
})

describe('canonical Saved Resource Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined
  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession(); seedAuthenticatedSession('saved-csrf')
  })
  afterEach(() => { restoreFetch?.(); restoreStorage(); resetProductSession(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('keeps the backend-generated contract authoritative', () => {
    /* Type aliases are erased at runtime, so the derivation from the generated
       schema is asserted on the declaration itself. */
    expect(generatedBridgeSource).toMatch(/from\s+'@known\/product-v1'/u)
    for (const schema of ['SavedResourceView', 'SavedResourcePage', 'SaveResourceResult'] as const) {
      expect(typesSource).toMatch(new RegExp(`export type ${schema} = Schemas\\['${schema}'\\]`, 'u'))
    }
    /* …and the transport layer references the generated contract by name
       rather than a copied shape. */
    for (const contract of ['SavedResourcePage', 'SavedResourceType', 'SaveResourceResult']) {
      expect(transportSources).toMatch(new RegExp(`\\b${contract}\\b`, 'u'))
    }
  })

  it('gates every Saved control on a live flag', () => {
    /* Behavioural half: the flag those controls consult really is on. */
    expect(isLive('savedResources')).toBe(true)
    /* Architecture half: *which* surfaces consult it. An unused `isLive` call
       has no observable effect beyond the branch it selects, and driving
       Reader/PathReader/ResourceDetail here would duplicate the page suites,
       so the wiring is asserted on the exact symbol each surface must call. */
    for (const [name, source] of [['PathReader', pathReaderSource], ['Reader', readerSource], ['ResourceDetail', resourceDetailSource]] as const) {
      expect(source, name).toMatch(/isLive\('savedResources'\)/u)
    }
    expect(featureFlagsSource).toMatch(/savedResources:\s*true/u)
  })

  it('lists all pages through the generated contract and preserves filters only on the first page', async () => {
    const mock = installFetchMock(() => jsonResponse(mock.calls.length === 1 ? page('next-token') : page()))
    restoreFetch = mock.restore
    const result = await productClient.loadSavedResources({ resourceType: 'node', collectionId: 'collection-1', limit: 1 }, { maxRetries: 0 })
    expect(result).toHaveLength(2)
    const first = requestPathAndSearch(mock.calls[0]!).searchParams
    const second = requestPathAndSearch(mock.calls[1]!).searchParams
    expect(Object.fromEntries(first)).toEqual({ resourceType: 'node', collectionId: 'collection-1', limit: '1' })
    expect(Object.fromEntries(second)).toEqual({ cursor: 'next-token' })
  })

  it('maps PUT and DELETE with no body, CSRF, and separate explicit intents', async () => {
    const mock = installFetchMock((input, init) => requestMethod({ input, init }) === 'PUT'
      ? jsonResponse({ resourceType: 'node', resourceId: 'node-1', savedAt: '2026-07-25T00:00:00.000Z' }, { status: 201 })
      : new Response(null, { status: 204 }))
    restoreFetch = mock.restore
    await productClient.saveResource('node', 'node-1', { intentId: 'save-node', maxRetries: 0 })
    await productClient.unsaveResource('node', 'node-1', { intentId: 'unsave-node', maxRetries: 0 })
    expect(mock.calls.map(requestMethod)).toEqual(['PUT', 'DELETE'])
    expect(mock.calls.map((call) => requestPathAndSearch(call).pathname)).toEqual([
      '/api/v1/saved-resources/node/node-1', '/api/v1/saved-resources/node/node-1',
    ])
    expect(requestHeaders(mock.calls[0]!).get('x-csrf-token')).toBe('saved-csrf')
    expect(requestHeaders(mock.calls[0]!).get('known-command-id')).not.toBe(requestHeaders(mock.calls[1]!).get('known-command-id'))
  })

  it('refreshes Session once after 401 and replays the same command id', async () => {
    const mock = installFetchMock((_input, init) => {
      if (mock.calls.length === 1) return jsonResponse(productErrorBody({ code: 'authentication_required', recovery: 'reauthenticate', sameRequestRetrySafe: true }), { status: 401 })
      if (mock.calls.length === 2) return jsonResponse({ authenticated: true, csrfToken: 'saved-csrf', idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
      return jsonResponse({ resourceType: 'node', resourceId: 'node-1', savedAt: '2026-07-25T00:00:00Z' })
    })
    restoreFetch = mock.restore
    await productClient.saveResource('node', 'node-1', { intentId: 'recover-save', maxRetries: 0 })
    expect(requestMethod(mock.calls[1]!)).toBe('GET')
    expect(requestHeaders(mock.calls[2]!).get('known-command-id')).toBe(requestHeaders(mock.calls[0]!).get('known-command-id'))
    expect(requestHeaders(mock.calls[2]!).get('x-csrf-token')).toBe('saved-csrf')
  })

  it('replays a committed unknown outcome and 409 with the exact same command id', async () => {
    const mock = installFetchMock(() => {
      if (mock.calls.length === 1) throw new TypeError('response lost after commit')
      if (mock.calls.length === 2) return jsonResponse({ resourceType: 'node', resourceId: 'node-1', savedAt: '2026-07-25T00:00:00Z' })
      return jsonResponse(productErrorBody({ code: 'command_id_reused', recovery: 'same_request', sameRequestRetrySafe: true }), { status: 409 })
    })
    restoreFetch = mock.restore
    const options = { intentId: 'same-save-intent', maxRetries: 0, clearIntentOnSuccess: false }
    await expect(productClient.saveResource('node', 'node-1', options)).rejects.toMatchObject({ code: 'transport_error' })
    await productClient.saveResource('node', 'node-1', options)
    await expect(productClient.saveResource('node', 'node-1', options)).rejects.toMatchObject({ code: 'command_id_reused' })
    expect(new Set(mock.calls.map((call) => requestHeaders(call).get('known-command-id'))).size).toBe(1)
  })
})
