// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationEffectReceipt } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import { cleanup, renderWithRouter, waitForDom } from '../../test/render'
import { BookmarkAutomation } from './BookmarkAutomation'
import { AutomationDepsProvider } from './shared'
import { buttonNamed, click, deps, fakeApi, rule, run } from './automations.test-helper'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn(), warning: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))

function effect(patch: Partial<AutomationEffectReceipt> = {}): AutomationEffectReceipt {
  return {
    id: 'eff-1', kind: 'placement', status: 'committed', undoAvailable: true, undoReason: '',
    effectDigest: 'd'.repeat(64), operationId: 'op-1', ...patch,
  }
}

function mount(api = fakeApi()) {
  renderWithRouter(
    <AutomationDepsProvider value={deps(api)}>
      <BookmarkAutomation collectionId="col-personal" nodeId="bm-1" />
    </AutomationDepsProvider>,
    { route: '/collections/col-personal/nodes/bm-1' },
  )
  return api
}

describe('Bookmark automation history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('shows what a rule did, by name, and undoes that one effect with its digest (AU-13)', async () => {
    const api = fakeApi()
    api.listRuns.mockResolvedValue({ items: [run('run-1', 'rule-arxiv', {
      revision: '7', explanation: 'Placed by rule rule-arxiv.', effects: [effect()],
    })], nextCursor: null })
    api.getRule.mockResolvedValue(rule('rule-arxiv', 'Papers to Academic'))
    mount(api)
    await waitForDom(() => document.querySelector('[data-run-id="run-1"]')?.textContent?.includes('Papers to Academic') ?? false)
    expect(api.listRuns).toHaveBeenCalledWith({ collectionId: 'col-personal', nodeId: 'bm-1' }, expect.anything())
    expect(document.querySelector('[data-testid="automation-effect-title"]')?.textContent).toBe('Moved by the rule')

    const reads = api.listRuns.mock.calls.length
    click(buttonNamed('Undo'))
    await waitForDom(() => toast.success.mock.calls.length === 1)
    expect(api.undoRunEffect).toHaveBeenCalledWith('run-1', {
      reason: 'Owner undid one automation effect from the bookmark page.',
      expectedEffectDigest: 'd'.repeat(64),
      effectReceiptId: 'eff-1',
    }, '7')
    expect(toast.success).toHaveBeenCalledWith('Undone. The bookmark is back in the folder it came from.')
    await waitForDom(() => api.listRuns.mock.calls.length > reads)
  })

  it('says why Undo is not offered, in the server’s terms made plain', async () => {
    const api = fakeApi()
    api.listRuns.mockResolvedValue({ items: [run('run-1', 'rule-arxiv', {
      effects: [effect({ undoAvailable: false, undoReason: 'A newer canonical change prevents safe Undo.' })],
    })], nextCursor: null })
    mount(api)
    await waitForDom(() => Boolean(document.querySelector('[data-testid="automation-undo-reason"]')))
    expect(buttonNamed('Undo')).toBeUndefined()
    expect(document.querySelector('[data-testid="automation-undo-reason"]')?.textContent)
      .toBe('Can’t undo: the bookmark changed after this, so nothing was changed.')
  })

  it('reports a refused Undo without claiming anything changed', async () => {
    const api = fakeApi()
    api.listRuns.mockResolvedValue({ items: [run('run-1', 'rule-arxiv', { effects: [effect()] })], nextCursor: null })
    api.undoRunEffect.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'Changed' }))
    mount(api)
    await waitForDom(() => Boolean(buttonNamed('Undo')))
    click(buttonNamed('Undo'))
    await waitForDom(() => toast.error.mock.calls.length === 1)
    expect(toast.error).toHaveBeenCalledWith('Nothing was changed: the bookmark changed since this was done.')
  })

  it('says nothing has happened yet, and links to the rules', async () => {
    mount()
    await waitForDom(() => document.querySelector('[role="status"]')?.textContent === 'Nothing yet')
    expect(document.querySelector('[data-testid="bookmark-automation"] a')?.getAttribute('href')).toBe('/automations')
  })

  it('is not there at all where the server has no automations', async () => {
    const api = fakeApi()
    api.listRuns.mockRejectedValue(new ProductApiError({ status: 404, code: 'not_found', message: 'Not found' }))
    mount(api)
    await waitForDom(() => api.listRuns.mock.calls.length > 0 && !document.querySelector('[data-testid="bookmark-automation"]'))
    expect(document.querySelector('[data-testid="bookmark-automation"]')).toBeNull()
  })
})
