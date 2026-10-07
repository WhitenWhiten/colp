// @vitest-environment happy-dom
import { act } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
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

  it('replaces a failed avatar with a stable text fallback', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    const image = document.querySelector<HTMLImageElement>('[data-testid="profile-avatar"] img')
    expect(image?.src).toBe('https://images.example.test/mira.png')
    act(() => image?.dispatchEvent(new Event('error')))
    expect(document.querySelector('[data-testid="profile-avatar"] img')).toBeNull()
    expect(document.querySelector('[data-testid="profile-avatar"]')?.textContent).toBe('MC')
  })

  it('uses the same avatar in journal mode and falls back to initials when the image fails', async () => {
    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    await act(async () => findButtonByName('Journal').click())
    const image = document.querySelector<HTMLImageElement>('[data-testid="journal-monogram"] img')
    expect(image?.src).toBe('https://images.example.test/mira.png')
    act(() => image?.dispatchEvent(new Event('error')))
    expect(document.querySelector('[data-testid="journal-monogram"] img')).toBeNull()
    expect(document.querySelector('[data-testid="journal-monogram"]')?.textContent).toBe('MC')
  })

  it('copies profile URL when navigator.share is absent', async () => {
    const originalShare = (navigator as unknown as { share?: unknown }).share
    const originalClipboard = navigator.clipboard
    // @ts-expect-error test override
    delete navigator.share
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    mocks.getPublicProfilePage.mockResolvedValue(profilePage())
    renderProfile()
    await waitForDom(domFinishedLoading)

    const shareButton = findButtonByName('Share')
    await act(async () => shareButton.click())
    expect(writeText).toHaveBeenCalledWith(window.location.href)

    if (originalShare) (navigator as unknown as { share?: unknown }).share = originalShare
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  })
})
