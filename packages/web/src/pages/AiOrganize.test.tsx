// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../api/featureFlags'
import { ProductApiError, type OrganizePlan } from '../api'
import { AiOrganize } from './AiOrganize'
import aiOrganizeSource from './AiOrganize.tsx?raw'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  enabled: false,
  getOwnedCollectionsPage: vi.fn(),
  createCollectionOrganizePlan: vi.fn(),
  getCollectionOrganizePlan: vi.fn(),
  applyCollectionOrganizePlan: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isAiOrganizeExposureEnabled: () => mocks.enabled,
    productClient: {
      ...actual.productClient,
      getOwnedCollectionsPage: mocks.getOwnedCollectionsPage,
      createCollectionOrganizePlan: mocks.createCollectionOrganizePlan,
      getCollectionOrganizePlan: mocks.getCollectionOrganizePlan,
      applyCollectionOrganizePlan: mocks.applyCollectionOrganizePlan,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

function ownedPage(ids: string[]) {
  return {
    items: ids.map((id) => ({
      collection: {
        id,
        kind: 'bookmarks' as const,
        title: `Collection ${id}`,
        summary: null,
        visibility: 'private' as const,
        allowSearchIndexing: false,
        publicationSlug: null,
        publishedAt: null,
        rootNodeId: `root-${id}`,
        revision: '1',
        etag: '"r"',
        contentRevision: '1',
        contentEtag: '"c"',
        policyRevision: '1',
        policyEtag: '"p"',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-18T00:00:00.000Z',
      },
      capabilities: {
        updateCollection: true,
        managePublication: true,
        createNode: true,
        updateNode: true,
        moveNode: true,
        deleteNode: true,
      },
    })),
    page: { returnedCount: ids.length, hasMore: false, nextCursor: null },
  }
}

function plan(overrides: Partial<OrganizePlan> = {}): OrganizePlan {
  return {
    planId: 'plan-1',
    etag: '"plan-etag-1"',
    expiresAt: '2026-08-24T12:00:00.000Z',
    collectionRevision: 'rev-1',
    plannerId: 'heuristic.v1.host-cluster',
    truncated: false,
    actions: [
      {
        id: 'act-1',
        sourceFolderId: 'folder-inbox',
        sourceFolderTitle: 'Inbox',
        target: { type: 'existing', folderId: 'folder-gh', title: 'GitHub' },
        nodeIds: ['n1', 'n2'],
        count: 2,
        reason: 'Same host cluster.',
        confidence: 0.8,
      },
    ],
    ...overrides,
  }
}

function applyButton() {
  return [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === 'Apply selected')
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}</p>
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the page loads owned collections through the Product client,
 *    auto-creates a plan, applies only the selected actions with the plan's
 *    If-Match etag, navigates to the library on success, and maps 404 /
 *    other-ProductApiError / AbortError onto the documented states. Driven
 *    through the real page with the client and the exposure switch mocked.
 *
 * 2. Architecture — the *absence* of mock plan data, of a direct node-move
 *    call from the browser, and of a private Product transport import. An
 *    unused import or an untaken fallback branch renders nothing, so no probe
 *    can falsify it; the scan is kept for that half and anchored on module
 *    specifiers and identifiers rather than on formatting.
 */
describe('AI organize Product wiring behaviour', () => {

  function render() {
    mountTree(
        <MemoryRouter initialEntries={['/ai/organize']}>
          <LocationProbe />
          <AiOrganize />
        </MemoryRouter>,
      )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.enabled = false
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage([]))
    mocks.createCollectionOrganizePlan.mockResolvedValue(plan())
    mocks.getCollectionOrganizePlan.mockResolvedValue(plan())
    mocks.applyCollectionOrganizePlan.mockResolvedValue({
      planId: 'plan-1',
      appliedActionIds: ['act-1'],
      createdFolderIds: [],
      movedNodeIds: ['n1', 'n2'],
    })
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps production FEATURE_FLAGS.aiOrganize true', () => {
    expect(FEATURE_FLAGS.aiOrganize).toBe(true)
  })

  it('keeps flag-off EmptyState and does not render a mock plan', async () => {
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ai-organize-flag-off"]')).not.toBeNull()
    expect(document.body.textContent).toContain('AI organize is not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('This workspace has not enabled')
    expect(document.querySelector('[data-testid="ai-plan-row"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain('Systems theory')
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.getOwnedCollectionsPage).not.toHaveBeenCalled()
    expect(mocks.createCollectionOrganizePlan).not.toHaveBeenCalled()
    expect(mocks.getCollectionOrganizePlan).not.toHaveBeenCalled()
    expect(mocks.applyCollectionOrganizePlan).not.toHaveBeenCalled()
  })


  it('renders an honest empty list when exposure is on and no owned collections exist', async () => {
    mocks.enabled = true
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ai-organize-flag-off"]')).toBeNull()
    expect(document.body.textContent).toContain('Organize messy folders')
    expect(document.body.textContent).toContain('No collections yet')
    expect(document.querySelector('[data-testid="ai-plan-list"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain('Unsorted (12)')
    expect(applyButton()).toBeUndefined()
    expect(mocks.getOwnedCollectionsPage).toHaveBeenCalled()
    expect(mocks.createCollectionOrganizePlan).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps the apply row hidden until a collection is selected', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1', 'col-2']))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Select a collection')
    expect(applyButton()).toBeUndefined()
    expect(document.querySelector('a[href="/classify"]')).toBeNull()
    expect(mocks.createCollectionOrganizePlan).not.toHaveBeenCalled()
    // The collection pick is a "Collection:" pill, not a chip row.
    const pick = document.querySelector<HTMLSelectElement>('[data-testid="ai-collection-pick"] select')!
    expect(document.querySelector('[data-testid="ai-collection-pick"]')?.textContent).toContain('Collection:')
    expect(pick.value).toBe('')
    await act(async () => {
      pick.value = 'col-2'
      pick.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitForDom(() => mocks.createCollectionOrganizePlan.mock.calls.length > 0)
    expect(mocks.createCollectionOrganizePlan.mock.calls[0]?.[0]).toBe('col-2')
  })

  it('auto-creates a plan for a single owned collection and renders live actions', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.getOwnedCollectionsPage).toHaveBeenCalled()
    expect(mocks.createCollectionOrganizePlan).toHaveBeenCalledWith(
      'col-1',
      {},
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    expect(mocks.createCollectionOrganizePlan.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(mocks.getOwnedCollectionsPage.mock.invocationCallOrder[0]!)
    const rows = document.querySelectorAll('[data-testid="ai-plan-row"]')
    expect(rows).toHaveLength(1)
    /* The check mark span is the row's only <span> (the body is div > strong + p). */
    expect(rows[0]?.querySelector('span')).not.toBeNull()
    expect(rows[0]?.textContent).toContain('Inbox')
    expect(rows[0]?.textContent).toContain('GitHub')
    expect(rows[0]?.textContent).toContain('2')
    expect(rows[0]?.textContent).toContain('Same host cluster.')
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain('Systems theory')
    expect(applyButton()?.disabled).toBe(false)
  })

  it('applies selected actions with If-Match and navigates to the library', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    render()
    await waitForDom(domFinishedLoading)
    const apply = applyButton()
    expect(apply?.disabled).toBe(false)
    act(() => apply!.click())
    await waitForDom(domFinishedLoading)
    const confirmBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Apply')
    expect(confirmBtn).toBeTruthy()
    act(() => confirmBtn!.click())
    await waitForDom(domFinishedLoading)
    expect(mocks.applyCollectionOrganizePlan).toHaveBeenCalledWith(
      'col-1',
      'plan-1',
      { actionIds: ['act-1'] },
      expect.objectContaining({ ifMatch: '"plan-etag-1"' }),
    )
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-1')
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.success).toHaveBeenCalledTimes(1)
    expect(mocks.success).toHaveBeenCalledWith('Organized 2 bookmarks')
  })

  it('prompts for confirmation before applying and does not apply if cancelled', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    render()
    await waitForDom(domFinishedLoading)
    const apply = applyButton()
    act(() => apply!.click())
    await waitForDom(domFinishedLoading)
    const cancelBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Cancel')
    expect(cancelBtn).toBeTruthy()
    act(() => cancelBtn!.click())
    await waitForDom(domFinishedLoading)
    expect(mocks.applyCollectionOrganizePlan).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(1)
  })

  it('preserves plan and selected actions on apply failure and shows error in-place', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    mocks.applyCollectionOrganizePlan.mockRejectedValueOnce(
      new ProductApiError({ status: 500, code: 'internal_error', message: 'Failed to apply' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    const apply = applyButton()
    act(() => apply!.click())
    await waitForDom(domFinishedLoading)
    const confirmBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Apply')
    act(() => confirmBtn!.click())
    await waitForDom(domFinishedLoading)

    // Plan and rows are NOT wiped out
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(1)
    const row = document.querySelector<HTMLButtonElement>('[data-testid="ai-plan-row"]')
    expect(row?.getAttribute('aria-checked')).toBe('true')
    // Error is displayed in place (role="alert")
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not apply the organize plan')
    // Route error state is NOT shown
    expect(document.body.textContent).not.toContain("Couldn't load an organize plan")

    // Retry applying works without losing selections
    act(() => applyButton()!.click())
    await waitForDom(domFinishedLoading)
    const retryConfirmBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((btn) => btn.textContent?.trim() === 'Apply')
    act(() => retryConfirmBtn!.click())
    await waitForDom(domFinishedLoading)
    expect(mocks.applyCollectionOrganizePlan).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-1')
  })

  it('disables Apply when no actions are selected', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    render()
    await waitForDom(domFinishedLoading)
    const row = document.querySelector<HTMLButtonElement>('[data-testid="ai-plan-row"]')
    expect(row?.getAttribute('aria-checked')).toBe('true')
    act(() => row!.click())
    await waitForDom(domFinishedLoading)
    expect(row?.getAttribute('aria-checked')).toBe('false')
    expect(applyButton()?.disabled).toBe(true)
    expect(mocks.applyCollectionOrganizePlan).not.toHaveBeenCalled()
  })

  it('shows the not-available state when create returns 404 resource_not_found and keeps mock rows out', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    mocks.createCollectionOrganizePlan.mockRejectedValueOnce(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not found' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ai-organize-flag-off"]')).toBeNull()
    expect(document.body.textContent).toMatch(/not available yet/i)
    expect(document.body.textContent).not.toContain('尚未开放')
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain('Systems theory')
    expect(mocks.applyCollectionOrganizePlan).not.toHaveBeenCalled()
  })

  it('clears the action list on other ProductApiError and offers a working Retry', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    mocks.createCollectionOrganizePlan.mockRejectedValueOnce(
      new ProductApiError({ status: 500, code: 'internal_error', message: 'boom' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(0)
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain('Systems theory')
    expect(document.body.textContent).not.toMatch(/尚未开放/)

    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === 'Try again')
    expect(retry).toBeTruthy()
    act(() => retry!.click())
    await waitForDom(domFinishedLoading)
    expect(mocks.createCollectionOrganizePlan).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(1)
  })

  it('ignores AbortError on load without an error banner or mock plan', async () => {
    mocks.enabled = true
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage(['col-1']))
    mocks.createCollectionOrganizePlan.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelectorAll('[data-testid="ai-plan-row"]')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Design systems')
    expect(document.body.textContent).not.toContain("Couldn't load")
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps mock plan data, node mutations and a private Product client out of the page', () => {
    /* The reachable half is proven behaviourally above: every client call
       lands on the `../api` barrel mock, `isProductApiError` decides the
       documented 404 / error / abort branches, and no node-mutation call is
       ever made (the exact apply argument lists are asserted). The
       unreachable half is what a render cannot show: an *unused* mock plan
       import, `mockOrLive`, or a hand-rolled transport changes nothing until
       the branch using it is taken. Anchored on module specifiers and
       identifiers so a rename of an unrelated symbol cannot break it. */
    expect(aiOrganizeSource.length).toBeGreaterThan(8_000)
    expect(aiOrganizeSource).toMatch(/from '\.\.\/api'/)
    expect(aiOrganizeSource).not.toContain('aiOrganizePlan')
    expect(aiOrganizeSource).not.toContain('legacyAiOrganizePlan')
    expect(aiOrganizeSource).not.toContain('mockOrLive')
    expect(aiOrganizeSource).not.toContain('createCollectionNode')
    expect(aiOrganizeSource).not.toContain('moveCollectionNode')
    expect(aiOrganizeSource).not.toMatch(
      /from ['"]\.\.\/api\/(?:productClient|product-client|product-transport|types|errors|mock-data)['"]/,
    )
  })
})
