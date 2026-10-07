// @vitest-environment happy-dom
import { act } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicProfilePage } from '../api/types'
import { Profile } from './Profile'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getPublicProfilePage: vi.fn(),
  getPublicProfileActivity: vi.fn(),
  getFollowingPage: vi.fn(),
  getFollowersPage: vi.fn(),
  isFollowingProfile: vi.fn(),
  followProfile: vi.fn(),
  unfollowProfile: vi.fn(),
  abandonFollowIntent: vi.fn(),
  auth: {
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' } as { profileId: string; handle: string } | null,
    isLoggedIn: true,
    bootstrapping: false,
  },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getPublicProfilePage: mocks.getPublicProfilePage,
      getPublicProfileActivity: mocks.getPublicProfileActivity,
      getFollowingPage: mocks.getFollowingPage,
      getFollowersPage: mocks.getFollowersPage,
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

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

function emptyFollowPage() {
  return { items: [], nextCursor: null }
}

function emptyActivityPage() {
  return { items: [] as ReturnType<typeof activityItem>[], nextCursor: null }
}

function activityItem(input: {
  activityId?: string
  collectionId?: string
  collectionTitle?: string | null
  publicationSlug?: string | null
  publishedAt?: string
  summary?: string | null
} = {}) {
  return {
    activityId: input.activityId ?? 'activity-1',
    kind: 'collection_change' as const,
    collectionId: input.collectionId ?? 'collection-1',
    collectionTitle: input.collectionTitle === undefined ? 'Systems notes' : input.collectionTitle,
    publicationSlug: input.publicationSlug === undefined ? 'systems-notes' : input.publicationSlug,
    publishedAt: input.publishedAt ?? '2026-07-24T00:00:00.000Z',
    summary: input.summary === undefined ? null : input.summary,
  }
}

function profilePage(input: {
  handle?: string
  displayName?: string
  avatarUrl?: string | null
  about?: string
  collections?: PublicProfilePage['collections']
  cursor?: string | null
  hasMore?: boolean
} = {}): PublicProfilePage {
  return {
    profile: {
      profileId: 'bbbbbbbbbbbbbbbbbbbbbA',
      handle: input.handle ?? 'mira',
      displayName: input.displayName ?? 'Mira Chen',
      avatarUrl: input.avatarUrl ?? 'https://images.example.test/mira.png',
      about: input.about ?? '',
    },
    collections: input.collections ?? [{
      id: 'collection-1',
      slug: 'systems-notes',
      title: 'Systems notes',
      summary: 'Primary sources and implementation notes.',
      kind: 'knowledge_collection',
      updatedAt: '2026-07-24T00:00:00.000Z',
    }],
    page: {
      cursor: input.cursor ?? null,
      hasMore: input.hasMore ?? false,
    },
  }
}

describe('public Profile activity tab', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    delete window.__KNOWN_FLAGS__
    vi.stubEnv('VITE_FOLLOW_ACCEPTANCE', 'true')
    mocks.auth.user = { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' }
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.isFollowingProfile.mockResolvedValue(false)
    mocks.getFollowingPage.mockResolvedValue(emptyFollowPage())
    mocks.getFollowersPage.mockResolvedValue(emptyFollowPage())
    mocks.getPublicProfileActivity.mockResolvedValue(emptyActivityPage())
    // Describe the endpoint by its input: any handle resolves to that handle's
    // public page, so both StrictMode mount attempts are served instead of a
    // call-order queue sized for one mount running dry.
    mocks.getPublicProfilePage.mockImplementation((handle: string) =>
      Promise.resolve(profilePage({ handle })))
    window.localStorage.clear()
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function renderProfile(path = '/u/mira', withHandleSwitch = false): void {
    const host = document.getElementById('test-root')
    if (!host) throw new Error('test root missing')
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          {withHandleSwitch && <Link to="/u/kai">Open Kai</Link>}
          <Routes>
            <Route path="/u/:handle" element={<Profile />} />
            <Route path="/profile/:handle" element={<Profile />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('keeps collections as the default tab and does not fetch activity until Activity is selected', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[aria-label="Profile sections"] [role="tab"][aria-selected="true"]')?.textContent).toBe('Collections')
    expect(document.querySelector('[role="list"][aria-label="Public collections"]')).not.toBeNull()
    expect(mocks.getPublicProfileActivity).not.toHaveBeenCalled()
    expect(document.querySelector('[data-profile-state="unsupported-activity"]')).toBeNull()
  })

  it('links public activity titles to encoded publication slugs', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    mocks.getPublicProfileActivity.mockResolvedValueOnce({
      items: [
        activityItem({
          activityId: 'activity-encoded',
          collectionTitle: 'Encoded systems notes',
          publicationSlug: 'notes/systems',
          collectionId: 'should-not-become-a-path',
        }),
        activityItem({
          activityId: 'activity-missing-slug',
          collectionId: 'collection-without-slug',
          collectionTitle: 'Title without a public slug',
          publicationSlug: null,
        }),
      ],
      nextCursor: null,
    })
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Activity').click())
    await waitForDom(domFinishedLoading)

    expect(mocks.getPublicProfileActivity).toHaveBeenCalledWith(
      { handle: 'mira', limit: 24 },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(document.querySelector('[data-profile-state="activity"]')).not.toBeNull()
    expect(document.querySelector('[data-profile-state="unsupported-activity"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Activity is on the way')
    const encodedHref = `/c/${encodeURIComponent('notes/systems')}`
    expect(document.querySelector<HTMLAnchorElement>(`a[href="${encodedHref}"]`)?.textContent)
      .toContain('Encoded systems notes')
    expect(document.querySelector('a[href="/c/should-not-become-a-path"]')).toBeNull()
    expect(document.querySelector('a[href="/c/collection-without-slug"]')).toBeNull()
    expect(document.body.textContent).toContain('Title without a public slug')
    // The API has one activity kind with no finer detail, so it reads as what happened.
    expect(document.body.textContent).toContain('Updated a collection')
    expect(document.body.textContent).not.toContain('Collection change')
  })

  it('shows an empty activity EmptyState instead of an on-the-way placeholder', async () => {
    const pending = deferred<ReturnType<typeof emptyActivityPage>>()
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    mocks.getPublicProfileActivity.mockReturnValueOnce(pending.promise)
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Activity').click())
    expect(document.querySelector('[data-profile-state="loading-activity"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Activity is on the way')
    expect(document.querySelector('[data-profile-state="unsupported-activity"]')).toBeNull()

    await act(async () => pending.resolve(emptyActivityPage()))
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-profile-state="empty-activity"]')?.textContent)
      .toContain('No public activity yet')
    expect(document.querySelector('[data-profile-state="empty-activity"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Activity is on the way')
    expect(document.querySelector('[data-profile-state="unsupported-activity"]')).toBeNull()
  })

  it('shows a retryable activity error without legacy-demo or fake Interface Systems copy', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    mocks.getPublicProfileActivity
      .mockRejectedValueOnce(new ProductApiError({
        status: 503,
        code: 'feature_temporarily_unavailable',
        message: 'temporarily unavailable',
      }))
      .mockResolvedValueOnce({
        items: [activityItem({ collectionTitle: 'Recovered systems notes', publicationSlug: 'recovered-notes' })],
        nextCursor: null,
      })
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Activity').click())
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-profile-state="activity-error"]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load activity")
    expect(findButtonByName('Try again').disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Activity is on the way')
    expect(document.body.textContent).not.toContain('legacy-demo')
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('Updated Interface Systems')
    expect(document.body.textContent).not.toContain('moved “Spacing as a system”')
    expect(document.querySelector('[data-profile-state="unsupported-activity"]')).toBeNull()

    await act(async () => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-profile-state="activity"]')).not.toBeNull()
    expect(document.querySelector<HTMLAnchorElement>('a[href="/c/recovered-notes"]')?.textContent)
      .toContain('Recovered systems notes')
    expect(document.body.textContent).not.toContain('legacy-demo')
    expect(document.body.textContent).not.toContain('Interface Systems')
  })

  it('appends activity from nextCursor using Load more', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    mocks.getPublicProfileActivity
      .mockResolvedValueOnce({
        items: [activityItem()],
        nextCursor: 'activity-page-2',
      })
      .mockResolvedValueOnce({
        items: [activityItem({
          activityId: 'activity-2',
          collectionId: 'collection-2',
          collectionTitle: 'Distributed systems',
          publicationSlug: 'distributed-systems',
        })],
        nextCursor: null,
      })
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Activity').click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector<HTMLAnchorElement>('a[href="/c/systems-notes"]')?.textContent)
      .toContain('Systems notes')

    await act(async () => findButtonByName('Load more').click())
    await waitForDom(domFinishedLoading)

    expect(mocks.getPublicProfileActivity).toHaveBeenLastCalledWith(
      { handle: 'mira', cursor: 'activity-page-2' },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(mocks.getPublicProfileActivity.mock.calls.at(-1)?.[0]).not.toHaveProperty('limit')
    expect(document.querySelector<HTMLAnchorElement>('a[href="/c/distributed-systems"]')?.textContent)
      .toContain('Distributed systems')
    expect(document.querySelector('a[href="/c/collection-1"]')).toBeNull()
    expect(document.querySelector('a[href="/c/collection-2"]')).toBeNull()
    expect(document.querySelectorAll('a[href^="/c/"]').length).toBeGreaterThanOrEqual(2)
  })

  it('does not render closed summary tokens as activity card body copy', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    mocks.getPublicProfileActivity.mockResolvedValueOnce({
      items: [activityItem({ summary: 'public_collection_updated' })],
      nextCursor: null,
    })
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Activity').click())
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-profile-state="activity"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Systems notes')
    expect(document.body.textContent).not.toContain('public_collection_updated')
    expect(document.querySelector('[data-testid="feed-card-body"]')).toBeNull()
  })

})
