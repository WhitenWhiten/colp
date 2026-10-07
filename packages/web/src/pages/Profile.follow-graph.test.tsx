// @vitest-environment happy-dom
import { act } from 'react'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
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

function emptyFollowPage() {
  return { items: [], nextCursor: null }
}

function emptyActivityPage() {
  return { items: [] as Array<Record<string, unknown>>, nextCursor: null }
}

function followPerson(input: {
  profileId?: string
  handle?: string
  displayName?: string
  avatarUrl?: string | null
} = {}) {
  return {
    profileId: input.profileId ?? 'cccccccccccccccccccccA',
    handle: input.handle ?? 'kai',
    displayName: input.displayName ?? 'Kai Ito',
    avatarUrl: input.avatarUrl ?? null,
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

describe('public Profile follow graph', () => {

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
    /* The first page is the endpoint's steady state, not a one-shot of a call
       sequence: StrictMode mounts the route twice (the first request is
       aborted by the effect cleanup), so a `Once` queue sized for a single
       mount leaves the surviving mount with `undefined`. */
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
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

  it('fills follow chips from the first page and links Following handles', async () => {
    const followed = followPerson()
    const follower = followPerson({
      profileId: 'dddddddddddddddddddddA',
      handle: 'lin-yichen',
      displayName: '林一晨',
    })
    mocks.getFollowingPage.mockResolvedValueOnce({ items: [followed], nextCursor: null })
    mocks.getFollowersPage.mockResolvedValueOnce({ items: [follower], nextCursor: null })
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    expect(mocks.getFollowingPage).toHaveBeenCalledWith(
      'bbbbbbbbbbbbbbbbbbbbbA',
      { limit: 100 },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(mocks.getFollowersPage).toHaveBeenCalledWith(
      'bbbbbbbbbbbbbbbbbbbbbA',
      { limit: 100 },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(document.querySelector('[data-profile-field="following"]')?.textContent).toBe('1')
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('1')

    await act(async () => findButtonByName('Following').click())
    const followedLink = document.querySelector<HTMLAnchorElement>('a[href="/u/kai"]')
    expect(followedLink?.textContent).toContain('Kai Ito')
    expect(followedLink?.textContent).toContain('@kai')
    expect(document.querySelector('[role="list"][aria-label="Following"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('on the way')

    await act(async () => findButtonByName('Followers').click())
    expect(document.querySelector<HTMLAnchorElement>('a[href="/u/lin-yichen"]')?.textContent)
      .toContain('林一晨')
  })

  it('falls back to initials when a followed person\'s avatar fails to load', async () => {
    mocks.getFollowingPage.mockResolvedValue({
      items: [followPerson({ avatarUrl: 'https://images.example.test/kai.png' })],
      nextCursor: null,
    })
    renderProfile()
    await waitForDom(domFinishedLoading)
    await act(async () => findButtonByName('Following').click())

    const row = document.querySelector<HTMLAnchorElement>('[role="list"][aria-label="Following"] a[href="/u/kai"]')
    const image = row?.querySelector('img')
    expect(image?.getAttribute('src')).toBe('https://images.example.test/kai.png')
    await act(async () => { image?.dispatchEvent(new Event('error')) })
    expect(row?.querySelector('img')).toBeNull()
    expect(row?.querySelector('[aria-hidden="true"] > span')?.textContent).toBe('KI')
  })

  it('omits follow counts when the first page has a continuation', async () => {
    mocks.getFollowingPage.mockResolvedValueOnce({
      items: [followPerson(), followPerson({ profileId: 'eeeeeeeeeeeeeeeeeeeeeA', handle: 'nora' })],
      nextCursor: 'following-page-2',
    })
    mocks.getFollowersPage.mockResolvedValueOnce({
      items: Array.from({ length: 100 }, (_, index) => followPerson({
        profileId: `follower-${index}`,
        handle: `follower-${index}`,
      })),
      nextCursor: 'followers-page-2',
    })
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-profile-field="following"]')).toBeNull()
    expect(document.querySelector('[data-profile-field="followers"]')).toBeNull()
    expect(document.querySelectorAll('[aria-label="Profile statistics"] li')).toHaveLength(1)
    expect(findButtonByName('Following').textContent?.replace(/\s+/g, ' ').trim()).toBe('Following')
    expect(findButtonByName('Followers').textContent?.replace(/\s+/g, ' ').trim()).toBe('Followers')
    expect(document.body.textContent).not.toContain('2+')
    expect(document.body.textContent).not.toContain('100+')
    expect(document.body.textContent).not.toContain('—')
  })

  it('does not call follow list APIs when signed out and does not fake a zero count', async () => {
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    expect(mocks.getFollowingPage).not.toHaveBeenCalled()
    expect(mocks.getFollowersPage).not.toHaveBeenCalled()
    expect(document.querySelector('[data-profile-field="followers"]')).toBeNull()
    expect(document.querySelector('[data-profile-field="following"]')).toBeNull()
    expect(document.body.textContent).not.toContain('—')
    expect(findButtonByName('Followers').textContent?.replace(/\s+/g, ' ').trim()).toBe('Followers')
    expect(findButtonByName('Following').textContent?.replace(/\s+/g, ' ').trim()).toBe('Following')

    await act(async () => findButtonByName('Following').click())
    expect(document.body.textContent).not.toContain('on the way')
    // Sign in returns to the list the visitor opened (?tab= since W-36).
    expect(document.querySelector(`a[href="/login?returnTo=${encodeURIComponent('/u/mira?tab=following')}"]`)?.textContent).toBe('Sign in')
  })

  it('shows signed-out visitors a sign-in link and no unknown count', async () => {
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    const signIn = document.querySelector<HTMLAnchorElement>('[data-testid="profile-follow-signin"]')
    expect(signIn?.textContent).toBe('Sign in to follow')
    expect(signIn?.getAttribute('href')).toBe(
      `/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`,
    )
    expect(document.body.textContent).not.toContain('—')
    expect(document.querySelector('[data-profile-field="followers"]')).toBeNull()
    expect(document.querySelector('[data-profile-field="following"]')).toBeNull()

    await act(async () => findButtonByName('Journal').click())
    const journalSignIn = document.querySelector<HTMLAnchorElement>('[data-testid="profile-follow-signin"]')
    expect(journalSignIn?.textContent).toBe('Sign in to follow')
    const journalStats = document.querySelector('[data-testid="journal-profile"] .journal-stats')
    expect(journalStats?.querySelector('[data-profile-field="journal-readers"]')).toBeNull()
    expect(journalStats?.querySelector('[data-profile-field="journal-following"]')).toBeNull()
    expect(journalStats?.textContent).not.toMatch(/readers|following/i)
    expect(journalStats?.textContent).not.toContain('—')
  })

  it('continues a Following page with only cursor', async () => {
    mocks.getFollowingPage
      .mockResolvedValueOnce({ items: [followPerson()], nextCursor: 'following-page-2' })
      .mockResolvedValueOnce({
        items: [followPerson({ profileId: 'ffffffffffffffffffA', handle: 'nora', displayName: 'Nora Vale' })],
        nextCursor: null,
      })
    mocks.getFollowersPage.mockResolvedValueOnce(emptyFollowPage())
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-profile-field="following"]')).toBeNull()

    await act(async () => findButtonByName('Following').click())
    await act(async () => findButtonByName('Load more').click())
    await waitForDom(domFinishedLoading)

    expect(mocks.getFollowingPage).toHaveBeenLastCalledWith(
      'bbbbbbbbbbbbbbbbbbbbbA',
      { cursor: 'following-page-2' },
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(mocks.getFollowingPage.mock.calls.at(-1)?.[1]).not.toHaveProperty('limit')
    expect(document.querySelector<HTMLAnchorElement>('a[href="/u/nora"]')?.textContent)
      .toContain('Nora Vale')
    expect(document.querySelector('[data-profile-field="following"]')?.textContent).toBe('2')
  })

  it('reloads follow lists when this profile is invalidated over storage', async () => {
    mocks.getFollowersPage
      .mockResolvedValueOnce(emptyFollowPage())
      .mockResolvedValueOnce({
        items: [followPerson({ handle: 'actor', displayName: 'Actor' })],
        nextCursor: null,
      })
    mocks.getFollowingPage.mockResolvedValue(emptyFollowPage())
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('0')

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'known.follow.invalidate.v1',
        newValue: 'bbbbbbbbbbbbbbbbbbbbbA',
      }))
    })
    await waitForDom(domFinishedLoading)

    expect(mocks.getFollowersPage).toHaveBeenCalledTimes(2)
    expect(mocks.getFollowingPage).toHaveBeenCalledTimes(2)
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('1')
  })

  it('keeps the follow counts on screen while an invalidation revalidates', async () => {
    let releaseFollowers: ((page: { items: unknown[]; nextCursor: null }) => void) | undefined
    mocks.getFollowersPage
      .mockResolvedValueOnce({
        items: [followPerson({ handle: 'ada', displayName: 'Ada' })],
        nextCursor: null,
      })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFollowers = resolve }))
    mocks.getFollowingPage.mockResolvedValue(emptyFollowPage())
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('1')

    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'known.follow.invalidate.v1',
        newValue: 'bbbbbbbbbbbbbbbbbbbbbA',
      }))
    })

    // Refetch is in flight: the known count stays on screen.
    expect(releaseFollowers).toBeDefined()
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('1')

    await act(async () => {
      releaseFollowers?.({ items: [], nextCursor: null })
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-profile-field="followers"]')?.textContent).toBe('0')
  })

  it('keeps the profile section in ?tab= and moves focus to a list opened from a stat', async () => {
    mocks.getFollowingPage.mockResolvedValue({ items: [followPerson()], nextCursor: null })
    mocks.getFollowersPage.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    let search = ''
    function LocationProbe() {
      search = useLocation().search
      return null
    }
    mountTree(
      <MemoryRouter initialEntries={['/u/mira?tab=following']}>
        <LocationProbe />
        <Routes>
          <Route path="/u/:handle" element={<Profile />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitForDom(domFinishedLoading)
    // A deep link opens the section it names.
    expect(document.getElementById('profile-tab-following')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[role="list"][aria-label="Following"]')).not.toBeNull()

    await act(async () => document.getElementById('profile-tab-collections')?.click())
    expect(search).toBe('')

    const followersStat = document.querySelector<HTMLButtonElement>('button[aria-controls="profile-followers-panel"]')!
    await act(async () => followersStat.click())
    expect(search).toBe('?tab=followers')
    const panel = document.getElementById('profile-followers-panel')
    expect(panel?.getAttribute('tabindex')).toBe('-1')
    await waitForDom(() => document.activeElement === panel)
    expect(document.activeElement).toBe(panel)
  })
})
