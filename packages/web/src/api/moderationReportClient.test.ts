// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { applyMeView, applySessionView, clearSession } from './sessionStore'
import { productErrorBody, requestHeaders } from './test-helpers'

const COMMAND_KEY = 'known.command-id.v1:'
const REPORT = {
  target: { kind: 'collection' as const, id: 'col_report_target' },
  category: 'spam' as const,
  description: 'unsolicited ads',
}

function callHeaders(call: Parameters<typeof fetch> | undefined): Headers {
  return requestHeaders({
    input: call?.[0] ?? '',
    init: call?.[1],
  })
}

describe('generated moderation report client', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    clearSession()
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-moderation-report',
      idleExpiresAt: '2026-10-03T02:00:00.000Z',
      absoluteExpiresAt: '2026-10-03T03:00:00.000Z',
    })
    applyMeView({
      account: { id: 'account-a', email: null },
      profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null },
    })
  })

  it('posts the report through the generated client with CSRF, command id, and body', async () => {
    const created = {
      id: 'case_1',
      target: REPORT.target,
      category: 'spam',
      status: 'submitted',
      publicResolution: null,
      revision: '1',
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(created), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))
    const intentId = 'moderation-report:submit'

    await expect(productClient.submitModerationReport(REPORT, { intentId, maxRetries: 0 })).resolves.toEqual(created)

    const [input, init] = fetchMock.mock.calls[0] ?? []
    const url = input as URL
    const headers = requestHeaders({ input: input!, init })
    expect(url.pathname).toBe('/api/v1/moderation/reports')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('include')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-moderation-report')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(headers.get('If-Match')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual(REPORT)
    expect(sessionStorage.getItem(`${COMMAND_KEY}${intentId}`)).toBeNull()
  })

  it('maps a product error envelope without replacing the command id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(productErrorBody({
      code: 'invalid_request',
      message: 'description is invalid',
      recovery: 'user_action',
      sameRequestRetrySafe: false,
      fieldErrors: [{ path: 'description', code: 'invalid', message: 'description is invalid' }],
    })), { status: 400, headers: { 'content-type': 'application/json' } }))
    const intentId = 'moderation-report:invalid'

    await expect(productClient.submitModerationReport(REPORT, { intentId, maxRetries: 0 })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: 'description is invalid',
      recovery: 'user_action',
      sameRequestRetrySafe: false,
      fieldErrors: [{ path: 'description', code: 'invalid', message: 'description is invalid' }],
    })
    await expect(productClient.submitModerationReport(REPORT, { intentId, maxRetries: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
    })

    const first = callHeaders(fetchMock.mock.calls[0]).get('Known-Command-Id')
    const second = callHeaders(fetchMock.mock.calls[1]).get('Known-Command-Id')
    expect(first).toMatch(/^[0-9a-f-]{36}$/u)
    expect(second).toBe(first)
    expect(sessionStorage.getItem(`${COMMAND_KEY}${intentId}`)).toBe(first)
    expect(callHeaders(fetchMock.mock.calls[0]).get('X-CSRF-Token')).toBe('csrf-moderation-report')
  })

  it('does not rotate the command id when the response is not a product envelope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>gateway</html>', {
      status: 422,
      headers: { 'content-type': 'text/html' },
    }))
    const intentId = 'moderation-report:unknown'

    await expect(productClient.submitModerationReport(REPORT, { intentId, maxRetries: 0 })).rejects.toMatchObject({
      status: 422,
      code: 'unknown_error',
      message: 'Product API error (422)',
      recovery: 'user_action',
      sameRequestRetrySafe: false,
    })
    const stored = sessionStorage.getItem(`${COMMAND_KEY}${intentId}`)
    const first = callHeaders(fetchMock.mock.calls[0]).get('Known-Command-Id')
    expect(stored).toBe(first)

    await expect(productClient.submitModerationReport(REPORT, { intentId, maxRetries: 0 })).rejects.toMatchObject({
      status: 422,
      code: 'unknown_error',
    })
    expect(callHeaders(fetchMock.mock.calls[1]).get('Known-Command-Id')).toBe(first)
    expect(sessionStorage.getItem(`${COMMAND_KEY}${intentId}`)).toBe(first)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(REPORT)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not send the original report after the account changes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const pending = productClient.submitModerationReport(REPORT, {
      intentId: 'moderation-report:account-change',
      maxRetries: 0,
    })
    // requireCsrf yields before the generated POST. The switch has to land in that gap.
    applyMeView({
      account: { id: 'account-b', email: null },
      profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null },
    })

    await expect(pending).rejects.toMatchObject({
      status: 409,
      code: 'mutation_conflict',
      sameRequestRetrySafe: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
