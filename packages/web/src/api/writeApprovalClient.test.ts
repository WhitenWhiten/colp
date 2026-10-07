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
import type { WriteApprovalPage, WriteApprovalView } from './types'

function approvalView(overrides: Partial<WriteApprovalView> = {}): WriteApprovalView {
  return {
    planId: 'plan-1',
    status: 'pending',
    risk: 'high',
    requiresApproval: true,
    summary: 'Change node visibility to public',
    impact: {
      collections: 1,
      nodes: 1,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: ['sourceRef'],
    },
    requiredScopes: ['access:write'],
    target: { kind: 'node', collectionId: 'col-1', nodeId: 'node-1' },
    operations: [{
      type: 'set_visibility',
      collectionId: 'col-1',
      nodeId: 'node-1',
      visibility: 'public',
      nodeSummary: null,
    }],
    createdAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-07T00:00:00.000Z',
    decision: 'pending',
    etag: '"approval:v1"',
    ...overrides,
  }
}

function approvalPage(items: WriteApprovalView[] = [approvalView()]): WriteApprovalPage {
  return { items, nextCursor: null }
}

function lastCall(calls: FetchCall[]): FetchCall {
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]!
}

describe('MCP-W08 write approval Product client', () => {
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
    clearCommandId('write-approval:plan-1:approve:client-retry')
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('lists current-account approvals without CSRF or command headers', async () => {
    const mock = installFetchMock(() => jsonResponse(approvalPage()))
    restoreFetch = mock.restore

    const page = await productClient.getWriteApprovalPage({ limit: 12 }, { maxRetries: 0 })
    expect(page.items[0]?.planId).toBe('plan-1')
    expect(page.nextCursor).toBeNull()

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    const request = requestPathAndSearch(call)
    expect(request.pathname).toBe('/api/v1/mcp/approvals')
    expect(request.searchParams.get('limit')).toBe('12')
    expect(call.init?.credentials).toBe('include')
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
  })

  it('loads one approval with an encoded plan id and no mutation headers', async () => {
    const mock = installFetchMock(() => jsonResponse(approvalView()))
    restoreFetch = mock.restore

    await productClient.getWriteApproval('plan-1', { maxRetries: 0 })
    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('GET')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/mcp/approvals/plan-1')
    expect(requestHeaders(call).get('If-Match')).toBeNull()
    expect(requestHeaders(call).get('Known-Command-Id')).toBeNull()
  })

  it('sends CSRF, Origin, strong If-Match, stable command id, and typed decision', async () => {
    seedAuthenticatedSession('csrf-approval')
    const intentId = 'write-approval:plan-1:approve:client-retry'
    const commandId = getOrCreateCommandId(intentId)
    const mock = installFetchMock(() => jsonResponse({
      kind: 'decided',
      planId: 'plan-1',
      decision: 'approved',
      status: 'approved',
      etag: '"approval:v2"',
    }, { headers: { ETag: '"approval:v2"' } }))
    restoreFetch = mock.restore

    const result = await productClient.decideWriteApproval(
      'plan-1',
      'approve',
      '"approval:v1"',
      { intentId, maxRetries: 0 },
    )
    expect(result.decision).toBe('approved')

    const call = lastCall(mock.calls)
    expect(requestMethod(call)).toBe('POST')
    expect(requestPathAndSearch(call).pathname).toBe('/api/v1/mcp/approvals/plan-1/decision')
    expect(JSON.parse(String(call.init?.body))).toEqual({ decision: 'approve' })
    const headers = requestHeaders(call)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-approval')
    expect(headers.get('If-Match')).toBe('"approval:v1"')
    expect(headers.get('Known-Command-Id')).toBe(commandId)
    expect(isUuidV4(commandId)).toBe(true)
  })

  it('replays an unknown decision outcome with the exact same command id', async () => {
    seedAuthenticatedSession('csrf-approval-retry')
    const intentId = 'write-approval:plan-1:approve:client-retry'
    let attempts = 0
    const mock = installFetchMock(() => {
      attempts += 1
      if (attempts === 1) {
        return jsonResponse(productErrorBody({
          code: 'internal_error',
          recovery: 'same_request',
          sameRequestRetrySafe: true,
        }), { status: 500 })
      }
      return jsonResponse({
        kind: 'decided',
        planId: 'plan-1',
        decision: 'approved',
        status: 'approved',
        etag: '"approval:v2"',
      })
    })
    restoreFetch = mock.restore

    await expect(productClient.decideWriteApproval(
      'plan-1', 'approve', '"approval:v1"', { intentId, maxRetries: 0 },
    )).rejects.toMatchObject({ status: 500, code: 'internal_error' })
    await productClient.decideWriteApproval(
      'plan-1', 'approve', '"approval:v1"', { intentId, maxRetries: 0 },
    )

    const first = requestHeaders(mock.calls[0]!)
    const replay = requestHeaders(mock.calls[1]!)
    expect(replay.get('Known-Command-Id')).toBe(first.get('Known-Command-Id'))
    expect(replay.get('If-Match')).toBe(first.get('If-Match'))
    expect(replay.get('X-CSRF-Token')).toBe(first.get('X-CSRF-Token'))
  })

  it('maps stale, conflict, and missing approval Product errors without fallback', async () => {
    seedAuthenticatedSession('csrf-approval-errors')
    const stale = installFetchMock(() => jsonResponse(productErrorBody({
      code: 'precondition_failed',
      recovery: 'refresh_and_retry',
      precondition: 'resource',
      currentEtag: '"approval:v2"',
    }), { status: 412 }))
    restoreFetch = stale.restore
    await expect(productClient.decideWriteApproval(
      'plan-1', 'deny', '"approval:v1"', { intentId: 'write-approval:plan-1:deny:client-error', maxRetries: 0 },
    )).rejects.toMatchObject({ status: 412, code: 'precondition_failed', currentEtag: '"approval:v2"' })

    const conflict = installFetchMock(() => jsonResponse(productErrorBody({
      code: 'mutation_conflict',
      recovery: 'refresh_and_retry',
    }), { status: 409 }))
    restoreFetch = conflict.restore
    await expect(productClient.decideWriteApproval(
      'plan-1', 'approve', '"approval:v1"', { intentId: 'write-approval:plan-1:approve:client-conflict', maxRetries: 0 },
    )).rejects.toMatchObject({ status: 409, code: 'mutation_conflict' })

    const missing = installFetchMock(() => jsonResponse(productErrorBody({
      code: 'resource_not_found',
      recovery: 'none',
    }), { status: 404 }))
    restoreFetch = missing.restore
    await expect(productClient.getWriteApproval('missing', { maxRetries: 0 }))
      .rejects.toMatchObject({ status: 404, code: 'resource_not_found' })
  })
})
