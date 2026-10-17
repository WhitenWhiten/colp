import { act } from 'react'
import { vi } from 'vitest'
import type { AutomationApi } from '../../api/automationClient'
import type {
  AutomationBindingSet,
  AutomationHealthIncident,
  AutomationJob,
  AutomationPauseState,
  AutomationPreviewResult,
  AutomationRule,
  AutomationRuleDefinition,
  AutomationRuleUsage,
  AutomationRun,
} from '../../api/automationTypes'
import type { AutomationDeps } from './shared'
import type { FolderSource } from './folders'

/* Synthetic automation DTOs and an injected API for network-free page tests.
   Shapes follow the generated contract; ids are fixtures, not live data. */

export const T = '2026-10-12T09:30:00.000Z'

export function definition(name: string, match: AutomationRuleDefinition['match'], patch: Partial<AutomationRuleDefinition> = {}): AutomationRuleDefinition {
  return {
    apiVersion: 'colp.automation/v1',
    name,
    roles: [{ key: 'destination', kind: 'folder', required: true, description: 'Folder matching bookmarks are moved to' }],
    on: 'bookmark.intake',
    scope: { collectionId: 'col-personal' },
    match,
    intake: { folderRole: 'destination', constraint: 'withinSubtree', satisfies: ['classify.root'], onUnusableBinding: 'keepOriginalAndBlock', respectExplicitSelection: true },
    trigger: { mode: 'each' },
    tasks: [],
    route: { mode: 'targets', targetIds: [], execution: 'single' },
    policy: {
      history: 'fromActivation', imports: 'exclude', restores: 'exclude', userEdits: 'preserve', sameStageReentry: 'deny', maxHops: 8,
      conflictingPlacement: 'review', privacy: 'standard', broadcastAllowed: false, maxRunsPerDay: 100, pauseMode: 'stopAdmissionHoldPending', missingInput: 'defer',
    },
    priority: 100,
    ...patch,
  }
}

export function rule(id: string, name: string, patch: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id,
    revision: '3',
    desiredState: 'enabled',
    effectiveState: 'active',
    definition: definition(name, { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' }),
    bindingSetId: `bind-${id}`,
    createdAt: T,
    updatedAt: T,
    ...patch,
  }
}

export function binding(id: string, nodeId: string): AutomationBindingSet {
  return {
    id,
    revision: '1',
    name: nodeId,
    updatedAt: T,
    values: { destination: { kind: 'folder', folder: { serverUuid: 'server-demo', collectionId: 'col-personal', nodeId }, followIdentity: true, onUnavailable: 'block', notifyOn: ['delete'] } },
  }
}

export function pause(paused = false, revision = '1'): AutomationPauseState {
  return { paused, pausedAt: paused ? T : null, pausedBy: paused ? 'owner' : null, revision, heldJobs: 0 }
}

export function incident(patch: Partial<AutomationHealthIncident> = {}): AutomationHealthIncident {
  return {
    id: 'inc-1', ruleId: 'rule-ssrn', role: 'destination', code: 'bindingDeleted', severity: 'error', state: 'open',
    blockingStages: ['intake'], message: 'Old papers was deleted.', firstSeenAt: T, lastSeenAt: T, dependencyRevision: '1',
    ...patch,
  }
}

export function run(id: string, ruleId: string, patch: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id, revision: '2', ruleId, ruleRevision: '3', bindingRevision: '1', executionPolicyRevision: null, status: 'completed',
    memberEventIds: ['evt-1'], recipientTargetIds: [], createdAt: T, updatedAt: T, jobIds: [], causationRoot: id, kind: 'intake',
    effects: [], unread: false, outputCount: 0, ...patch,
  }
}

export function usage(patch: Partial<AutomationRuleUsage> = {}): AutomationRuleUsage {
  return {
    periodStart: '2026-09-14T00:00:00.000Z', periodEnd: '2026-10-14T00:00:00.000Z', admittedRuns: 37,
    readyJobs: 2, succeededJobs: 29, heldJobs: 4, pendingJobs: 1, leasedJobs: 0, committingJobs: 0,
    policyBlockedJobs: 3, budgetBlockedJobs: 2, awaitingApprovalJobs: 2, uncertainJobs: 1,
    optionalCalls: 34, unknownCostCalls: 3, reportedCostMicros: '1250000', externalCosts: 'unknownDisclosed',
    costDisplay: 'External cost is unknown for one or more calls; reported amounts are unverified observations.',
    budgetDay: '2026-10-14', dailyRunLimit: 20, reservedRuns: 17, remainingRuns: 3, deliveryCapability: 'unavailable', acceptedDeliveries: null,
    ...patch,
  }
}

export function job(id: string, status: AutomationJob['status'], patch: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id, revision: '4', runId: 'run-1', status, inputDigest: 'a'.repeat(64), allowedFolders: [], inputsPaged: false,
    attemptGeneration: 1, createdAt: T,
    task: { id: 'summary', type: 'summary.generate', after: [], executorRole: 'researchEnricher', required: true, outputContract: 'summary.sourced.v1', inputFields: ['url'], instruction: 'Summarize.' },
    ...patch,
  }
}

export function previewResult(id = 'preview-1'): AutomationPreviewResult {
  return {
    previewId: id,
    sideEffects: false,
    decisions: [
      { eventId: 'e1', outcome: 'matched', satisfiedTasks: [], pendingTasks: [], explanation: 'Would place in canonical folder f-academic; preview only; no effect.' },
      { eventId: 'e2', outcome: 'notMatched', satisfiedTasks: [], pendingTasks: [], explanation: 'notMatched' },
    ],
    diagnostics: [],
    plannedRunCount: 1,
    remainderCount: 0,
    completeHistory: false,
    truncated: false,
  }
}

type Mocked<T> = { [K in keyof T]: T[K] & ReturnType<typeof vi.fn> }

export function fakeApi(): Mocked<AutomationApi> {
  const api = {
    getCapabilities: vi.fn(async () => ({ contractVersion: '0.2.1-design' as const, ruleApiVersions: ['colp.automation/v1'], runtimeProfiles: [], triggerModes: ['each' as const], taskTypes: [], eventsEnabled: false, limits: { maxRules: 100, maxExpressionBytes: 4096, maxTasksPerRule: 8 } })),
    getPause: vi.fn(async () => pause()),
    setPause: vi.fn(async (paused: boolean) => pause(paused, '2')),
    listRules: vi.fn(async () => ({ items: [] as AutomationRule[], nextCursor: null })),
    getRule: vi.fn(async (id: string) => rule(id, 'Rule')),
    createRule: vi.fn(async (input: { definition: AutomationRuleDefinition; bindingSetId: string }) => rule('rule-new', input.definition.name, { desiredState: 'draft', effectiveState: 'draft', definition: input.definition, bindingSetId: input.bindingSetId, revision: '1' })),
    replaceRule: vi.fn(async (id: string) => rule(id, 'Rule')),
    setRuleLifecycle: vi.fn(async (id: string) => rule(id, 'Rule')),
    archiveRule: vi.fn(async (id: string) => rule(id, 'Rule', { desiredState: 'archived', effectiveState: 'archived' })),
    previewRule: vi.fn(async () => previewResult()),
    listBindingSets: vi.fn(async () => ({ items: [] as AutomationBindingSet[], nextCursor: null })),
    getBindingSet: vi.fn(async (id: string) => binding(id, 'f-academic')),
    createBindingSet: vi.fn(async () => binding('bind-new', 'f-academic')),
    replaceBindingSet: vi.fn(async (id: string) => binding(id, 'f-academic')),
    deleteBindingSet: vi.fn(async () => undefined),
    getRuleHealth: vi.fn(async (id: string) => ({ ruleId: id, checkedAt: T, effectiveState: 'active' as const, incidents: [] as AutomationHealthIncident[] })),
    getRuleDependencies: vi.fn(async (id: string) => ({ ruleId: id, dependencies: [
      { kind: 'folder' as const, role: 'destination', resourceId: 'f-academic', revision: '1', status: 'valid' as const },
      { kind: 'runtime' as const, role: 'intake', resourceId: 'automation-m1', revision: 'm1', status: 'valid' as const },
    ] })),
    revalidateRule: vi.fn(async (id: string) => ({ ruleId: id, checkedAt: T, effectiveState: 'active' as const, incidents: [] })),
    listIncidents: vi.fn(async () => ({ items: [] as AutomationHealthIncident[], nextCursor: null })),
    acknowledgeIncident: vi.fn(async () => incident({ state: 'acknowledged' })),
    listRuns: vi.fn(async () => ({ items: [] as AutomationRun[], nextCursor: null })),
    getRun: vi.fn(async (id: string) => run(id, 'rule-1')),
    undoRunEffect: vi.fn(async (id: string) => run(id, 'rule-1')),
    cancelRun: vi.fn(async (id: string) => run(id, 'rule-1', { status: 'cancelled', revision: '3' })),
    getJob: vi.fn(async (id: string) => job(id, 'succeeded')),
    retryJob: vi.fn(async (id: string) => job(id, 'ready', { revision: '5', attemptGeneration: 2 })),
    previewRunOnce: vi.fn(),
    startRunOnce: vi.fn(),
    listRunOutputs: vi.fn(async () => ({ items: [], nextCursor: null })),
    markRunRead: vi.fn(),
    listConnectionProfiles: vi.fn(async () => ({ items: [], nextCursor: null })),
    createConnectionProfile: vi.fn(),
    replaceConnectionProfile: vi.fn(),
    listTargets: vi.fn(async () => ({ items: [], nextCursor: null })),
    createTarget: vi.fn(),
    replaceTarget: vi.fn(),
    issuePairing: vi.fn(),
    revokeTarget: vi.fn(),
    decideJob: vi.fn(async (id: string) => ({ jobId: id, resultId: 'result-1', proposalDigest: 'd'.repeat(64), status: 'awaitingApproval' as const, effectReceiptIds: [], diagnostics: [] })),
    exportAutomations: vi.fn(),
  }
  return api as unknown as Mocked<AutomationApi>
}

export function fakeFolders(): FolderSource {
  return {
    listCollections: vi.fn(async () => [{ id: 'col-personal', title: 'Bookmarks' }]),
    loadFolders: vi.fn(async (collectionId: string) => collectionId === 'col-personal'
      ? {
          collectionId,
          rootId: 'root-p',
          folders: [
            { id: 'f-academic', title: 'Academic', path: 'Academic', depth: 0 },
            { id: 'f-reading', title: 'Reading', path: 'Reading', depth: 0 },
            { id: 'f-design', title: 'Design', path: 'Reading › Design', depth: 1 },
          ],
        }
      : { collectionId, rootId: 'root-w', folders: [] }),
    serverUuid: vi.fn(async () => 'server-demo'),
  }
}

export function deps(api = fakeApi(), folders = fakeFolders()): AutomationDeps & { api: ReturnType<typeof fakeApi> } {
  return { api, folders } as AutomationDeps & { api: ReturnType<typeof fakeApi> }
}

/** React-controlled inputs need the native setter, then an input event. */
export function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export function choose(element: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export function click(element: Element | null | undefined): void {
  if (!(element instanceof HTMLElement)) throw new Error('nothing to click')
  act(() => element.click())
}

export function buttonNamed(name: string | RegExp, root: ParentNode = document): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => (
    typeof name === 'string' ? button.textContent?.trim() === name : name.test(button.textContent ?? '')
  ))
}
