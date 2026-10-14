// @vitest-environment happy-dom
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { resetAutomationStatus } from '../../lib/automationStatus'
import { Automations } from '../Automations'
import { binding, buttonNamed, click, deps, fakeApi, incident, pause, rule, run } from './automations.test-helper'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

function mount(api = fakeApi(), route = '/automations') {
  renderWithRouter(
    <Routes><Route path="/automations/*" element={<Automations deps={deps(api)} />} /></Routes>,
    { route },
  )
  return api
}

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

describe('Automations home', () => {
  beforeEach(() => {
    resetAutomationStatus()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    resetAutomationStatus()
  })

  it('says each rule in one sentence with the folder’s current name (AU-01, AU-03)', async () => {
    const api = fakeApi()
    api.listRules.mockResolvedValue({ items: [rule('rule-arxiv', 'Papers to Academic')], nextCursor: null })
    api.listBindingSets.mockResolvedValue({ items: [binding('bind-rule-arxiv', 'f-academic')], nextCursor: null })
    mount(api)
    await waitForDom(() => text('[data-rule-id="rule-arxiv"] [data-testid="automation-sentence"]').includes('Academic'))
    expect(text('[data-rule-id="rule-arxiv"] [data-testid="automation-sentence"]'))
      .toBe('When a bookmark saved to Personal is from arxiv.org, move it to Academic.')
    expect(text('[data-rule-id="rule-arxiv"] [data-state]')).toBe('On')
    expect(buttonNamed('Pause', document.querySelector('[data-rule-id="rule-arxiv"]') ?? document)).toBeDefined()
  })

  it('offers preview, not a bare switch, for a rule that is off', async () => {
    const api = fakeApi()
    api.listRules.mockResolvedValue({ items: [
      rule('rule-draft', 'Draft rule', { desiredState: 'draft', effectiveState: 'draft' }),
      rule('rule-gone', 'Archived rule', { desiredState: 'archived', effectiveState: 'archived' }),
    ], nextCursor: null })
    mount(api)
    await waitForDom(() => Boolean(document.querySelector('[data-rule-id="rule-draft"]')))
    const card = document.querySelector('[data-rule-id="rule-draft"]')
    expect(card?.querySelector('a[href="/automations/rules/rule-draft/edit#preview"]')?.textContent).toBe('Preview and turn on')
    expect(buttonNamed('Pause', card ?? document)).toBeUndefined()
    expect(document.querySelector('[data-rule-id="rule-gone"]')).toBeNull()
  })

  it('names both rules when they disagree about one bookmark, and the incident’s repair (AU-04, AU-05)', async () => {
    const api = fakeApi()
    api.listRules.mockResolvedValue({ items: [rule('rule-a', 'Papers to Academic'), rule('rule-b', 'Papers to Work'), rule('rule-ssrn', 'SSRN')], nextCursor: null })
    api.listRuns.mockResolvedValue({ items: [
      run('run-a', 'rule-a', { status: 'review', memberEventIds: ['evt-9'] }),
      run('run-b', 'rule-b', { status: 'review', memberEventIds: ['evt-9'] }),
    ], nextCursor: null })
    api.listIncidents.mockResolvedValue({ items: [incident()], nextCursor: null })
    mount(api)
    await waitForDom(() => text('[data-kind="decision"]').includes('disagree'))
    expect(text('[data-kind="decision"] [data-testid="automation-notice-title"]')).toBe('“Papers to Academic” and “Papers to Work” disagree about a bookmark')
    expect(text('[data-testid="automations-attention-count"]')).toBe('2')
    const notice = document.querySelector('[data-code="bindingDeleted"]')
    expect(notice?.textContent).toContain('SSRN')
    expect(notice?.querySelector('a[href="/automations/rules/rule-ssrn/edit"]')?.textContent).toBe('Choose another folder')
    expect(notice?.querySelector('a[href="/sync"]')?.textContent).toBe('Restore folder')

    click(buttonNamed('Dismiss', notice ?? document))
    await waitForDom(() => api.acknowledgeIncident.mock.calls.length === 1)
    expect(api.acknowledgeIncident).toHaveBeenCalledWith('inc-1')
  })

  it('pauses everything with the pause revision and says what pausing means (AU-06)', async () => {
    const api = mount()
    await waitForDom(() => buttonNamed('Pause all')?.disabled === false)
    click(buttonNamed('Pause all'))
    await waitForDom(() => Boolean(buttonNamed('Resume all')))
    expect(api.setPause).toHaveBeenCalledWith(true, '1')
    expect(text('[data-testid="automations-paused"]')).toContain('Bookmarks saved while paused are not processed later.')
    expect(toast.success).toHaveBeenCalledWith('All automations are paused.')

    api.setPause.mockResolvedValueOnce(pause(false, '3'))
    click(buttonNamed('Resume all'))
    await waitForDom(() => Boolean(buttonNamed('Pause all')))
    expect(api.setPause).toHaveBeenLastCalledWith(false, '2')
    expect(document.querySelector('[data-testid="automations-paused"]')).toBeNull()
  })

  it('refreshes the pause state when someone else changed it first', async () => {
    const api = fakeApi()
    api.setPause.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'Changed elsewhere.' }))
    mount(api)
    await waitForDom(() => buttonNamed('Pause all')?.disabled === false)
    click(buttonNamed('Pause all'))
    await waitForDom(() => api.getPause.mock.calls.length >= 2)
    expect(toast.error).toHaveBeenCalledWith('Changed elsewhere.')
  })

  it('says automations are not available where the server has none', async () => {
    const api = fakeApi()
    api.getPause.mockRejectedValue(new ProductApiError({ status: 404, code: 'not_found', message: 'Not found' }))
    mount(api)
    await waitForDom(() => text('h1') === 'Automations are not available yet')
    expect(buttonNamed('Pause all')).toBeUndefined()
  })

  it('starts empty with the two ways to make a rule', async () => {
    mount()
    await waitForDom(() => text('[data-testid="automations-empty"]').includes('No rules yet'))
    const links = [...document.querySelectorAll('[data-testid="automations-empty"] a')].map((link) => link.getAttribute('href'))
    expect(links).toEqual(['/automations/new', '/library'])
  })
})
