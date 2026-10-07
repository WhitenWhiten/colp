// @vitest-environment happy-dom
/* MCP-W08 write approval frontend boundary.
 *
 * Behaviour: the page's data hook is driven with the client mocked, so the
 * load path is observed as calls — the list read on the list route, the
 * single-plan read on the detail route, the plan-id guard rejecting an
 * unrouteable id before any request, and the signed-out resumption redirect
 * carrying the guarded return path and the approval reason. A rename or file
 * split inside pages/write-approvals/ cannot move any of these.
 *
 * Architecture: the remaining claims are absences and wiring — the page must
 * not import mock/legacy data or inject raw markup, the route and nav entry
 * must exist in the shell, and the acceptance-override env keys cannot be
 * observed while the live flag short-circuits them. Those are asserted on
 * module specifiers, route literals and named symbols.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProductWriteApprovalClient,
  type WriteApprovalPage,
  type WriteApprovalView,
} from '@known/product-v1-client'
import { clearRouteCache } from '../lib/routeCache'
import { useWriteApprovals } from '../pages/write-approvals/data'
import apiIndexSource from './index.ts?raw'
import featureFlagsSource from './featureFlags.ts?raw'
import { isReadableReplicaExposureEnabled, isWriteApprovalsExposureEnabled } from './featureFlags'
import productClientSource from './productClient.ts?raw'
import transportSource from './product-transport.ts?raw'

const clientDomainSources = Object.values(import.meta.glob('./product-client-*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const transportDomainSources = Object.values(import.meta.glob('./product-transport*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const clientSources = [productClientSource, ...clientDomainSources].join('\n')
const transportSources = [transportSource, ...transportDomainSources].join('\n')
import typesSource from './types.ts?raw'
import appSource from '../App.tsx?raw'
import topNavSource from '../components/TopNav.tsx?raw'
import loginSource from '../pages/Login.tsx?raw'
import loginReasonSource from '../pages/loginReason.ts?raw'
import pageSource from '../pages/WriteApprovals.tsx?raw'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { LOGIN_REASON_APPROVAL_REQUIRED, loginReasonMessage } from '../pages/loginReason'
import { getOrCreateCommandId } from './commandId'
import {
  createMemorySessionStorage, installFetchMock, installSessionStorage, jsonResponse,
  requestHeaders, requestMethod, requestPathAndSearch, resetProductSession, seedAuthenticatedSession,
} from './test-helpers'

const mocks = vi.hoisted(() => ({
  enabled: true,
  auth: { isLoggedIn: true, bootstrapping: false },
  getWriteApprovalPage: vi.fn(),
  getWriteApproval: vi.fn(),
  decideWriteApproval: vi.fn(),
  abandonWriteApprovalIntent: vi.fn(),
  loadOwnedCollections: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isWriteApprovalsExposureEnabled: () => mocks.enabled,
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
vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.toast, error: mocks.toast }),
}))

/* Split surfaces: the nav shell keeps its account links in topnav/, and the
   page keeps its data/view in write-approvals/ — the boundary holds over the
   whole reachable surface, not the entry file's text. */
const topNavSurface = [
  topNavSource,
  ...Object.values(
    import.meta.glob(
      ['../components/topnav/*.{ts,tsx}', '!../components/topnav/*.test.*'],
      { eager: true, import: 'default', query: '?raw' },
    ),
  ),
].join('\n') as string

const pageSurface = [
  pageSource,
  ...Object.values(
    import.meta.glob(
      ['../pages/write-approvals/*.{ts,tsx}', '!../pages/write-approvals/**/*.test.*'],
      { eager: true, import: 'default', query: '?raw' },
    ),
  ),
].join('\n') as string

function approvalView(overrides: Partial<WriteApprovalView> = {}): WriteApprovalView {
  return {
    planId: 'plan-1',
    status: 'pending',
    risk: 'high',
    requiresApproval: true,
    summary: 'Review MCP write',
    impact: {
      collections: 1,
      nodes: 1,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    },
    requiredScopes: ['access:write'],
    target: { kind: 'node', collectionId: 'col-1', nodeId: 'node-1' },
    operations: [],
    createdAt: '2026-08-06T00:00:00.000Z',
    expiresAt: '2026-08-07T00:00:00.000Z',
    decision: 'pending',
    etag: '"approval:v1"',
    ...overrides,
  }
}

function LoginTarget() {
  const location = useLocation()
  return createElement('div', { 'data-testid': 'login-route' }, `${location.pathname}${location.search}`)
}

describe('MCP-W08 write approval frontend boundary', () => {
  let current!: ReturnType<typeof useWriteApprovals>

  function Probe() {
    current = useWriteApprovals()
    return null
  }
  function render(route: string) {
    mountTree(createElement(
      MemoryRouter,
      { initialEntries: [route] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/approvals/:planId?', element: createElement(Probe) }),
        createElement(Route, { path: '/login', element: createElement(LoginTarget) }),
      ),
    ))
  }
  const loaded = () => current != null && current.loading === false

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    mocks.enabled = true
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [approvalView()], nextCursor: null })
    mocks.getWriteApproval.mockImplementation((planId: string) => Promise.resolve(approvalView({ planId })))
    mocks.loadOwnedCollections.mockResolvedValue([])
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  describe('useWriteApprovals behaviour', () => {
    it('loads the queue through the canonical client', async () => {
      render('/approvals')
      await waitForDom(loaded)
      expect(mocks.getWriteApprovalPage).toHaveBeenCalledWith(
        { limit: 100 },
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(mocks.getWriteApproval).not.toHaveBeenCalled()
      expect(current.approvals.map((item) => item.planId)).toEqual(['plan-1'])
    })

    it('loads a single plan by its route id through the canonical client', async () => {
      render('/approvals/plan-1')
      await waitForDom(loaded)
      expect(mocks.getWriteApproval).toHaveBeenCalledWith('plan-1', expect.objectContaining({ maxRetries: 0 }))
      expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()
      expect(current.detailMode).toBe(true)
      expect(current.invalidPlanId).toBe(false)
      expect(current.approvals.map((item) => item.planId)).toEqual(['plan-1'])
    })

    it('rejects a plan id outside the path contract before issuing any request', async () => {
      render('/approvals/plan%20id')
      await waitForDom(loaded)
      expect(current.invalidPlanId).toBe(true)
      expect(mocks.getWriteApproval).not.toHaveBeenCalled()
      expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()
    })

    it('resumes sign-in from a signed-out plan link with the guarded return path and reason', async () => {
      mocks.auth.isLoggedIn = false
      render('/approvals/plan-1')
      await waitForDom(() => document.querySelector('[data-testid="login-route"]') !== null)
      const target = document.querySelector('[data-testid="login-route"]')!.textContent ?? ''
      expect(target.startsWith('/login?')).toBe(true)
      const params = new URLSearchParams(target.slice('/login?'.length))
      expect(params.get('reason')).toBe(LOGIN_REASON_APPROVAL_REQUIRED)
      expect(params.get('returnTo')).toBe('/approvals/plan-1')
      expect(mocks.getWriteApproval).not.toHaveBeenCalled()
    })
    it('decides through the real canonical client on the generated decision route', async () => {
      /* This suite mocks the api barrel for the hook probes above, so the
         decision bridge is exercised through `importActual`: the real client,
         the real transport, a mocked socket. */
      const actualApi = await vi.importActual<typeof import('../api')>('../api')
      const restoreStorage = installSessionStorage(createMemorySessionStorage())
      resetProductSession()
      seedAuthenticatedSession('csrf-decision')
      const mock = installFetchMock(() => jsonResponse({
        kind: 'decided', planId: 'plan-1', decision: 'approved', status: 'approved', etag: '"approval:v2"',
      }, { headers: { ETag: '"approval:v2"' } }))
      try {
        const result = await actualApi.productClient.decideWriteApproval(
          'plan-1', 'approve', '"approval:v1"', { intentId: 'write-approval:plan-1:approve', maxRetries: 0 },
        )
        expect(result.decision).toBe('approved')
        expect(requestMethod(mock.calls[0]!)).toBe('POST')
        expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/mcp/approvals/plan-1/decision')
        expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ decision: 'approve' })
        expect(requestHeaders(mock.calls[0]!).get('if-match')).toBe('"approval:v1"')
        expect(requestHeaders(mock.calls[0]!).get('x-csrf-token')).toBe('csrf-decision')
      } finally {
        mock.restore()
        resetProductSession()
        restoreStorage()
      }
    })

    it('releases a retained decision intent so the next action allocates a new command id', async () => {
      /* The other probes mock the api barrel; this one runs the real client so
         the abandon operation is observed through its real effect: it releases
         the intent's stored command id. */
      const actualApi = await vi.importActual<typeof import('../api')>('../api')
      const restoreStorage = installSessionStorage(createMemorySessionStorage())
      resetProductSession()
      seedAuthenticatedSession('csrf-abandon')
      try {
        const intentId = 'write-approval:plan-1:approve:abandon-probe'
        const first = getOrCreateCommandId(intentId)
        /* Re-reading the same intent reuses the command id (idempotent retry)… */
        expect(getOrCreateCommandId(intentId)).toBe(first)
        /* …and abandoning it releases the allocation, so a fresh action cannot
           replay a command the server already saw. */
        actualApi.productClient.abandonWriteApprovalIntent(intentId)
        const second = getOrCreateCommandId(intentId)
        expect(second).not.toBe(first)
      } finally {
        resetProductSession()
        restoreStorage()
      }
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('uses the W07 generated client and contract types without copied fetch DTOs', () => {
      /* Type-level: the contract types come from the generated runtime. */
      expect(typeof createProductWriteApprovalClient).toBe('function')
      const page: WriteApprovalPage = { items: [], nextCursor: null }
      expect(page.items).toEqual([])
      expect(transportSources).toContain('createProductWriteApprovalClient')
      expect(typesSource).toMatch(/export type WriteApprovalView = Schemas\['WriteApprovalView'\]/u)
      /* The approval route is spelled only by the generated runtime. */
      expect(clientSources).not.toMatch(/['"`]\/api\/v1\/mcp\/approvals/u)
      expect(clientSources).not.toMatch(/\bfetch\s*\([^\n]*api\/v1\/mcp\/approvals/u)
      /* …and the contract types are re-exported from the api barrel. */
      expect(apiIndexSource).toMatch(/\bWriteApprovalView\b/u)
      expect(apiIndexSource).toMatch(/\bWriteApprovalDecisionResult\b/u)
    })

    it('keeps write approval exposure live with an acceptance override', () => {
      expect(isWriteApprovalsExposureEnabled()).toBe(true)
      /* The VITE_* override short-circuits behind the live flag, so no run can
         observe it from outside; assert the wiring by name. */
      expect(featureFlagsSource).toContain('isWriteApprovalsExposureEnabled')
      expect(featureFlagsSource).toContain('VITE_WRITE_APPROVALS_ACCEPTANCE')
    })

    it('keeps readable replica exposure off by default with an acceptance override', () => {
      expect(isReadableReplicaExposureEnabled()).toBe(false)
      expect(featureFlagsSource).toContain('isReadableReplicaExposureEnabled')
      expect(featureFlagsSource).toContain('VITE_READABLE_REPLICA_ACCEPTANCE')
    })

    it('routes the page and exposes account navigation only from the app shell', () => {
      expect(appSource).toMatch(/path="approvals\/:planId"/u)
      expect(topNavSurface).toMatch(/\bisWriteApprovalsExposureEnabled\b/u)
      expect(topNavSurface).toMatch(/['"`]\/approvals/u)
    })

    it('keeps approval sign-in resumption on guarded return and reason values', () => {
      /* The reason token has a message, and nothing outside the allow-list can
         create sign-in feedback. */
      expect(loginReasonMessage(LOGIN_REASON_APPROVAL_REQUIRED)).toBe(
        'Please sign in before authorizing this MCP change.',
      )
      expect(loginReasonMessage('something_else')).toBeNull()
      /* Login consumes the guarded return path and the reason mapping. */
      expect(loginSource).toMatch(/\bsafeReturnTo\b/u)
      expect(loginSource).toMatch(/\bloginReasonMessage\b/u)
      expect(loginReasonSource).toMatch(/LOGIN_REASON_APPROVAL_REQUIRED = 'approval_required'/u)
      expect(loginReasonSource).toMatch(/\bLOGIN_REASON_MESSAGES\b/u)
      expect(loginReasonSource).not.toMatch(/\breturn\s+raw\b/iu)
    })

    it('keeps untrusted approval content out of executable markup and demo data', () => {
      expect(pageSurface).toMatch(/from ['"](?:\.\.\/)+api['"]/u)
      /* The plan id path contract mirrors the backend route. */
      expect(pageSurface).toMatch(/PLAN_ID_PATTERN = \/\^\[A-Za-z0-9\._~-\]\{1,128\}\$\/u/u)
      expect(pageSurface).toMatch(/\bLOGIN_REASON_APPROVAL_REQUIRED\b/u)
      expect(pageSurface).not.toMatch(/dangerouslySetInnerHTML|innerHTML|document\.write/u)
      expect(pageSurface).not.toMatch(/from ['"][^'"]*(?:legacy-demo|mock-data)[^'"]*['"]/u)
      expect(pageSurface).toMatch(/\brequiredScopes\b/u)
      expect(pageSurface).toMatch(/\bprivateFieldsExcluded\b/u)
    })

    it('keeps generated types source-derived instead of copied in the web tree', () => {
      const generated = readFileSync(resolve('src/generated/product-v1.ts'), 'utf8')
      expect(generated).toMatch(/from\s+'@known\/product-v1'/u)
    })
  })
})
