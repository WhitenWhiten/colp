// @vitest-environment happy-dom
import { act } from 'react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { buttonNamed, click, deps, fakeApi, job, rule, run, usage } from './automations.test-helper'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

function mount(api = fakeApi(), route = '/automations/runs/run-1') {
  renderWithRouter(
    <Routes><Route path="/automations/*" element={<Automations deps={deps(api)} />} /></Routes>,
    { route },
  )
  return api
}

function withRun(patch: Partial<AutomationRun> = {}) {
  const api = fakeApi()
  api.getRun.mockResolvedValue(run('run-1', 'rule-arxiv', patch))
  api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic'))
  return api
}

const text = (selector: string, root: ParentNode = document) => root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const dialog = () => document.querySelector('[role="dialog"]')

describe('Run detail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('refreshes a running run and the same job ids, then stops polling after leaving', async () => {
    const api = withRun({ status: 'running', jobIds: ['job-a'] })
    let completed = false
    api.getRun.mockImplementation(async () => run('run-1', 'rule-arxiv', {
      status: completed ? 'completed' : 'running', revision: completed ? '2' : '1', jobIds: ['job-a'],
    }))
    api.getJob.mockImplementation(async () => job('job-a', completed ? 'succeeded' : 'ready'))
    vi.useFakeTimers()
    mount(api)
    await waitForDom(() => document.querySelector('[data-job-id="job-a"]')?.getAttribute('data-status') === 'ready')
    completed = true
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    await waitForDom(() => document.querySelector('[data-job-id="job-a"]')?.getAttribute('data-status') === 'succeeded')
    expect(text('h1')).toBe('Run finished')
    const calls = api.getRun.mock.calls.length
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api.getRun.mock.calls.length).toBe(calls)
  })

  it('keeps a newer cancel result when an older refresh finishes late', async () => {
    const api = withRun({ status: 'running' })
    let resolveOld: ((value: AutomationRun) => void) | undefined
    api.getRun.mockImplementation(async () => run('run-1', 'rule-arxiv', { status: 'running', revision: '1' }))
    api.cancelRun.mockResolvedValue(run('run-1', 'rule-arxiv', { status: 'cancelled', revision: '2' }))
    mount(api)
    await waitForDom(() => text('h1') === 'Run in progress')
    api.getRun.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    click(buttonNamed('Refresh'))
    await waitForDom(() => Boolean(resolveOld))
    click(buttonNamed('Cancel remaining work'))
    await waitForDom(() => Boolean(dialog()))
    click(buttonNamed('Cancel remaining work', dialog() ?? document))
    await waitForDom(() => text('h1') === 'Run cancelled')
    await act(async () => { resolveOld?.(run('run-1', 'rule-arxiv', { status: 'running', revision: '1' })) })
    expect(text('h1')).toBe('Run cancelled')
  })

  it.each([
    ['waiting', 'Run waiting to start', true],
    ['running', 'Run in progress', true],
    ['review', 'Run needs your decision', true],
    ['blocked', 'Run blocked', true],
    ['completed', 'Run finished', false],
    ['partial', 'Run partly finished', false],
    ['cancelled', 'Run cancelled', false],
    ['failed', 'Run failed', false],
  ] as const)('a %s run reads “%s” and offers Cancel only while work remains', async (status, headline, cancellable) => {
    mount(withRun({ status }))
    await waitForDom(() => text('h1') === headline)
    expect(Boolean(buttonNamed('Cancel remaining work'))).toBe(cancellable)
    expect(document.querySelector('a[href="/automations/rules/rule-arxiv"]')).not.toBeNull()
  })

  it('puts the server’s explanation in plain words and says an empty run changed nothing', async () => {
    mount(withRun({ status: 'review', explanation: 'Equal-priority rules selected incompatible destinations; the original location was preserved.' }))
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-run-explanation"]')))
    expect(text('[data-testid="automation-run-explanation"]'))
      .toBe('Rules with the same priority chose different folders, so the bookmark stayed where you saved it.')
    expect(document.body.textContent).toContain('Nothing was changed.')
  })

  it('marks a held run and keeps the hold distinct from its state', async () => {
    mount(withRun({ status: 'waiting', held: true }))
    await waitForDom(() => text('h1') === 'Run waiting to start')
    expect(document.body.textContent).toContain('It is on hold and does not go on by itself.')
    expect(document.body.textContent).toContain('On hold')
    expect(document.querySelector('a[href="/automations/rules/rule-arxiv/edit#preview"]')?.textContent).toContain('choose whether to continue')
  })

  it('shows each agent step with only the action its state allows', async () => {
    const api = withRun({ status: 'running', jobIds: ['job-a', 'job-b', 'job-c', 'job-d'], usage: usage() })
    api.getJob.mockImplementation(async (id: string) => ({
      'job-a': job('job-a', 'awaitingApproval', { planId: 'plan-a' }),
      'job-b': job('job-b', 'uncertain', { task: { ...job('x', 'ready').task, type: 'tags.generate' } }),
      'job-c': job('job-c', 'stale'),
    })[id] ?? Promise.reject(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'This step is no longer available.' })))
    mount(api)
    await waitForDom(() => document.querySelectorAll('[data-job-id]').length === 3)
    const approval = document.querySelector('[data-job-id="job-a"]')
    expect(approval?.querySelector('a')?.getAttribute('href')).toBe('/approvals/plan-a')
    expect(document.querySelector('[data-testid="automation-usage"]')).not.toBeNull()
    expect(approval?.querySelector('button')).toBeNull()
    const uncertain = document.querySelector('[data-job-id="job-b"]')
    expect(text('[data-job-id="job-b"] p')).toContain('Suggest tags')
    expect(buttonNamed('Try again', uncertain ?? document)).toBeDefined()
    const stale = document.querySelector('[data-job-id="job-c"]')
    expect(stale?.querySelector('a, button')).toBeNull()
    expect(stale?.textContent).toContain('The bookmark changed after this started')
    expect(text('[data-status="unreadable"]')).toBe('This step is no longer available.')

    click(buttonNamed('Try again', uncertain ?? document))
    await waitForDom(() => api.retryJob.mock.calls.length === 1)
    expect(api.retryJob).toHaveBeenCalledWith('job-b', '4')
    await waitForDom(() => document.querySelector('[data-job-id="job-b"]')?.getAttribute('data-status') === 'ready')
  })

  it('reports a refused retry as the server worded it', async () => {
    const api = withRun({ status: 'running', jobIds: ['job-b'] })
    api.getJob.mockResolvedValue(job('job-b', 'uncertain'))
    api.retryJob.mockRejectedValue(new ProductApiError({ status: 409, code: 'automation_retry_unavailable', message: 'No pinned calls remain.' }))
    mount(api)
    await waitForDom(() => Boolean(buttonNamed('Try again')))
    // Without the server's counts the side says nothing rather than "no agent work".
    expect(document.querySelector('[data-testid="automation-usage"]')).toBeNull()
    click(buttonNamed('Try again'))
    await waitForDom(() => toast.error.mock.calls.length === 1)
    expect(toast.error).toHaveBeenCalledWith('No pinned calls remain.')
  })

  it('cancels what is left only after the owner confirms, with the run revision', async () => {
    const api = withRun({ status: 'waiting', revision: '8' })
    api.cancelRun.mockResolvedValue(run('run-1', 'rule-arxiv', { status: 'cancelled', revision: '9' }))
    mount(api)
    await waitForDom(() => Boolean(buttonNamed('Cancel remaining work')))
    click(buttonNamed('Cancel remaining work'))
    await waitForDom(() => Boolean(dialog()))
    click(buttonNamed('Keep running', dialog() ?? document))
    await waitForDom(() => !dialog())
    expect(api.cancelRun).not.toHaveBeenCalled()

    click(buttonNamed('Cancel remaining work'))
    await waitForDom(() => Boolean(dialog()))
    click(buttonNamed('Cancel remaining work', dialog() ?? document))
    await waitForDom(() => text('h1') === 'Run cancelled')
    expect(api.cancelRun).toHaveBeenCalledWith('run-1', '8')
    expect(buttonNamed('Cancel remaining work')).toBeUndefined()
  })

  it('undoes one effect from the run page and shows the run the server returned', async () => {
    const api = withRun({ status: 'completed', revision: '5', effects: [{
      id: 'eff-1', kind: 'placement', status: 'committed', undoAvailable: true, undoReason: '', effectDigest: 'e'.repeat(64), operationId: 'op-1',
    }] })
    api.undoRunEffect.mockResolvedValue(run('run-1', 'rule-arxiv', { status: 'completed', revision: '6', effects: [{
      id: 'eff-1', kind: 'placement', status: 'reverted', undoAvailable: false, undoReason: 'This placement has already been reverted.', effectDigest: 'e'.repeat(64), operationId: 'op-1',
    }] }))
    mount(api)
    await waitForDom(() => Boolean(buttonNamed('Undo')))
    click(buttonNamed('Undo'))
    await waitForDom(() => document.querySelector('[data-effect-id="eff-1"]')?.getAttribute('data-status') === 'reverted')
    expect(api.undoRunEffect).toHaveBeenCalledWith('run-1', expect.objectContaining({
      effectReceiptId: 'eff-1', reason: 'Owner undid one automation effect from the run page.',
    }), '5')
    expect(buttonNamed('Undo')).toBeUndefined()
  })

  it('says when a run is gone, and when it belongs to someone else', async () => {
    const api = fakeApi()
    api.getRun.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found' }))
    mount(api)
    await waitForDom(() => text('h1') === 'This run is not available')
    cleanup()
    const refused = fakeApi()
    refused.getRun.mockRejectedValue(new ProductApiError({ status: 403, code: 'insufficient_permission', message: 'No' }))
    mount(refused)
    await waitForDom(() => text('h1') === 'You do not have access')
  })
})
