// @vitest-environment happy-dom
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSummary } from '../../api/agentsClient'
import type { AutomationAgentSetupInput, AutomationAgentSetupResult, AutomationConnectionProfile, AutomationTarget } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { buttonNamed, click, deps, fakeApi, fakeFolders, job, rule, run } from './automations.test-helper'

vi.mock('../../components/AppToast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn() }) }))

const target: AutomationTarget = {
  id: 'target-ai', revision: '2', configuration: { name: 'ChatGPT', providerLabel: '', broadcastOptIn: false,
    privacy: 'standard', connectionProfileId: 'profile-ai', wakeMode: 'poll', pollIntervalMinutes: 1 },
  status: 'active', wakeMode: 'poll', wakeReadiness: 'active', wakeReason: 'Paired.', isolation: 'sharedCredential', subscriptionCount: 0,
}

const chatgpt: AgentSummary = { id: 'https://chatgpt.com/oauth/client.json', name: 'ChatGPT', kind: 'oauth_client', scopes: ['automation:work'],
  createdAt: '2026-10-21T00:00:00Z', lastSeenAt: null, policy: 'manual' }
const unpaired: AutomationTarget = { ...target, status: 'unpaired', wakeReadiness: 'waitingForPairing', wakeReason: 'Redeem a short-lived Owner pairing grant.' }

async function mount(options: { agents?: AgentSummary[]; profiles?: AutomationConnectionProfile[]; targets?: AutomationTarget[]; current?: AutomationTarget; ready?: boolean } = {}) {
  const api = fakeApi(), folders = fakeFolders()
  folders.listBookmarks = vi.fn(async () => [{ id: 'bookmark-test', title: 'A matching paper' }])
  api.getCapabilities.mockResolvedValue({ ...await api.getCapabilities(), taskTypes: ['summary.generate', 'tags.generate'] })
  api.getTarget = vi.fn(async () => options.current ?? target)
  if (options.profiles) api.listConnectionProfiles.mockResolvedValue({ items: options.profiles, nextCursor: null })
  if (options.targets) api.listTargets.mockResolvedValue({ items: options.targets, nextCursor: null })
  api.prepareAgent = vi.fn(async (input: AutomationAgentSetupInput): Promise<AutomationAgentSetupResult> => {
    const definition = { ...input.definition, route: { mode: 'targets' as const, execution: 'single' as const, targetIds: [target.id] } }
    const result: AutomationAgentSetupResult = { rule: rule('rule-ai', definition.name, { definition, desiredState: 'draft', effectiveState: 'draft', bindingSetId: 'binding-ai', executionPolicyId: 'policy-ai' }),
      binding: { id: 'binding-ai', revision: '1', updatedAt: '2026-10-21T00:00:00Z', ...input.bindings }, target, pairing: null }
    api.getRule.mockResolvedValue(result.rule)
    api.getBindingSet.mockResolvedValue(result.binding)
    return result
  })
  renderWithRouter(<Routes><Route path="/automations/*" element={<Automations deps={{ ...deps(api, folders), agents: {
    listAgents: vi.fn(async () => ({ agents: options.agents ?? [chatgpt] })),
  } }} />} /></Routes>, { route: '/automations/new?collectionId=col-personal&folderId=f-academic&condition=siteIs:arxiv.org' })
  await waitForDom(() => [...document.querySelectorAll('label')].some(label => label.textContent?.includes('Generate a summary')))
  const label = [...document.querySelectorAll('label')].find(item => item.textContent?.includes('Generate a summary'))
  click(label?.querySelector('input'))
  await waitForDom(() => Boolean(document.getElementById('automation-agent')) && (options.ready === false || !buttonNamed('Connect and test')?.disabled))
  return { api, folders }
}

afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('guided rule AI connection', () => {
  it('preselects the connected AI, prepares everything in one command and requires a real test before enabling', async () => {
    const { api } = await mount()
    expect((document.getElementById('automation-agent') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('ChatGPT')
    expect(document.querySelector('details')?.open).toBe(false)
    click(buttonNamed('Connect and test'))
    await waitForDom(() => Boolean(document.getElementById('automation-test-bookmark')))
    expect(api.prepareAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: { name: 'ChatGPT', clientId: 'https://chatgpt.com/oauth/client.json' },
      definition: expect.objectContaining({ tasks: [expect.objectContaining({ type: 'summary.generate' })] }),
      bindings: { name: expect.any(String), values: { destination: expect.objectContaining({ folder: { serverUuid: 'server-demo', collectionId: 'col-personal', nodeId: 'f-academic' } }) } } }))
    expect(api.createConnectionProfile).not.toHaveBeenCalled()
    expect(api.createBindingSet).not.toHaveBeenCalled()
    click(buttonNamed(/^Preview( again)?$/))
    await waitForDom(() => api.previewRule.mock.calls.length === 1)
    expect(document.querySelector<HTMLButtonElement>('[data-testid="automation-turn-on"]')?.disabled).toBe(true)
    api.previewRunOnce.mockResolvedValue({ id: 'test-preview', previewDigest: 'a'.repeat(64), matchedCount: 1, blockedCount: 0, explicitChoiceCount: 1,
      canStart: true, maxMembers: 1000, sample: [], sideEffects: false, expiresAt: '2099-01-01T00:00:00Z' })
    api.startRunOnce.mockResolvedValue(run('test-run', 'rule-ai', { status: 'running', childRunIds: ['test-child'] }))
    api.getRun.mockImplementation(async id => run(id, 'rule-ai', id === 'test-child' ? { jobIds: ['job-test'] } : { childRunIds: ['test-child'] }))
    api.getJob.mockResolvedValue(job('job-test', 'succeeded'))
    click(buttonNamed('Test on this bookmark'))
    await waitForDom(() => document.body.textContent?.includes('Test completed.') === true)
    expect(api.previewRunOnce).toHaveBeenCalledWith('rule-ai', expect.objectContaining({ nodeId: 'bookmark-test', tasksOnly: true, tasks: 'all', moveFolderedBookmarks: false }), expect.any(String))
    expect(document.querySelector<HTMLButtonElement>('[data-testid="automation-turn-on"]')?.disabled).toBe(true)
    click(buttonNamed(/^Preview( again)?$/))
    await waitForDom(() => api.previewRule.mock.calls.length === 2)
    expect(document.querySelector<HTMLButtonElement>('[data-testid="automation-turn-on"]')?.disabled).toBe(false)
  })

  it('keeps a failed setup retryable without sending a different configuration', async () => {
    const { api } = await mount()
    api.prepareAgent.mockRejectedValueOnce(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'Try again soon.' }))
    click(buttonNamed('Connect and test'))
    await waitForDom(() => document.body.textContent?.includes('Try again soon.') === true)
    click(buttonNamed('Connect and test'))
    await waitForDom(() => Boolean(document.getElementById('automation-test-bookmark')))
    expect(api.prepareAgent.mock.calls[0]).toEqual(api.prepareAgent.mock.calls[1])
  })

  it('an agent that allowed rule work at sign-in pairs by itself: no code, no identifiers, no fresh request', async () => {
    const { api } = await mount({ current: unpaired })
    const make = api.prepareAgent.getMockImplementation()! as (input: AutomationAgentSetupInput) => Promise<AutomationAgentSetupResult>
    api.prepareAgent.mockImplementation(async input => ({ ...await make(input), target: unpaired,
      pairing: { pairingId: 'pair-ai', targetId: target.id, code: 'one-use-secret', expiresAt: '2099-01-01T00:00:00Z' } }))
    click(buttonNamed('Connect and test'))
    await waitForDom(() => document.body.textContent?.includes('Waiting for ChatGPT to connect') === true)
    expect(buttonNamed('Make a new connection request')).toBeUndefined()
    expect(buttonNamed('Copy connection request')).toBeDefined()
    expect(buttonNamed('Test on this bookmark')).toBeUndefined()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('one-use-secret')
    expect(text).not.toContain('automation.targets.pair')
    expect(text).not.toContain(target.id)
    expect(text).toContain('automation.targets.mine')
  })

  it('a key-based worker still gets the one-use code flow, and a replayed code asks for a fresh request', async () => {
    const key: AgentSummary = { ...chatgpt, id: 'key-research', name: 'Research worker key', kind: 'api_key' }
    const profile: AutomationConnectionProfile = { id: 'profile-ai', revision: '1', eventsSupport: 'unknown',
      configuration: { name: 'Research worker key', authorizedClientId: key.id, credentialBindingId: 'pending-x', automationEnabled: true, catalogs: ['standard', 'automationWorker'] } }
    const { api } = await mount({ agents: [key], profiles: [profile], targets: [unpaired], current: unpaired })
    expect((document.getElementById('automation-agent') as HTMLSelectElement).selectedOptions[0]?.textContent).toBe('ChatGPT')
    const make = api.prepareAgent.getMockImplementation()! as (input: AutomationAgentSetupInput) => Promise<AutomationAgentSetupResult>
    api.prepareAgent.mockImplementation(async input => ({ ...await make(input), target: unpaired,
      pairing: { pairingId: 'pair-ai', targetId: target.id, code: null, expiresAt: '2099-01-01T00:00:00Z' } }))
    click(buttonNamed('Connect and test'))
    await waitForDom(() => Boolean(buttonNamed('Make a new connection request')))
    expect(api.prepareAgent).toHaveBeenCalledWith(expect.objectContaining({ targetId: target.id }))
    expect(buttonNamed('Test on this bookmark')).toBeUndefined()
    expect(document.body.textContent).not.toContain('Test completed.')
  })

  it('an agent that signed in without rule-work permission is sent back to the consent page instead of a code', async () => {
    await mount({ agents: [{ ...chatgpt, scopes: ['mcp:read:own'] }], ready: false })
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-agent-permission"]')))
    expect(document.querySelector('[data-testid="automation-agent-permission"]')?.textContent).toContain('allow “Do rule work”')
    expect(buttonNamed('Connect and test')?.disabled).toBe(true)
  })
});
