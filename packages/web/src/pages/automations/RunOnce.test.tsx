// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRuleDefinition, AutomationRunOnceInput, AutomationRunOncePreview } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { Automations } from '../Automations'
import { buttonNamed, click, definition, deps, fakeApi, pickFolder, rule, run } from './automations.test-helper'

/* AW-59 against the AW-41 consumer fixture (fixtures/aw-41/handoff.json):
   the page previews a selection, starts only that stored preview by its id
   and digest, and never starts one that changed, expired or was refused. */

const handoff = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../../../docs/automation/evidence/fixtures/aw-41/handoff.json'),
  'utf8',
)) as {
  previewRequest: AutomationRunOnceInput
  previewResponse: AutomationRunOncePreview
  overLimitResponse: AutomationRunOncePreview
  startRequest: { previewId: string; previewDigest: string }
  stale: { status: number; code: string }
}

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

const later = () => new Date(Date.now() + 15 * 60_000).toISOString()
/** The fixture's preview, still current: its own expiry is in the past. */
const current = (patch: Partial<AutomationRunOncePreview> = {}): AutomationRunOncePreview => ({ ...handoff.previewResponse, expiresAt: later(), ...patch })

const summarize: AutomationRuleDefinition['tasks'][number] = {
  id: 'summary', type: 'summary.generate', after: [], executorRole: 'summarizer', required: false,
  outputContract: 'summary.v1', inputFields: ['title', 'url'], instruction: 'Summarize it.',
}

function mount(api = fakeApi(), route = '/automations/rules/rule-arxiv/run-once') {
  renderWithRouter(
    <Routes><Route path="/automations/*" element={<Automations deps={deps(api)} />} /></Routes>,
    { route },
  )
  return api
}

function withRule(patch = {}) {
  const api = fakeApi()
  api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic', patch))
  return api
}

const folderSelect = () => document.querySelector<HTMLButtonElement>('#run-once-folder')
const startButton = () => document.querySelector<HTMLButtonElement>('[data-testid="run-once-start"]')
const previewPanel = () => document.querySelector('[data-testid="run-once-preview"]')
const option = (label: string) => [...document.querySelectorAll('label')]
  .find((row) => row.textContent?.includes(label))?.querySelector('input')

async function previewed(api: ReturnType<typeof fakeApi>) {
  await waitForDom(() => folderSelect()?.value === 'root-p')
  expect(startButton()?.disabled).toBe(true)
  click(buttonNamed('Preview'))
  await waitForDom(() => previewPanel()?.getAttribute('data-state') !== 'empty')
  return api
}

describe('Run once', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('previews the whole collection by default and starts only that preview, by its id and digest', async () => {
    const api = withRule()
    api.previewRunOnce.mockResolvedValue(current())
    api.startRunOnce.mockResolvedValue(run('run_manual', 'rule-arxiv', { kind: 'manual', status: 'running' }))
    api.getRun.mockResolvedValue(run('run_manual', 'rule-arxiv', { kind: 'manual', status: 'running' }))
    mount(api)
    await previewed(api)

    expect(api.previewRunOnce).toHaveBeenCalledWith('rule-arxiv', {
      ...handoff.previewRequest,
      folder: { serverUuid: 'server-demo', collectionId: 'col-personal', nodeId: 'root-p' },
    }, expect.any(String))
    const stats = [...document.querySelectorAll('[aria-label="Preview totals"] li')].map((item) => [item.getAttribute('data-outcome'), item.querySelector('span')?.textContent])
    expect(stats).toEqual([['matched', '3'], ['explicitChoice', '2']])
    const sample = [...document.querySelectorAll('[data-testid="run-once-sample"] li')].map((item) => item.getAttribute('data-decision'))
    expect(sample).toEqual(['matched', 'explicitChoice'])
    expect(startButton()?.textContent).toBe('Start on 3 bookmarks')

    click(startButton())
    await waitForDom(() => api.getRun.mock.calls.length > 0)
    expect(api.startRunOnce).toHaveBeenCalledTimes(1)
    expect(api.startRunOnce.mock.calls[0]).toEqual(['rule-arxiv', handoff.startRequest])
    expect(api.getRun.mock.calls[0]?.[0]).toBe('run_manual')
  })

  it('numbers its steps only when there is more than one', async () => {
    // Each step's number sits just before its heading.
    const indexes = () => [...document.querySelectorAll('[data-testid="automation-run-once"] ol > li h2')]
      .map((heading) => heading.previousElementSibling?.textContent ?? null)
    mount(withRule())
    await waitForDom(() => folderSelect()?.value === 'root-p')
    expect(indexes()).toEqual([null])

    cleanup()
    document.body.innerHTML = ''
    mount(withRule({ definition: definition('Papers to Academic', { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' }, { tasks: [summarize] }) }))
    await waitForDom(() => folderSelect()?.value === 'root-p')
    expect(indexes()).toEqual(['1', '2'])
  })

  it('throws the preview away when any option changes, so a changed selection cannot start', async () => {
    const api = withRule({ definition: definition('Papers to Academic', { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' }, { tasks: [summarize] }) })
    api.previewRunOnce.mockResolvedValue(current())
    mount(api)

    await waitForDom(() => folderSelect()?.value === 'root-p')
    const changes = [
      () => click(option('Include its subfolders')),
      () => click(option('Also move bookmarks already in a folder')),
      () => pickFolder('run-once-folder', 'f-reading'),
      () => click(option('File and run its agent tasks')),
    ]
    for (const change of changes) {
      click(buttonNamed('Preview'))
      await waitForDom(() => previewPanel()?.getAttribute('data-state') === 'current')
      expect(startButton()?.disabled).toBe(false)
      change()
      await waitForDom(() => previewPanel()?.getAttribute('data-state') === 'empty')
      expect(startButton()?.disabled).toBe(true)
    }

    click(buttonNamed('Preview'))
    await waitForDom(() => api.previewRunOnce.mock.calls.length === 5)
    expect(api.previewRunOnce.mock.calls[4]?.[1]).toEqual({
      folder: { serverUuid: 'server-demo', collectionId: 'col-personal', nodeId: 'f-reading' },
      includeDescendants: false,
      moveFolderedBookmarks: true,
      tasks: 'all',
    })
    // A fresh attempt each time: an identical body is still a new preview.
    expect(new Set(api.previewRunOnce.mock.calls.map((call) => call[2])).size).toBe(5)
    expect(api.startRunOnce).not.toHaveBeenCalled()
  })

  it('will not start an expired, over-limit or refused preview, and says why', async () => {
    const cases: [AutomationRunOncePreview, RegExp][] = [
      [{ ...handoff.overLimitResponse, expiresAt: later() }, /more than 1,000 bookmarks/],
      [current({ canStart: false, blockedCount: 2 }), /2 bookmarks can’t be filed/],
      [current({ canStart: false, matchedCount: 0, explicitChoiceCount: 0 }), /Nothing here matches/],
    ]
    for (const [result, reason] of cases) {
      const api = withRule()
      api.previewRunOnce.mockResolvedValue(result)
      mount(api)
      await previewed(api)
      expect(document.querySelector('[data-testid="run-once-blocker"]')?.textContent).toMatch(reason)
      expect(startButton()?.disabled).toBe(true)
      cleanup()
    }

    // The fixture's own expiry has passed.
    const api = withRule()
    api.previewRunOnce.mockResolvedValue(handoff.previewResponse)
    mount(api)
    await previewed(api)
    expect(document.querySelector('[data-testid="run-once-expired"]')).not.toBeNull()
    expect(startButton()?.disabled).toBe(true)
  })

  it('stops offering Start the moment the preview expires', async () => {
    const api = withRule()
    api.previewRunOnce.mockResolvedValue(current({ expiresAt: new Date(Date.now() + 300).toISOString() }))
    mount(api)
    await previewed(api)
    expect(startButton()?.disabled).toBe(false)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="run-once-expired"]')), 3000)
    expect(startButton()?.disabled).toBe(true)
    expect(previewPanel()?.getAttribute('data-state')).toBe('stale')
  })

  it('discards a preview the server calls stale and asks for a new one', async () => {
    const api = withRule()
    api.previewRunOnce.mockResolvedValue(current())
    api.startRunOnce.mockRejectedValue(new ProductApiError({ status: handoff.stale.status, code: handoff.stale.code, message: 'Run-once preview changed or expired; refresh the preview.' }))
    mount(api)
    await previewed(api)
    click(startButton())
    await waitForDom(() => previewPanel()?.getAttribute('data-state') === 'empty')
    expect(previewPanel()?.textContent).toContain('Preview again, then start.')
    expect(startButton()?.disabled).toBe(true)
    expect(api.getRun).not.toHaveBeenCalled()
  })

  it('keeps the preview after no answer, so Start repeats the same request', async () => {
    const api = withRule()
    api.previewRunOnce.mockResolvedValue(current())
    api.startRunOnce.mockRejectedValueOnce(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'Busy' }))
    api.startRunOnce.mockResolvedValueOnce(run('run_manual', 'rule-arxiv', { kind: 'manual' }))
    api.getRun.mockResolvedValue(run('run_manual', 'rule-arxiv', { kind: 'manual' }))
    mount(api)
    await previewed(api)
    click(startButton())
    await waitForDom(() => toast.error.mock.calls.length === 1)
    expect(String(toast.error.mock.calls[0]?.[0])).toContain('won’t run twice')
    await waitForDom(() => startButton()?.disabled === false)
    click(startButton())
    await waitForDom(() => api.getRun.mock.calls.length > 0)
    expect(api.startRunOnce.mock.calls).toEqual([['rule-arxiv', handoff.startRequest], ['rule-arxiv', handoff.startRequest]])
  })

  it('is offered from the rule page, and not for an archived rule', async () => {
    const api = withRule()
    mount(api, '/automations/rules/rule-arxiv')
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-run-once-link"]')))
    expect(document.querySelector('[data-testid="automation-run-once-link"]')?.getAttribute('href')).toBe('/automations/rules/rule-arxiv/run-once')
    cleanup()

    mount(withRule({ desiredState: 'archived', effectiveState: 'archived' }))
    await waitForDom(() => document.body.textContent?.includes('This rule is archived') === true)
    expect(buttonNamed('Preview')).toBeUndefined()
  })
})
