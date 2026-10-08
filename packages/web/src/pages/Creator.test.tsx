// @vitest-environment happy-dom
/* Creator publishing-insights boundary.
 *
 * Behaviour — the real page driven with the Product client mocked: the signed
 * out/loading/error/ready states, the DTO that paints the funnel, sparkline and
 * top resources, the Edit fallback to the owned list, the retry cadence, and
 * the identity/abort fencing of an in-flight GET. Derived values (rates, hrefs)
 * are asserted from the payload rather than from source text.
 *
 * Architecture — the exposure switch (a runtime value on the production flag
 * module) and the absence of the demo analytics surface: the 18,420 sample
 * counter, a creatorAnalytics module and the retired interface-systems slug.
 * Those numbers are absent from the page, and a fixture the driven path never
 * renders would still ship, so the module scan is the complete form.
 */
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../api/featureFlags'
import type { OwnedCollectionPage } from '../api/types'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import creatorSource from './Creator.tsx?raw'
import { Creator } from './Creator'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    isLoggedIn: false,
    bootstrapping: false,
    user: null as { accountId: string } | null,
  },
  getMyPublishingInsights: vi.fn(),
  getOwnedCollectionsPage: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getMyPublishingInsights: mocks.getMyPublishingInsights,
      getOwnedCollectionsPage: mocks.getOwnedCollectionsPage,
    },
  }
})

type InsightsDto = {
  /* The response really carries the funnel window; the generated DTO currently
     pins it to the literal 30 (product-v1.ts: "window: { days: 30 }"). Widened
     to a number here so a test can drive a server-side window change. */
  window: { days: number }
  funnel: [{ label: string; value: number }, { label: string; value: number }]
  weekly: [{ w: string; views: number }, { w: string; views: number }, { w: string; views: number }, { w: string; views: number }]
  topResources: Array<{ id: string; collectionId: string; title: string; opens: number }>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function insights(overrides: Partial<InsightsDto> = {}): InsightsDto {
  return {
    window: { days: 30 },
    funnel: [
      { label: 'Collection views', value: 42 },
      { label: 'Preview opens', value: 7 },
    ],
    weekly: [
      { w: 'W1', views: 3 },
      { w: 'W2', views: 5 },
      { w: 'W3', views: 8 },
      { w: 'W4', views: 11 },
    ],
    topResources: [{
      id: 'node-1',
      collectionId: 'col/public-1',
      title: 'Primary source',
      opens: 9,
    }],
    ...overrides,
  }
}

function ownedPage(id: string, visibility: 'public' | 'unlisted' | 'private' = 'public'): OwnedCollectionPage {
  return {
    items: [{
      collection: {
        id,
        kind: 'bookmarks',
        title: `Collection ${id}`,
        summary: null,
        visibility,
        allowSearchIndexing: false,
        publicationSlug: visibility === 'private' ? null : `slug-${id}`,
        publishedAt: visibility === 'private' ? null : '2026-08-18T00:00:00.000Z',
        rootNodeId: `root-${id}`,
        revision: 'r',
        etag: '"r"',
        contentRevision: 'c',
        contentEtag: '"c"',
        policyRevision: 'p',
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
    }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
  }
}

function signIn(accountId = 'account-a'): void {
  mocks.auth.isLoggedIn = true
  mocks.auth.bootstrapping = false
  mocks.auth.user = { accountId }
  applySessionView({
    authenticated: true,
    csrfToken: 'csrf',
    idleExpiresAt: '2026-08-19T01:00:00.000Z',
    absoluteExpiresAt: '2026-08-20T00:00:00.000Z',
  })
  applyMeView({
    account: { id: accountId, email: `${accountId}@test` },
    profile: { id: `profile-${accountId}`, handle: 'owner', displayName: 'Owner', avatarUrl: null },
  })
}

function signOut(): void {
  mocks.auth.isLoggedIn = false
  mocks.auth.bootstrapping = false
  mocks.auth.user = null
  clearSession()
}

describe('Creator publishing insights', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    signOut()
    mocks.getMyPublishingInsights.mockResolvedValue(insights())
    mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage('owned-public'))
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    clearSession()
    document.body.innerHTML = ''
  })

  function renderCreator(): void {
    const host = document.getElementById('test-root')
    if (!host) throw new Error('test root missing')
    mountTree(
        <MemoryRouter>
          <Creator />
        </MemoryRouter>,
      )
  }

  describe('creator insights behaviour', () => {
    it('shows EmptyState and a login returnTo when signed out, without demo numbers', async () => {
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(mocks.getMyPublishingInsights).not.toHaveBeenCalled()
      expect(document.querySelector('[data-testid="creator-page"]')).not.toBeNull()
      expect(document.querySelector('[role="status"]')).not.toBeNull()
      const login = document.querySelector<HTMLAnchorElement>('a[href="/login?returnTo=%2Fcreator"]')
      expect(login).not.toBeNull()
      expect(login?.className).toMatch(/\bbtn\b/)
      expect(document.body.textContent).not.toContain('18420')
      expect(document.body.textContent).not.toContain('creatorAnalytics')
      expect(document.querySelector('[data-testid="creator-stats"]')).toBeNull()
    })

    it('shows loading without demo numbers while the GET is in flight', async () => {
      signIn()
      const pending = deferred<InsightsDto>()
      /* StrictMode re-runs the mount effect, so the discarded request and the
         live one both have to stay in flight: the page is only genuinely
         "loading" while the GET the reader waits on has not settled. */
      mocks.getMyPublishingInsights.mockImplementation(() => pending.promise)
      renderCreator()
      await settled()

      expect(mocks.getMyPublishingInsights).toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('18420')
      const loading = Boolean(
        document.querySelector('[role="status"]')
        || document.body.textContent?.includes('—')
        || document.body.textContent?.toLowerCase().includes('loading'),
      )
      expect(loading).toBe(true)
      expect(document.body.textContent).not.toContain('Primary source')

      await act(async () => pending.resolve(insights()))
      await waitForDom(domFinishedLoading)
    })

    it('renders funnel, weekly, and topResources from the GET DTO and encodes the Edit collectionId', async () => {
      signIn()
      const dto = insights()
      /* Base implementation, not a one-shot queue: every mount-time GET (StrictMode
         runs the effect twice) must answer with the same DTO. */
      mocks.getMyPublishingInsights.mockResolvedValue(dto)
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(document.querySelector('[data-testid="creator-stats"]')).not.toBeNull()
      expect(document.querySelector('svg[aria-label="Weekly collection views"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="creator-insight-list"]')).not.toBeNull()
      expect(document.body.textContent).toContain(String(dto.funnel[0].value))
      expect(document.body.textContent).toContain(String(dto.funnel[1].value))
      expect(document.body.textContent).toContain(dto.weekly[0].w)
      expect(document.body.textContent).toContain(dto.weekly[3].w)
      expect(
        document.querySelector('svg[aria-label="Weekly collection views"] path[fill="none"]')?.getAttribute('d') ?? '',
      ).toMatch(/^M/)
      expect(
        [...document.querySelectorAll('ol.week-sparkline-legend li[title]')]
          .map((bar) => bar.getAttribute('title')),
      ).toEqual(dto.weekly.map((week) => `${week.views} views`))
      expect(
        [...document.querySelectorAll('ol.week-sparkline-legend li span:first-child')]
          .map((node) => node.textContent),
      ).toEqual(dto.weekly.map((week) => String(week.views)))
      expect(
        document.querySelector('svg[aria-label="Weekly collection views"]')?.innerHTML ?? '',
      ).not.toMatch(/chart-2|chart-3/)
      expect(document.body.textContent).toContain(dto.topResources[0]!.title)
      expect(document.body.textContent).toContain(`${dto.topResources[0]!.opens.toLocaleString()} opens`)
      expect(document.body.textContent).not.toContain('18420')
      expect(
        document.querySelector(`a[href="/r/node-1?collectionId=${encodeURIComponent(dto.topResources[0]!.collectionId)}&subjectType=node"]`),
      ).not.toBeNull()

      const edit = [...document.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent?.trim() === 'Edit collection')
      expect(edit?.getAttribute('href')).toBe(
        `/library/${encodeURIComponent(dto.topResources[0]!.collectionId)}?collection=edit`,
      )
      // The top bookmark's collection is not among the owned list here, so
      // the card names it by the bookmark it holds.
      expect(document.querySelector('[data-testid="creator-edit-target"]')?.textContent)
        .toBe('The collection holding Primary source')
    })

    it('names the collection the Edit button opens', async () => {
      signIn()
      mocks.getMyPublishingInsights.mockResolvedValue(insights())
      mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage('col/public-1'))
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(document.querySelector('[data-testid="creator-edit-target"]')?.textContent)
        .toBe('Collection: Collection col/public-1')
      const edit = [...document.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent?.trim() === 'Edit collection')
      expect(edit?.getAttribute('href')).toBe(`/library/${encodeURIComponent('col/public-1')}?collection=edit`)
    })

    it('offers a Collection pill when more than one published collection is owned', async () => {
      signIn()
      const first = ownedPage('col/public-1'), second = ownedPage('col-two')
      mocks.getOwnedCollectionsPage.mockResolvedValue({ ...first, items: [...first.items, ...second.items] })
      renderCreator()
      await waitForDom(domFinishedLoading)

      const select = document.querySelector<HTMLSelectElement>('[data-testid="creator-collection-select"] select')
      expect(select?.value).toBe('col/public-1')
      expect([...select!.options].map((option) => option.textContent)).toEqual(['Collection col/public-1', 'Collection col-two'])
      expect(document.querySelector('[data-testid="creator-collection-select"]')?.textContent).toContain('Collection:')
      await act(async () => {
        select!.value = 'col-two'
        select!.dispatchEvent(new Event('change', { bubbles: true }))
      })
      const edit = [...document.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent?.trim() === 'Edit collection')
      expect(edit?.getAttribute('href')).toBe('/library/col-two?collection=edit')
    })

    it('renders the window from the DTO window.days instead of a 30-day literal', async () => {
      signIn()
      /* The payload carries the funnel window, so a server-side window change
         (here 7 days) has to move both window labels. */
      const dto = insights({ window: { days: 7 } })
      mocks.getMyPublishingInsights.mockResolvedValue(dto)
      renderCreator()
      await waitForDom(domFinishedLoading)

      /* Positive anchor: the ready state really painted this DTO, so a missing
         label cannot pass by rendering the sign-in or loading branch. */
      expect(document.querySelector('[data-testid="creator-stats"]')).not.toBeNull()
      expect(document.body.textContent).toContain(String(dto.funnel[0].value))
      /* The window label rides the Collection views stat (the Audience journey
         card that repeated it is gone). */
      expect(
        [...document.querySelectorAll('p')].map((node) => node.textContent?.trim()),
      ).toContain('Last 7 days')
      expect(document.body.textContent).not.toContain('Last 30 days')

      /* The other direction: the 30-day window still reads naturally. Fresh
         mount, because mountTree reuses a live root and would keep the state. */
      cleanup()
      mocks.getMyPublishingInsights.mockResolvedValue(insights())
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(document.body.textContent).toContain('Last 30 days')
      expect(document.body.textContent).not.toContain('Last 7 days')
    })

    it('derives the preview rate and the opens total from the DTO funnel', async () => {
      signIn()
      mocks.getMyPublishingInsights.mockResolvedValue(insights({
        funnel: [
          { label: 'Collection views', value: 40 },
          { label: 'Preview opens', value: 10 },
        ],
      }))
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(document.body.textContent).toContain('25.0% of collection views')
      // Shown once, on the Preview opens stat: no duplicate funnel bars.
      expect(document.body.textContent?.match(/25\.0%/g)).toHaveLength(1)
      expect(document.body.textContent).not.toContain('NaN')
    })

    it('shows 0.0% when totalViews is 0', async () => {
      signIn()
      /* Base implementation: the zero-valued DTO answers every mount-time GET. */
      mocks.getMyPublishingInsights.mockResolvedValue(insights({
        funnel: [
          { label: 'Collection views', value: 0 },
          { label: 'Preview opens', value: 0 },
        ],
        weekly: [
          { w: 'W1', views: 0 },
          { w: 'W2', views: 0 },
          { w: 'W3', views: 0 },
          { w: 'W4', views: 0 },
        ],
        topResources: [],
      }))
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(document.body.textContent).toMatch(/0\.0%/)
      expect(document.body.textContent).not.toContain('NaN')
      expect(document.body.textContent).not.toContain('18420')
    })

    it('falls back to the latest owned public collection for Edit when topResources has no collectionId', async () => {
      signIn()
      /* No collectionId on any mount-time GET, so the owned-list fallback runs
         for each of them and answers with the same page. */
      mocks.getMyPublishingInsights.mockResolvedValue(insights({ topResources: [] }))
      mocks.getOwnedCollectionsPage.mockResolvedValue(ownedPage('owned-public'))
      renderCreator()
      await waitForDom(domFinishedLoading)

      const edit = [...document.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent?.trim() === 'Edit collection')
      expect(edit?.getAttribute('href')).toBe(`/library/${encodeURIComponent('owned-public')}?collection=edit`)
    })

    it('omits the Edit link when topResources has no collectionId and the owned list fails', async () => {
      signIn()
      mocks.getMyPublishingInsights.mockResolvedValue(insights({ topResources: [] }))
      /* Every fallback lookup fails, whichever mount-time GET triggered it. */
      mocks.getOwnedCollectionsPage.mockRejectedValue(new Error('owned list down'))
      renderCreator()
      await waitForDom(domFinishedLoading)

      const edit = [...document.querySelectorAll<HTMLAnchorElement>('a')]
        .find((link) => link.textContent?.trim() === 'Edit collection')
      expect(edit).toBeUndefined()
      expect(document.body.textContent).not.toContain('interface-systems')
    })

    it('shows EmptyState and Retry on GET reject, retries the GET, and never uses creatorAnalytics', async () => {
      signIn()
      /* Stateful, not a call queue: StrictMode re-runs the mount effect, so the
         number of mount-time GETs is not a fixed 1. The dashboard stays down
         until the test brings it back up for the Retry click. */
      let dashboardUp = false
      mocks.getMyPublishingInsights.mockImplementation(async () => {
        if (!dashboardUp) throw new Error('dashboard down')
        return insights()
      })
      renderCreator()
      await waitForDom(domFinishedLoading)

      expect(document.querySelector('[role="alert"]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('18420')
      expect(document.body.textContent).not.toContain('creatorAnalytics')
      const retry = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Try again')
      expect(retry).not.toBeUndefined()
      // Every request so far is the same request: same options, own abort signal.
      for (const call of mocks.getMyPublishingInsights.mock.calls) {
        expect(call[0]).toMatchObject({ maxRetries: 0 })
        expect(call[0]?.signal).toBeInstanceOf(AbortSignal)
      }
      const beforeRetry = mocks.getMyPublishingInsights.mock.calls.length
      // Mount issues one GET per effect run (StrictMode re-runs it once) — an
      // unbounded number here would be a refetch loop.
      expect(beforeRetry).toBeLessThanOrEqual(2)

      dashboardUp = true
      await act(async () => retry?.click())
      await waitForDom(domFinishedLoading)

      // Retry issues exactly one more GET — not a burst and not a no-op.
      expect(mocks.getMyPublishingInsights.mock.calls.length).toBe(beforeRetry + 1)
      expect(document.querySelector('[data-testid="creator-stats"]')).not.toBeNull()
      expect(document.body.textContent).toContain('42')
    })

    it('does not apply a stale GET after unmount or identity change', async () => {
      signIn('account-a')
      const first = deferred<InsightsDto>()
      const second = deferred<InsightsDto>()
      const leftover = deferred<InsightsDto>()
      /* Keyed on the scenario, not on call order: every GET the component has in
         flight before the identity change is answered by `first`, however many
         mount-time invocations StrictMode produces. */
      let phase: 'account-a' | 'account-b' | 'leftover' = 'account-a'
      mocks.getMyPublishingInsights.mockImplementation(() => (
        phase === 'account-a' ? first.promise : phase === 'account-b' ? second.promise : leftover.promise
      ))

      renderCreator()
      await settled()
      const mountSignals = mocks.getMyPublishingInsights.mock.calls
        .map((call) => call[0]?.signal as AbortSignal | undefined)
      expect(mountSignals.length).toBeGreaterThan(0)
      expect(mountSignals.every((signal) => signal instanceof AbortSignal)).toBe(true)
      const firstSignal = mountSignals[0]
      expect(firstSignal).toBeInstanceOf(AbortSignal)

      phase = 'account-b'
      const callsBeforeIdentityChange = mocks.getMyPublishingInsights.mock.calls.length
      // One GET per mount effect run (StrictMode re-runs it once) — no loop.
      expect(callsBeforeIdentityChange).toBeLessThanOrEqual(2)
      await act(async () => {
        applyMeView({
          account: { id: 'account-b', email: 'b@test' },
          profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null },
        })
        await Promise.resolve()
        await Promise.resolve()
      })
      await settled()

      // The identity change aborts every GET still in flight for the previous
      // identity and issues exactly one replacement.
      expect(firstSignal?.aborted).toBe(true)
      expect(mountSignals.every((signal) => signal?.aborted)).toBe(true)
      expect(mocks.getMyPublishingInsights.mock.calls.length).toBe(callsBeforeIdentityChange + 1)

      await act(async () => first.resolve(insights({
        funnel: [
          { label: 'Collection views', value: 111 },
          { label: 'Preview opens', value: 11 },
        ],
      })))
      await settled()
      expect(document.body.textContent).not.toContain('111')

      await act(async () => second.resolve(insights({
        funnel: [
          { label: 'Collection views', value: 222 },
          { label: 'Preview opens', value: 22 },
        ],
      })))
      await waitForDom(() => document.body.textContent?.includes('222') === true)
      expect(document.body.textContent).toContain('222')
      expect(document.body.textContent).not.toContain('111')

      // A GET still in flight when the page leaves must never paint: unmount
      // aborts it and its late resolution is dropped.
      phase = 'leftover'
      await act(async () => {
        applyMeView({
          account: { id: 'account-c', email: 'c@test' },
          profile: { id: 'profile-c', handle: 'c', displayName: 'C', avatarUrl: null },
        })
        await Promise.resolve()
        await Promise.resolve()
      })
      await waitForDom(() => mocks.getMyPublishingInsights.mock.calls.length > callsBeforeIdentityChange + 1)
      const inFlightAtUnmount = mocks.getMyPublishingInsights.mock.calls.at(-1)?.[0]?.signal as AbortSignal | undefined
      expect(inFlightAtUnmount?.aborted).toBe(false)

      act(() => {
        cleanup()
      })
      expect(inFlightAtUnmount?.aborted).toBe(true)
      await act(async () => leftover.resolve(insights({
        funnel: [
          { label: 'Collection views', value: 333 },
          { label: 'Preview opens', value: 33 },
        ],
      })))
      await settled()
      expect(document.body.textContent).not.toContain('333')
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('ships creator exposure live with the demo analytics surface absent', () => {
      /* Behavioural half: the flag the page really consults is on. */
      expect(FEATURE_FLAGS.creator).toBe(true)
      /* Architecture half: the retired demo analytics surface must not return.
         The rendered probes above only see the branches a test drives, so the
         sample counter (18,420), the creatorAnalytics module and the retired
         interface-systems slug are asserted on the page module; a fixture
         sitting in an unrendered branch would ship silently. The positive
         anchor first: a source that failed to load would pass every absence. */
      expect(creatorSource).toContain('getMyPublishingInsights')
      expect(creatorSource).not.toMatch(/demoExtras/u)
      expect(creatorSource).not.toMatch(/creatorAnalytics/u)
      expect(creatorSource).not.toMatch(/18420/u)
      expect(creatorSource).not.toMatch(/interface-systems/u)
    })
  })
})
