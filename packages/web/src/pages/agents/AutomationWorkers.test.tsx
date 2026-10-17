// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsApi } from '../../api/agentsClient'
import type { AutomationConnectionProfile, AutomationTarget } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { resetAutomationStatus } from '../../lib/automationStatus'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { Agents } from '../Agents'
import { fakeApi, pause, typeInto } from '../automations/automations.test-helper'
import { originHint } from './automationWorkers'

/* AW-53 against the AW-26 contract fixtures (fixtures/aw-26/statuses.json):
   readiness and its reason come from the server; the page shows them, pairs
   with a one-use code kept in memory only, and edits the Owner's opt-ins. */

const fixtures = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../../../docs/automation/evidence/fixtures/aw-26/statuses.json'),
  'utf8',
)) as { scenarios: Array<{ label: string; target: AutomationTarget }> }

function scenario(label: string, id = label): AutomationTarget {
  const found = fixtures.scenarios.find((item) => item.label === label)
  if (!found) throw new Error(`missing fixture ${label}`)
  return { ...found.target, id, configuration: { ...found.target.configuration, name: `Worker ${label}` } }
}

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: true, bootstrapping: false, user: { accountId: 'account-1' } }),
}))
vi.mock('../../components/AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: toast.success, error: toast.error }),
}))

const agent = {
  id: 'client-research', name: 'Research worker key', kind: 'api_key' as const, scopes: ['automation:work'],
  createdAt: '2026-10-01T12:00:00.000Z', lastSeenAt: null, policy: 'manual' as const,
}

function agentsApi(): AgentsApi {
  return {
    listAgents: vi.fn(async () => ({ agents: [agent] })),
    listAgentAudit: vi.fn(),
    getAgentPolicy: vi.fn(),
    putAgentPolicy: vi.fn(),
    revokeAgent: vi.fn(),
    issueAgentKey: vi.fn(),
    undoApproval: vi.fn(),
  } as unknown as AgentsApi
}

function profile(patch: Partial<AutomationConnectionProfile['configuration']> = {}): AutomationConnectionProfile {
  return {
    id: 'profile.fixture', revision: '4', eventsSupport: 'unknown',
    configuration: {
      name: 'Research worker key', automationEnabled: true, authorizedClientId: 'client-research',
      credentialBindingId: 'binding-1', catalogs: ['standard', 'automationWorker'], ...patch,
    },
  }
}

function automation(targets: AutomationTarget[], profiles = [profile()], eventsEnabled = false) {
  const api = fakeApi()
  api.getPause.mockResolvedValue(pause())
  api.getCapabilities.mockResolvedValue({ contractVersion: '0.2.1-design', ruleApiVersions: [], runtimeProfiles: [], triggerModes: ['each'], taskTypes: [], eventsEnabled, limits: { maxRules: 1, maxExpressionBytes: 1, maxTasksPerRule: 1 } })
  api.listConnectionProfiles.mockResolvedValue({ items: profiles, nextCursor: null })
  api.listTargets.mockResolvedValue({ items: targets, nextCursor: null })
  return api
}

function mount(api: ReturnType<typeof automation>, origin = 'http://127.0.0.1:3000') {
  mountTree(<Agents api={agentsApi()} automationApi={api} origin={origin} />, { initialEntries: ['/agents'] })
}

const card = (id: string) => document.querySelector(`[data-target-id="${id}"]`)
const text = (root: Element | null | undefined, testId: string) => root?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

function button(name: string, root: ParentNode | null = document): HTMLButtonElement {
  const found = [...(root ?? document).querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)
  if (!found) throw new Error(`missing button ${name}`)
  return found
}

describe('Automation workers on Agents', () => {
  beforeEach(() => {
    resetAutomationStatus()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.clearAllMocks()
    resetAutomationStatus()
  })

  it('stays out of the page where the server has no automations', async () => {
    const api = automation([])
    api.getPause.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found' }))
    mount(api)
    await waitForDom(() => document.body.textContent?.includes('Research worker key') === true)
    expect(document.querySelector('[data-testid="automation-workers"]')).toBeNull()
    expect(document.querySelector('#agents-tab-worker')).toBeNull()
    expect(api.listTargets).not.toHaveBeenCalled()
  })

  it.each([
    ['unpaired', 'Not paired', 'Pair it with a one-use code to start.'],
    ['subscription-missing', 'Waiting for events', 'Production Events delivery is unavailable until BE-4.'],
    ['unreachable', 'Blocked', 'Reachability verification is unavailable in BE-3; no reachable Events endpoint is asserted.'],
    ['active', 'Ready', 'Paired. It picks up work whenever it checks; COLP doesn’t start it.'],
    ['polling', 'Ready', 'Paired. It picks up work whenever it checks; COLP doesn’t start it.'],
  ])('shows the %s fixture as the server reports it', async (label, badge, reason) => {
    mount(automation([scenario(label)]))
    await waitForDom(() => Boolean(card(label)))
    expect(text(card(label), 'worker-readiness')).toBe(badge)
    expect(text(card(label), 'worker-reason')).toBe(reason)
  })

  it('says a selected events mode is a choice, not an active subscription', async () => {
    mount(automation([scenario('subscription-missing', 'events')]))
    await waitForDom(() => Boolean(card('events')))
    expect(card('events')?.textContent).toContain('Woken by events, once a subscription is verified. Chosen, not active yet.')
    expect(card('events')?.textContent).toContain('Check for work instead')
  })

  it('keeps polling honest about who runs the worker', async () => {
    mount(automation([scenario('polling', 'poll')]))
    await waitForDom(() => Boolean(card('poll')))
    expect(card('poll')?.textContent).toContain('Checks for work every minute. That timing is the worker’s own; COLP doesn’t start it.')
    // Events are off on this server: no switch that could never work.
    expect([...(card('poll')?.querySelectorAll('button') ?? [])].map((item) => item.textContent)).toEqual(['Revoke'])
  })

  it('explains why a shared credential blocks restricted work', async () => {
    const restricted: AutomationTarget = {
      ...scenario('active', 'shared'),
      status: 'error',
      wakeReadiness: 'blocked',
      wakeReason: 'Restricted work requires a verified dedicated credential binding.',
      configuration: { ...scenario('active').configuration, name: 'Private notes', privacy: 'restricted' },
    }
    mount(automation([restricted]))
    await waitForDom(() => Boolean(card('shared')))
    expect(text(card('shared'), 'worker-reason')).toBe('Restricted rules need a worker with its own credential that no other worker uses.')
    expect(card('shared')?.textContent).toContain('Shared with other workers or tools; fine for standard rules, not for restricted ones')
    expect(card('shared')?.textContent).toContain('Restricted and standard')
  })

  it('hides revoked workers and says how many', async () => {
    mount(automation([scenario('active', 'live'), scenario('revoked', 'gone')]))
    await waitForDom(() => Boolean(card('live')))
    expect(card('gone')).toBeNull()
    expect(document.body.textContent).toContain('1 revoked worker not shown.')
  })

  it('shows the one-use pairing code once, in memory only', async () => {
    const api = automation([scenario('unpaired', 'new')])
    const code = 'one-use-secret-code-xyz'
    api.issuePairing.mockResolvedValue({ pairingId: 'pair-1', targetId: 'new', code, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    mount(api)
    await waitForDom(() => Boolean(card('new')))
    act(() => button('Pair', card('new')).click())
    await waitForDom(() => Boolean(card('new')?.querySelector('[data-testid="worker-grant"]')))
    expect(api.issuePairing).toHaveBeenCalledWith('new', '1')
    const grant = card('new')?.querySelector('[data-testid="worker-grant"]')?.textContent ?? ''
    expect(grant).toContain(`export COLP_PAIRING_CODE=${code}`)
    expect(grant).toContain('export COLP_TARGET_ID=new')
    expect(grant).toContain('export COLP_ORIGIN=http://127.0.0.1:3000')
    // The worker redeems with a stable command id, so nobody has to make one up.
    expect(grant).toMatch(/export COLP_PAIRING_COMMAND_ID=[0-9a-f-]{36}/u)
    expect(window.location.href).not.toContain(code)
    const stored = [...Object.values(localStorage), ...Object.values(sessionStorage)].join(' ')
    expect(stored).not.toContain(code)

    act(() => button('Done, hide it', card('new')).click())
    expect(document.body.textContent).not.toContain(code)
  })

  it('asks for a new code when a replayed pairing returns none', async () => {
    const api = automation([scenario('unpaired', 'new')])
    api.issuePairing.mockResolvedValue({ pairingId: 'pair-1', targetId: 'new', code: null, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    mount(api)
    await waitForDom(() => Boolean(card('new')))
    act(() => button('Pair', card('new')).click())
    await waitForDom(() => card('new')?.textContent?.includes('already shown once') === true)
    expect(button('Make a new code', card('new'))).toBeDefined()
  })

  it('says what to turn on when the server refuses to pair', async () => {
    const api = automation([scenario('unpaired', 'new')])
    api.issuePairing.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Enabled worker target is unavailable.' }))
    mount(api)
    await waitForDom(() => Boolean(card('new')))
    act(() => button('Pair', card('new')).click())
    await waitForDom(() => toast.error.mock.calls.length === 1)
    expect(toast.error).toHaveBeenCalledWith('This worker can’t be paired: turn on “Use for automations” and “Do rule work” for its agent first.')
  })

  it('puts the manager and worker opt-ins on the agent’s card, each on its own', async () => {
    const api = automation([scenario('active', 'live')])
    api.replaceConnectionProfile.mockResolvedValue(profile())
    mount(api)
    const optIns = () => document.querySelector('[data-agent-id="client-research"] [data-profile-id="profile.fixture"]')
    await waitForDom(() => Boolean(optIns()))
    const switches = () => [...(optIns()?.querySelectorAll<HTMLButtonElement>('[role="switch"]') ?? [])]
    expect(switches().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true'])

    act(() => switches()[1]?.click())
    await waitForDom(() => api.replaceConnectionProfile.mock.calls.length === 1)
    expect(api.replaceConnectionProfile).toHaveBeenCalledWith('profile.fixture', expect.objectContaining({
      catalogs: ['standard', 'automationWorker', 'automationManager'], automationEnabled: true, credentialBindingId: 'binding-1',
    }), '4')

    // Turning work off would unpair the paired worker: the owner confirms first.
    act(() => switches()[2]?.click())
    await waitForDom(() => Boolean(document.querySelector('[role="dialog"]')))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Unpair 1 worker?')
    act(() => button('Change and unpair', document.querySelector('[role="dialog"]')).click())
    await waitForDom(() => api.replaceConnectionProfile.mock.calls.length === 2)
    expect(api.replaceConnectionProfile.mock.calls[1]?.[1]).toMatchObject({ catalogs: ['standard'] })
  })

  /** Targets the fake server lists, with whatever Add worker creates added to them. */
  function serverTargets(api: ReturnType<typeof automation>, created: AutomationTarget) {
    let targets: AutomationTarget[] = []
    api.listTargets.mockImplementation(async () => ({ items: targets, nextCursor: null }))
    api.createTarget.mockImplementation(async () => {
      targets = [created]
      return created
    })
  }

  it('adds and pairs a worker in one press, with defaults for everything else', async () => {
    const api = automation([])
    serverTargets(api, scenario('unpaired', 'created'))
    api.issuePairing.mockResolvedValue({ pairingId: 'pair-1', targetId: 'created', code: 'fresh-code', expiresAt: new Date(Date.now() + 300_000).toISOString() })
    mount(api)
    await waitForDom(() => document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    expect((document.getElementById('worker-name') as HTMLInputElement).value).toBe('Rule worker')
    expect(document.getElementById('worker-profile')).toBeNull()
    expect(text(document.body, 'worker-agent-note')).toContain('Runs as Research worker key.')
    expect(text(document.body, 'worker-more-note')).toBe('Checks for work every minute · standard rules')

    act(() => button('Add and pair').click())
    await waitForDom(() => Boolean(card('created')?.querySelector('[data-testid="worker-grant"]')))
    expect(api.createTarget).toHaveBeenCalledWith({
      name: 'Rule worker', providerLabel: '', broadcastOptIn: false, privacy: 'standard',
      connectionProfileId: 'profile.fixture', wakeMode: 'poll', pollIntervalMinutes: 1,
    })
    expect(api.issuePairing).toHaveBeenCalledWith('created', '1')
    expect(api.replaceConnectionProfile).not.toHaveBeenCalled()
    expect(card('created')?.textContent).toContain('export COLP_PAIRING_CODE=fresh-code')
    expect(text(card('created'), 'worker-reason')).toBe('Waiting for the worker to use the code below.')
    expect(toast.success).toHaveBeenCalledWith('Added “Rule worker”. Copy its pairing settings now.')
    expect(document.querySelector('form.agents-worker-form')).toBeNull()
  })

  it('keeps the owner’s choices under More options', async () => {
    const api = automation([])
    serverTargets(api, scenario('unpaired', 'created'))
    api.issuePairing.mockResolvedValue({ pairingId: 'pair-1', targetId: 'created', code: 'fresh-code', expiresAt: new Date(Date.now() + 300_000).toISOString() })
    mount(api)
    await waitForDom(() => document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    typeInto(document.getElementById('worker-name') as HTMLInputElement, 'Paper summaries')
    typeInto(document.getElementById('worker-provider') as HTMLInputElement, 'Script on my laptop')
    typeInto(document.getElementById('worker-interval') as HTMLInputElement, '5')
    act(() => [...document.querySelectorAll<HTMLInputElement>('input[name="worker-privacy"]')][1]?.click())
    expect(text(document.body, 'worker-more-note')).toBe('Checks for work every 5 minutes · restricted and standard rules')
    act(() => button('Add and pair').click())
    await waitForDom(() => api.createTarget.mock.calls.length === 1)
    expect(api.createTarget).toHaveBeenCalledWith({
      name: 'Paper summaries', providerLabel: 'Script on my laptop', broadcastOptIn: false, privacy: 'restricted',
      connectionProfileId: 'profile.fixture', wakeMode: 'poll', pollIntervalMinutes: 5,
    })
  })

  it('opens More options to point at an interval that can’t be saved', async () => {
    const api = automation([])
    mount(api)
    await waitForDom(() => document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    typeInto(document.getElementById('worker-interval') as HTMLInputElement, '0')
    act(() => button('Add and pair').click())
    await waitForDom(() => Boolean(document.querySelector('form.agents-worker-form [role="alert"]')))
    expect(document.querySelector('form.agents-worker-form [role="alert"]')?.textContent).toBe('Check interval is a whole number of minutes, from 1 to 1440.')
    expect(document.querySelector<HTMLDetailsElement>('details.agents-worker-more')?.open).toBe(true)
    expect(api.createTarget).not.toHaveBeenCalled()
  })

  it('turns on rule work for its agent while adding, instead of sending the owner to two switches', async () => {
    const api = automation([], [profile({ automationEnabled: false, catalogs: ['standard'] })])
    serverTargets(api, scenario('unpaired', 'created'))
    api.replaceConnectionProfile.mockResolvedValue(profile())
    api.issuePairing.mockResolvedValue({ pairingId: 'pair-1', targetId: 'created', code: 'fresh-code', expiresAt: new Date(Date.now() + 300_000).toISOString() })
    mount(api)
    await waitForDom(() => document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    expect(text(document.body, 'worker-agent-note')).toBe('Runs as Research worker key. Adding it also lets this agent do rule work.')
    act(() => button('Add and pair').click())
    await waitForDom(() => api.issuePairing.mock.calls.length === 1)
    expect(api.replaceConnectionProfile).toHaveBeenCalledWith('profile.fixture', expect.objectContaining({
      automationEnabled: true, catalogs: ['standard', 'automationWorker'], credentialBindingId: 'binding-1',
    }), '4')
    expect(api.replaceConnectionProfile.mock.invocationCallOrder[0]).toBeLessThan(api.createTarget.mock.invocationCallOrder[0] ?? 0)
  })

  it('keeps the added worker when pairing is refused, and says so', async () => {
    const api = automation([])
    serverTargets(api, scenario('unpaired', 'created'))
    api.issuePairing.mockRejectedValue(new ProductApiError({ status: 503, code: 'feature_temporarily_unavailable', message: 'Pairing is busy. Try again.' }))
    mount(api)
    await waitForDom(() => document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    act(() => button('Add and pair').click())
    await waitForDom(() => Boolean(card('created')))
    expect(toast.error).toHaveBeenCalledWith('Added “Rule worker”, but it isn’t paired yet. Pairing is busy. Try again.')
    expect(button('Pair', card('created'))).toBeDefined()
  })

  it('warns that hosted agents can’t reach a local address before choosing events (blocked origin)', async () => {
    mount(automation([], [profile()], true))
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-workers"]')) && document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    const events = [...document.querySelectorAll<HTMLInputElement>('input[name="worker-wake"]')][1]
    act(() => events?.click())
    await waitForDom(() => Boolean(document.querySelector('[data-testid="worker-origin-hint"]')))
    expect(document.querySelector('[data-testid="worker-origin-hint"]')?.textContent).toContain('isn’t a public HTTPS address')
  })

  it('opens the worker steps from the worker form when no agent is set up for automations', async () => {
    mount(automation([], []))
    await waitForDom(() => document.body.textContent?.includes('No workers yet') === true)
    act(() => button('Add worker').click())
    const blocked = document.querySelector('[data-testid="worker-no-connection"]')
    expect(blocked?.textContent).toContain('none of them is set up for automations yet')
    const workerTab = () => document.querySelector<HTMLButtonElement>('#agents-tab-worker')
    expect(workerTab()?.getAttribute('aria-selected')).toBe('false')

    act(() => button('Show the worker steps', blocked).click())
    await waitForDom(() => workerTab()?.getAttribute('aria-selected') === 'true')
    expect(document.activeElement).toBe(workerTab())
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toContain('Give it its own key')
  })

  it('adds the worker guide, pointed at this server', async () => {
    mount(automation([]), 'https://colp.example.net')
    await waitForDom(() => Boolean(document.querySelector('#agents-tab-worker')))
    act(() => (document.querySelector('#agents-tab-worker') as HTMLButtonElement).click())
    const panel = document.querySelector('[role="tabpanel"]')?.textContent ?? ''
    expect(panel).toContain('export COLP_ORIGIN=https://colp.example.net')
    expect(panel).toContain('choosing events doesn’t make it active')
    expect(panel).toContain('this page can’t register one for you')
  })
})

describe('originHint', () => {
  it('treats only public HTTPS hosts as reachable, as a hint', () => {
    expect(originHint('https://colp.example.net')).toBe('public')
    for (const local of ['http://colp.example.net', 'https://localhost:3000', 'https://192.168.1.4', 'https://10.0.0.2',
      'https://172.20.1.1', 'https://nas.local', 'https://box.home.arpa', 'https://[::1]:8443', 'not a url']) {
      expect(originHint(local)).toBe('local')
    }
  })
})
