// @vitest-environment happy-dom
/**
 * FO-05 public Collection page time-sort UI tests. The sort toggle maps to the
 * real children endpoint (productClient.listCollectionChildren) and renders
 * one layer with nextCursor paging; a 404 (backend flag off) falls back to
 * the curated snapshot layer.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProductApiError } from '../api/errors'
import type { CollectionChildrenPage, CollectionChildrenSort } from '../api'
import { cleanup, domFinishedLoading, waitForDom } from '../test/render'
import { writeRouteCache } from '../lib/routeCache'
import {
  bookmark,
  captureSearch,
  deferred,
  mocks,
  renderCollection,
  rootNode,
  setUpCollectionPage,
  snapshot,
  tearDownCollectionPage,
} from './Collection.test-helper'
import { Collection } from './Collection'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks: apiMocks } = await import('./Collection.test-mocks')
  return {
    ...actual,
    // CS-01 community vote control is not under test here; gate it off so it
    // never resolves the community target over the network.
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: apiMocks.loadPublicCollectionSnapshot,
      recordPublicCollectionInsightEvent: apiMocks.recordPublicCollectionInsightEvent,
      listCollectionChildren: apiMocks.listCollectionChildren,
      getPublicProfilePage: apiMocks.getPublicProfilePage,
      getFollowersPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getFollowingPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      isFollowingProfile: apiMocks.isFollowingProfile,
      followProfile: apiMocks.followProfile,
      unfollowProfile: apiMocks.unfollowProfile,
      abandonFollowIntent: apiMocks.abandonFollowIntent,
      getCollectionFollowState: apiMocks.getCollectionFollowState,
    },
  }
})

vi.mock('../components/AppToast', async () => {
  const { mocks: toastMocks } = await import('./Collection.test-mocks')
  return { useToast: () => ({ toast: toastMocks.toast, success: toastMocks.success, error: toastMocks.error }) }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

vi.mock('../lib/useOwnedCollections', () => ({
  useOwnedCollections: () => ({
    state: 'ready' as const,
    items: [],
    message: '',
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    reload: vi.fn(),
  }),
}))

const childrenItem = (id: string, overrides: Partial<CollectionChildrenPage['items'][number]> = {}) => ({
  id,
  parentId: 'root-1',
  kind: 'bookmark' as const,
  title: id,
  url: `https://${id}.example/path`,
  description: `${id} description`,
  position: `P${id}`,
  createdAt: `2026-09-14T00:00:0${id === 'Newest source' ? 2 : 1}.000Z`,
  updatedAt: '2026-09-14T00:00:02.000Z',
  iconUrl: null,
  ...overrides,
})

const childrenPage = (sort: CollectionChildrenSort, items: CollectionChildrenPage['items'], nextCursor: string | null): CollectionChildrenPage => ({
  collectionId: 'col-public',
  parentId: 'root-1',
  rootId: 'root-1',
  contentRevision: '9',
  sort,
  items: items as CollectionChildrenPage['items'],
  nextCursor,
})

beforeEach(() => {
  setUpCollectionPage()
  mocks.listCollectionChildren.mockReset()
  mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([rootNode(), bookmark('Oldest source')]))
})
afterEach(tearDownCollectionPage)

describe('public Collection page time sorts (FO-05)', () => {
  it('renders the created_desc layer from the real children endpoint', async () => {
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('Newest source'),
      childrenItem('Older source'),
    ], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)

    const newest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Newest'))
    expect(newest).toBeTruthy()
    await act(async () => { newest?.click() })

    await waitForDom(() => (mocks.listCollectionChildren as ReturnType<typeof vi.fn>).mock.calls.length >= 1)
    expect(mocks.listCollectionChildren).toHaveBeenCalledWith('col-public', expect.objectContaining({
      sort: 'created_desc',
      limit: 50,
      parentId: undefined,
    }))
    // The children layer is rendered from the endpoint response (not the
    // snapshot): Newest first, and Oldest from the API page.
    await waitForDom(() => document.querySelector('[data-sort="created_desc"]') !== null)
    expect(document.body.textContent).toContain('Newest source')
    expect(document.body.textContent).toContain('Older source')
    // Root already shows the total on the masthead, so the toolbar chip stays off.
    expect(document.querySelector('[data-testid="collection-toolbar"]')?.textContent ?? '').not.toMatch(/\d+ (of \d+ )?bookmarks?/)
  })

  it('FO-08 honors the children node-level faviconCdnAllowed opt-out in the sorted layer', async () => {
    // A public collection whose collection-level fact allows the CDN.
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(
      [rootNode(), bookmark('Oldest source')],
      'public',
      { faviconCdnAllowed: true },
    ))
    // The children endpoint sends the node-level opt-out on the explicit-none
    // bookmark only (mirroring the curated snapshot); the sibling keeps the
    // collection-level fact.
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('optedout', { faviconCdnAllowed: false }),
      childrenItem('allowed', {}),
    ], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)

    const newest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Newest'))
    expect(newest).toBeTruthy()
    await act(async () => { newest?.click() })
    await waitForDom(() => document.querySelector('[data-sort="created_desc"]') !== null)

    // Only the sibling without the opt-out hotlinks the CDN. Regression: the
    // children-layer mapping dropped the node fact, so the collection-level
    // flag revived the CDN for the explicit-none bookmark in the sorted view.
    const cdnSrcs = [...document.querySelectorAll<HTMLImageElement>('img')]
      .map((img) => img.getAttribute('src'))
      .filter((src): src is string => src !== null && /favicon\.im/.test(src))
    expect(cdnSrcs).toEqual(['https://a.favicon.im/allowed.example?throw-error-on-404=true'])
    const rows = [...document.querySelectorAll('[data-collection-resource]')]
    const optedOutRow = rows.find((row) => row.textContent?.includes('optedout'))
    expect(optedOutRow).toBeTruthy()
    expect(optedOutRow?.querySelector('img')).toBeNull()
  })

  it('keeps the owner\'s pin mark on bookmarks in the sorted layer', async () => {
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('Pinned source', { pinned: true }),
      childrenItem('Other source', {}),
    ], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)
    const newest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Newest'))
    await act(async () => { newest?.click() })
    await waitForDom(() => document.querySelector('[data-sort="created_desc"]') !== null)

    const marks = [...document.querySelectorAll('[data-testid="bookmark-pinned"]')]
    expect(marks).toHaveLength(1)
    expect(marks[0]!.closest('[data-collection-resource]')?.textContent).toContain('Pinned source')
  })

  it('pages the children layer with nextCursor via Load more', async () => {
    mocks.listCollectionChildren
      .mockResolvedValueOnce(childrenPage('created_asc', [
        childrenItem('First item'),
        childrenItem('Second item'),
      ], 'cursor-page-1'))
      .mockResolvedValueOnce(childrenPage('created_asc', [
        childrenItem('Third item'),
      ], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)

    const oldest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Oldest')
    await act(async () => { oldest?.click() })

    await waitForDom(() => document.body.textContent?.includes('Second item') === true)
    const loadMore = document.querySelector<HTMLButtonElement>('[data-collection-children-load-more]')
    expect(loadMore).not.toBeNull()
    await act(async () => { loadMore?.click() })

    await waitForDom(() => document.body.textContent?.includes('Third item') === true)
    expect(mocks.listCollectionChildren).toHaveBeenLastCalledWith('col-public', expect.objectContaining({
      sort: 'created_asc',
      cursor: 'cursor-page-1',
    }))
    // No more pages: the Load more button disappears.
    expect(document.querySelector('[data-collection-children-load-more]')).toBeNull()
  })

  it('switching view or filtering a sorted layer keeps the loaded pages instead of re-sorting', async () => {
    mocks.listCollectionChildren
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('First item')], 'cursor-page-1'))
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('Second item')], null))
    renderCollection('/c/research-notes?sort=created_desc')
    await waitForDom(() => document.body.textContent?.includes('First item') === true)
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-collection-children-load-more]')?.click() })
    await waitForDom(() => document.body.textContent?.includes('Second item') === true)
    expect(mocks.listCollectionChildren).toHaveBeenCalledTimes(2)

    for (const label of ['Gallery', 'List', 'Compact', 'Board']) {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((candidate) => candidate.textContent?.trim() === label)
      if (!button) throw new Error(`${label} view button missing`)
      await act(async () => { button.click() })
      expect(document.body.textContent).not.toContain('Sorting bookmarks')
      expect(document.body.textContent).toContain('Second item')
    }
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter bookmarks"]')
    if (!filter) throw new Error('Filter input missing')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, 'second')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(captureSearch).toContain('q=second')
    expect(document.body.textContent).not.toContain('Sorting bookmarks')
    expect(document.body.textContent).toContain('Second item')
    expect(mocks.listCollectionChildren).toHaveBeenCalledTimes(2)
  })

  it('falls back to the curated snapshot layer when the children endpoint 404s (flag off)', async () => {
    mocks.listCollectionChildren.mockRejectedValue(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'not found',
    }))
    renderCollection('/c/research-notes?sort=created_desc')
    await waitForDom(domFinishedLoading)

    // The snapshot layer re-appears (curated default) and the URL drops the
    // unsupported sort.
    await waitForDom(() => document.querySelector('[data-sort="curated"]') !== null)
    expect(captureSearch).not.toContain('sort=created_desc')
    // The backend receives exactly the one initial request for the unsupported
    // sort (StrictMode test harness may mount the effect twice — at least one
    // and never more than the effect-driven calls).
    expect(mocks.listCollectionChildren).toHaveBeenCalled()
    // The snapshot bookmark is rendered again.
    await waitForDom(() => document.body.textContent?.includes('Oldest source') === true)
  })

  it('F1: a ?sort= on a reading_path renders curated content and strips the param', async () => {
    const pathBase = snapshot([rootNode(), bookmark('Path bookmark')])
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({
      ...pathBase,
      collection: { ...pathBase.collection, kind: 'reading_path' },
    })
    renderCollection('/c/research-notes?sort=created_desc')
    // Curated content, never the "This order isn't available" empty state.
    await waitForDom(() => document.body.textContent?.includes('Path bookmark') === true)
    expect(document.body.textContent).not.toContain("This order isn't available")
    // The stale param is dropped and the children endpoint is never touched.
    await waitForDom(() => document.querySelector('[data-sort="curated"]') !== null)
    expect(captureSearch).not.toContain('sort=created_desc')
    expect(mocks.listCollectionChildren).not.toHaveBeenCalled()
  })

  it('F1: with the flag off a ?sort= renders curated content, not the unavailable state', async () => {
    ;(window as { __KNOWN_FLAGS__?: Record<string, boolean> }).__KNOWN_FLAGS__ = { faviconPolicy: false }
    try {
      renderCollection('/c/research-notes?sort=created_desc')
      await waitForDom(() => document.body.textContent?.includes('Oldest source') === true)
      expect(document.body.textContent).not.toContain("This order isn't available")
      await waitForDom(() => document.querySelector('[data-sort="curated"]') !== null)
      expect(captureSearch).not.toContain('sort=created_desc')
      // The flag-off page never calls the children endpoint for the sort.
      expect(mocks.listCollectionChildren).not.toHaveBeenCalled()
    } finally {
      ;(window as { __KNOWN_FLAGS__?: Record<string, boolean> }).__KNOWN_FLAGS__ = undefined
    }
  })

  it("F1: a sorted visit paints the loading state first, never \"This order isn't available\"", () => {
    writeRouteCache('public-collection:research-notes', snapshot([rootNode(), bookmark('Oldest source')]))
    const html = renderToString(
      <MemoryRouter initialEntries={['/c/research-notes?sort=created_desc']}>
        <Routes>
          <Route path="/c/:slug" element={<Collection />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(html).toContain('Sorting bookmarks…')
    expect(html).not.toContain("This order isn't available")
  })

  it('F3: a load-more that lands after a sort switch is dropped, not appended', async () => {
    const stalePage2 = deferred<CollectionChildrenPage>()
    mocks.listCollectionChildren
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('CD-1')], 'cursor-cd'))
      .mockReturnValueOnce(stalePage2.promise)
      .mockResolvedValueOnce(childrenPage('created_asc', [childrenItem('CA-1')], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)

    const newest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Newest'))
    await act(async () => { newest?.click() })
    await waitForDom(() => document.body.textContent?.includes('CD-1') === true)

    const loadMore = document.querySelector<HTMLButtonElement>('[data-collection-children-load-more]')!
    await act(async () => { loadMore.click() })
    await waitForDom(() => (mocks.listCollectionChildren as ReturnType<typeof vi.fn>).mock.calls.length >= 2)

    // Switch sort while the continuation is still in flight.
    const oldest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Oldest')
    await act(async () => { oldest?.click() })
    await waitForDom(() => document.body.textContent?.includes('CA-1') === true)
    expect(document.body.textContent).not.toContain('CD-1')

    // The old continuation resolves afterwards: its items must not bleed into
    // the new created_asc layer.
    await act(async () => {
      stalePage2.resolve(childrenPage('created_desc', [childrenItem('STALE page 2')], null))
    })
    await waitForDom(() => (mocks.listCollectionChildren as ReturnType<typeof vi.fn>).mock.calls.length >= 3)
    expect(document.body.textContent).not.toContain('STALE page 2')
  })

  it('F3: an expired children cursor reloads from the first page instead of a stuck button', async () => {
    mocks.listCollectionChildren
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('Item 1')], 'cursor-expired'))
      .mockRejectedValueOnce(new ProductApiError({ status: 400, code: 'invalid_cursor', message: 'cursor expired' }))
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('Fresh start')], 'cursor-fresh'))
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('Fresh page 2')], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)

    const newest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Newest'))
    await act(async () => { newest?.click() })
    await waitForDom(() => document.body.textContent?.includes('Item 1') === true)

    const loadMore = document.querySelector<HTMLButtonElement>('[data-collection-children-load-more]')!
    await act(async () => { loadMore.click() })

    // Recovery: page 1 is re-fetched WITHOUT the stale cursor.
    await waitForDom(() => document.body.textContent?.includes('Fresh start') === true)
    const recoveryCall = (mocks.listCollectionChildren as ReturnType<typeof vi.fn>).mock.calls.at(-1)!
    expect(recoveryCall[1]).toEqual(expect.objectContaining({ sort: 'created_desc' }))
    expect(recoveryCall[1]).not.toHaveProperty('cursor')
    expect(document.body.textContent).not.toContain('Item 1')
    expect(document.querySelector('[data-testid="collection-children-notice"]')?.textContent)
      .toContain('reloaded from the first page')

    // The button is alive again: the next click pages normally.
    const freshLoadMore = document.querySelector<HTMLButtonElement>('[data-collection-children-load-more]')!
    expect(freshLoadMore).not.toBeNull()
    expect(freshLoadMore.disabled).toBe(false)
    await act(async () => { freshLoadMore.click() })
    await waitForDom(() => document.body.textContent?.includes('Fresh page 2') === true)
  })

  it('F4: sorted search with no matches on page 1 keeps Load more for later pages', async () => {
    mocks.listCollectionChildren
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('Dog')], 'cursor-dog'))
      .mockResolvedValueOnce(childrenPage('created_desc', [childrenItem('Zebra')], null))
    renderCollection('/c/research-notes?sort=created_desc&q=zeb')
    await waitForDom(() => document.body.textContent?.includes('No bookmarks match') === true)
    expect(document.body.textContent).toContain('Nothing in this collection matches “zeb”.')
    expect(document.body.textContent).toContain('Searching the items loaded so far. Load more to search further.')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Clear search')).toBe(true)

    const loadMore = document.querySelector<HTMLButtonElement>('[data-collection-children-load-more]')
    expect(loadMore).not.toBeNull()
    await act(async () => { loadMore?.click() })

    await waitForDom(() => document.body.textContent?.includes('Zebra') === true)
    expect(mocks.listCollectionChildren).toHaveBeenLastCalledWith('col-public', expect.objectContaining({
      sort: 'created_desc',
      cursor: 'cursor-dog',
    }))
    expect(document.body.textContent).not.toContain('Searching the items loaded so far')
  })

  it('R13-07: a time-sorted search with more pages says it only covers loaded items', async () => {
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('Zebra'),
    ], 'cursor-more'))
    renderCollection('/c/research-notes?sort=created_desc&q=zeb')
    await waitForDom(() => document.body.textContent?.includes('Zebra') === true)
    const html = document.querySelector('[data-testid="public-collection-page"]')?.innerHTML ?? ''
    const noticeAt = html.indexOf('Searching the items loaded so far. Load more to search further.')
    const resultAt = html.indexOf('data-collection-resource')
    expect(noticeAt).toBeGreaterThan(-1)
    expect(resultAt).toBeGreaterThan(noticeAt)
    expect(document.querySelector('[data-collection-children-load-more]')).not.toBeNull()
  })

  it('R13-07: clearing a sorted search keeps the current folder', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      bookmark('Root only'),
    ]))
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('Folder item'),
    ], null))
    renderCollection('/c/research-notes?sort=created_desc&folder=folder-papers&q=missing')
    await waitForDom(() => document.body.textContent?.includes('No bookmarks match') === true)
    expect(document.body.textContent).toContain('Nothing in this folder matches “missing”.')
    expect(document.body.textContent).not.toContain('Searching the items loaded so far')
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Clear search')
    if (!clear) throw new Error('Clear search button missing')
    await act(async () => { clear.click() })
    expect(captureSearch).toContain('folder=folder-papers')
    expect(captureSearch).toContain('sort=created_desc')
    expect(captureSearch).not.toContain('q=')
    await waitForDom(() => document.body.textContent?.includes('Folder item') === true)
    expect(document.body.textContent).not.toContain('Root only')
  })

  it('R13-08: a folder card in created_desc mode does not show an item count', async () => {
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('Sorted folder', { kind: 'folder', url: null }),
    ], null))
    renderCollection('/c/research-notes?sort=created_desc')
    await waitForDom(() => document.querySelector('[data-sort="created_desc"] [data-collection-subfolder]') !== null)
    const card = document.querySelector('[data-sort="created_desc"] [data-collection-subfolder]')
    expect(card).toBeTruthy()
    expect(card?.textContent ?? '').not.toMatch(/\bitems?\b/)
  })

  it('F5: a url-null bookmark shows as a titled row in sorted mode, same as curated', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(
      snapshot([rootNode(), bookmark('Curated no-URL bookmark', 'root-1', null)]),
    )
    mocks.listCollectionChildren.mockResolvedValue(childrenPage('created_desc', [
      childrenItem('Sorted no-URL bookmark', { url: null }),
    ], null))
    renderCollection('/c/research-notes')
    await waitForDom(domFinishedLoading)

    const newest = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Newest'))
    await act(async () => { newest?.click() })
    await waitForDom(() => document.body.textContent?.includes('Sorted no-URL bookmark') === true)

    const manual = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === "Curator's order")
    await act(async () => { manual?.click() })
    await waitForDom(() => document.body.textContent?.includes('Curated no-URL bookmark') === true)
  })

  it('counts loaded bookmarks inside a sorted folder and hides the chip until that layer is ready', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      bookmark('Snapshot paper', 'folder-papers'),
    ]))
    const pending = deferred<CollectionChildrenPage>()
    mocks.listCollectionChildren.mockImplementation(() => pending.promise)
    renderCollection('/c/research-notes?sort=created_desc&folder=folder-papers&q=keep')
    await waitForDom(() => document.body.textContent?.includes('Sorting bookmarks') === true)
    const toolbarText = () => document.querySelector('[data-testid="collection-toolbar"]')?.textContent ?? ''
    expect(toolbarText()).not.toMatch(/\d+ (of \d+ )?bookmarks?/)

    await act(async () => {
      pending.resolve(childrenPage('created_desc', [
        childrenItem('Keep me'),
        childrenItem('Drop me'),
        childrenItem('A folder', { kind: 'folder', url: null }),
      ], null))
    })
    await waitForDom(() => toolbarText().includes('1 of 2 bookmarks'))
    expect(document.body.textContent).not.toContain('Searching the items loaded so far')
  })
})