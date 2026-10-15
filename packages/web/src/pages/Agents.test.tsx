// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsApi } from '../api/agentsClient'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'
import { Agents } from './Agents'
import { outcomeBadge } from './agents/AgentCard'

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

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const auth = vi.hoisted(() => ({
  isLoggedIn: true, bootstrapping: false, csrfToken: 'csrf', sessionState: 'ready',
  serverBusySeconds: null as number | null, refreshSession: vi.fn(async () => {}),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => auth,
}))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: toast.success, error: toast.error }),
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
    auth.isLoggedIn = true
    auth.sessionState = 'ready'
  })

  it('shows the outage state, not Sign in, while the session check fails (R15-23)', () => {
    auth.isLoggedIn = false
    auth.sessionState = 'offline'
    mountTree(<Agents origin="https://colp.example.net" />, { initialEntries: ['/agents'] })
    expect(document.body.textContent).toContain('COLP Server is unavailable right now')
    expect(document.body.textContent).not.toContain('Sign in to manage agents')
    expect(document.body.textContent).not.toContain('to issue a key')
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
  })

  it('shows connect instructions and does not fetch with the default loader', async () => {
    mountTree(<Agents origin="https://colp.example.net" />, { initialEntries: ['/agents'] })
    await waitForDom(() => document.body.textContent?.includes('No agents yet') === true)
    expect(document.querySelector('[data-testid="agents-page"] h1')?.textContent).toBe('Agents')
    const panel = () => document.querySelector('[role="tabpanel"]')?.textContent ?? ''
    expect(panel()).toContain('claude mcp add --transport http colp "https://colp.example.net/collections/-/mcp-compat"')
    expect(panel()).toContain('claude mcp login colp')

    act(() => findButtonByName('Codex').click())
    expect(document.querySelector('#agents-tab-codex')?.getAttribute('aria-selected')).toBe('true')
    expect(panel()).toContain('codex mcp add colp --url "https://colp.example.net/collections/-/mcp-compat"')

    act(() => findButtonByName('Other clients').click())
    expect(panel()).toContain('https://colp.example.net/collections/-/mcp-compat')
    expect(panel()).toContain('Start the client’s OAuth sign-in for this server')
    expect(panel()).toContain('curl -X POST "https://colp.example.net/api/v1/auth/oauth2/register"')

    act(() => findButtonByName('API key').click())
    expect(panel()).toContain('Authorization: Bearer $ACCESS_TOKEN')
  })

  it('reverts a policy change the server refuses and says so in a toast', async () => {
    api.listAgents.mockResolvedValue({ agents: [agent] })
    api.putAgentPolicy.mockRejectedValue(new Error('offline'))
    mountTree(<Agents api={api as AgentsApi} origin="https://colp.example.net" />, { initialEntries: ['/agents'] })
    await waitForDom(() => document.body.textContent?.includes('Claude Code') === true)
    act(() => findButtonByName('Trusted').click())
    await waitForDom(() => toast.error.mock.calls.length >= 1)
    expect(toast.error).toHaveBeenCalledWith('Could not change the policy for Claude Code.')
    expect(findButtonByName('Manual').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('Every change waits for you on Approvals.')
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

    mountTree(<Agents api={api as AgentsApi} origin="https://colp.example.net" />, { initialEntries: ['/agents'] })
    await waitForDom(() => document.body.textContent?.includes('Claude Code') === true)

    act(() => findButtonByName('Trusted').click())
    await waitForDom(() => api.putAgentPolicy.mock.calls.length >= 1)
    expect(api.putAgentPolicy).toHaveBeenCalledWith('claude-code', 'trusted')
    expect(findButtonByName('Trusted').getAttribute('aria-pressed')).toBe('true')

    act(() => findButtonByName('Activity').click())
    await waitForDom(() => document.body.textContent?.includes('Move three bookmarks') === true)
    expect(api.listAgentAudit).toHaveBeenCalledWith('claude-code')
    expect(api.getAgentPolicy).toHaveBeenCalledWith('claude-code')
    expect(document.querySelector('a[href="/library/col-1/history"]')?.getAttribute('aria-label')).toContain('ver-1')
    expect(document.body.textContent).toContain('Applied')

    act(() => findButtonByName('API key').click())
    typeName('script')
    act(() => findButtonByName('Issue key').click())
    await waitForDom(() => document.body.textContent?.includes('colp_secret_once') === true)
    expect(api.issueAgentKey).toHaveBeenCalledWith('script', expect.objectContaining({ intentId: expect.any(String) }))
    expect(document.body.textContent).toContain('It will not be shown again.')
    // The refreshed list pushes the secret down; focus lands on its Copy button.
    await waitForDom(() => document.activeElement?.getAttribute('aria-label') === 'Copy API key')

    act(() => findButtonByName('Revoke').click())
    await waitForDom(() => findButtonByName('Revoke agent') instanceof HTMLButtonElement)
    act(() => findButtonByName('Revoke agent').click())
    await waitForDom(() => api.revokeAgent.mock.calls.length >= 1)
    expect(api.revokeAgent).toHaveBeenCalledWith('claude-code')
    await waitForDom(() => toast.success.mock.calls.length >= 1)
    expect(toast.success).toHaveBeenCalledWith('Claude Code is revoked. 1 pending plan cancelled.')
  })

  it('names plan outcomes in plain words', () => {
    expect(outcomeBadge('consumed')).toEqual({ label: 'Applied', tone: 'success' })
    expect(outcomeBadge('pending')).toEqual({ label: 'Waiting for you', tone: 'warning' })
    expect(outcomeBadge('needs_review')).toEqual({ label: 'Needs review', tone: 'neutral' })
  })
})
