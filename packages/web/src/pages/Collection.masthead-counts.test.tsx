// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionNode, PublicCollectionSnapshot } from '../api/types'
import { collectLayeredRules, readStyle } from '../styles/dashboard-stack-cascade.test-helper'
import { Collection } from './Collection'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

import { ioState, mocks } from './Collection.masthead.test-mocks'
import { installMastheadHarness, renderCollection, snapshot } from './Collection.masthead.test-helper'

installMastheadHarness()

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      recordPublicCollectionInsightEvent: mocks.recordPublicCollectionInsightEvent,
      getPublicProfilePage: mocks.getPublicProfilePage,
      getFollowersPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getFollowingPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
      getCollectionFollowState: mocks.getCollectionFollowState,
      followCollection: mocks.followCollection,
      unfollowCollection: mocks.unfollowCollection,
      abandonCollectionFollowIntent: mocks.abandonCollectionFollowIntent,
    },
  }
})

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

describe('public Collection masthead', () => {
  it('renders views, not followers, when viewCount is 12', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, viewCount: 12 },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-collection-field="views"]')?.textContent).toBe('12')
    expect(document.body.textContent).toContain('views')
    expect(document.body.textContent).not.toContain('followers')
    expect(document.querySelector('[data-collection-field="followers"]')).toBeNull()
  })

  it('clamps a long masthead title to three lines at ≤639, not a single-line ellipsis', async () => {
    const title = 'A maintained map of primary sources and practical references for systems research'
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, title },
    })

    const mobile = collectLayeredRules(readStyle('collection.css')).find(
      (rule) => rule.selector === '.collection-masthead .display' && rule.media?.max === 639,
    )
    expect(mobile, 'mobile masthead title rule must exist').toBeTruthy()
    expect(mobile!.body).toMatch(/-webkit-line-clamp:\s*3/)
    expect(mobile!.body).not.toMatch(/white-space:\s*nowrap/)

    const style = document.createElement('style')
    style.id = 'masthead-clamp-test'
    style.textContent = `.collection-masthead .display { ${mobile!.body} }`
    document.head.appendChild(style)

    renderCollection()
    await waitForDom(domFinishedLoading)

    const heading = document.querySelector('header h1')
    expect(heading?.textContent).toBe(title)
    const computed = getComputedStyle(heading!)
    expect(computed.whiteSpace).not.toBe('nowrap')
    const clamp =
      computed.getPropertyValue('line-clamp') || computed.getPropertyValue('-webkit-line-clamp')
    expect(clamp.trim()).toBe('3')
    expect(computed.overflow).toBe('hidden')
    document.getElementById('masthead-clamp-test')?.remove()
  })

  it('does not render views when viewCount is 0', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: { ...snapshot().collection, viewCount: 0 },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-collection-field="views"]')).toBeNull()
    expect(document.body.textContent).not.toContain('0 views')
    expect(document.body.textContent).not.toContain('followers')
  })

  it('issues zero collection-follow HTTP and hides the button when the flag is off', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: false }
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="collection-follow"]')).toBeNull()
    expect(document.querySelector('[data-testid="collection-follow-label"]')).toBeNull()
    expect(document.querySelector('[data-collection-field="followers"]')).toBeNull()
    expect(mocks.getCollectionFollowState).not.toHaveBeenCalled()
    expect(mocks.followCollection).not.toHaveBeenCalled()
    expect(mocks.unfollowCollection).not.toHaveBeenCalled()
  })

  it('renders 1 follower when followerCount is 1', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    mocks.getCollectionFollowState.mockResolvedValue({
      following: false, followerCount: 1, followedAt: null,
    })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => document.querySelector('[data-collection-field="followers"]') != null)

    expect(document.querySelector('[data-collection-field="followers"]')?.textContent).toBe('1')
    expect(document.body.textContent).toContain('1 follower')
    expect(document.body.textContent).not.toContain('1 followers')
  })

  it('shows the follower count for the owner without a follow button', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    mocks.getCollectionFollowState.mockResolvedValue({
      following: false, followerCount: 3, followedAt: null,
    })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...snapshot(),
      collection: {
        ...snapshot().collection,
        owner: { ...snapshot().collection.owner!, handle: 'actor' },
      },
    })
    renderCollection()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => document.querySelector('[data-collection-field="followers"]') != null)

    expect(document.querySelector('[data-testid="collection-follow"]')).toBeNull()
    expect(document.querySelector('[data-collection-field="followers"]')?.textContent).toBe('3')
    expect(document.body.textContent).toContain('3 followers')
    // StrictMode double-invokes the mount effect, so the mount can issue two
    // identical authority reads (only the newest generation is applied). The
    // guarantee is that every read targets the same collection and that a
    // later render does not re-read the status.
    const reads = mocks.getCollectionFollowState.mock.calls.length
    expect(reads).toBeGreaterThanOrEqual(1)
    expect(mocks.getCollectionFollowState.mock.calls.every((call) => call[0] === 'col-public')).toBe(true)
    const listButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'List')
    if (!listButton) throw new Error('List button missing')
    await act(async () => { listButton.click() })
    await waitForDom(domFinishedLoading)
    expect(mocks.getCollectionFollowState.mock.calls.length).toBe(reads)
  })

  it('hides the followers stat when followerCount is 0', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    mocks.getCollectionFollowState.mockResolvedValue({
      following: false, followerCount: 0, followedAt: null,
    })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => document.querySelector('[data-testid="collection-follow"]') != null)

    expect(document.querySelector('[data-collection-field="followers"]')).toBeNull()
    expect(document.body.textContent).not.toContain('0 followers')
    expect(document.body.textContent).not.toMatch(/\bfollowers\b/u)
  })

  it('follows then unfollows from the masthead label when collection-follow is on', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    // Server state: the authority read answers whatever the server currently
    // holds, and the mutation advances it. A per-mount queue would hand the
    // post-follow answer to the StrictMode remount instead of the pre-follow one.
    let authority = { following: false, followerCount: 3, followedAt: null as string | null }
    mocks.getCollectionFollowState.mockImplementation(() => Promise.resolve(authority))
    mocks.followCollection.mockImplementation(() => {
      authority = { following: true, followerCount: 4, followedAt: '2026-08-26T01:00:00.000Z' }
      return Promise.resolve(authority)
    })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => (
      document.querySelector('[data-testid="collection-follow-label"]')?.textContent === 'Follow'
    ))

    expect(document.querySelector('[data-collection-field="followers"]')?.textContent).toBe('3')
    expect(document.body.textContent).toContain('3 followers')

    const readsBeforeFollow = mocks.getCollectionFollowState.mock.calls.length
    const button = document.querySelector<HTMLButtonElement>('[data-testid="collection-follow"]')
    expect(button).not.toBeNull()
    await act(async () => { button?.click() })
    await waitForDom(() => (
      document.querySelector('[data-testid="collection-follow-label"]')?.textContent === 'Unfollow'
    ))

    expect(mocks.followCollection).toHaveBeenCalledTimes(1)
    // StrictMode's double-invoked mount effect adds one extra authority read;
    // the guarantee is that the follow action re-reads the status exactly once.
    expect(mocks.getCollectionFollowState.mock.calls.length).toBe(readsBeforeFollow + 1)
    expect(document.querySelector('[data-collection-field="followers"]')?.textContent).toBe('4')
    expect(document.body.textContent).toContain('4 followers')
  })

  it('hides the button and count after a backend 404 without retrying', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    mocks.getCollectionFollowState.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not exposed' }),
    )
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    renderCollection()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => mocks.getCollectionFollowState.mock.calls.length >= 1)
    await waitForDom(() => document.querySelector('[data-testid="collection-follow"]') === null)

    expect(document.querySelector('[data-collection-field="followers"]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/\bfollowers\b/u)
    // StrictMode's remount adds one authority read; a 404 must not schedule any
    // further attempt once the unavailable state is painted.
    const reads = mocks.getCollectionFollowState.mock.calls.length
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(mocks.getCollectionFollowState.mock.calls.length).toBe(reads)
    expect(mocks.followCollection).not.toHaveBeenCalled()
  })
})
