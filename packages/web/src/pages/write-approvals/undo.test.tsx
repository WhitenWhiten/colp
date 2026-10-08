// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applySessionView, clearSession } from '../../api/sessionStore'
import type { WriteApprovalView } from '../../api/types'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../../test/render'
import { WriteApprovals } from '../WriteApprovals'

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  owned: vi.fn(),
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getWriteApprovalPage: mocks.page,
      getWriteApproval: mocks.page,
      loadOwnedCollections: mocks.owned,
    },
  }
})
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: true, bootstrapping: false }),
}))

function approval(approvedBy: string | null): WriteApprovalView & { approvedBy: string | null } {
  return {
    planId: 'plan-policy',
    status: 'consumed',
    risk: 'low',
    requiresApproval: false,
    summary: 'Move three bookmarks',
    impact: {
      collections: 1,
      nodes: 3,
      annotations: 0,
      attachments: 0,
      relations: 0,
      privateFieldsExcluded: [],
    },
    requiredScopes: ['nodes:write'],
    target: { kind: 'collection', collectionId: 'col-1', nodeId: null },
    operations: [],
    createdAt: '2026-10-03T00:00:00.000Z',
    expiresAt: '2026-10-04T00:00:00.000Z',
    decision: 'approved',
    etag: '"approval:policy"',
    approvedBy,
  }
}

describe('approvals Undo', () => {
  beforeEach(() => {
    mocks.owned.mockResolvedValue([])
    mocks.page.mockResolvedValue({ items: [approval('policy')], nextCursor: null })
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-undo-page',
      idleExpiresAt: '2099-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    clearSession()
    vi.clearAllMocks()
  })

  it('shows approvedBy and undoes a policy-approved plan', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('force=true')) {
        return new Response(JSON.stringify({
          planId: 'plan-policy',
          versionId: 'ver-9',
          restored: true,
          noop: false,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        error: {
          code: 'mutation_conflict',
          message: 'A newer collection version exists.',
          recovery: 'refresh_and_retry',
        },
      }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchImpl)

    mountTree(<WriteApprovals />, { initialEntries: ['/approvals'] })
    await waitForDom(() => document.body.textContent?.includes('approvedBy: policy') === true)
    expect(document.querySelector('[data-testid="approval-undo"]')?.textContent).toBe('Undo')

    act(() => findButtonByName('Undo').click())
    await waitForDom(() => document.body.textContent?.includes('A newer collection version exists.') === true)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('/api/v1/mcp/approvals/plan-policy/undo')

    act(() => findButtonByName('Undo anyway').click())
    await waitForDom(() => String(fetchImpl.mock.calls.at(-1)?.[0]).includes('force=true'))
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-undo-page')
  })

  it('does not offer Undo when the plan was not approved by policy', async () => {
    mocks.page.mockResolvedValue({ items: [approval(null)], nextCursor: null })
    mountTree(<WriteApprovals />, { initialEntries: ['/approvals'] })
    await waitForDom(() => document.body.textContent?.includes('approvedBy: —') === true)
    expect(document.querySelector('[data-testid="approval-undo"]')).toBeNull()
  })
})
