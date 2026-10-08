// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkHealthItem } from '../api'
import { ProductApiError } from '../api/errors'
import { LibraryHealth } from './LibraryHealth'
import { clearRouteCache } from '../lib/routeCache'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  enabled: true,
  getMyLinkHealth: vi.fn(),
  enqueueMyLinkHealthChecks: vi.fn(),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLinkHealthExposureEnabled: () => mocks.enabled,
    productClient: {
      ...actual.productClient,
      getMyLinkHealth: mocks.getMyLinkHealth,
      enqueueMyLinkHealthChecks: mocks.enqueueMyLinkHealthChecks,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

function item(overrides: Partial<LinkHealthItem> = {}): LinkHealthItem {
  return {
    nodeId: 'node-1',
    collectionId: 'col-1',
    collectionTitle: 'Reading list',
    title: 'Pending bookmark',
    url: 'https://example.test/path',
    status: 'pending',
    duplicateOfNodeId: null,
    host: 'example.test',
    ...overrides,
  }
}

/* The issue filter is a "Issue: <value>" SelectMenu pill (toolbar grammar). */
function filterSelect() {
  const select = document.querySelector<HTMLSelectElement>('[data-testid="health-issue-filter"] select')
  if (!select) throw new Error('missing issue filter')
  return select
}

function filterOptions() {
  return [...filterSelect().options]
}

function chooseFilter(name: string) {
  const option = filterOptions()
    .find((node) => node.textContent?.toLowerCase().startsWith(name.toLowerCase()))
  if (!option) throw new Error(`missing filter ${name}`)
  act(() => {
    filterSelect().value = option.value
    filterSelect().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function optionLabel(option: HTMLOptionElement): string {
  return (option.textContent ?? '').replace(/\s*\(\d+\)\s*$/u, '').trim()
}

function scopeButton(name: string) {
  const group = document.querySelector('[aria-label="Link health scope"]')
  const button = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((node) => node.textContent?.trim() === name)
  if (!button) throw new Error(`missing scope ${name}`)
  return button
}

function checkAllButton() {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((node) => node.textContent?.trim() === 'Check all links')
  if (!button) throw new Error('missing Check all links')
  return button
}

describe('LibraryHealth Product wiring', () => {

  function render() {
    mountTree(
        <MemoryRouter>
          <LibraryHealth />
        </MemoryRouter>,
      )
  }

  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.enabled = true
    mocks.getMyLinkHealth.mockResolvedValue({ items: [item()], nextCursor: null })
    mocks.enqueueMyLinkHealthChecks.mockResolvedValue({ queued: 1 })
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    clearRouteCache()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('keeps flag-off inert and does not call GET or POST', async () => {
    mocks.enabled = false
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="link-health-flag-off"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Link health is not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('This workspace has not enabled')
    expect(mocks.getMyLinkHealth).not.toHaveBeenCalled()
    expect(mocks.enqueueMyLinkHealthChecks).not.toHaveBeenCalled()
  })

  it('shows loading then pending rows when exposure is on', async () => {
    let resolvePage!: (value: { items: LinkHealthItem[]; nextCursor: null }) => void
    // One pending page answers every mount attempt; resolving it is what moves
    // the page out of Loading and onto the loaded rows.
    const pendingPage = new Promise<{ items: LinkHealthItem[]; nextCursor: null }>((resolve) => {
      resolvePage = resolve
    })
    mocks.getMyLinkHealth.mockReturnValue(pendingPage)
    render()
    expect(document.querySelector('[role="status"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Loading link health')
    expect(document.querySelector('[role="alert"]')).toBeNull()

    await act(async () => {
      resolvePage({ items: [item({ title: 'Pending bookmark' })], nextCursor: null })
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(document.body.textContent).toContain('Pending bookmark')
    expect(document.body.textContent).toContain('example.test')
    expect(document.body.textContent).toContain('Reading list')
    expect(document.body.textContent).toContain('Not checked yet')
    expect(mocks.getMyLinkHealth).toHaveBeenCalledWith(
      { limit: 50 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mocks.getMyLinkHealth.mock.calls[0]?.[0]).not.toHaveProperty('scope')
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Apply suggested fixes')
    expect(document.body.textContent).not.toContain('Checking 842')
  })

  it('posts an empty checks body then refetches when Check all links is clicked', async () => {
    render()
    await waitForDom(domFinishedLoading)
    const check = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === 'Check all links')
    expect(check).toBeTruthy()
    const getsBeforeCheck = mocks.getMyLinkHealth.mock.calls.length
    act(() => check!.click())
    await waitForDom(domFinishedLoading)
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }),
    )
    expect(mocks.toast).toHaveBeenCalledWith(
      'Checking 1 link. Reload this page in a few minutes to see results.',
    )
    // One user action issues exactly one more GET (catches a refetch loop
    // without encoding StrictMode's doubled initial mount).
    expect(mocks.getMyLinkHealth.mock.calls.length).toBe(getsBeforeCheck + 1)
  })

  it('asks Product for pending status and duplicate=true from the filter row', async () => {
    render()
    await waitForDom(domFinishedLoading)
    chooseFilter('Not checked yet')
    await waitForDom(domFinishedLoading)
    expect(mocks.getMyLinkHealth).toHaveBeenLastCalledWith(
      { limit: 50, status: 'pending' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    chooseFilter('Duplicates')
    await waitForDom(domFinishedLoading)
    expect(mocks.getMyLinkHealth).toHaveBeenLastCalledWith(
      { limit: 50, duplicate: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    const filterLabels = filterOptions().map((node) => optionLabel(node))
    expect(filterLabels.some((label) => /stale/i.test(label))).toBe(false)
    expect(filterLabels).toEqual([
      'All', 'Broken', 'Redirects', 'Duplicates', 'Healthy', 'Not checked yet',
    ])
  })

  it('omits scope on the default owned list and sends shared when that scope is selected', async () => {
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.getMyLinkHealth.mock.calls[0]?.[0]).toEqual({ limit: 50 })
    expect(mocks.getMyLinkHealth.mock.calls[0]?.[0]).not.toHaveProperty('scope')
    act(() => scopeButton('Shared with me').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.getMyLinkHealth).toHaveBeenLastCalledWith(
      { limit: 50, scope: 'shared' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    chooseFilter('Not checked yet')
    await waitForDom(domFinishedLoading)
    expect(mocks.getMyLinkHealth).toHaveBeenLastCalledWith(
      { limit: 50, status: 'pending', scope: 'shared' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('posts an empty checks body for Check all while Owned is selected', async () => {
    render()
    await waitForDom(domFinishedLoading)
    act(() => checkAllButton().click())
    await waitForDom(domFinishedLoading)
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }),
    )
  })

  it('check all on shared posts only unique editor collection ids from the loaded page', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [
        item({
          nodeId: 'node-editor',
          collectionId: 'col-editor',
          membership: 'editor',
          title: 'Editor bookmark',
        }),
        item({
          nodeId: 'node-viewer',
          collectionId: 'col-viewer',
          membership: 'viewer',
          title: 'Viewer bookmark',
        }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    act(() => scopeButton('Shared with me').click())
    await waitForDom(domFinishedLoading)
    act(() => checkAllButton().click())
    await waitForDom(domFinishedLoading)
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledWith(
      { collectionId: 'col-editor' },
      expect.objectContaining({ intentId: 'link-health-checks:col-editor', maxRetries: 0 }),
    )
    expect(mocks.enqueueMyLinkHealthChecks.mock.calls.some((call) => call[0]?.collectionId === 'col-viewer')).toBe(false)
  })

  it('toasts and skips enqueue when shared has no editor rows', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [item({ nodeId: 'node-viewer', collectionId: 'col-viewer', membership: 'viewer' })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    act(() => scopeButton('Shared with me').click())
    await waitForDom(domFinishedLoading)
    const getsBeforeCheck = mocks.getMyLinkHealth.mock.calls.length
    act(() => checkAllButton().click())
    await waitForDom(domFinishedLoading)
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith('Only editors can recheck shared collections')
    expect(mocks.enqueueMyLinkHealthChecks).not.toHaveBeenCalled()
    expect(mocks.getMyLinkHealth).toHaveBeenCalledTimes(getsBeforeCheck)
  })

  it('check all on all posts owned empty body then editor collection ids only', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [
        item({ nodeId: 'node-owner', collectionId: 'col-owned', membership: 'owner' }),
        item({ nodeId: 'node-editor', collectionId: 'col-editor', membership: 'editor' }),
      ],
      nextCursor: null,
    })
    mocks.enqueueMyLinkHealthChecks
      .mockResolvedValueOnce({ queued: 2 })
      .mockResolvedValueOnce({ queued: 3 })
    render()
    await waitForDom(domFinishedLoading)
    act(() => scopeButton('All').click())
    await waitForDom(domFinishedLoading)
    act(() => checkAllButton().click())
    await waitForDom(domFinishedLoading)
    expect(mocks.toast).toHaveBeenCalledWith(
      'Checking 5 links. Reload this page in a few minutes to see results.',
    )
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenNthCalledWith(
      1,
      {},
      expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }),
    )
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenNthCalledWith(
      2,
      { collectionId: 'col-editor' },
      expect.objectContaining({ intentId: 'link-health-checks:col-editor', maxRetries: 0 }),
    )
    expect(mocks.enqueueMyLinkHealthChecks).toHaveBeenCalledTimes(2)
    expect(mocks.enqueueMyLinkHealthChecks.mock.calls.some((call) => call[0]?.collectionId === 'col-owned')).toBe(false)
  })

  it('appends membership beside the resource only for shared and all scopes', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [item({ membership: 'editor' })],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="health-resource"]')?.textContent).not.toContain('Editor')
    act(() => scopeButton('Shared with me').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="health-resource"]')?.textContent).toContain('Editor')
    act(() => scopeButton('All').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="health-resource"]')?.textContent).toContain('Editor')
    act(() => scopeButton('Owned').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="health-resource"]')?.textContent).not.toContain('Editor')
  })

  it('shows an alert EmptyState on reject and Retry reloads', async () => {
    // Server state, not a call-order queue: the outage is still up for both
    // StrictMode mount attempts and ends before the user presses Retry.
    let loadFails = true
    mocks.getMyLinkHealth.mockImplementation(() => (
      loadFails
        ? Promise.reject(new Error('network'))
        : Promise.resolve({ items: [item({ title: 'Recovered bookmark' })], nextCursor: null })
    ))
    render()
    await waitForDom(domFinishedLoading)
    const alert = document.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain("Couldn't load link health")
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((node) => node.textContent?.trim() === 'Try again')
    expect(retry).toBeTruthy()
    loadFails = false
    act(() => retry!.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Recovered bookmark')
  })

  it('sends a 401 to Sign in instead of Retry', async () => {
    // The 401 is the endpoint's answer for this session, so every mount
    // attempt sees it.
    mocks.getMyLinkHealth.mockRejectedValue(new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Sign in',
    }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Sign in to check your links')
    expect(document.querySelector('a[href^="/login"]')?.textContent).toBe('Sign in')
    expect(document.body.textContent).not.toContain('Retry')
    expect(document.body.textContent).not.toContain('Could not load link health')
  })

  it('does not treat AbortError as a load failure', async () => {
    // The live load aborts: without this, StrictMode's first (aborted) call
    // alone rejects and the test would pass on unrelated data.
    mocks.getMyLinkHealth.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Could not load link health')
  })

  it('renders live health filters and no mock maintenance copy', async () => {
    render()
    await waitForDom(domFinishedLoading)
    const filters = filterOptions().map((option) => optionLabel(option).toLowerCase())
    expect(filters).toEqual(['all', 'broken', 'redirects', 'duplicates', 'healthy', 'not checked yet'])
    expect(filters).not.toContain('stale')
    const counted = filterOptions().filter((option) => /\d/u.test(option.textContent ?? ''))
    expect(counted).toHaveLength(1)
    expect(counted[0]?.selected).toBe(true)
    expect(counted[0]?.textContent).toBe('All (1)')
    expect(mocks.getMyLinkHealth).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Apply suggested fixes')
    expect(document.body.textContent).not.toContain('Checking 842')
    expect(document.body.textContent).not.toContain('healthResourcesSeed')
    expect(document.body.textContent?.toLowerCase()).not.toContain('mock')
  })

  it('appends the next page and withholds counts until nextCursor is null', async () => {
    mocks.getMyLinkHealth.mockImplementation(async (query: { cursor?: string } = {}) => {
      if (query.cursor === 'c1') {
        return {
          items: [item({ nodeId: 'node-2', title: 'Second bookmark', status: 'healthy' })],
          nextCursor: null,
        }
      }
      return {
        items: [item({ title: 'First bookmark', status: 'pending' })],
        nextCursor: 'c1',
      }
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('First bookmark')
    expect(document.body.textContent).not.toContain('Second bookmark')
    const loadMore = findButtonByName('Load more')
    expect(loadMore.parentElement?.classList.contains('empty-state-actions')).toBe(true)
    expect(document.body.textContent).toContain('0 of the first 1 links are healthy')
    expect(document.body.textContent).not.toContain('Could not check')
    expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-label'))
      .toBe('0 of the first 1 links are healthy')
    expect(filterOptions().every((option) => !/\d/u.test(option.textContent ?? ''))).toBe(true)

    const callsBefore = mocks.getMyLinkHealth.mock.calls.length
    await act(async () => {
      loadMore.click()
    })
    await waitForDom(() => document.body.textContent?.includes('Second bookmark') === true && domFinishedLoading())
    expect(mocks.getMyLinkHealth).toHaveBeenCalledWith({ cursor: 'c1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.getMyLinkHealth.mock.calls.length).toBe(callsBefore + 1)
    expect(document.body.textContent).toContain('First bookmark')
    expect(document.querySelectorAll('[data-testid="health-resource"]')).toHaveLength(2)
    expect(document.body.textContent).not.toContain('Load more')
    expect(document.body.textContent).toContain('1 of 2 links are healthy')
    expect(document.body.textContent).toContain('Could not check')
    const counted = filterOptions().filter((option) => /\d/u.test(option.textContent ?? ''))
    expect(counted).toHaveLength(1)
    expect(counted[0]?.selected).toBe(true)
    expect(counted[0]?.textContent).toBe('All (2)')
  })

  it('drops a next page that lands after the filter changed', async () => {
    let releasePage: (() => void) | undefined
    mocks.getMyLinkHealth.mockImplementation(async (query: { cursor?: string; status?: string } = {}) => {
      if (query.cursor === 'c1') {
        await new Promise<void>((resolve) => { releasePage = resolve })
        return { items: [item({ nodeId: 'node-late', title: 'Late all-view bookmark' })], nextCursor: null }
      }
      if (query.status === 'broken') {
        return {
          items: [item({ nodeId: 'node-broken', title: 'Broken bookmark', status: 'broken', errorClass: 'http', httpStatus: 404 })],
          nextCursor: null,
        }
      }
      return { items: [item({ title: 'First bookmark' })], nextCursor: 'c1' }
    })
    render()
    await waitForDom(domFinishedLoading)
    act(() => findButtonByName('Load more').click())
    await waitForDom(() => releasePage !== undefined)
    chooseFilter('Broken')
    await waitForDom(() => document.body.textContent?.includes('Broken bookmark') === true)
    await act(async () => {
      releasePage?.()
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Broken bookmark')
    expect(document.body.textContent).not.toContain('Late all-view bookmark')
    expect(document.body.textContent).not.toContain('First bookmark')
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('reports a failed next page with an error toast', async () => {
    mocks.getMyLinkHealth.mockImplementation(async (query: { cursor?: string } = {}) => {
      if (query.cursor === 'c1') throw new ProductApiError({ status: 500, code: 'internal_error', message: 'boom' })
      return { items: [item({ title: 'First bookmark' })], nextCursor: 'c1' }
    })
    render()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      findButtonByName('Load more').click()
    })
    await waitForDom(() => mocks.error.mock.calls.length > 0)
    expect(mocks.error).toHaveBeenCalledWith('Couldn’t load more links. Try again')
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('First bookmark')
  })

  it('hides the overview on Broken and shows a number only on the chosen issue', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [
        item({
          nodeId: 'node-broken',
          title: 'Broken bookmark',
          status: 'broken',
          errorClass: 'http',
          httpStatus: 404,
        }),
        item({ nodeId: 'node-healthy', title: 'Healthy bookmark', status: 'healthy' }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    chooseFilter('Broken')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/links are healthy/u)
    expect(document.body.textContent).not.toContain('Could not check')
    expect(filterSelect().value).toBe('broken')
    const options = filterOptions()
    const active = options.find((option) => option.value === 'broken')!
    expect(optionLabel(active)).toBe('Broken')
    expect(active.textContent).toBe('Broken (2)')
    for (const option of options) {
      if (option === active) continue
      expect(option.textContent ?? '').not.toMatch(/\d/u)
    }
  })

  it('sends editable rows to the bookmark editor and names the page job', async () => {
    mocks.getMyLinkHealth.mockResolvedValue({
      items: [
        item({
          nodeId: 'node-edit',
          collectionId: 'col edit',
          title: 'Editable bookmark',
          status: 'broken',
          errorClass: 'http',
          httpStatus: 404,
          membership: 'editor',
        }),
        item({
          nodeId: 'node-view',
          collectionId: 'col-view',
          title: 'View only bookmark',
          status: 'broken',
          errorClass: 'http',
          httpStatus: 404,
          membership: 'viewer',
        }),
        item({
          nodeId: 'node-redir',
          collectionId: 'col-edit',
          title: 'Redirect bookmark',
          status: 'redirect',
          finalUrl: 'https://example.test/final',
          membership: 'owner',
        }),
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('h1')?.textContent).toBe('Link health')
    expect(document.querySelector('nav[aria-label="Breadcrumb"] a[href="/library"]')).not.toBeNull()
    expect([...document.querySelectorAll('a')].some((anchor) => anchor.textContent?.trim() === 'Back to library')).toBe(false)
    expect(checkAllButton().className).toContain('btn-primary')
    const scope = document.querySelector('[aria-label="Link health scope"]')
    expect(scope?.classList.contains('view-switch')).toBe(true)
    expect(scope?.classList.contains('health-filters')).toBe(false)
    expect([...document.querySelectorAll('dt')].map((node) => node.textContent)).toEqual([
      'Broken', 'Could not check', 'Redirects', 'Duplicates', 'Not checked yet',
    ])
    expect(document.querySelector('[class~="health-checked-label"]')?.textContent).toBe('Last checked ')

    const editRow = document.querySelector('[data-node-id="node-edit"]')
    const editTitle = editRow?.querySelector('a[href="/library/col%20edit?node=node-edit"]')
    expect(editTitle?.textContent).toBe('Editable bookmark')
    const editActions = [...(editRow?.querySelectorAll('[role="cell"]') ?? [])].at(-1)
    expect(editActions?.querySelector('a')?.textContent).toBe('Edit link')
    expect(editActions?.querySelector('a')?.className).toContain('btn-secondary')

    const viewerRow = document.querySelector('[data-node-id="node-view"]')
    expect(viewerRow?.querySelector('a')).toBeNull()
    expect(viewerRow?.textContent).toContain('View only bookmark')
    const viewerAction = [...(viewerRow?.querySelectorAll('[role="cell"]') ?? [])].at(-1)
    expect(viewerAction?.childElementCount).toBe(0)

    const redirectRow = document.querySelector('[data-node-id="node-redir"]')
    const redirectActions = [...(redirectRow?.querySelectorAll('a') ?? [])]
    const actionLinks = redirectActions.filter((anchor) => anchor.closest('[class~="health-action"]'))
    expect(actionLinks.map((anchor) => anchor.textContent?.trim())).toEqual(['Edit link', 'Open final URL'])
    expect(actionLinks[0]?.className).toContain('btn-secondary')
    expect(actionLinks[1]?.className).toContain('btn-ghost')
    expect(actionLinks[0]?.getAttribute('href')).toBe('/library/col-edit?node=node-redir')
    const shownUrl = redirectActions.find((anchor) => anchor.textContent === 'https://example.test/final')
    expect(shownUrl?.getAttribute('title')).toBe('https://example.test/final')
  })
})
