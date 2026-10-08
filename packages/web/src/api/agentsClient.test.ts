import { afterEach, describe, expect, it, vi } from 'vitest'
import { applySessionView, clearSession } from './sessionStore'
import {
  agentConnectCopy,
  getAgentPolicy,
  issueAgentKey,
  listAgentAudit,
  listAgents,
  putAgentPolicy,
  revokeAgent,
  undoApproval,
} from './agentsClient'

const agent = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'oauth_client',
  scopes: ['mcp:read:own', 'nodes:write'],
  createdAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: '2026-10-02T00:00:00.000Z',
  policy: 'manual',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('agent connect copy', () => {
  it('names Claude Code, Codex, and an API key against this origin', () => {
    const copy = agentConnectCopy('https://colp.example.net/')
    expect(copy.strictUrl).toBe('https://colp.example.net/collections/-/mcp')
    expect(copy.compatUrl).toBe('https://colp.example.net/collections/-/mcp-compat')
    expect(copy.claude).toContain('claude mcp add --transport http colp')
    expect(copy.claude).toContain(copy.compatUrl)
    expect(copy.codex).toBe(copy.strictUrl)
    expect(copy.curl).toContain('Authorization: Bearer $ACCESS_TOKEN')
    expect(copy.curl).toContain('MCP-Protocol-Version: 2026-07-28')
    expect(copy.curl).toContain(copy.strictUrl)
  })
})

describe('agent directory client', () => {
  afterEach(() => {
    clearSession()
  })

  it('does not fetch loaders during unit tests unless fetch is injected', async () => {
    await expect(listAgents()).resolves.toEqual({ agents: [] })
    await expect(listAgentAudit('claude-code')).resolves.toEqual({ records: [] })
    await expect(getAgentPolicy('claude-code')).resolves.toEqual({ clientId: 'claude-code', policy: 'manual' })
  })

  it('lists agents, reads policy, and loads audit', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/me/agents')) return json(200, { agents: [agent] })
      if (url.includes('/policy')) return json(200, { clientId: 'claude-code', policy: 'trusted' })
      return json(200, {
        records: [{
          id: 'plan-1',
          kind: 'plan',
          createdAt: '2026-10-03T00:00:00.000Z',
          summary: 'Move three bookmarks',
          outcome: 'consumed',
          versionId: 'ver-1',
          collectionId: 'col-1',
        }],
      })
    })
    await expect(listAgents({ fetch: fetchImpl })).resolves.toEqual({ agents: [agent] })
    await expect(getAgentPolicy('claude-code', { fetch: fetchImpl })).resolves.toEqual({
      clientId: 'claude-code',
      policy: 'trusted',
    })
    const audit = await listAgentAudit('claude-code', { fetch: fetchImpl })
    expect(audit.records[0]).toMatchObject({ versionId: 'ver-1', collectionId: 'col-1', outcome: 'consumed' })
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain('/api/v1/me/agents/claude-code/audit?limit=50')
  })

  it('puts policy, revokes, and issues a key once', async () => {
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-agents',
      idleExpiresAt: '2099-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') return json(200, { clientId: 'claude-code', policy: 'trusted' })
      if (url.endsWith('/revoke')) return json(200, { id: 'key-1', revoked: true, cancelledPlanCount: 2 })
      return json(201, { id: 'key-1', name: 'script', secret: 'colp_secret_once' })
    })
    await expect(putAgentPolicy('claude-code', 'trusted', { fetch: fetchImpl })).resolves.toEqual({
      clientId: 'claude-code',
      policy: 'trusted',
    })
    const put = fetchImpl.mock.calls[0]
    expect(put?.[1]).toMatchObject({
      method: 'PUT',
      credentials: 'include',
      body: JSON.stringify({ policy: 'trusted' }),
    })
    expect(new Headers(put?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-agents')

    await expect(revokeAgent('key-1', { fetch: fetchImpl })).resolves.toEqual({
      id: 'key-1',
      revoked: true,
      cancelledPlanCount: 2,
    })
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBeUndefined()

    await expect(issueAgentKey(' script ', { fetch: fetchImpl, intentId: 'issue-1' })).resolves.toEqual({
      id: 'key-1',
      name: 'script',
      secret: 'colp_secret_once',
    })
    const issue = fetchImpl.mock.calls[2]
    expect(String(issue?.[0])).toContain('/api/v1/me/agents/keys')
    expect(issue?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ name: 'script' }),
    })
    expect(new Headers(issue?.[1]?.headers).get('Known-Command-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('posts approval undo and retries with force', async () => {
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-undo',
      idleExpiresAt: '2099-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('force=true')) {
        return json(200, { planId: 'plan-1', versionId: 'ver-1', restored: true, noop: false })
      }
      return json(409, {
        error: {
          code: 'mutation_conflict',
          message: 'A newer version exists.',
          recovery: 'refresh_and_retry',
        },
      })
    })
    await expect(undoApproval('plan-1', { fetch: fetchImpl })).rejects.toMatchObject({
      status: 409,
      code: 'mutation_conflict',
    })
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/v1/mcp/approvals/plan-1/undo')
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{}' })
    await expect(undoApproval('plan-1', { fetch: fetchImpl, force: true })).resolves.toMatchObject({
      planId: 'plan-1',
      versionId: 'ver-1',
      restored: true,
    })
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('force=true')
  })
})
