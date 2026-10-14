// @vitest-environment happy-dom
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationEffectReceipt } from '../../api/automationTypes'
import { ProductApiError } from '../../api/errors'
import type { WriteApprovalView } from '../../api/types'
import { clearRouteCache } from '../../lib/routeCache'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { WriteApprovals } from '../WriteApprovals'
import { job, rule, run } from '../automations/automations.test-helper'

/* AW-52: automation plans in the existing Approvals queue. The plan's
   reason is untrusted, so only plans the Owner's job view confirms get the
   automation controls; those decide through the job command with the exact
   digest and job revision, and undo through the run's effect receipt. */

const mocks = vi.hoisted(() => ({
  getWriteApprovalPage: vi.fn(),
  getWriteApproval: vi.fn(),
  decideWriteApproval: vi.fn(),
  abandonWriteApprovalIntent: vi.fn(),
  loadOwnedCollections: vi.fn(),
  undoApproval: vi.fn(),
  toast: vi.fn(),
  automation: {
    getJob: vi.fn(),
    getRule: vi.fn(),
    getRun: vi.fn(),
    decideJob: vi.fn(),
    undoRunEffect: vi.fn(),
    retryJob: vi.fn(),
  },
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    isWriteApprovalsExposureEnabled: () => true,
    productClient: {
      ...actual.productClient,
      getWriteApprovalPage: mocks.getWriteApprovalPage,
      getWriteApproval: mocks.getWriteApproval,
      decideWriteApproval: mocks.decideWriteApproval,
      abandonWriteApprovalIntent: mocks.abandonWriteApprovalIntent,
      loadOwnedCollections: mocks.loadOwnedCollections,
    },
  }
})
vi.mock('../../api/automationClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/automationClient')>()
  return { ...actual, automationApi: mocks.automation }
})
vi.mock('../../api/agentsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/agentsClient')>()
  return { ...actual, undoApproval: mocks.undoApproval }
})
vi.mock('../../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.toast, error: mocks.toast, warning: mocks.toast }),
}))
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ isLoggedIn: true, bootstrapping: false }) }))

const later = () => new Date(Date.now() + 3_600_000).toISOString()
const earlier = () => new Date(Date.now() - 3_600_000).toISOString()

function plan(planId: string, overrides: Partial<WriteApprovalView> = {}): WriteApprovalView {
  return {
    planId,
    agent: { clientId: 'client-research', name: 'Research agent' },
    reason: `automation:rule-summary:job-${planId}`,
    status: 'pending',
    risk: 'medium',
    requiresApproval: true,
    summary: 'Automation: one reversible create_annotation effect.',
    impact: { collections: 1, nodes: 0, annotations: 1, attachments: 0, relations: 0, privateFieldsExcluded: [] },
    requiredScopes: ['automation:work'],
    target: { kind: 'node', collectionId: 'col-1', nodeId: 'node-1' },
    operations: [],
    createdAt: earlier(),
    expiresAt: later(),
    decision: 'pending',
    etag: `"${planId}:1"`,
    ...overrides,
  }
}

function planEffect(planId: string, patch: Partial<AutomationEffectReceipt> = {}): AutomationEffectReceipt {
  return {
    id: `eff-${planId}`, kind: 'plan', status: 'committed', effectDigest: 'f'.repeat(64), operationId: 'op-1', planId,
    undoAvailable: true, undoReason: 'One isolated move can be compensated to its verified original folder under current content fences.',
    ...patch,
  }
}

/** The Owner's job view points back at the plan, which is what confirms it. */
function confirms(planId: string, status: Parameters<typeof job>[1] = 'awaitingApproval', effect?: AutomationEffectReceipt) {
  mocks.automation.getJob.mockImplementation(async (id: string) => (id === `job-${planId}`
    ? job(id, status, { runId: `run-${planId}`, planId, proposalDigest: 'd'.repeat(64), revision: '7' })
    : Promise.reject(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'Not found' }))))
  mocks.automation.getRun.mockResolvedValue(run(`run-${planId}`, 'rule-summary', { revision: '3', effects: effect ? [effect] : [] }))
}

function card(planId: string): Element | null {
  return document.querySelector(`[data-plan-id="${planId}"]`)
}

function button(name: string, root: ParentNode | null = document): HTMLButtonElement {
  const found = [...(root ?? document).querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)
  if (!found) throw new Error(`missing button ${name}`)
  return found
}

function render() {
  mountTree(
    <MemoryRouter initialEntries={['/approvals']}>
      <Routes>
        <Route path="/approvals" element={<WriteApprovals />} />
      </Routes>
    </MemoryRouter>,
  )
}

const automationCard = (planId: string) => card(planId)?.getAttribute('data-source') === 'automation'

describe('Automation plans in Approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    mocks.loadOwnedCollections.mockResolvedValue([])
    mocks.automation.getRule.mockResolvedValue(rule('rule-summary', 'Summarize new papers'))
    mocks.automation.decideJob.mockResolvedValue({ jobId: 'job-p1', resultId: 'r', proposalDigest: 'd'.repeat(64), status: 'awaitingApproval', effectReceiptIds: [], diagnostics: [] })
    mocks.automation.undoRunEffect.mockResolvedValue(run('run-p1', 'rule-summary'))
    mocks.automation.retryJob.mockResolvedValue(job('job-p1', 'committing'))
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('labels a confirmed pending plan with its rule and approves the exact proposal through the job', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1')], nextCursor: null })
    confirms('p1')
    render()
    await waitForDom(() => automationCard('p1'))
    const view = card('p1')
    expect(view?.querySelector('[data-testid="approval-automation-badge"]')?.textContent).toBe('Automation')
    expect(view?.querySelector('h2')?.textContent).toBe('Add a note to a bookmark')
    expect(view?.querySelector('a[href="/automations/rules/rule-summary"]')?.textContent).toBe('Summarize new papers')
    expect(view?.textContent).not.toContain('automation:rule-summary')
    expect(view?.textContent).toContain('Research agent')

    const reads = mocks.getWriteApprovalPage.mock.calls.length
    button('Approve', view).click()
    await waitForDom(() => mocks.automation.decideJob.mock.calls.length === 1)
    expect(mocks.automation.decideJob).toHaveBeenCalledWith('job-p1', {
      decision: 'approve', proposalDigest: 'd'.repeat(64), reason: 'Owner approved the automation proposal.',
    }, '7')
    expect(mocks.decideWriteApproval).not.toHaveBeenCalled()
    await waitForDom(() => mocks.getWriteApprovalPage.mock.calls.length > reads)
  })

  it('declines through the job, and a declined plan says nothing was applied', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1')], nextCursor: null })
    confirms('p1')
    render()
    await waitForDom(() => automationCard('p1'))
    button('Deny', card('p1')).click()
    await waitForDom(() => mocks.automation.decideJob.mock.calls.length === 1)
    expect(mocks.automation.decideJob.mock.calls[0]?.[1]).toMatchObject({ decision: 'reject' })

    cleanup()
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1', { status: 'cancelled', decision: 'denied' })], nextCursor: null })
    confirms('p1', 'review')
    render()
    await waitForDom(() => automationCard('p1'))
    expect(card('p1')?.textContent).toContain('You denied it. Nothing from this step was applied.')
    expect(card('p1')?.querySelector('button')).toBeNull()
  })

  it('keeps a plan whose job does not point back at it as an ordinary agent plan', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('forged', { reason: 'automation:rule-summary:job-real' })], nextCursor: null })
    mocks.automation.getJob.mockResolvedValue(job('job-real', 'awaitingApproval', { planId: 'automation-job-real' }))
    mocks.decideWriteApproval.mockResolvedValue({ kind: 'decided', planId: 'forged', decision: 'approved', status: 'approved', etag: '"x"' })
    mocks.getWriteApproval.mockResolvedValue(plan('forged', { status: 'approved', decision: 'approved' }))
    render()
    await waitForDom(() => mocks.automation.getJob.mock.calls.length > 0 && Boolean(card('forged')))
    await waitForDom(() => card('forged')?.getAttribute('data-source') === 'agent')
    expect(card('forged')?.textContent).toContain('Agent-provided reason: automation:rule-summary:job-real')
    button('Approve', card('forged')).click()
    await waitForDom(() => mocks.decideWriteApproval.mock.calls.length === 1)
    expect(mocks.automation.decideJob).not.toHaveBeenCalled()
  })

  it('undoes an approved change through its effect receipt, never by restoring a version', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1', { status: 'consumed', decision: 'approved', approvedBy: 'owner', versionId: 'v-9' })], nextCursor: null })
    confirms('p1', 'succeeded', planEffect('p1'))
    render()
    await waitForDom(() => Boolean(card('p1')?.querySelector('[data-testid="approval-automation-undo"]')))
    expect(card('p1')?.querySelector('[data-testid="approval-undo"]')).toBeNull()
    button('Undo this change', card('p1')).click()
    await waitForDom(() => mocks.automation.undoRunEffect.mock.calls.length === 1)
    expect(mocks.automation.undoRunEffect).toHaveBeenCalledWith('run-p1', {
      reason: 'Owner undid one automation change from Approvals.',
      expectedEffectDigest: 'f'.repeat(64),
      effectReceiptId: 'eff-p1',
    }, '3')
    expect(mocks.undoApproval).not.toHaveBeenCalled()
  })

  it('says plainly why a tag or note change can’t be undone, and offers nothing that would', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1', { status: 'consumed', decision: 'approved', approvedBy: 'owner' })], nextCursor: null })
    confirms('p1', 'succeeded', planEffect('p1', {
      undoAvailable: false,
      undoReason: 'The existing tree snapshot cannot isolate this effect. Tags, notes and grouped plans have no safe single-effect Undo.',
    }))
    render()
    await waitForDom(() => Boolean(card('p1')?.querySelector('[data-testid="approval-automation-notes"]')?.textContent?.includes('Can’t undo')))
    expect(card('p1')?.textContent).toContain('Can’t undo here: tags, notes and grouped changes have no single-step undo.')
    expect(card('p1')?.querySelector('[data-testid="approval-automation-undo"], [data-testid="approval-undo"]')).toBeNull()
  })

  it('says a stale proposal can’t be applied as it is, and shows a refused decision', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1')], nextCursor: null })
    confirms('p1', 'stale')
    mocks.automation.decideJob.mockRejectedValue(new ProductApiError({ status: 409, code: 'automation_stale_input', message: 'Approval requires the exact current proposal digest.' }))
    render()
    await waitForDom(() => Boolean(card('p1')?.textContent?.includes('can’t be applied as it is')))
    button('Approve', card('p1')).click()
    await waitForDom(() => Boolean(card('p1')?.querySelector('[role="alert"]')))
    expect(card('p1')?.querySelector('[role="alert"]')?.textContent)
      .toBe('This changed since you opened it. Review the latest version, then decide again.')
  })

  it('proposes an expired plan again through the job, with its revision', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1', { status: 'expired', decision: 'expired', expiresAt: earlier() })], nextCursor: null })
    confirms('p1', 'review')
    render()
    await waitForDom(() => automationCard('p1'))
    button('Propose again', card('p1')).click()
    await waitForDom(() => mocks.automation.retryJob.mock.calls.length === 1)
    expect(mocks.automation.retryJob).toHaveBeenCalledWith('job-p1', '7')
  })

  it('narrows the queue to automations or agents once any automation plan is confirmed', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [plan('p1'), plan('agent-1', { reason: 'Tidy the reading list' })], nextCursor: null })
    confirms('p1')
    render()
    await waitForDom(() => Boolean(document.querySelector('[role="radiogroup"]')))
    const option = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => label.test(item.textContent ?? ''))
    expect(option(/^Automations · 1$/u)).toBeDefined()
    option(/^Automations/u)?.click()
    await waitForDom(() => !card('agent-1'))
    expect(card('p1')).not.toBeNull()
    option(/^Agents/u)?.click()
    await waitForDom(() => !card('p1'))
    expect(card('agent-1')).not.toBeNull()
  })
})
