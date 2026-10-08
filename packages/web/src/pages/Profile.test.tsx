// @vitest-environment happy-dom
import { act } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import { ProductApiError } from '../api/errors'
import type { PublicProfilePage } from '../api/types'
import { Profile } from './Profile'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, settled, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

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
  return { items: [], nextCursor: null }
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

describe('public Profile page', () => {

  beforeEach(() => {
    clearRouteCache()
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

  it('restores the original profile composition around generated public DTO fields', async () => {
    installPageMetaBaseline()
    mocks.getPublicProfilePage.mockResolvedValue(profilePage({
      handle: 'very_long_handle_that_must_wrap_without_changing_the_contract',
      displayName: '<script>Unsafe display name</script>',
      collections: [{
        id: 'collection-public',
        slug: 'public-reading-path',
        title: '<img src=x onerror=alert(1)>',
        summary: 'A long summary rendered as text, never as markup.',
        kind: 'reading_path',
        updatedAt: '2026-07-24T00:00:00.000Z',
      }],
    }))

    renderProfile('/profile/very_long_handle_that_must_wrap_without_changing_the_contract')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('h1')?.textContent).toBe('<script>Unsafe display name</script>')
    // R15-11: the profile masthead carries a report path.
    expect(document.querySelector('[data-testid="report-profile"]')?.textContent).toBe('Report')
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(document.querySelector('[data-testid="public-profile-page"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Profile display mode"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="profile-hero"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"][aria-label="Profile sections"]')).not.toBeNull()
    expect(document.querySelector('[role="list"][aria-label="Public collections"]')).not.toBeNull()
    const list = document.querySelector('[aria-label="Public collections"]')
    expect(list?.getAttribute('role')).toBe('list')
    const link = document.querySelector<HTMLAnchorElement>('a[href="/c/public-reading-path"]')
    expect(link?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(document.body.textContent).toContain('Followers')
    expect(document.body.textContent).toContain('Following')
    expect(document.body.textContent).toContain('Activity')
    expect(document.querySelector('[data-profile-field="bio"]')).toBeNull()
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('0')
    expect(document.querySelector('[data-profile-field="following"]')?.textContent).toBe('0')
    expect(findButtonByName('Follow').disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Systems researcher')
    expect(pageMetaContent('meta[name="description"]')).toBe('1 public collection on Know-N')
    expect(canonicalHref()).toBe('https://know-n.com/u/very_long_handle_that_must_wrap_without_changing_the_contract')
  })

  it('projects a stored about onto the public hero and journal without interpreting markup', async () => {
    installPageMetaBaseline()
    const rawAbout = `<script>I collect\u0000 bookmarks.</script>\n ${'x'.repeat(600)}`
    mocks.getPublicProfilePage.mockResolvedValue(profilePage({
      about: rawAbout,
    }))
    renderProfile()
    await waitForDom(domFinishedLoading)

    const heroBio = document.querySelector('[data-testid="profile-hero"] [data-profile-field="bio"]')
    expect(heroBio?.textContent).toBe(rawAbout)
    expect(document.querySelector('[data-testid="profile-hero"] script')).toBeNull()

    await act(async () => findButtonByName('Journal').click())
    expect(document.querySelector('[data-testid="journal-profile"] [data-profile-field="bio"]')?.textContent)
      .toBe(rawAbout)
    expect(document.querySelector('[data-testid="journal-profile"] script')).toBeNull()
    const description = pageMetaContent('meta[name="description"]') ?? ''
    expect(description).toHaveLength(500)
    expect(description).toMatch(/^<script>I collect bookmarks\.<\/script> x/u)
    expect(description).not.toMatch(/[\u0000-\u001F\u007F]/u)
    expect(document.head.querySelector('script')).toBeNull()
    expect(canonicalHref()).toBe('https://know-n.com/u/mira')
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(pageMetaContent('meta[property="og:url"]')).toBe(canonicalHref())
  })

  it('marks an unknown handle noindex and removes its canonical', async () => {
    installPageMetaBaseline()
    // Every mount attempt for an unknown handle gets the same 404.
    mocks.getPublicProfilePage.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))
    renderProfile('/u/missing')
    await waitForDom(domFinishedLoading)

    expect(canonicalHref()).toBeNull()
    expect(robotsContents()).toEqual(['noindex'])
  })

  it('leaves the head indexable when the profile read fails transiently (R15-22)', async () => {
    installPageMetaBaseline()
    mocks.getPublicProfilePage.mockRejectedValue(new ProductApiError({
      status: 503,
      code: 'feature_temporarily_unavailable',
      message: 'unavailable',
      retryAfterSeconds: 30,
    }))
    renderProfile('/u/mira')
    await waitForDom(domFinishedLoading)

    expect(document.title).toContain('Profile error')
    expect(robotsContents()).toEqual([])
  })

  it('does not render or query Follow while exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { follow: false }
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile(); await waitForDom(domFinishedLoading)
    expect([...document.querySelectorAll<HTMLButtonElement>('button')]
      .some((candidate) => candidate.textContent === 'Follow')).toBe(false)
    expect(document.querySelector('[data-profile-field="followers"]')).toBeNull()
    expect(document.querySelector('[data-profile-field="following"]')).toBeNull()
    expect(document.body.textContent).not.toContain('—')
    expect(findButtonByName('Followers').textContent?.replace(/\s+/g, ' ').trim()).toBe('Followers')
    expect(findButtonByName('Following').textContent?.replace(/\s+/g, ' ').trim()).toBe('Following')
    expect(mocks.isFollowingProfile).not.toHaveBeenCalled()
    expect(mocks.getFollowingPage).not.toHaveBeenCalled()
    expect(mocks.getFollowersPage).not.toHaveBeenCalled()

    await act(async () => findButtonByName('Journal').click())
    const journalStats = document.querySelector('[data-testid="journal-profile"] .journal-stats')
    expect(journalStats?.querySelector('[data-profile-field="journal-readers"]')).toBeNull()
    expect(journalStats?.querySelector('[data-profile-field="journal-following"]')).toBeNull()
    expect(journalStats?.textContent).not.toMatch(/readers|following/i)
    expect(journalStats?.textContent).not.toContain('—')
  })

  it('uses stable profile identity for accessible Follow and authoritative Unfollow', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    // Answer by the action that actually happened: StrictMode mounts the page
    // twice, so a queue of one-shot values is consumed by the extra mount and
    // the follow state never lines up with the UI.
    let following = false
    mocks.isFollowingProfile.mockImplementation(async () => following)
    mocks.followProfile.mockImplementation(async () => { following = true; return { following: true } })
    mocks.unfollowProfile.mockImplementation(async () => { following = false; return { following: false } })
    renderProfile(); await waitForDom(() => {
      const button = document.querySelector('button[aria-busy]')
      const label = [...(button?.querySelectorAll('span') ?? [])]
        .find((span) => !span.hasAttribute('aria-hidden') && !span.querySelector('span'))
      return (label?.textContent ?? '').trim() === 'Follow'
    })

    const follow = findButtonByName('Follow')
    expect(follow.getAttribute('aria-pressed')).toBe('false')
    expect(follow.className).toContain('btn-primary')
    await act(async () => follow.click()); await waitForDom(domFinishedLoading)
    expect(mocks.followProfile).toHaveBeenCalledWith(
      'bbbbbbbbbbbbbbbbbbbbbA',
      expect.objectContaining({ intentId: expect.stringContaining('bbbbbbbbbbbbbbbbbbbbbA') }),
    )
    expect(findButtonByName('Unfollow').getAttribute('aria-pressed')).toBe('true')
    expect(findButtonByName('Unfollow').className).toContain('btn-secondary')

    await act(async () => findButtonByName('Unfollow').click()); await waitForDom(domFinishedLoading)
    expect(mocks.unfollowProfile).toHaveBeenCalledWith('bbbbbbbbbbbbbbbbbbbbbA', expect.any(Object))
    expect(findButtonByName('Follow').getAttribute('aria-pressed')).toBe('false')
  })

  it('offers Edit profile instead of Follow and Report on the viewer\'s own profile', async () => {
    mocks.auth.user = { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'mira' }
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    function LocationProbe() {
      const location = useLocation()
      return <output data-testid="location">{location.search}</output>
    }
    mountTree(
      <MemoryRouter initialEntries={['/u/mira']}>
        <Routes>
          <Route path="/u/:handle" element={<><Profile /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(domFinishedLoading)

    const edit = findButtonByName('Edit profile')
    expect(edit.className).toContain('btn-secondary')
    expect(edit.className).toContain('btn-sm')
    expect(document.querySelector('[data-testid="report-profile"]')).toBeNull()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Follow')).toBe(false)
    expect(findButtonByName('Share')).toBeTruthy()
    await act(async () => edit.click())
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('?settings=profile')

    await act(async () => findButtonByName('Journal').click())
    expect(findButtonByName('Edit profile')).toBeTruthy()
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Follow')).toBe(false)
  })

  it('uses real collections in journal mode without mixing Activity assertions', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Following').click())
    expect(document.body.textContent).not.toContain('on the way')
    expect(document.querySelector('[data-profile-state="unsupported-following"]')).toBeNull()
    expect(document.querySelector('[data-profile-state="empty-following"]')?.textContent)
      .toContain('Not following anyone yet')
    expect(document.body.textContent).not.toContain('and collections')

    await act(async () => findButtonByName('Journal').click())
    expect(document.querySelector('[data-testid="journal-profile"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="journal-monogram"] img')?.getAttribute('src'))
      .toBe('https://images.example.test/mira.png')
    expect(document.querySelector('a[href="/c/systems-notes"]')?.textContent)
      .toContain('Systems notes')
    expect(document.querySelector('[data-profile-field="journal-readers"]')?.textContent).toBe('0')
    expect(document.querySelector('[data-profile-field="journal-following"]')?.textContent).toBe('0')
    expect(document.querySelector('[data-profile-field="bio"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Independent notes on systems and attention')
  })

  it('projects loaded follow-graph counts onto journal readers and sources followed', async () => {
    mocks.getFollowersPage.mockResolvedValueOnce({
      items: [
        { profileId: 'cccccccccccccccccccccA', handle: 'kai', displayName: 'Kai Ito', avatarUrl: null },
        { profileId: 'dddddddddddddddddddddA', handle: 'nora', displayName: 'Nora Vale', avatarUrl: null },
      ],
      nextCursor: null,
    })
    mocks.getFollowingPage.mockResolvedValueOnce({
      items: [
        { profileId: 'eeeeeeeeeeeeeeeeeeeeeA', handle: 'lin', displayName: 'Lin Chen', avatarUrl: null },
      ],
      nextCursor: null,
    })
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('2')
    expect(document.querySelector('[data-profile-field="following"]')?.textContent).toBe('1')

    await act(async () => findButtonByName('Journal').click())
    expect(document.querySelector('[data-profile-field="journal-readers"]')?.textContent).toBe('2')
    expect(document.querySelector('[data-profile-field="journal-following"]')?.textContent).toBe('1')
  })


  it('keeps loading, not-found, empty, and retryable network errors distinct', async () => {
    installPageMetaBaseline({
      description: 'Origin profile description.',
      canonical: 'https://know-n.com/u/mira',
      ogUrl: 'https://know-n.com/u/mira',
    })
    const pending = deferred<PublicProfilePage>()
    // The same pending page answers every mount attempt; resolving it is what
    // drives the transition out of Loading.
    mocks.getPublicProfilePage.mockReturnValue(pending.promise)
    renderProfile()
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading profile')
    expect(pageMetaContent('meta[name="description"]')).toBe('Origin profile description.')
    expect(canonicalHref()).toBe('https://know-n.com/u/mira')
    expect(pageMetaContent('meta[property="og:url"]')).toBe('https://know-n.com/u/mira')
    expect(robotsContents()).toEqual([])

    await act(async () => pending.resolve(profilePage({ collections: [] })))
    expect(document.querySelector('[data-profile-state="empty"]')?.textContent)
      .toContain('No public collections yet')

    cleanup()
    // Every mount attempt for an unknown handle gets the same 404.
    mocks.getPublicProfilePage.mockRejectedValue(new ProductApiError({
      status: 404,
      code: 'resource_not_found',
      message: 'not found',
    }))
    renderProfile('/u/missing')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="absence-stage"]')?.textContent)
      .toContain('Profile unavailable')
    expect(document.body.textContent).not.toContain('@missing')
    expect(document.querySelector('button')).toBeNull()

    cleanup()
    // Server state, not a call-order queue: the outage is still up for both
    // StrictMode mount attempts and ends before the user presses Retry.
    let transportDown = true
    mocks.getPublicProfilePage.mockImplementation((handle: string) => (
      transportDown
        ? Promise.reject(new ProductApiError({
            status: 0,
            code: 'transport_error',
            message: 'offline',
          }))
        : Promise.resolve(profilePage({ handle, displayName: 'Recovered profile' }))
    ))
    renderProfile('/u/retry')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load this profile")
    expect(document.body.textContent).not.toContain('Mira Chen')

    transportDown = false
    const callsBeforeRetry = mocks.getPublicProfilePage.mock.calls.length
    await act(async () => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)
    // Retry issues exactly one more request for the same page.
    expect(mocks.getPublicProfilePage.mock.calls.length).toBe(callsBeforeRetry + 1)
    expect(document.querySelector('h1')?.textContent).toBe('Recovered profile')
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(
      'retry',
      { limit: 24 },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
  })

  it('uses plural fallback copy for a partial profile page', async () => {
    installPageMetaBaseline()
    mocks.getPublicProfilePage.mockResolvedValue(profilePage({ hasMore: true }))
    renderProfile()
    await waitForDom(domFinishedLoading)

    expect(pageMetaContent('meta[name="description"]')).toBe('Public collections on Know-N')
  })

  it('appends a stable page without duplicates, preserves data on failure, and moves focus', async () => {
    // The endpoint answers by the cursor it was asked for, so both StrictMode
    // mount attempts receive page 1 instead of draining a call-order queue.
    const second = deferred<PublicProfilePage>()
    const thirdPage = profilePage({
      collections: [{
        id: 'collection-3', slug: 'reliable-systems', title: 'Reliable systems',
        summary: null, kind: 'bookmarks', updatedAt: '2026-07-22T00:00:00.000Z',
      }],
    })
    let continuationThreeFails = true
    mocks.getPublicProfilePage.mockImplementation(
      (_handle: string, query: { limit: number; cursor?: string }) => {
        if (query.cursor === 'profile-page-2') return second.promise
        if (query.cursor === 'profile-page-3') {
          return continuationThreeFails
            ? Promise.reject(new ProductApiError({
                status: 503,
                code: 'feature_temporarily_unavailable',
                message: 'temporarily unavailable',
              }))
            : Promise.resolve(thirdPage)
        }
        return Promise.resolve(profilePage({ cursor: 'profile-page-2', hasMore: true }))
      },
    )
    renderProfile()
    await waitForDom(domFinishedLoading)
    // The live mount (the last call) requested page 1 for the handle.
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(
      'mira',
      { limit: 24 },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )

    const loadMore = findButtonByName('Load more')
    loadMore.focus()
    act(() => loadMore.click())
    expect(document.body.textContent).toContain('Systems notes')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading more collections')
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(
      'mira',
      { limit: 24, cursor: 'profile-page-2' },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )

    await act(async () => second.resolve(profilePage({
      cursor: 'profile-page-3',
      hasMore: true,
      collections: [
        {
          id: 'collection-1', slug: 'systems-notes', title: 'Duplicate systems notes',
          summary: null, kind: 'knowledge_collection', updatedAt: '2026-07-24T00:00:00.000Z',
        },
        {
          id: 'collection-2', slug: 'distributed-systems', title: 'Distributed systems',
          summary: null, kind: 'bookmarks', updatedAt: '2026-07-23T00:00:00.000Z',
        },
      ],
    })))

    expect(document.querySelectorAll('[data-profile-collection-id="collection-1"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-profile-collection-id="collection-2"]')).toHaveLength(1)
    expect(document.activeElement?.textContent).toContain('Distributed systems')

    // The continuation endpoint is still down, so this request fails.
    await act(async () => findButtonByName('Load more').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(
      'mira',
      { limit: 24, cursor: 'profile-page-3' },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(document.querySelectorAll('[data-profile-collection-id]')).toHaveLength(2)
    expect(document.body.textContent).toContain('Systems notes')
    expect(document.body.textContent).toContain('Distributed systems')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load more collections")
    expect(findButtonByName('Try again').disabled).toBe(false)

    continuationThreeFails = false
    await act(async () => findButtonByName('Try again').click())
    await waitForDom(domFinishedLoading)
    expect(mocks.getPublicProfilePage).toHaveBeenLastCalledWith(
      'mira',
      { limit: 24, cursor: 'profile-page-3' },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(document.querySelectorAll('[data-profile-collection-id]')).toHaveLength(3)
    expect(document.body.textContent).toContain('Reliable systems')
  })

  it('aborts old handles and ignores a late response that does not honor cancellation', async () => {
    // The endpoint answers per handle: both StrictMode mount attempts for the
    // same handle share its deferred page, and the handle switch gets its own.
    const oldPage = deferred<PublicProfilePage>()
    const newPage = deferred<PublicProfilePage>()
    const pagesByHandle = new Map<string, Deferred<PublicProfilePage>>([
      ['mira', oldPage],
      ['kai', newPage],
    ])
    mocks.getPublicProfilePage.mockImplementation((handle: string) => {
      const page = pagesByHandle.get(handle)
      if (!page) throw new Error(`unexpected profile handle: ${handle}`)
      return page.promise
    })

    renderProfile('/u/mira', true)
    await waitForDom(() => document.body.textContent?.includes('Open Kai') === true)
    // The live mount's request is the in-flight read that the switch must abort.
    const oldSignal = mocks.getPublicProfilePage.mock.calls.at(-1)?.[2]?.signal as AbortSignal

    const switchLink = [...document.querySelectorAll<HTMLAnchorElement>('a')]
      .find((candidate) => candidate.textContent === 'Open Kai')
    if (!switchLink) throw new Error('handle switch link missing')
    act(() => switchLink.click())
    await settled()
    expect(oldSignal.aborted).toBe(true)

    await act(async () => newPage.resolve(profilePage({ handle: 'kai', displayName: 'Kai Ito' })))
    expect(document.querySelector('h1')?.textContent).toBe('Kai Ito')

    await act(async () => oldPage.resolve(profilePage({ handle: 'mira', displayName: 'Late Mira' })))
    expect(document.querySelector('h1')?.textContent).toBe('Kai Ito')
    expect(document.body.textContent).not.toContain('Late Mira')
  })
})
