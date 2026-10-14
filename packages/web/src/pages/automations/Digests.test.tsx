// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRunOutput } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { buttonNamed, click, deps, fakeApi, rule, run } from './automations.test-helper'

/* AW-45 against the AW-58 consumer fixture (fixtures/aw-58/handoff.json):
   outputs are plain text with provenance, reading marks through the output
   on screen only, and the server's read state is what a refresh shows. */

const handoff = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../../../docs/automation/evidence/fixtures/aw-58/handoff.json'),
  'utf8',
)) as {
  firstPage: { items: AutomationRunOutput[]; nextCursor: string }
  laterPage: { items: AutomationRunOutput[]; nextCursor: null }
  markReadRequest: { throughOutputId: string }
}
const [digest] = handoff.firstPage.items
const [review] = handoff.laterPage.items
if (!digest || !review) throw new Error('fixture pages are empty')

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

function mount(api = fakeApi(), route = '/automations/runs/run_batch') {
  renderWithRouter(
    <Routes><Route path="/automations/*" element={<Automations deps={deps(api)} />} /></Routes>,
    { route },
  )
  return api
}

function batchRun(patch = {}) {
  return run('run_batch', 'rule-digest', { kind: 'batch', status: 'completed', outputCount: 2, unread: true, revision: '5', ...patch })
}

function withRun(patch = {}) {
  const api = fakeApi()
  api.getRun.mockResolvedValue(batchRun(patch))
  api.getRule.mockResolvedValue(rule('rule-digest', 'Weekly papers'))
  api.listTargets.mockResolvedValue({ items: [{
    id: 'target_research', revision: '1', status: 'active', subscriptionCount: 0, isolation: 'sharedCredential', wakeMode: 'poll',
    wakeReadiness: 'active', wakeReason: 'x',
    configuration: { name: 'Research worker', providerLabel: 'Laptop', broadcastOptIn: false, privacy: 'standard', connectionProfileId: 'p' },
  }], nextCursor: null })
  api.markRunRead.mockResolvedValue({ id: 'receipt_read', status: 'completed', resourceId: 'run_batch', diagnostics: [] })
  return api
}

const outputs = () => [...document.querySelectorAll('[data-output-id]')].map((item) => item.getAttribute('data-output-id'))

describe('What a run wrote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows each output as plain text with who wrote it and its sources', async () => {
    const api = withRun()
    const hostile: AutomationRunOutput = { ...digest, output: { ...digest.output, text: '<img src=x onerror="alert(1)"> Read these\nin order.' } }
    api.listRunOutputs.mockResolvedValue({ items: [hostile], nextCursor: null })
    mount(api)
    await waitForDom(() => outputs().length === 1)
    const text = document.querySelector('[data-testid="automation-output-text"]')
    expect(text?.textContent).toBe('<img src=x onerror="alert(1)"> Read these\nin order.')
    expect(text?.querySelector('img')).toBeNull()
    const card = document.querySelector(`[data-output-id="${digest.id}"]`)
    expect(card?.textContent).toContain('Digest')
    await waitForDom(() => card?.textContent?.includes('Written by Research worker') === true)
    expect(card?.querySelector(`a[href="#job-${digest.jobId}"]`)).not.toBeNull()
    expect(card?.querySelector('summary')?.textContent).toBe('1 source')
  })

  it('marks read only through the output on screen, with the run revision', async () => {
    const api = withRun()
    api.listRunOutputs.mockImplementation(async (_id: string, page?: { cursor?: string | null }) => (
      page?.cursor === handoff.firstPage.nextCursor ? handoff.laterPage : handoff.firstPage
    ))
    mount(api)
    await waitForDom(() => api.markRunRead.mock.calls.length === 1)
    expect(api.markRunRead).toHaveBeenCalledWith('run_batch', handoff.markReadRequest.throughOutputId, '5')
    expect(outputs()).toEqual([digest.id])

    // Showing the later page reads through that one too; nothing past it.
    api.getRun.mockResolvedValue(batchRun({ unread: true, revision: '6' }))
    click(buttonNamed('Show more'))
    await waitForDom(() => outputs().length === 2)
    await waitForDom(() => api.markRunRead.mock.calls.some((call) => call[1] === review.id))
    expect(new Set(api.markRunRead.mock.calls.map((call) => call[1]))).toEqual(new Set([digest.id, review.id]))
  })

  it('reads the run again when a later output changed it, and marks through the same output', async () => {
    const api = withRun()
    api.listRunOutputs.mockResolvedValue({ items: [digest], nextCursor: null })
    api.markRunRead.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'Changed' }))
    // Once the first mark was refused, the server's run carries the later output's revision.
    api.getRun.mockImplementation(async () => batchRun(api.markRunRead.mock.calls.length > 0 ? { revision: '6' } : {}))
    mount(api)
    await waitForDom(() => api.markRunRead.mock.calls.length >= 2)
    expect(api.markRunRead.mock.calls[1]).toEqual(['run_batch', digest.id, '6'])
  })

  it('shows what the server says after a refresh: read stays read, a later output is new', async () => {
    const api = withRun({ unread: false })
    api.listRunOutputs.mockResolvedValue({ items: [digest], nextCursor: null })
    mount(api)
    await waitForDom(() => outputs().length === 1)
    expect(document.querySelector('[data-testid="automation-run-unread"]')).toBeNull()
    expect(api.markRunRead).not.toHaveBeenCalled()
    cleanup()

    const later = withRun({ unread: true, outputCount: 2, revision: '7' })
    later.listRunOutputs.mockResolvedValue({ items: [digest, review], nextCursor: null })
    mount(later)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-run-unread"]')))
    await waitForDom(() => later.markRunRead.mock.calls.length === 1)
    expect(later.markRunRead).toHaveBeenCalledWith('run_batch', review.id, '7')
  })

  it('says when the source bookmarks are gone instead of showing text', async () => {
    const api = withRun()
    api.listRunOutputs.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Source unavailable.' }))
    mount(api)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-outputs-unavailable"]')))
    expect(document.querySelector('[data-testid="automation-output-text"]')).toBeNull()
    expect(api.markRunRead).not.toHaveBeenCalled()
  })
})

describe('Digests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lists only runs that wrote something, with the server’s unread state and their digest', async () => {
    const api = fakeApi()
    api.listRuns.mockResolvedValue({ items: [
      batchRun(),
      run('run-quiet', 'rule-digest', { outputCount: 0 }),
      run('run-read', 'rule-digest', { kind: 'batch', outputCount: 1, unread: false }),
    ], nextCursor: null })
    api.listRules.mockResolvedValue({ items: [rule('rule-digest', 'Weekly papers')], nextCursor: null })
    api.listRunOutputs.mockImplementation(async (id: string) => ({
      items: id === 'run_batch' ? [review, digest] : [review],
      nextCursor: null,
    }))
    mount(api, '/automations/digests')
    await waitForDom(() => document.querySelectorAll('[data-run-id]').length === 2)
    expect(document.querySelector('[data-run-id="run-quiet"]')).toBeNull()
    const fresh = document.querySelector('[data-run-id="run_batch"]')
    expect(fresh?.getAttribute('data-unread')).toBe('true')
    expect(fresh?.querySelector('a')?.getAttribute('href')).toBe('/automations/runs/run_batch#outputs')
    await waitForDom(() => fresh?.textContent?.includes(digest.output.text) === true)
    expect(document.querySelector('[data-run-id="run-read"]')?.getAttribute('data-unread')).toBeNull()
    expect(api.listRunOutputs).toHaveBeenCalledWith('run_batch', { limit: 3 })
    expect(api.markRunRead).not.toHaveBeenCalled()
  })

  it('starts empty with a way back to the rules', async () => {
    mount(fakeApi(), '/automations/digests')
    await waitForDom(() => document.body.textContent?.includes('No digests yet') === true)
  })
})
