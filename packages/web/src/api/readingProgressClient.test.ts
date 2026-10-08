import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import generatedBridgeSource from '../generated/product-v1.ts?raw'
import librarySource from '../pages/Library.tsx?raw'
import pathReaderSource from '../pages/PathReader.tsx?raw'
import readerSource from '../pages/Reader.tsx?raw'
import featureFlagsSource from './featureFlags.ts?raw'
import { isLive } from './featureFlags'
import { productClient } from './productClient'
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

const view = (progress = 0.42, etag = '"reading-1"') => ({
  resourceType: 'node' as const, resourceId: 'node-1', status: 'in_progress' as const,
  progress, completedAt: null, updatedAt: '2026-07-25T00:00:00.000Z', etag,
  target: { availability: 'available' as const, collectionId: 'collection-1', title: 'Reading node', url: 'https://reading.test' },
})

describe('canonical Reading Progress Product client', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined
  beforeEach(() => {
    vi.stubEnv('VITE_MOCK_SESSION', 'false')
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession(); seedAuthenticatedSession('reading-csrf')
  })
  afterEach(() => { restoreFetch?.(); restoreStorage(); resetProductSession(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('keeps the generated Reading Progress contract authoritative', () => {
    /* Type aliases are erased at runtime, so the derivation from the generated
       schema is asserted on the declaration itself; the transport layer must
       reference the generated contract by name rather than a copied shape. */
    expect(generatedBridgeSource).toMatch(/from\s+'@known\/product-v1'/u)
    for (const schema of ['ReadingProgressView', 'ReadingProgressPage', 'ReadingProgressUpdate', 'ReadingProgressMutationResult'] as const) {
      expect(typesSource).toMatch(new RegExp(`export type ${schema} = Schemas\\['${schema}'\\]`, 'u'))
      expect(transportSources).toMatch(new RegExp(`\\b${schema}\\b`, 'u'))
    }
  })

  it('gates the Reading Progress surfaces on a live flag', () => {
    /* Behavioural half: the flag those surfaces consult really is on. */
    expect(isLive('readingProgress')).toBe(true)
    /* Architecture half: *which* surfaces consult it. An unused `isLive` call
       has no observable effect beyond the fallback branch it selects, and
       driving Reader/PathReader/Library here would duplicate the page suites,
       so the wiring is asserted on the exact symbol each surface must call. */
    for (const [name, source] of [['Reader', readerSource], ['PathReader', pathReaderSource], ['Library', librarySource]] as const) {
      expect(source, name).toMatch(/isLive\('readingProgress'\)/u)
    }
    expect(featureFlagsSource).toMatch(/readingProgress:\s*true/u)
  })

  it('maps item/list reads and preserves filters only on the first cursor page', async () => {
    const mock = installFetchMock(() => mock.calls.length === 1
      ? jsonResponse({ items: [view()], page: { returnedCount: 1, hasMore: true, nextCursor: 'next' } })
      : jsonResponse({ items: [view(1, '"reading-2"')], page: { returnedCount: 1, hasMore: false, nextCursor: null } }))
    restoreFetch = mock.restore
    const items = await productClient.loadReadingProgress({ status: 'in_progress', limit: 1 }, { maxRetries: 0 })
    expect(items).toHaveLength(2)
    expect(Object.fromEntries(requestPathAndSearch(mock.calls[0]!).searchParams)).toEqual({ status: 'in_progress', limit: '1' })
    expect(Object.fromEntries(requestPathAndSearch(mock.calls[1]!).searchParams)).toEqual({ cursor: 'next' })
  })

  it('maps create/update/reset with fractional progress, CSRF, strong ETag, and distinct intents', async () => {
    const mock = installFetchMock((_input, init) => requestMethod({ input: _input, init }) === 'DELETE'
      ? new Response(null, { status: 204 })
      : jsonResponse({ status: 'in_progress', progress: 0.42, completedAt: null, updatedAt: '2026-07-25T00:00:00Z' }, { status: 200, headers: { etag: '"reading-2"' } }))
    restoreFetch = mock.restore
    const updated = await productClient.putReadingProgress('node', 'node-1', { status: 'in_progress', progress: 0.42 }, '"reading-1"', { intentId: 'progress-update', maxRetries: 0 })
    await productClient.resetReadingProgress('node', 'node-1', '"reading-2"', { intentId: 'progress-reset', maxRetries: 0 })
    expect(updated.etag).toBe('"reading-2"')
    expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ status: 'in_progress', progress: 0.42 })
    expect(requestHeaders(mock.calls[0]!).get('if-match')).toBe('"reading-1"')
    expect(requestHeaders(mock.calls[1]!).get('if-match')).toBe('"reading-2"')
    expect(requestHeaders(mock.calls[0]!).get('known-command-id')).not.toBe(requestHeaders(mock.calls[1]!).get('known-command-id'))
  })

  it('refreshes Session after 401 while replaying the exact command id', async () => {
    const mock = installFetchMock(() => {
      if (mock.calls.length === 1) return jsonResponse(productErrorBody({ code: 'authentication_required', recovery: 'reauthenticate', sameRequestRetrySafe: true }), { status: 401 })
      if (mock.calls.length === 2) return jsonResponse({ authenticated: true, csrfToken: 'reading-csrf', idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
      return jsonResponse({ status: 'completed', progress: 1, completedAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z' }, { headers: { etag: '"reading-2"' } })
    })
    restoreFetch = mock.restore
    await productClient.putReadingProgress('node', 'node-1', { status: 'completed', progress: 1 }, '"reading-1"', { intentId: 'recover-progress', maxRetries: 0 })
    expect(requestHeaders(mock.calls[2]!).get('known-command-id')).toBe(requestHeaders(mock.calls[0]!).get('known-command-id'))
    expect(requestHeaders(mock.calls[2]!).get('x-csrf-token')).toBe('reading-csrf')
  })

  it('surfaces 412 authority and preserves an unknown outcome command for explicit replay', async () => {
    const mock = installFetchMock(() => {
      if (mock.calls.length === 1) throw new TypeError('response lost after commit')
      if (mock.calls.length === 2) return jsonResponse({ status: 'in_progress', progress: 0.75, completedAt: null, updatedAt: '2026-07-25T00:00:01Z' }, { headers: { etag: '"reading-2"' } })
      return jsonResponse(productErrorBody({ code: 'precondition_failed', recovery: 'refresh_and_retry', precondition: 'resource', currentEtag: '"reading-3"' }), { status: 412 })
    })
    restoreFetch = mock.restore
    const options = { intentId: 'same-progress-intent', maxRetries: 0, clearIntentOnSuccess: false }
    await expect(productClient.putReadingProgress('node', 'node-1', { status: 'in_progress', progress: 0.75 }, '"reading-1"', options)).rejects.toMatchObject({ code: 'transport_error' })
    await productClient.putReadingProgress('node', 'node-1', { status: 'in_progress', progress: 0.75 }, '"reading-1"', options)
    await expect(productClient.putReadingProgress('node', 'node-1', { status: 'completed', progress: 1 }, '"reading-2"', { intentId: 'stale', maxRetries: 0 })).rejects.toMatchObject({ status: 412, currentEtag: '"reading-3"' })
    expect(requestHeaders(mock.calls[1]!).get('known-command-id')).toBe(requestHeaders(mock.calls[0]!).get('known-command-id'))
  })
})
