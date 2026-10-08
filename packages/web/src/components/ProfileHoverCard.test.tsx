// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FollowPage, PublicProfilePage } from '../api'
import { ProfileHoverCard } from './ProfileHoverCard'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  getPublicProfilePage: vi.fn(),
  getFollowersPage: vi.fn(),
  getFollowingPage: vi.fn(),
  isFollowingProfile: vi.fn(),
  followProfile: vi.fn(),
  unfollowProfile: vi.fn(),
  abandonFollowIntent: vi.fn(),
}))

type AuthState = {
  user: { profileId: string; handle: string } | null
  isLoggedIn: boolean
  bootstrapping: boolean
}

const authState = vi.hoisted(() => ({
  current: {
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  } as AuthState,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getPublicProfilePage: mocks.getPublicProfilePage,
      getFollowersPage: mocks.getFollowersPage,
      getFollowingPage: mocks.getFollowingPage,
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => authState.current,
}))

/* Unique identity per test: the module-level profile/counts caches are
   keyed by handle/profileId and intentionally outlive a single mount. */
let sequence = 0

function nextIdentity() {
  sequence += 1
  return {
    handle: `curator-${sequence}`,
    profileId: `bbbbbbbbbbbbbbbbbbb${String(sequence).padStart(2, '0')}`,
  }
}

function profilePage(handle: string, profileId: string, collections = 3): PublicProfilePage {
  return {
    profile: {
      profileId,
      handle,
      displayName: 'Curator',
      avatarUrl: null,
      about: 'Maintains reading maps about systems, cities, and the craft of keeping notes.',
    },
    collections: Array.from({ length: collections }, (_, index) => ({
      id: `col-${index}`,
      slug: `path-${index}`,
      title: `Path ${index}`,
      summary: null,
      kind: 'bookmarks' as const,
      updatedAt: '2026-07-24T00:00:00.000Z',
    })),
    page: { cursor: null, hasMore: false },
  }
}

function followPage(count: number): FollowPage {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      profileId: `person-${index}`,
      handle: `person-${index}`,
      displayName: `Person ${index}`,
      avatarUrl: null,
    })),
    nextCursor: null,
  }
}

function pointerOver(element: Element, pointerType: 'mouse' | 'touch') {
  const init = { bubbles: true, pointerType } as PointerEventInit
  const event = typeof PointerEvent === 'undefined'
    ? new MouseEvent('pointerover', { bubbles: true })
    : new PointerEvent('pointerover', init)
  element.dispatchEvent(event)
}

describe('ProfileHoverCard', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubEnv('VITE_FOLLOW_ACCEPTANCE', 'true')
    authState.current = {
      user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
      isLoggedIn: true,
      bootstrapping: false,
    }
    mocks.isFollowingProfile.mockResolvedValue(false)
    mocks.getFollowersPage.mockResolvedValue(followPage(12))
    mocks.getFollowingPage.mockResolvedValue(followPage(5))
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  function renderCard(identity = nextIdentity()) {
    mountTree(
        <MemoryRouter>
          <ProfileHoverCard
            handle={identity.handle}
            displayName="Curator"
            avatarUrl={null}
            profileId={identity.profileId}
          >
            <strong>Curator</strong>
          </ProfileHoverCard>
        </MemoryRouter>,
      )
    return identity
  }

  function trigger(): HTMLAnchorElement {
    const element = document.querySelector<HTMLAnchorElement>('[data-testid="profile-hover-trigger"]')
    if (!element) throw new Error('trigger missing')
    return element
  }

  async function flush() {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function openWithFocus() {
    await act(async () => {
      trigger().dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await flush()
    await flush()
  }

  it('links the trigger to the public profile and never fetches while closed', () => {
    const identity = renderCard()
    expect(trigger().getAttribute('href')).toBe(`/u/${identity.handle}`)
    expect(trigger().textContent).toContain('Curator')
    expect(document.querySelector('[role="group"]')).toBeNull()
    expect(mocks.getPublicProfilePage).not.toHaveBeenCalled()
    expect(mocks.getFollowersPage).not.toHaveBeenCalled()
  })

  it('opens on focus and shows identity, full bio, follow state, and collection count', async () => {
    const identity = renderCard()
    mocks.getPublicProfilePage.mockResolvedValueOnce(profilePage(identity.handle, identity.profileId))

    await openWithFocus()

    const card = document.querySelector('[role="group"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Curator')
    expect(card?.textContent).toContain(`@${identity.handle}`)
    expect(card?.textContent).toContain('the craft of keeping notes')
    expect(card?.textContent).toContain('3 Public collections')
    expect(card?.textContent).toContain('12 Followers')
    expect(card?.textContent).toContain('5 Following')
    expect(mocks.getPublicProfilePage).toHaveBeenCalledWith(
      identity.handle,
      { limit: 24 },
      { maxRetries: 0 },
    )
    const follow = card?.querySelector('button[aria-pressed]')
    expect(follow?.querySelector('span span:not([aria-hidden])')?.textContent).toBe('Follow')
    /* Hidden measure spans pin the button width to the widest workflow
       label so state changes never resize it. */
    const measured = [...(follow?.querySelectorAll('span[aria-hidden="true"]') ?? [])]
      .map((span) => span.textContent)
    expect(measured).toEqual(['Follow', 'Unfollow', 'Checking…', 'Following…', 'Unfollowing…'])
  })

  it('opens on mouse hover but ignores touch pointers', async () => {
    const identity = renderCard()
    mocks.getPublicProfilePage.mockResolvedValue(profilePage(identity.handle, identity.profileId))

    await act(async () => {
      pointerOver(trigger(), 'touch')
    })
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(document.querySelector('[role="group"]')).toBeNull()

    await act(async () => {
      pointerOver(trigger(), 'mouse')
    })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await flush()
    await flush()
    expect(document.querySelector('[role="group"]')).not.toBeNull()
  })

  it('closes on Escape and serves the reopen from cache', async () => {
    const identity = renderCard()
    mocks.getPublicProfilePage.mockResolvedValue(profilePage(identity.handle, identity.profileId))

    await openWithFocus()
    expect(document.querySelector('[role="group"]')).not.toBeNull()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(document.querySelector('[role="group"]')).toBeNull()

    await openWithFocus()
    expect(document.querySelector('[role="group"]')?.textContent).toContain('Curator')
    expect(mocks.getPublicProfilePage).toHaveBeenCalledTimes(1)
  })

  it('shows no followers count when the first page has a continuation', async () => {
    const identity = renderCard()
    mocks.getPublicProfilePage.mockResolvedValueOnce(profilePage(identity.handle, identity.profileId))
    mocks.getFollowersPage.mockResolvedValueOnce({ ...followPage(100), nextCursor: 'followers-page-2' })

    await openWithFocus()

    const card = document.querySelector('[role="group"]')
    expect(card?.textContent).toContain('3 Public collections')
    expect(card?.textContent).toContain('5 Following')
    expect(card?.textContent).not.toContain('Follower')
    expect(card?.textContent).not.toContain('100+')
  })

  it('keeps the card useful for anonymous readers without follow counts', async () => {
    authState.current = { user: null, isLoggedIn: false, bootstrapping: false }
    const identity = renderCard()
    mocks.getPublicProfilePage.mockResolvedValueOnce(profilePage(identity.handle, identity.profileId))

    await openWithFocus()

    const card = document.querySelector('[role="group"]')
    expect(card?.textContent).toContain('3 Public collections')
    expect(card?.textContent).not.toContain('Followers')
    expect(card?.textContent).not.toContain('Following')
    expect(card?.querySelector('button[aria-pressed]')).toBeNull()
    expect(mocks.getFollowersPage).not.toHaveBeenCalled()
  })

  it('degrades to the seed identity when the profile read fails', async () => {
    const identity = renderCard()
    mocks.getPublicProfilePage.mockRejectedValueOnce(new Error('boom'))

    await openWithFocus()

    const card = document.querySelector('[role="group"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('Curator')
    expect(card?.textContent).toContain(`@${identity.handle}`)
    expect(card?.textContent).toContain('unavailable')
  })
})
