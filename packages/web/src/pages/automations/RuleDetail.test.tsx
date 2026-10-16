// @vitest-environment happy-dom
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { binding, buttonNamed, click, deps, fakeApi, incident, rule, run, usage } from './automations.test-helper'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

function mount(api = fakeApi(), route = '/automations/rules/rule-arxiv') {
  renderWithRouter(
    <Routes><Route path="/automations/*" element={<Automations deps={deps(api)} />} /></Routes>,
    { route },
  )
  return api
}

function withRule(patch = {}) {
  const api = fakeApi()
  api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic', patch))
  api.listBindingSets.mockResolvedValue({ items: [binding('bind-rule-arxiv', 'f-academic')], nextCursor: null })
  return api
}

const text = (selector: string) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const usageRows = () => [...document.querySelectorAll('[data-testid="automation-usage"] dl > div')]
  .map((row) => [row.getAttribute('data-key'), row.querySelector('dd')?.textContent])

describe('Rule detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('says what the rule does, its state in words, and what it relies on by name', async () => {
    const api = withRule()
    mount(api)
    await waitForDom(() => text('[data-testid="automation-sentence"]').includes('Academic'))
    expect(text('h1')).toBe('Papers to Academic')
    expect(document.body.textContent).toContain('On. It files matching bookmarks as you save them.')
    const folderCheck = document.querySelector('[data-kind="folder"]')
    expect(folderCheck?.textContent).toContain('Academic')
    expect(folderCheck?.getAttribute('data-status')).toBe('valid')
    expect(document.querySelector('a[href="/automations/rules/rule-arxiv/edit"]')?.textContent).toBe('Edit')
  })

  it('shows each job state the server counted, never a total, and the allowance as observed (AU-22, AU-23)', async () => {
    const api = withRule({ usage: usage() })
    mount(api)
    await waitForDom(() => usageRows().length > 0)
    expect(usageRows()).toEqual([
      ['pending', '1'], ['ready', '2'], ['approval', '2'], ['uncertain', '1'], ['blocked', '3'], ['held', '4'], ['succeeded', '29'],
    ])
    expect(text('[data-key="blocked"] dt')).toContain('2 over the daily allowance')
    expect(text('[data-key="held"] dt')).toContain('also counted above')
    expect(document.querySelector('[data-key="approval"] a')?.getAttribute('href')).toBe('/approvals')
    expect(text('[data-testid="automation-allowance"]')).toContain('17 of 20')
    expect(text('[data-testid="automation-allowance"]')).toContain('3 left today.')
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('85')
    expect(text('[data-testid="automation-cost"]')).toBe('34 agent calls, 3 with an unknown cost. Your agent bills these; COLP can’t see the amount.')
  })

  it('says an exhausted allowance does not stop filing', async () => {
    const api = withRule({ usage: usage({ reservedRuns: 20, remainingRuns: 0 }) })
    mount(api)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-allowance"]')))
    expect(text('[data-testid="automation-allowance"]')).toContain('None left today. Bookmarks are still filed')
  })

  it('explains why a placement-only rule has no usage', async () => {
    mount(withRule())
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-usage"]')))
    expect(text('[data-testid="automation-usage"]')).toContain('This rule only files bookmarks')
  })

  it('finds this rule’s runs in the account’s run list, page by page', async () => {
    const api = withRule()
    api.listRuns
      .mockResolvedValueOnce({ items: [run('run-other', 'rule-other')], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [run('run-mine', 'rule-arxiv', { explanation: 'Already in the verified destination; no canonical mutation required.' })], nextCursor: null })
    mount(api)
    await waitForDom(() => Boolean(document.querySelector('[data-run-id="run-mine"]')))
    expect(document.querySelector('[data-run-id="run-other"]')).toBeNull()
    expect(api.listRuns).toHaveBeenCalledWith({ cursor: 'c2', limit: 100 }, expect.anything())
    const link = document.querySelector('[data-run-id="run-mine"] a')
    expect(link?.getAttribute('href')).toBe('/automations/runs/run-mine')
    expect(link?.textContent).toBe('Already in the rule’s folder, so nothing moved.')
  })

  it('treats no runs as normal, not as a fault (AU-22)', async () => {
    mount(withRule())
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-rule-no-runs"]')))
    expect(text('[data-testid="automation-rule-no-runs"]')).toBe('No runs yet. That is fine: the rule runs when you save a bookmark it matches.')
  })

  it('lists open health notices and checks again with the rule revision', async () => {
    const api = withRule({ revision: '6', effectiveState: 'blocked' })
    api.getRuleHealth.mockResolvedValue({ ruleId: 'rule-arxiv', checkedAt: '2026-10-12T09:30:00.000Z', effectiveState: 'blocked', incidents: [incident({ ruleId: 'rule-arxiv' })] })
    mount(api)
    await waitForDom(() => Boolean(document.querySelector('[data-code="bindingDeleted"]')))
    expect(text('[data-testid="automation-notice-title"]')).toBe('Its folder was deleted')
    click(buttonNamed('Check again'))
    await waitForDom(() => api.revalidateRule.mock.calls.length === 1)
    expect(api.revalidateRule).toHaveBeenCalledWith('rule-arxiv', '6')
  })

  it('shows a health read failure and offers a retry instead of an empty notice list', async () => {
    const api = withRule()
    api.getRuleHealth.mockRejectedValue(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'Health is unavailable.' }))
    mount(api)
    await waitForDom(() => document.querySelector('[role="alert"]')?.textContent?.includes('Health is unavailable.') === true)
    expect(buttonNamed('Try again')).toBeDefined()
    api.getRuleHealth.mockResolvedValue({ ruleId: 'rule-arxiv', checkedAt: '2026-10-12T09:30:00.000Z', effectiveState: 'active', incidents: [] })
    click(buttonNamed('Try again'))
    await waitForDom(() => api.getRuleHealth.mock.calls.length >= 2)
  })

  it('refreshes the state badge after dismissing a delivery notice', async () => {
    const api = withRule()
    api.getRule.mockImplementation(async () => rule('rule-arxiv', 'Papers', {
      effectiveState: api.acknowledgeIncident.mock.calls.length ? 'active' : 'degraded',
    }))
    api.getRuleHealth.mockImplementation(async () => ({ ruleId: 'rule-arxiv', checkedAt: '2026-10-12T09:30:00.000Z',
      effectiveState: api.acknowledgeIncident.mock.calls.length ? 'active' as const : 'degraded' as const,
      incidents: api.acknowledgeIncident.mock.calls.length ? [] : [incident({ code: 'deliveryFailure', role: 'delivery', severity: 'error', ruleId: 'rule-arxiv' })],
    }))
    mount(api)
    await waitForDom(() => document.querySelector('[data-state="degraded"]') !== null && Boolean(buttonNamed('Dismiss')))
    click(buttonNamed('Dismiss'))
    await waitForDom(() => document.querySelector('[data-state="active"]') !== null)
    expect(api.getRule.mock.calls.length).toBeGreaterThan(1)
  })

  it('pauses with the rule revision and shows the state the server returned', async () => {
    const api = withRule({ revision: '6' })
    api.setRuleLifecycle.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic', { revision: '7', desiredState: 'paused', effectiveState: 'paused' }))
    mount(api)
    await waitForDom(() => buttonNamed('Pause')?.disabled === false)
    click(buttonNamed('Pause'))
    await waitForDom(() => text('[data-state]') === 'Paused')
    expect(api.setRuleLifecycle).toHaveBeenCalledWith('rule-arxiv', expect.objectContaining({ state: 'paused', pendingRuns: 'hold' }), '6')
    expect(document.querySelector('a[href="/automations/rules/rule-arxiv/edit#preview"]')?.textContent).toBe('Preview and turn on')
  })

  it('says a missing rule is not available and a refused one needs access', async () => {
    const api = fakeApi()
    api.getRule.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found' }))
    mount(api)
    await waitForDom(() => text('h1') === 'This rule is not available')
    cleanup()
    const refused = fakeApi()
    refused.getRule.mockRejectedValue(new ProductApiError({ status: 403, code: 'insufficient_permission', message: 'No' }))
    mount(refused)
    await waitForDom(() => text('h1') === 'You do not have access')
    expect(document.querySelector('[data-testid="automation-rule"]')).toBeNull()
  })
})
