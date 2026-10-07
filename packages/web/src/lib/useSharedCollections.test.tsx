// @vitest-environment happy-dom
/* Shared-collections hook boundary.
 *
 * Behaviour — the two private list endpoints are kept apart by observing which
 * one each hook calls, the first page is limit-only, `loadMore` continues with
 * the opaque cursor alone, a failed later page keeps confirmed rows, a late
 * first page for a previous account is dropped, a signed-out desk issues no
 * read, `/me` hydration does not refetch, and a 401 becomes sign-in copy.
 * Driven by rendering the real hooks with the Product client mocked.
 *
 * Architecture — the module graph: neither hook may reach a private client
 * (product-transport / productClient / types / errors / mock-data) directly,
 * and demo fixture people must not live in the shared-collections hook at all.
 * An unused import or an unrendered literal branch changes no observable
 * behaviour, so those are asserted on module specifiers and literals.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { OwnedCollectionPage } from '../api/types'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import { useOwnedCollections } from './useOwnedCollections'
import { useSharedCollections } from './useSharedCollections'
import ownedHookSource from './useOwnedCollections.ts?raw'
import sharedHookSource from './useSharedCollections.ts?raw'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ page: vi.fn(), ownedPage: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      listSharedCollections: mocks.page,
      getOwnedCollectionsPage: mocks.ownedPage,
    },
  }
})

const DEMO_PEOPLE = /Alex Chen|Jordan Blake|Morgan Lee|Priya Shah/

function page(ids: string[], hasMore = false, nextCursor: string | null = null): OwnedCollectionPage {
  return {
    items: ids.map((id) => ({
      collection: {
        id, kind: 'bookmarks', title: `Shared ${id}`, summary: null, visibility: 'private',
        allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: `root-${id}`,
        revision: 'r', etag: '"r"', contentRevision: 'c', contentEtag: '"c"', policyRevision: 'p',
        policyEtag: '"p"', createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
      capabilities: {
        updateCollection: false, managePublication: false, createNode: true,
        updateNode: true, moveNode: true, deleteNode: true,
      },
    })),
    page: { returnedCount: ids.length, hasMore, nextCursor },
  }
}

function Harness() {
  const collections = useSharedCollections()
  return (
    <div data-state={collections.state} data-more={String(collections.hasMore)}>
      <span data-testid="ids">{collections.items.map((item) => item.collection.id).join(',')}</span>
      <span data-testid="message">{collections.message}</span>
      <button type="button" onClick={() => void collections.loadMore()}>More</button>
      <button type="button" onClick={() => void collections.reload()}>Reload</button>
    </div>
  )
}

/** The sibling owned-list hook, driven against the same two mocked endpoints. */
function OwnedHarness() {
  const collections = useOwnedCollections()
  return (
    <div data-state={collections.state}>
      <span data-testid="owned-ids">{collections.items.map((item) => item.collection.id).join(',')}</span>
      <span data-testid="owned-message">{collections.message}</span>
    </div>
  )
}

describe('useSharedCollections', () => {
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
    mocks.ownedPage.mockResolvedValue(page(['owned-one']))
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })
  function render() { mountTree(<Harness />) }

  describe('shared collections behaviour', () => {
    it('loads the first page and continues with cursor-only requests', async () => {
      /* The endpoint is described by its own input cursor, so every StrictMode
         mount read sees the same first page and only loadMore asks for page two. */
      mocks.page.mockImplementation((query: { cursor?: string }) => Promise.resolve(
        query.cursor === undefined ? page(['one'], true, 'cursor-two') : page(['two']),
      ))
      render(); await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('one')
      /* The first page is requested limit-only; StrictMode's duplicate mount read
         is the aborted one, so read the surviving call rather than calls[0]. */
      const liveFirstRead = mocks.page.mock.calls.find((call) => !(call[1]!.signal as AbortSignal).aborted)
      expect(liveFirstRead?.[0]).toEqual({ limit: 30 })
      act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'More')?.click())
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('one,two')
      expect(mocks.page.mock.calls.at(-1)?.[0]).toEqual({ cursor: 'cursor-two' })
    })

    it('keeps confirmed rows when a later page fails', async () => {
      /* Cursor-keyed endpoint: the first page always succeeds, page two always fails. */
      mocks.page.mockImplementation((query: { cursor?: string }) => (
        query.cursor === undefined
          ? Promise.resolve(page(['one'], true, 'cursor-two'))
          : Promise.reject(new ProductApiError({ status: 503, code: 'feature_temporarily_unavailable', message: 'down', recovery: 'same_request', sameRequestRetrySafe: true }))
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
      /* The list endpoint answers per signed-in account: account-a's read is held
         open so it can settle after the switch, account-b answers immediately. */
      mocks.page.mockImplementation(() => {
        if ((getSessionSnapshot().me?.account.id ?? 'anonymous') === 'account-a') {
          return new Promise<OwnedCollectionPage>((resolve) => { resolveOld = resolve })
        }
        return Promise.resolve(page(['account-b']))
      })
      render(); await settled()
      /* The held-open read really exists, so the late-resolve probe below cannot
         pass by doing nothing. */
      expect(resolveOld).toBeTypeOf('function')
      const oldSignal = mocks.page.mock.calls.at(-1)![1].signal as AbortSignal
      await act(async () => {
        applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } })
        await Promise.resolve(); await Promise.resolve()
      })
      expect(oldSignal.aborted).toBe(true)
      await waitForDom(() => document.querySelector('[data-testid="ids"]')?.textContent === 'account-b')
      expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('account-b')
      await act(async () => { resolveOld?.(page(['account-a'])); await Promise.resolve(); await Promise.resolve() })
      expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('account-b')
    })

    it('does not fetch shared collections while signed out', async () => {
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
      /* StrictMode deliberately runs the mount effect twice; the hook's cleanup
         aborts the first read, so exactly one read stays live and it is the
         limit-only first page. */
      const liveReads = mocks.page.mock.calls.filter((call) => !(call[1]!.signal as AbortSignal).aborted)
      expect(liveReads).toHaveLength(1)
      expect(liveReads[0]![0]).toEqual({ limit: 30 })
      const readsBeforeHydration = mocks.page.mock.calls.length
      await act(async () => {
        applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
        await Promise.resolve(); await Promise.resolve()
      })
      /* /me hydrating for the same private identity must not issue another read. */
      expect(mocks.page.mock.calls.length).toBe(readsBeforeHydration)
    })

    it('surfaces 401 as a sign-in message without keeping stale rows', async () => {
      /* Every read for this session is rejected with 401, as the endpoint would. */
      mocks.page.mockRejectedValue(new ProductApiError({
        status: 401, code: 'authentication_required', message: 'Sign in', recovery: 'user_action', sameRequestRetrySafe: false,
      }))
      render(); await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-state]')?.getAttribute('data-state')).toBe('error')
      expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('')
      expect(document.querySelector('[data-testid="message"]')?.textContent).toBe('Sign in to view shared collections')
    })

    it('reads the shared endpoint and never the owned one', async () => {
      /* The old text check was "the hook mentions listSharedCollections and not
         getOwnedCollectionsPage". Observing the calls is the same guarantee
         without the rename fragility: the shared sidebar must not be fed by the
         owned-list endpoint, whose rows carry owner-only capabilities. */
      render(); await waitForDom(domFinishedLoading)
      expect(mocks.page).toHaveBeenCalled()
      expect(mocks.page.mock.calls[0]?.[0]).toEqual({ limit: 30 })
      expect(mocks.ownedPage).not.toHaveBeenCalled()
    })

    it('paints only the endpoint payload, with no fixture people', async () => {
      mocks.page.mockResolvedValue(page(['shared-alpha', 'shared-beta']))
      render(); await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('shared-alpha,shared-beta')
      expect(document.body.textContent).not.toMatch(DEMO_PEOPLE)
    })
  })

  describe('owned collection behaviour', () => {
    it('reads the owned endpoint and never the shared one', async () => {
      /* The converse of the boundary above: the owned list must not be fed by
         the shared endpoint either, which is what "these two hooks are not the
         same input" means when the code actually runs. */
      mountTree(<OwnedHarness />)
      await waitForDom(() => document.querySelector('[data-testid="owned-ids"]')?.textContent === 'owned-one')
      expect(mocks.ownedPage).toHaveBeenCalled()
      expect(mocks.ownedPage.mock.calls[0]?.[0]).toEqual({ limit: 30 })
      expect(mocks.page).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toMatch(DEMO_PEOPLE)
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps both list hooks on the public api barrel', () => {
      /* An unused deep import changes no observable behaviour, and the calls
         above are identical whether the endpoint came from the barrel or from
         productClient directly — so the module graph is what has to be pinned.
         The specifier is matched, not a formatted import line, so neither
         reordering nor renaming a local binding can break this. */
      const privateClientImport = /from ['"][^'"]*api\/(?:productClient|product-client|product-transport|types|errors|mock-data)['"]/u
      expect(sharedHookSource).toMatch(/from ['"]\.\.\/api['"]/u)
      expect(ownedHookSource).toMatch(/from ['"]\.\.\/api['"]/u)
      expect(sharedHookSource).not.toMatch(privateClientImport)
      expect(ownedHookSource).not.toMatch(privateClientImport)
    })

    it('keeps demo fixture people out of the shared-collections hook', () => {
      /* The rendered probe above only sees the payload branch the test drives;
         a hardcoded sample name inside an unrendered branch would still ship.
         Asserting the module has no fixture people is the only complete form. */
      expect(sharedHookSource).not.toMatch(DEMO_PEOPLE)
      expect(ownedHookSource).not.toMatch(DEMO_PEOPLE)
    })
  })
})
