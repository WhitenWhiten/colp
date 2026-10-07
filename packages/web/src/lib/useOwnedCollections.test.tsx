// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { OwnedCollectionPage } from '../api/types'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { useOwnedCollections } from './useOwnedCollections'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ page: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, getOwnedCollectionsPage: mocks.page } }
})

function page(ids: string[], hasMore = false, nextCursor: string | null = null): OwnedCollectionPage {
  return {
    items: ids.map((id) => ({
      collection: {
        id, kind: 'bookmarks', title: `Collection ${id}`, summary: null, visibility: 'private',
        allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: `root-${id}`,
        revision: 'r', etag: '"r"', contentRevision: 'c', contentEtag: '"c"', policyRevision: 'p',
        policyEtag: '"p"', createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
      capabilities: {
        updateCollection: true, managePublication: false, createNode: true,
        updateNode: true, moveNode: true, deleteNode: true,
      },
    })),
    page: { returnedCount: ids.length, hasMore, nextCursor },
  }
}

function Harness() {
  const collections = useOwnedCollections()
  return (
    <div data-state={collections.state} data-more={String(collections.hasMore)}>
      <span data-testid="ids">{collections.items.map((item) => item.collection.id).join(',')}</span>
      <span data-testid="message">{collections.message}</span>
      <button type="button" onClick={() => void collections.loadMore()}>More</button>
      <button type="button" onClick={() => void collections.reload()}>Reload</button>
    </div>
  )
}

describe('useOwnedCollections', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z',
    })
    applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
    mocks.page.mockResolvedValue(page(['one']))
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })
  function render() { mountTree(<Harness />) }

  it('loads the first page and continues with cursor-only requests', async () => {
    /* The endpoint answers by request: an uncursored read is the first page
       (which advertises the next cursor), the cursored read is page two. */
    mocks.page.mockImplementation((request: { cursor?: string }) => (
      request.cursor === 'cursor-two'
        ? Promise.resolve(page(['two']))
        : Promise.resolve(page(['one'], true, 'cursor-two'))
    ))
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('one')
    expect(mocks.page.mock.calls[0]![0]).toEqual({ limit: 30 })
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'More')?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('one,two')
    // Loading more sends the cursor only.
    expect(mocks.page.mock.calls.at(-1)?.[0]).toEqual({ cursor: 'cursor-two' })
  })

  it('keeps confirmed rows when a later page fails', async () => {
    /* The cursored page is the failing one; the first page keeps answering. */
    mocks.page.mockImplementation((request: { cursor?: string }) => (
      request.cursor === 'cursor-two'
        ? Promise.reject(new ProductApiError({ status: 503, code: 'feature_temporarily_unavailable', message: 'down', recovery: 'same_request', sameRequestRetrySafe: true }))
        : Promise.resolve(page(['one'], true, 'cursor-two'))
    ))
    render(); await waitForDom(domFinishedLoading)
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'More')?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready')
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('one')
    expect(document.querySelector('[data-testid="message"]')?.textContent).toBe('Temporarily unavailable. Retry shortly.')
  })

  it('ignores a late first page after the account changes', async () => {
    let resolveOld: ((value: OwnedCollectionPage) => void) | undefined
    let account = 'account-a'
    /* Endpoint state: the first page of whichever account is signed in. The
       first account's read is held open so it can resolve late. */
    mocks.page.mockImplementation(() => (
      account === 'account-b'
        ? Promise.resolve(page(['account-b']))
        : new Promise<OwnedCollectionPage>((resolve) => { resolveOld = resolve })
    ))
    render(); await settled()
    const oldSignal = mocks.page.mock.calls.at(-1)![1].signal as AbortSignal
    await act(async () => {
      account = 'account-b'
      applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } })
      await Promise.resolve(); await Promise.resolve()
    })
    // The previous account's in-flight read is aborted, and the new account's
    // read paints.
    expect(oldSignal.aborted).toBe(true)
    await waitForDom(() => document.querySelector('[data-testid="ids"]')?.textContent === 'account-b')
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('account-b')
    await act(async () => { resolveOld?.(page(['account-a'])); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('account-b')
  })

  it('does not fetch private collections while signed out', async () => {
    clearSession()
    render(); await waitForDom(domFinishedLoading)
    expect(mocks.page).not.toHaveBeenCalled()
    expect(document.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready')
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('')
  })

  it('fetches after /session even before /me hydrates', async () => {
    clearSession()
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z',
    })
    render(); await waitForDom(domFinishedLoading)
    // The session alone is enough to fetch, and every read is the same first page.
    expect(mocks.page.mock.calls.length).toBeGreaterThan(0)
    expect(new Set(mocks.page.mock.calls.map((call) => JSON.stringify(call[0])))).toEqual(
      new Set([JSON.stringify({ limit: 30 })]),
    )
    const loadsBeforeHydration = mocks.page.mock.calls.length
    await act(async () => {
      applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
      await Promise.resolve(); await Promise.resolve()
    })
    // Hydrating /me does not change the private identity, so nothing is refetched.
    expect(mocks.page.mock.calls.length).toBe(loadsBeforeHydration)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('one')
  })
})
