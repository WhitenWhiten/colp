// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForDom } from '../test/render'
import {
  mocks,
  renderCollection,
  setUpCollectionPage,
  snapshot,
  tearDownCollectionPage,
} from './Collection.test-helper'

const communityGate = vi.hoisted(() => ({ enabled: false }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks } = await import('./Collection.test-mocks')
  return {
    ...actual,
    isCommunityExposureEnabled: () => communityGate.enabled,
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
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      createCollectionNode: mocks.createCollectionNode,
      getCollectionFollowState: mocks.getCollectionFollowState,
      followCollection: mocks.followCollection,
      unfollowCollection: mocks.unfollowCollection,
      abandonCollectionFollowIntent: mocks.abandonCollectionFollowIntent,
      resolveCommunityTarget: mocks.resolveCommunityTarget,
      setCommunityVote: mocks.setCommunityVote,
      abandonCommunityVoteIntent: mocks.abandonCommunityVoteIntent,
      getCommunityComments: mocks.getCommunityComments,
    },
  }
})

vi.mock('../lib/useOwnedCollections', () => ({
  useOwnedCollections: () => ({
    state: 'ready' as const,
    items: [
      {
        collection: { id: 'col-own-aaaaaaaaaaaaA', title: 'My shelf' },
        capabilities: { createNode: true },
        bookmarkCount: 3,
      },
    ] as unknown as import('../api').OwnedCollectionListItem[],
    message: '',
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
  }),
}))

vi.mock('../components/AppToast', async () => {
  const { mocks } = await import('./Collection.test-mocks')
  return {
    useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

describe('public Collection page', () => {
  beforeEach(setUpCollectionPage)
  beforeEach(() => { communityGate.enabled = false })
  afterEach(tearDownCollectionPage)

  it('mounts the community vote control for the resolved collection when exposure is on', async () => {
    communityGate.enabled = true
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    const target = {
      kind: 'collection' as const,
      id: 'col-public',
      collectionId: null,
      seriesId: null,
      generation: 'static-v1',
    }
    mocks.resolveCommunityTarget.mockResolvedValue({
      target,
      title: 'Research notes',
      href: '/c/research-notes',
      canVote: false,
      canComment: true,
      canCurateComments: false,
      votes: { target, up: 4, down: 1, myVote: null },
    })

    renderCollection()
    await waitForDom(() => document.querySelector('[data-testid="community-vote-up"]') !== null)
    expect(mocks.resolveCommunityTarget).toHaveBeenCalledWith(
      { kind: 'collection', id: 'col-public' },
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(document.querySelector('[data-testid="community-vote-up-count"]')?.textContent).toBe('4')
  })
})
