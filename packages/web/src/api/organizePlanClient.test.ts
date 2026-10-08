import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient, ProductApiError } from './productClient'
import {
  clearCommandId,
  getOrCreateCommandId,
} from './commandId'
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

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

const ORGANIZE_CREATE_INTENT = 'create-organize-plan'
const ORGANIZE_APPLY_INTENT = 'apply-organize-plan'
const ORGANIZE_ENCODED_COLLECTION = 'col/a+b'
const ORGANIZE_ENCODED_PLAN = 'plan/x+y'

function organizePlanBody() {
  return {
    planId: 'plan-1',
    etag: '"plan-etag-1"',
    expiresAt: '2026-08-24T12:00:00.000Z',
    collectionRevision: 'rev-1',
    plannerId: 'heuristic.v1.host-cluster',
    truncated: false,
    actions: [],
  }
}

function organizeRequestHref(call: FetchCall): string {
  if (typeof call.input === 'string') return call.input
  if (call.input instanceof URL) return call.input.href
  return call.input.url
}

describe('OG-FE-02 organize-plan Product client', () => {
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
    clearCommandId(ORGANIZE_CREATE_INTENT)
    clearCommandId(ORGANIZE_APPLY_INTENT)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('creates a plan with POST, credentials, CSRF, command id, and JSON body', async () => {
    seedAuthenticatedSession('csrf-organize')
    const commandId = getOrCreateCommandId(ORGANIZE_CREATE_INTENT)
    const mock = installFetchMock(() => jsonResponse(organizePlanBody(), { status: 201 }))
    restoreFetch = mock.restore

    const result = await productClient.createCollectionOrganizePlan(
      'col-1',
      {},
      { intentId: ORGANIZE_CREATE_INTENT, maxRetries: 0 },
    )
    expect(result.planId).toBe('plan-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/collections/col-1/organize-plans')
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({})
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-organize')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
    expect(headers.get('If-Match')).toBeNull()
  })

  it('gets a plan without CSRF, command id, or If-Match', async () => {
    seedAuthenticatedSession('csrf-read')
    const mock = installFetchMock(() => jsonResponse(organizePlanBody()))
    restoreFetch = mock.restore
    const signal = new AbortController().signal

    const result = await productClient.getCollectionOrganizePlan('col-1', 'plan-1', {
      signal,
      maxRetries: 0,
    })
    expect(result.planId).toBe('plan-1')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/organize-plans/plan-1',
    )
    expect(call.init?.credentials).toBe('include')
    expect(call.init?.signal).toBeInstanceOf(AbortSignal) // derived: caller signal + R15-12 deadline
    const headers = requestHeaders(call)
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
    expect(headers.get('If-Match')).toBeNull()
  })

  it('applies selected actions with CSRF, command id, If-Match, and actionIds body', async () => {
    seedAuthenticatedSession('csrf-organize-apply')
    const commandId = getOrCreateCommandId(ORGANIZE_APPLY_INTENT)
    const mock = installFetchMock(() => jsonResponse({
      planId: 'plan-1',
      appliedActionIds: ['act-1'],
      createdFolderIds: [],
      movedNodeIds: ['n1'],
    }))
    restoreFetch = mock.restore

    const result = await productClient.applyCollectionOrganizePlan(
      'col-1',
      'plan-1',
      { actionIds: ['act-1'] },
      { intentId: ORGANIZE_APPLY_INTENT, ifMatch: '"plan-etag-1"', maxRetries: 0 },
    )
    expect(result.appliedActionIds).toEqual(['act-1'])

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe(
      '/api/v1/collections/col-1/organize-plans/plan-1/apply',
    )
    expect(call.init?.credentials).toBe('include')
    expect(JSON.parse(String(call.init?.body))).toEqual({ actionIds: ['act-1'] })
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-organize-apply')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
    expect(headers.get('If-Match')).toBe('"plan-etag-1"')
    expect(headers.get('Content-Type')).toMatch(/application\/json/i)
  })

  it('encodes reserved characters in collectionId and planId', async () => {
    seedAuthenticatedSession('csrf-organize-encode')
    getOrCreateCommandId(ORGANIZE_CREATE_INTENT)
    getOrCreateCommandId(ORGANIZE_APPLY_INTENT)
    const mock = installFetchMock((input) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (href.includes('/apply')) {
        return jsonResponse({
          planId: ORGANIZE_ENCODED_PLAN,
          appliedActionIds: [],
          createdFolderIds: [],
          movedNodeIds: [],
        })
      }
      return jsonResponse(organizePlanBody())
    })
    restoreFetch = mock.restore

    await productClient.createCollectionOrganizePlan(
      ORGANIZE_ENCODED_COLLECTION,
      {},
      { intentId: ORGANIZE_CREATE_INTENT, maxRetries: 0 },
    )
    expect(organizeRequestHref(mock.calls[0]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ORGANIZE_ENCODED_COLLECTION)}/organize-plans`,
    )

    await productClient.getCollectionOrganizePlan(
      ORGANIZE_ENCODED_COLLECTION,
      ORGANIZE_ENCODED_PLAN,
      { maxRetries: 0 },
    )
    expect(organizeRequestHref(mock.calls[1]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ORGANIZE_ENCODED_COLLECTION)}/organize-plans/${encodeURIComponent(ORGANIZE_ENCODED_PLAN)}`,
    )

    await productClient.applyCollectionOrganizePlan(
      ORGANIZE_ENCODED_COLLECTION,
      ORGANIZE_ENCODED_PLAN,
      { actionIds: ['act-1'] },
      { intentId: ORGANIZE_APPLY_INTENT, ifMatch: '"plan-etag-1"', maxRetries: 0 },
    )
    expect(organizeRequestHref(mock.calls[2]!)).toContain(
      `/api/v1/collections/${encodeURIComponent(ORGANIZE_ENCODED_COLLECTION)}/organize-plans/${encodeURIComponent(ORGANIZE_ENCODED_PLAN)}/apply`,
    )
  })

  it('does not wrap AbortError from getCollectionOrganizePlan as ProductApiError', async () => {
    const mock = installFetchMock(() => Promise.reject(new DOMException('Aborted', 'AbortError')))
    restoreFetch = mock.restore

    const error = await productClient.getCollectionOrganizePlan('col-1', 'plan-1', { maxRetries: 0 })
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

    await expect(productClient.getCollectionOrganizePlan('col-1', 'plan-1', { maxRetries: 0 }))
      .rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused for create', async () => {
    seedAuthenticatedSession('csrf-organize-conflict')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const options = { intentId: ORGANIZE_CREATE_INTENT, maxRetries: 0 }

    await expect(productClient.createCollectionOrganizePlan('col-1', {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.createCollectionOrganizePlan('col-1', {}, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(ORGANIZE_CREATE_INTENT))
    expect(ids[1]).toBe(ids[0])
  })

  it('does not rotate Known-Command-Id on 409 command_id_reused for apply', async () => {
    seedAuthenticatedSession('csrf-organize-apply-conflict')
    const mock = installFetchMock(() =>
      jsonResponse(productErrorBody({
        code: 'command_id_reused',
        message: 'different command binding',
        recovery: 'user_action',
        sameRequestRetrySafe: false,
      }), { status: 409 }),
    )
    restoreFetch = mock.restore
    const options = {
      intentId: ORGANIZE_APPLY_INTENT,
      ifMatch: '"plan-etag-1"',
      maxRetries: 0,
    }

    await expect(productClient.applyCollectionOrganizePlan(
      'col-1',
      'plan-1',
      { actionIds: ['act-1'] },
      options,
    )).rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.applyCollectionOrganizePlan(
      'col-1',
      'plan-1',
      { actionIds: ['act-1'] },
      options,
    )).rejects.toMatchObject({ code: 'command_id_reused' })

    const ids = mock.calls.map((call) => requestHeaders(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(getOrCreateCommandId(ORGANIZE_APPLY_INTENT))
    expect(ids[1]).toBe(ids[0])
  })
})
