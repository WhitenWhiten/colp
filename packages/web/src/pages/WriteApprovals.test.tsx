// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { OwnedCollectionListItem, WriteApprovalView } from '../api/types'
import { clearRouteCache } from '../lib/routeCache'
import { WriteApprovals } from './WriteApprovals'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  enabled: true,
  getWriteApprovalPage: vi.fn(),
  getWriteApproval: vi.fn(),
  decideWriteApproval: vi.fn(),
  abandonWriteApprovalIntent: vi.fn(),
  loadOwnedCollections: vi.fn(),
  toast: vi.fn(),
  auth: {
    isLoggedIn: true,
    bootstrapping: false,
  },
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
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.toast, error: mocks.toast }),
}))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))

function LoginTarget() {
  const location = useLocation()
  return <div data-testid="login-route">{location.pathname}{location.search}</div>
}

function relativeInstant(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function owned(id: string, title: string): OwnedCollectionListItem {
  return {
    collection: {
      id, kind: 'bookmarks', title, summary: null, visibility: 'private',
      allowSearchIndexing: false, publicationSlug: null, publishedAt: null,
      rootNodeId: `${id}-root`, revision: '1', etag: '"1"', contentRevision: '1',
      contentEtag: '"1"', policyRevision: '1', policyEtag: '"1"',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: true, deleteCollection: true, managePublication: true,
      manageMembers: true, createNode: true, updateNode: true, moveNode: true,
      deleteNode: true, restoreNode: true, annotateNode: true, manageAnnotationVisibility: true,
      uploadBookmarkIcon: true,
    },
  } as OwnedCollectionListItem
}

function approvalView(overrides: Partial<WriteApprovalView> = {}): WriteApprovalView {
  return {
    planId: 'plan-1',
    status: 'pending',
    risk: 'high',
    requiresApproval: true,
    summary: 'Publish the node visibility change',
    impact: {
      collections: 1,
      nodes: 1,
      annotations: 2,
      attachments: 0,
      relations: 3,
      privateFieldsExcluded: ['sourceRef', 'creatorNote'],
    },
    requiredScopes: ['access:write', 'nodes:write'],
    target: { kind: 'node', collectionId: 'col-1', nodeId: 'node-1' },
    operations: [{
      type: 'set_visibility',
      collectionId: 'col-1',
      nodeId: 'node-1',
      visibility: 'public',
      nodeSummary: null,
    }],
    createdAt: relativeInstant(-60 * 60 * 1000),
    expiresAt: relativeInstant(60 * 60 * 1000),
    decision: 'pending',
    etag: '"approval:v1"',
    ...overrides,
  }
}

const pending = approvalView()
const approved = approvalView({
  status: 'approved',
  decision: 'approved',
  etag: '"approval:v2"',
})
const consumed = approvalView({
  planId: 'plan-consumed',
  status: 'consumed',
  decision: 'approved',
  etag: '"approval:consumed"',
})
const expired = approvalView({
  planId: 'plan-expired',
  status: 'expired',
  decision: 'expired',
  expiresAt: relativeInstant(-60 * 60 * 1000),
  etag: '"approval:expired"',
})

function byButton(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent?.trim() === name)
  if (!button) throw new Error(`missing button ${name}`)
  return button
}

describe('MCP-W08 Write approvals page', () => {

  function render(path = '/approvals') {
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/approvals" element={<WriteApprovals />} />
            <Route path="/approvals/:planId" element={<WriteApprovals />} />
            <Route path="/login" element={<LoginTarget />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    mocks.enabled = true
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [pending], nextCursor: null })
    mocks.getWriteApproval.mockResolvedValue(approved)
    mocks.loadOwnedCollections.mockResolvedValue([])
    mocks.decideWriteApproval.mockResolvedValue({
      kind: 'decided',
      planId: 'plan-1',
      decision: 'approved',
      status: 'approved',
      etag: '"approval:v2"',
    })
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps flag-off inert and does not call the Product API', async () => {
    mocks.enabled = false
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="write-approvals-flag-off"]')).not.toBeNull()
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.querySelector('a[href="/mcp"]')?.textContent).toBe('/mcp')
    expect(document.body.textContent).not.toContain('This workspace has not enabled')
    expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/hero|marketing|demo/iu)
  })

  it('maps a list 404 to the not-available empty copy', async () => {
    /* The endpoint is not available in this deployment, so every read — the
       StrictMode-discarded one and the live one — answers 404. A one-shot
       rejection would let the *live* read succeed and the copy would come from
       the discarded request's late error instead of the 404 mapping. */
    mocks.getWriteApprovalPage.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'Resource not found or not accessible',
    }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Write approvals are not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('Resource not found or not accessible')
    expect(document.body.textContent).not.toContain('Try again')
    expect(document.body.textContent).not.toContain('Retry')
  })

  it('renders summary, scopes, impact, and typed previews strictly as text', async () => {
    const attack = '<img src=x onerror=alert(1)>'
    const nodeTitle = '<script>alert(2)</script>'
    // The endpoint has one answer: every mount/effect pass must see this page.
    mocks.getWriteApprovalPage.mockResolvedValue({
      items: [approvalView({
        summary: `${attack} Review required`,
        operations: [{
          type: 'create_node',
          collectionId: 'col-1',
          nodeId: null,
          visibility: 'protected',
          nodeSummary: {
            kind: 'bookmark',
            title: nodeTitle,
            url: 'https://example.test/<svg onload=alert(3)>',
            visibility: 'protected',
          },
        }, {
          type: 'create_node',
          collectionId: 'col-1',
          nodeId: null,
          visibility: 'protected',
          nodeSummary: {
            kind: 'folder',
            title: 'Inbox',
            url: null,
            visibility: 'protected',
          },
        }, {
          type: 'create_node',
          collectionId: 'col-1',
          nodeId: null,
          visibility: 'protected',
          nodeSummary: null,
        }],
      })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('h1')?.textContent).toContain('Write approvals')
    // The title already names the page; no eyebrow repeats it.
    expect(document.querySelector('header .eyebrow')).toBeNull()
    expect(document.body.textContent).toContain(attack)
    expect(document.body.textContent).toContain(nodeTitle)
    const facts = document.querySelector('[role="table"][aria-label="Approval facts"]')
    expect(facts?.getAttribute('role')).toBe('table')
    expect([...facts!.querySelectorAll('[role="columnheader"]')].map((el) => el.textContent)).toEqual([
      'Created', 'Expires', 'Risk',
    ])
    expect([...document.querySelectorAll('[aria-label="Planned operations"] strong')].map((el) => el.textContent)).toEqual([
      'Create bookmark',
      'Create folder',
      'Create bookmark or folder',
    ])
    expect(document.body.textContent).toContain('Change library visibility')
    expect(document.body.textContent).toContain('sourceRef')
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('svg[onload]')).toBeNull()
  })

  it('leads with human-readable names and demotes opaque ids to meta code', async () => {
    mocks.loadOwnedCollections.mockResolvedValue([owned('col-1', 'Reading queue')])
    mocks.getWriteApprovalPage.mockResolvedValue({
      items: [approvalView({
        operations: [{
          type: 'create_node',
          collectionId: 'col-1',
          nodeId: 'node-9',
          visibility: 'protected',
          nodeSummary: {
            kind: 'bookmark',
            title: 'A readable bookmark',
            url: 'https://example.test/a',
            visibility: 'protected',
          },
        }],
      })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    // Scope chips lead with the permission name; the raw OAuth token stays off the card.
    expect(document.body.textContent).toContain('Change library visibility')
    expect(document.body.textContent).not.toContain('access:write')
    // Resolved ids show titles, not opaque tokens.
    expect(document.body.textContent).toContain('Reading queue')
    expect(document.body.textContent).toContain('A readable bookmark')
    expect([...document.querySelectorAll('code')].map((el) => el.textContent))
      .not.toContain('col-1')
  })

  it('approves with CSRF-aware client options and keyboard activation', async () => {
    render()
    await waitForDom(domFinishedLoading)
    const approve = byButton('Approve')
    approve.focus()
    expect(document.activeElement).toBe(approve)
    act(() => approve.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    act(() => approve.click())
    await waitForDom(domFinishedLoading)
    expect(mocks.decideWriteApproval).toHaveBeenCalledWith(
      'plan-1',
      'approve',
      '"approval:v1"',
      expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }),
    )
    expect(mocks.decideWriteApproval).toHaveBeenCalledTimes(1)
    expect(mocks.getWriteApproval).toHaveBeenCalledWith('plan-1', expect.objectContaining({ maxRetries: 0 }))
    expect(document.body.textContent).toContain('Approved')
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.trim() === 'Approve' || button.textContent?.trim() === 'Deny')).toBe(false)
  })

  it('denies a pending plan and abandons the completed intent', async () => {
    mocks.decideWriteApproval.mockResolvedValueOnce({
      kind: 'decided',
      planId: 'plan-1',
      decision: 'denied',
      status: 'cancelled',
      etag: '"approval:v2"',
    })
    mocks.getWriteApproval.mockResolvedValueOnce(approvalView({
      status: 'cancelled',
      decision: 'denied',
      etag: '"approval:v2"',
    }))
    render()
    await waitForDom(domFinishedLoading)
    act(() => byButton('Deny').click())
    await waitForDom(domFinishedLoading)
    const options = mocks.decideWriteApproval.mock.calls[0]?.[3] as { intentId: string } | undefined
    expect(mocks.decideWriteApproval).toHaveBeenCalledWith('plan-1', 'deny', '"approval:v1"', expect.anything())
    expect(mocks.decideWriteApproval).toHaveBeenCalledTimes(1)
    expect(mocks.abandonWriteApprovalIntent).toHaveBeenCalledWith(options?.intentId)
    expect(document.body.textContent).toContain('Cancelled')
  })

  it('retries an unknown outcome with the exact same decision, ETag, and intent', async () => {
    mocks.decideWriteApproval
      .mockRejectedValueOnce(new ProductApiError({
        status: 0,
        code: 'transport_error',
        message: 'unknown outcome',
        recovery: 'same_request',
        sameRequestRetrySafe: true,
      }))
      .mockResolvedValueOnce({
        kind: 'decided',
        planId: 'plan-1',
        decision: 'approved',
        status: 'approved',
        etag: '"approval:v2"',
      })
    render()
    await waitForDom(domFinishedLoading)
    act(() => byButton('Approve').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('may not have been recorded')
    expect(document.querySelector('[data-testid="login-route"]')).toBeNull()
    expect(mocks.abandonWriteApprovalIntent).not.toHaveBeenCalled()
    act(() => byButton('Retry decision').click())
    await waitForDom(domFinishedLoading)
    const first = mocks.decideWriteApproval.mock.calls[0]!
    const replay = mocks.decideWriteApproval.mock.calls[1]!
    expect(replay[1]).toBe(first[1])
    expect(replay[2]).toBe(first[2])
    expect((replay[3] as { intentId: string }).intentId).toBe((first[3] as { intentId: string }).intentId)
    expect(document.body.textContent).toContain('Approved')
  })

  it('refreshes after a precondition conflict and requires confirmation on the latest ETag', async () => {
    mocks.decideWriteApproval
      .mockRejectedValueOnce(new ProductApiError({
        status: 412,
        code: 'precondition_failed',
        message: 'Plan changed',
        recovery: 'refresh_and_retry',
        currentEtag: '"approval:v2"',
      }))
      .mockResolvedValueOnce({
        kind: 'decided',
        planId: 'plan-1',
        decision: 'approved',
        status: 'approved',
        etag: '"approval:v3"',
      })
    const updatedPending = approvalView({ etag: '"approval:v2"' })
    mocks.getWriteApproval
      .mockResolvedValueOnce(updatedPending)
      .mockResolvedValueOnce(approved)
    render()
    await waitForDom(domFinishedLoading)
    act(() => byButton('Approve').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('changed')
    expect(mocks.abandonWriteApprovalIntent).toHaveBeenCalled()
    act(() => byButton('Confirm approval with latest').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.decideWriteApproval.mock.calls[1]?.[2]).toBe('"approval:v2"')
    const firstIntent = (mocks.decideWriteApproval.mock.calls[0]?.[3] as { intentId: string }).intentId
    const confirmIntent = (mocks.decideWriteApproval.mock.calls[1]?.[3] as { intentId: string }).intentId
    expect(confirmIntent).not.toBe(firstIntent)
    expect(document.body.textContent).toContain('Approved')
  })

  it('links a blocked decision to sign-in with the current page as returnTo', async () => {
    mocks.decideWriteApproval.mockRejectedValueOnce(new ProductApiError({
      status: 422,
      code: 'validation_failed',
      message: 'Plan payload is no longer valid',
      recovery: 'user_action',
    }))
    render()
    await waitForDom(domFinishedLoading)
    act(() => byButton('Approve').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="login-route"]')).toBeNull()
    const signIn = document.querySelector<HTMLAnchorElement>('a[href^="/login"]')
    expect(signIn?.getAttribute('href')).toBe('/login?returnTo=%2Fapprovals')
  })

  it('converges after a multi-tab race when refresh shows the plan was consumed', async () => {
    mocks.decideWriteApproval.mockRejectedValueOnce(new ProductApiError({
      status: 412,
      code: 'precondition_failed',
      message: 'Plan changed',
      recovery: 'refresh_and_retry',
    }))
    mocks.getWriteApproval.mockResolvedValueOnce(consumed)
    render()
    await waitForDom(domFinishedLoading)
    act(() => byButton('Approve').click())
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Consumed')
    expect(document.body.textContent).not.toContain('Confirm approval with latest')
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.textContent?.trim() === 'Approve')).toBe(false)
  })

  it('shows expired and consumed terminal states without decision controls', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({
      items: [expired, consumed],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Expired')
    expect(document.body.textContent).toContain('Consumed')
    expect(document.body.textContent).not.toContain('Approve')
    expect(document.body.textContent).not.toContain('Deny')
  })

  it('redirects a list 401 to sign-in with an exact return path', async () => {
    /* Every read is unauthorized, so the redirect is driven by the live
       request rather than by the discarded mount pass's late error. */
    mocks.getWriteApprovalPage.mockRejectedValue(new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Sign in required',
      recovery: 'user_action',
    }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="login-route"]')?.textContent).toBe(
      '/login?returnTo=%2Fapprovals&reason=approval_required',
    )
  })

  it('loads only the requested detail and does not leak list results', async () => {
    const other = approvalView({ planId: 'plan-other', summary: 'Do not show this plan' })
    mocks.getWriteApprovalPage.mockResolvedValue({ items: [other], nextCursor: null })
    /* The detail endpoint serves the plan the reader opened, on every read. */
    mocks.getWriteApproval.mockResolvedValue(pending)
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    render('/approvals/plan-1')
    await waitForDom(domFinishedLoading)
    expect(mocks.getWriteApproval).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()
    expect(document.querySelector('[data-plan-id="plan-1"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain(other.summary)
    expect(document.body.textContent).toContain('Change library visibility')
    expect(document.body.textContent).toContain('sourceRef')
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  })

  it('redirects a detail 401 to sign-in with the detail return path', async () => {
    /* Every detail read is unauthorized, so the redirect comes from the live
       request, not from the discarded mount pass's late error. */
    mocks.getWriteApproval.mockRejectedValue(new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Sign in required',
    }))
    render('/approvals/plan-1')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="login-route"]')?.textContent).toBe(
      '/login?returnTo=%2Fapprovals%2Fplan-1&reason=approval_required',
    )
  })

  it('keeps the collection route on the list API', async () => {
    render('/approvals')
    await waitForDom(domFinishedLoading)
    expect(mocks.getWriteApprovalPage).toHaveBeenCalledWith(
      { limit: 100 },
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(mocks.getWriteApproval).not.toHaveBeenCalled()
  })

  it('waits for auth bootstrap and redirects signed-out visitors without an API request', async () => {
    mocks.auth.bootstrapping = true
    mocks.auth.isLoggedIn = false
    const { rerender } = mountTree(
      <MemoryRouter initialEntries={['/approvals/plan-1?source=mcp#review']}>
        <Routes>
          <Route path="/approvals/:planId" element={<WriteApprovals />} />
          <Route path="/login" element={<LoginTarget />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Checking your session')
    expect(mocks.getWriteApproval).not.toHaveBeenCalled()
    expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()

    mocks.auth.bootstrapping = false
    rerender(
      <MemoryRouter initialEntries={['/approvals/plan-1?source=mcp#review']}>
        <Routes>
          <Route path="/approvals/:planId" element={<WriteApprovals />} />
          <Route path="/login" element={<LoginTarget />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="login-route"]')?.textContent).toBe(
      '/login?returnTo=%2Fapprovals%2Fplan-1%3Fsource%3Dmcp%23review&reason=approval_required',
    )
    expect(mocks.getWriteApproval).not.toHaveBeenCalled()
  })

  it('shows an explicit not-found state for a missing detail', async () => {
    /* The plan does not exist, so every detail read answers 404. */
    mocks.getWriteApproval.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'Not found',
    }))
    render('/approvals/plan-missing')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Approval not found')
    expect(document.body.textContent).not.toContain('No write approvals')
    expect(document.querySelector('a[href="/approvals"]')).not.toBeNull()
  })

  it('rejects malformed detail ids without contacting the API', async () => {
    render('/approvals/bad%20plan')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid approval link')
    expect(mocks.getWriteApproval).not.toHaveBeenCalled()
    expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()
  })

  it.each([
    ['dot', `.${'a'.repeat(127)}`],
    ['underscore', `_${'b'.repeat(127)}`],
  ])('accepts a 128-character %s-prefixed detail id', async (_label, planId) => {
    // Detail mode re-fetches the plan on every effect pass; the endpoint keeps
    // returning the same plan for that id.
    mocks.getWriteApproval.mockResolvedValue(approvalView({ planId }))
    render(`/approvals/${planId}`)
    await waitForDom(domFinishedLoading)
    expect(mocks.getWriteApproval).toHaveBeenCalledWith(
      planId,
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(document.querySelector(`[data-plan-id="${planId}"]`)).not.toBeNull()
  })

  it('rejects a 129-character detail id without contacting the API', async () => {
    render(`/approvals/${'a'.repeat(129)}`)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Invalid approval link')
    expect(mocks.getWriteApproval).not.toHaveBeenCalled()
    expect(mocks.getWriteApprovalPage).not.toHaveBeenCalled()
  })

  it('abandons a decision intent and redirects only on an explicit decision 401', async () => {
    // The plan stays pending across every mount pass, so the decision control
    // under test is the one the user actually sees.
    mocks.getWriteApproval.mockResolvedValue(pending)
    mocks.decideWriteApproval.mockRejectedValueOnce(new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Session expired',
    }))
    render('/approvals/plan-1')
    await waitForDom(domFinishedLoading)
    act(() => byButton('Approve').click())
    await waitForDom(domFinishedLoading)
    const intentId = (mocks.decideWriteApproval.mock.calls[0]?.[3] as { intentId: string }).intentId
    expect(mocks.decideWriteApproval).toHaveBeenCalledTimes(1)
    expect(mocks.abandonWriteApprovalIntent).toHaveBeenCalledWith(intentId)
    expect(document.querySelector('[data-testid="login-route"]')?.textContent).toBe(
      '/login?returnTo=%2Fapprovals%2Fplan-1&reason=approval_required',
    )
  })

  it('renders collection publish without a missing bookmark row', async () => {
    mocks.getWriteApprovalPage.mockResolvedValue({
      items: [approvalView({
        summary: 'Publish this library',
        impact: {
          collections: 1,
          nodes: 0,
          annotations: 0,
          attachments: 0,
          relations: 0,
          privateFieldsExcluded: [],
        },
        target: { kind: 'collection', collectionId: 'col-1', nodeId: null },
        operations: [{
          type: 'set_visibility',
          collectionId: 'col-1',
          nodeId: null,
          visibility: 'public',
          nodeSummary: null,
        }],
      })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Publish library')
    expect(document.body.textContent).toContain('col-1')
    expect(document.body.textContent).toContain('Items')
    expect(document.body.textContent).not.toContain('Bookmark')
    expect(document.body.textContent).not.toContain('Not available')
    expect(document.body.textContent).not.toContain('Change visibility')
  })
})
