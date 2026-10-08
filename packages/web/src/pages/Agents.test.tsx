// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsApi } from '../api/agentsClient'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'
import { AgentsPage } from './Agents'

const agent = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'oauth_client' as const,
  scopes: ['mcp:read:own'],
  createdAt: '2026-10-01T12:00:00.000Z',
  lastSeenAt: null,
  policy: 'manual' as const,
}

const api = {
  listAgents: vi.fn(),
  listAgentAudit: vi.fn(),
  getAgentPolicy: vi.fn(),
  putAgentPolicy: vi.fn(),
  revokeAgent: vi.fn(),
  issueAgentKey: vi.fn(),
  undoApproval: vi.fn(),
}

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: true, bootstrapping: false, csrfToken: 'csrf' }),
}))

function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[name="keyName"]')
  if (!input) throw new Error('missing key name')
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Agents page', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.clearAllMocks()
  })

  it('shows connect instructions and does not fetch with the default loader', async () => {
    mountTree(<AgentsPage origin="https://colp.example.net" />, { initialEntries: ['/agents'] })
    await waitForDom(() => document.body.textContent?.includes('No agents yet') === true)
    expect(document.body.textContent).toContain('claude mcp add --transport http colp')
    expect(document.body.textContent).toContain('https://colp.example.net/collections/-/mcp-compat')
    expect(document.body.textContent).toContain('https://colp.example.net/collections/-/mcp')
    expect(document.body.textContent).toContain('Authorization: Bearer $KEY')
    expect(document.body.textContent).toContain('Codex')
    expect(document.querySelector('[data-testid="agents-page"] h1')?.textContent).toBe('Agents')
  })

  it('toggles policy, shows audit, issues a key once, and revokes it', async () => {
    api.listAgents.mockResolvedValue({ agents: [agent] })
    api.getAgentPolicy.mockResolvedValue({ clientId: agent.id, policy: 'manual' })
    api.listAgentAudit.mockResolvedValue({
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
    api.putAgentPolicy.mockResolvedValue({ clientId: agent.id, policy: 'trusted' })
    api.issueAgentKey.mockResolvedValue({ id: 'key-1', name: 'script', secret: 'colp_secret_once' })
    api.revokeAgent.mockResolvedValue({ id: agent.id, revoked: true, cancelledPlanCount: 1 })

    mountTree(<AgentsPage api={api as AgentsApi} origin="https://colp.example.net" />, { initialEntries: ['/agents'] })
    await waitForDom(() => document.body.textContent?.includes('Claude Code') === true)

    act(() => findButtonByName('Trusted').click())
    await waitForDom(() => api.putAgentPolicy.mock.calls.length >= 1)
    expect(api.putAgentPolicy).toHaveBeenCalledWith('claude-code', 'trusted')
    expect(findButtonByName('Trusted').getAttribute('aria-pressed')).toBe('true')

    act(() => findButtonByName('Audit').click())
    await waitForDom(() => document.body.textContent?.includes('Move three bookmarks') === true)
    expect(api.listAgentAudit).toHaveBeenCalledWith('claude-code')
    expect(api.getAgentPolicy).toHaveBeenCalledWith('claude-code')
    expect(document.querySelector('a[href="/library/col-1/history"]')?.textContent).toContain('ver-1')

    typeName('script')
    act(() => findButtonByName('Issue key').click())
    await waitForDom(() => document.body.textContent?.includes('colp_secret_once') === true)
    expect(api.issueAgentKey).toHaveBeenCalledWith('script', expect.objectContaining({ intentId: expect.any(String) }))
    expect(document.body.textContent).toContain('It will not be shown again.')

    act(() => findButtonByName('Revoke').click())
    await waitForDom(() => findButtonByName('Revoke agent') instanceof HTMLButtonElement)
    act(() => findButtonByName('Revoke agent').click())
    await waitForDom(() => api.revokeAgent.mock.calls.length >= 1)
    expect(api.revokeAgent).toHaveBeenCalledWith('claude-code')
  })
})
