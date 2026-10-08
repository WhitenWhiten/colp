// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionSnapshot } from '../api/types'
import { collectLayeredRules, readStyle } from '../styles/dashboard-stack-cascade.test-helper'
import { cleanup, domFinishedLoading, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'
import {
  bookmark,
  captureSearch,
  deferred,
  insightPayloads,
  mocks,
  previewObservers,
  renderCollection,
  rootNode,
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


/**
 * The public collection page renders its list view unvirtualized, and
 * FE-PUBLIC-COLLECTION-NO-VIRTUALIZE asked whether that matters. Measured, on
 * happy-dom, for a bookmarks collection:
 *
 *   | nodes | render | elements |
 *   |   100 |  194ms |    1,579 |
 *   |   500 |  406ms |    7,579 |
 *   | 2_000 |  823ms |   30,079 |
 *
 * Linear, at roughly 15 elements per row. The data layer's own ceiling is 1_000
 * pages of 100 nodes, so the shape extrapolates to ~1.5M elements and tens of
 * seconds of layout for a collection the fetch path is explicitly allowed to
 * load. That is the evidence the decision needed: the list view does need to be
 * bounded.
 *
 * What it does NOT settle is HOW. `VirtualList` takes a fixed `itemHeight`; the
 * comfort list is a flex column of auto-height rows (titles clamp at 2 lines,
 * some rows carry a description), so virtualizing it means either dynamic-height
 * measurement or a uniform row height — the second is a visible design change.
 * This test guards the measurement. It asserts the EXACT element count per size,
 * which reproduces bit-for-bit across runs, so a content loss — truncating the
 * board to 10 items, dropping descriptions, skipping rows — fails it. It does NOT
 * assert wall-clock time: those numbers move by several hundred percent between
 * runs on this machine (measured 370-1000ms for the size-100 case against the
 * 194ms first recorded), so a timing assertion would flake, and an earlier version
 * of this comment claimed a "superlinear term" guard that never existed.
 */
/**
 * Measured element counts for this fixture, reproduced bit-for-bit. Pinned so that
 * losing content fails the test rather than only shrinking a ratio. Re-pinned once
 * after the icon-paths refactor folded arrow-up-right's two <path>s into one —
 * one element per card, no content change — and once more (+1, constant) when
 * breadcrumb link labels gained an ellipsis span (R12-04). Re-pinned for R13:
 * W-08 dropped the "Published version" toolbar hint (-1), and W-10 dropped the
 * generic "Link" kind chip on each card (-1 per card) plus the "Public view"
 * chip, the placeholder byline and the root count chip (-3). No bookmark
 * content is lost; the text assertions below still see the first and last row.
 * BS-06 then added the masthead's "Subscribe to bookmarks" control
 * (span.subscribe-control + its button; the options chevron renders nothing
 * signed out): +2, constant. The board-card host rail then replaced the
 * footer strip (-1 per card), and the masthead/toolbar redesign added the
 * byline, figure nouns and the view rail's glyphs + names (+18, constant).
 * The Contents/main-column layout then wrapped the toolbar and layer in the
 * main column and put the stream under a counted "Bookmarks" section head,
 * dropping the toolbar's inner row (+3, constant).
 */
// The signed-in export menu is a wrapper plus its button (two elements).
const EXPECTED_ELEMENTS: Record<number, number> = { 100: 1_402, 500: 6_602, 2000: 26_102 }

describe('public Collection render cost by size', () => {
  beforeEach(setUpCollectionPage)
  beforeEach(() => { communityGate.enabled = false })
  afterEach(tearDownCollectionPage)

  for (const size of [100, 500, 2000]) {
    it(`renders ${size} bookmarks`, async () => {
      const base = snapshot()
      const nodes = Array.from({ length: size }, (_, index) => ({
        id: `scale-${index}`, parentId: base.collection.rootNodeId, kind: 'bookmark' as const,
        title: `Scaled source ${index}`, url: `https://scale.test/${index}`,
        position: String(index), description: null,
      }))
      mocks.loadPublicCollectionSnapshot.mockResolvedValue({
        ...base, nodes: [...base.nodes, ...nodes],
      })
      const started = Date.now()
      renderCollection()
      await waitForDom(domFinishedLoading, 180_000)
      const renderMs = Date.now() - started
      const elements = document.querySelectorAll('*').length
      console.log(`SIZE ${size} renderMs=${renderMs} elements=${elements}`)
      expect(document.body.textContent).toContain('Scaled source 0')
      // Exact, not a ratio: the count is deterministic, and a ratio upper bound
      // tolerates a 200x content loss (10 rows still gives ~16 elements per row).
      expect(elements).toBe(EXPECTED_ELEMENTS[size])
      expect(document.body.textContent).toContain(`Scaled source ${size - 1}`)
    }, 300_000)
  }
})
