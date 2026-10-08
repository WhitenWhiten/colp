// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicCollectionNode } from '../api/types'
import { cleanup, domFinishedLoading, waitForDom } from '../test/render'
import {
  bookmark,
  mocks,
  renderCollection,
  rootNode,
  setUpCollectionPage,
  snapshot,
  tearDownCollectionPage,
  textOutsideFolderCards,
} from './Collection.test-helper'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks } = await import('./Collection.test-mocks')
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

/* Folder cards open into previews when the folders are the layer's whole
   content or a few (≤4) sit beside bookmarks; a longer run of folders over
   bookmarks keeps the compact tabs. */
describe('public Collection page folder previews', () => {
  beforeEach(setUpCollectionPage)
  afterEach(tearDownCollectionPage)

  it('previews folders when they are the layer or a few sit beside bookmarks; many stay compact', async () => {
    const folder = (id: string, title: string, position: string, description: string | null = null): PublicCollectionNode => ({
      id, parentId: 'root-1', kind: 'folder', title, description, url: null, position,
    })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      folder('folder-papers', 'Papers', '0', 'Core reading'),
      folder('folder-empty', 'Empty drawer', '1'),
      folder('folder-nest', 'Nest', '2'),
      { id: 'folder-deep', parentId: 'folder-nest', kind: 'folder', title: 'Deep', description: null, url: null, position: '0' },
      bookmark('Paper A', 'folder-papers'),
      bookmark('Paper B', 'folder-papers'),
      bookmark('Paper C', 'folder-papers'),
      bookmark('Paper D', 'folder-papers'),
      bookmark('Deep paper', 'folder-deep'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-collection-folder-layer]')?.className)
      .toContain('collection-folder-board--rich')
    const card = (id: string) => document.querySelector(`[data-collection-subfolder][data-folder-id="${id}"]`)
    // Description, the first three bookmarks in curated order, then the remainder.
    expect(card('folder-papers')?.textContent).toContain('Core reading')
    expect([...card('folder-papers')?.querySelectorAll('[data-collection-folder-peek]') ?? []].map((el) => el.textContent))
      .toEqual(['Paper A', 'Paper B', 'Paper C'])
    expect(card('folder-papers')?.textContent).toContain('+1 more bookmark')
    expect(card('folder-empty')?.textContent).toContain('No bookmarks yet')
    // Nested bookmarks count toward the peek; direct subfolders are named.
    expect(card('folder-nest')?.textContent).toContain('Deep paper')
    expect(card('folder-nest')?.textContent).toContain('1 subfolder')
    // The peek is text inside the one card link — no nested anchors.
    expect(card('folder-papers')?.querySelector('a')).toBeNull()

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    // A few folders beside bookmarks preview too; the nested title shows
    // only inside its folder card.
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      folder('folder-papers', 'Papers', '0', 'Core reading'),
      bookmark('Paper A', 'folder-papers'),
      bookmark('Loose bookmark'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)
    const mixedLayer = document.querySelector('[data-collection-folder-layer]')
    expect(mixedLayer?.className).toContain('collection-folder-board--rich')
    expect(mixedLayer?.textContent).toContain('Paper A')
    expect(textOutsideFolderCards()).toContain('Loose bookmark')
    expect(textOutsideFolderCards()).not.toContain('Paper A')

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    // A long run of folders over bookmarks keeps the compact tabs.
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      ...['A', 'B', 'C', 'D', 'E'].map((letter, index) => folder(`folder-${letter}`, `Folder ${letter}`, String(index))),
      bookmark('Paper A', 'folder-A'),
      bookmark('Loose bookmark'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-collection-folder-layer]')?.className)
      .not.toContain('collection-folder-board--rich')
    expect(document.body.textContent).not.toContain('Paper A')
  })
})
