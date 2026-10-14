// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySessionView, clearSession } from './sessionStore'
import { automationEtag, createAutomationApi } from './automationClient'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function headersOf(call: unknown[] | undefined): Headers {
  return new Headers((call?.[1] as RequestInit | undefined)?.headers)
}

describe('automation client', () => {
  beforeEach(() => {
    applySessionView({ authenticated: true, csrfToken: 'csrf-auto', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
    sessionStorage.clear()
  })

  afterEach(() => {
    clearSession()
  })

  it('reads with the session only: no CSRF, no command', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [{ id: 'r1' }], nextCursor: 'next' }))
    const page = await createAutomationApi(fetchImpl).listRules('cur')
    expect(page).toEqual({ items: [{ id: 'r1' }], nextCursor: 'next' })
    expect(String(fetchImpl.mock.calls[0]?.[0 as never])).toBe('/api/v1/me/automations/rules?cursor=cur')
    const headers = headersOf(fetchImpl.mock.calls[0])
    expect(headers.get('X-CSRF-Token')).toBeNull()
    expect(headers.get('Known-Command-Id')).toBeNull()
  })

  it('turns a rule on with CSRF, a command id, the revision as If-Match and the exact preview id', async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: 'rule-1', revision: '4' }))
    await createAutomationApi(fetchImpl).setRuleLifecycle('rule-1', {
      state: 'enabled', pendingRuns: 'hold', activationPreviewId: 'preview-9', reason: 'Owner turned it on.',
    }, '3')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/me/automations/rules/rule-1/lifecycle')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-auto')
    expect(headers.get('If-Match')).toBe('"3"')
    expect(headers.get('Known-Command-Id')).toMatch(UUID_V4)
    expect(JSON.parse(String(init.body))).toMatchObject({ state: 'enabled', activationPreviewId: 'preview-9' })
  })

  it('replays the same command after an unknown outcome and starts a new one after success', async () => {
    const responses = [json(503, { error: { code: 'service_unavailable', message: 'Busy', recovery: 'same_request', sameRequestRetrySafe: true } }),
      json(200, { paused: true, revision: '2' }), json(200, { paused: true, revision: '3' })]
    const fetchImpl = vi.fn(async () => responses.shift() ?? json(500, {}))
    const api = createAutomationApi(fetchImpl)
    await expect(api.setPause(true, '1')).rejects.toMatchObject({ status: 503 })
    await api.setPause(true, '1')
    await api.setPause(true, '1')
    const ids = fetchImpl.mock.calls.map((call) => headersOf(call).get('Known-Command-Id'))
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
  })

  it('starts a new command after a definite refusal', async () => {
    const responses = [json(412, { error: { code: 'precondition_failed', message: 'Changed', recovery: 'refresh_and_retry' } }), json(200, {})]
    const fetchImpl = vi.fn(async () => responses.shift() ?? json(500, {}))
    const api = createAutomationApi(fetchImpl)
    await expect(api.archiveRule('rule-1', '1')).rejects.toMatchObject({ status: 412, code: 'precondition_failed' })
    await api.archiveRule('rule-1', '1')
    const ids = fetchImpl.mock.calls.map((call) => headersOf(call).get('Known-Command-Id'))
    expect(ids[0]).not.toBe(ids[1])
  })

  it('names one effect, its digest and the run revision when undoing', async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: 'run-1' }))
    await createAutomationApi(fetchImpl).undoRunEffect('run-1', {
      reason: 'Owner undid one effect.', expectedEffectDigest: 'a'.repeat(64), effectReceiptId: 'eff-1',
    }, '7')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/me/automations/runs/run-1/undo')
    expect(new Headers(init.headers).get('If-Match')).toBe(automationEtag('7'))
    expect(JSON.parse(String(init.body))).toEqual({ reason: 'Owner undid one effect.', expectedEffectDigest: 'a'.repeat(64), effectReceiptId: 'eff-1' })
  })

  it('filters runs to one bookmark and refuses a malformed id before any request', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [], nextCursor: null }))
    const api = createAutomationApi(fetchImpl)
    await api.listRuns({ collectionId: 'c1', nodeId: 'n1' })
    expect(String(fetchImpl.mock.calls[0]?.[0 as never])).toBe('/api/v1/me/automations/runs?collectionId=c1&nodeId=n1')
    await expect(api.getRule('../x')).rejects.toMatchObject({ code: 'invalid_request' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('cancels a run and retries a job as commands on that resource’s revision', async () => {
    const fetchImpl = vi.fn(async () => json(200, { id: 'x' }))
    const api = createAutomationApi(fetchImpl)
    await api.cancelRun('run-1', '8')
    await api.retryJob('job-1', '4')
    const [cancelUrl, cancelInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const [retryUrl, retryInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(cancelUrl).toBe('/api/v1/me/automations/runs/run-1/cancel')
    expect(new Headers(cancelInit.headers).get('If-Match')).toBe('"8"')
    expect(JSON.parse(String(cancelInit.body))).toEqual({ reason: 'Owner cancelled the remaining work of this run.' })
    expect(retryUrl).toBe('/api/v1/me/automations/jobs/job-1/retry')
    expect(new Headers(retryInit.headers).get('If-Match')).toBe('"4"')
    expect(new Headers(retryInit.headers).get('Known-Command-Id')).toMatch(UUID_V4)
  })

  it('decides a proposal by its exact digest on the job revision', async () => {
    const fetchImpl = vi.fn(async () => json(200, { jobId: 'job-1', status: 'awaitingApproval' }))
    await createAutomationApi(fetchImpl).decideJob('job-1', { decision: 'approve', proposalDigest: 'd'.repeat(64), reason: 'Owner approved.' }, '7')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/v1/me/automations/jobs/job-1/decision')
    const headers = new Headers(init.headers)
    expect(headers.get('If-Match')).toBe('"7"')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-auto')
    expect(JSON.parse(String(init.body))).toEqual({ decision: 'approve', proposalDigest: 'd'.repeat(64), reason: 'Owner approved.' })
  })

  it('issues a pairing code and changes opt-ins on the resource revision', async () => {
    const fetchImpl = vi.fn(async () => json(201, { pairingId: 'p', targetId: 't', code: 'c', expiresAt: '2099-01-01T00:00:00Z' }))
    const api = createAutomationApi(fetchImpl)
    await api.issuePairing('target-1', '3')
    await api.replaceConnectionProfile('profile-1', {
      name: 'Worker', automationEnabled: true, authorizedClientId: 'client', credentialBindingId: 'binding', catalogs: ['automationWorker'],
    }, '4')
    const [pairUrl, pairInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const [profileUrl, profileInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(pairUrl).toBe('/api/v1/me/automations/targets/target-1/pairings')
    expect(new Headers(pairInit.headers).get('If-Match')).toBe('"3"')
    expect(JSON.parse(String(pairInit.body))).toEqual({ reason: 'Owner issued a one-use pairing code.' })
    expect(profileUrl).toBe('/api/v1/me/automations/connection-profiles/profile-1')
    expect(profileInit.method).toBe('PUT')
    expect(new Headers(profileInit.headers).get('If-Match')).toBe('"4"')
  })

  it('pages a run’s outputs and marks read through one output on the run revision', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [], nextCursor: null }))
    const api = createAutomationApi(fetchImpl)
    await api.listRunOutputs('run-1', { cursor: 'c2', limit: 3 })
    await api.markRunRead('run-1', 'output-9', '5')
    const [listUrl] = fetchImpl.mock.calls[0] as unknown as [string]
    const [readUrl, readInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(listUrl).toBe('/api/v1/me/automations/runs/run-1/outputs?cursor=c2&limit=3')
    expect(readUrl).toBe('/api/v1/me/automations/runs/run-1/read')
    expect(new Headers(readInit.headers).get('If-Match')).toBe('"5"')
    expect(JSON.parse(String(readInit.body))).toEqual({ throughOutputId: 'output-9' })
  })

  it('starts a run-once by the preview’s id and digest alone, replaying it after an unknown outcome', async () => {
    const responses = [json(200, { id: 'preview-1' }), json(200, { id: 'preview-2' }),
      json(503, { error: { code: 'service_unavailable', message: 'Busy', recovery: 'same_request', sameRequestRetrySafe: true } }),
      json(201, { id: 'run-1' })]
    const fetchImpl = vi.fn(async () => responses.shift() ?? json(500, {}))
    const api = createAutomationApi(fetchImpl)
    const input = { folder: { serverUuid: 'server', collectionId: 'collection', nodeId: 'root' }, includeDescendants: true, moveFolderedBookmarks: false, tasks: 'none' as const }
    await api.previewRunOnce('rule-1', input, 'attempt-1')
    await api.previewRunOnce('rule-1', input, 'attempt-2')
    const preview = { previewId: 'preview-2', previewDigest: 'digest-2' }
    await expect(api.startRunOnce('rule-1', preview)).rejects.toMatchObject({ status: 503 })
    await api.startRunOnce('rule-1', preview)
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url]) => url)).toEqual([
      '/api/v1/me/automations/rules/rule-1/run-once/preview',
      '/api/v1/me/automations/rules/rule-1/run-once/preview',
      '/api/v1/me/automations/rules/rule-1/run-once',
      '/api/v1/me/automations/rules/rule-1/run-once',
    ])
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual(input)
    expect(JSON.parse(String(calls[2]?.[1].body))).toEqual(preview)
    const ids = calls.map((call) => headersOf(call).get('Known-Command-Id'))
    // Each preview is its own command; a start after no answer repeats the same one.
    expect(ids[0]).not.toBe(ids[1])
    expect(ids[2]).toMatch(UUID_V4)
    expect(ids[3]).toBe(ids[2])
  })

  it('reads a job, a rule’s dependencies and a sized run page', async () => {
    const fetchImpl = vi.fn(async () => json(200, { items: [], nextCursor: null }))
    const api = createAutomationApi(fetchImpl)
    await api.getJob('job-1')
    await api.getRuleDependencies('rule-1')
    await api.listRuns({ cursor: 'c', limit: 100 })
    expect(fetchImpl.mock.calls.map((call) => String(call[0 as never]))).toEqual([
      '/api/v1/me/automations/jobs/job-1',
      '/api/v1/me/automations/rules/rule-1/dependencies',
      '/api/v1/me/automations/runs?cursor=c&limit=100',
    ])
  })

  it('asks for a new sign-in when there is no CSRF token', async () => {
    clearSession()
    const fetchImpl = vi.fn(async () => json(200, {}))
    await expect(createAutomationApi(fetchImpl).setPause(true, '1')).rejects.toMatchObject({ status: 401 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
