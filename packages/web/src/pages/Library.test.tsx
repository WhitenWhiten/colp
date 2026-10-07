// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../api/featureFlags'
import { ProductApiError } from '../api/errors'
import { cleanup, domFinishedLoading, waitForDom } from '../test/render'
import {
  entry,
  mocks,
  mount,
  setUpLibrary,
  snapshot,
  tearDownLibrary,
} from './Library.test-helper'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks: apiMocks } = await import('./Library.test-mocks')
  return {
    ...actual,
    isLive: apiMocks.isLive,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: apiMocks.loadEditorSnapshot,
      loadAnnotations: apiMocks.loadAnnotations,
      loadPublicCollectionSnapshot: apiMocks.loadPublicCollectionSnapshot,
      listFollowedCollections: apiMocks.listFollowedCollections,
      listFollowedReports: apiMocks.listFollowedReports,
      listMyReports: apiMocks.listMyReports,
      getFollowedReportIssuesPage: apiMocks.getFollowedReportIssuesPage,
      getMyLibraryOrder: apiMocks.getMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})
vi.mock('../auth/AuthContext', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useAuth: () => m.auth }
})
vi.mock('../lib/useOwnedCollections', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useOwnedCollections: () => m.collections }
})
vi.mock('../lib/useSharedCollections', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useSharedCollections: () => m.shared }
})
vi.mock('../lib/useMyCollaborationInvites', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useMyCollaborationInvites: () => m.invites }
})
vi.mock('../lib/useSavedResource', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return {
    useSavedResources: () => m.saved,
    useSavedResource: () => ({ state: 'ready', saved: false, pending: false, label: 'Save', toggle: vi.fn(), retry: vi.fn(), reload: vi.fn() }),
  }
})
vi.mock('../lib/useReadingProgress', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return {
    useReadingProgressList: () => m.progress,
    useReadingProgress: () => ({ progress: 0, status: 'not_started', saveState: 'saved', message: '', setProgress: vi.fn(), toggleComplete: vi.fn(), retry: vi.fn(), flush: vi.fn(), reload: vi.fn() }),
  }
})
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

describe('Library', () => {
  beforeEach(setUpLibrary)
  afterEach(tearDownLibrary)


  it('keeps New collection visible and never falls back to sample folders', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('a[href="/library/new"]')?.textContent).toContain('New collection')
    expect(document.body.textContent).not.toContain('All bookmarks')
    expect(document.body.textContent).toContain('No collections yet')
    expect(document.body.textContent).not.toContain('The extension only syncs collections you own, not ones shared with you.')
  })

  it('asks signed-out visitors to log in instead of showing a mock library', async () => {
    mocks.auth.isLoggedIn = false
    mocks.auth.sessionState = 'signed-out'
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Sign in to open your library')
    const login = document.querySelector('a[href^="/login?returnTo="]')
    expect(login?.textContent).toContain('Sign in')
    expect(login?.getAttribute('href')).toBe('/login?returnTo=%2Flibrary')
    expect(document.body.textContent).not.toContain('All bookmarks')
  })

  it('asks occupancy visitors to verify email instead of flashing signed-out', async () => {
    mocks.auth.isLoggedIn = false
    mocks.auth.sessionState = 'verification-required'
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Verify your email to open your library')
    expect(document.querySelector('a[href="/verify-email?returnTo=%2Flibrary"]')?.textContent).toContain('Verify email')
    expect(document.body.textContent).not.toContain('Sign in to open your library')
    expect(document.body.textContent).not.toContain('All bookmarks')
  })

  it('opens the collection workspace instead of the editor', async () => {
    mocks.collections.items = [entry('space /?#', 'Editable'), entry('locked', 'Read only', false)]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === 'locked' ? 'Read only' : 'Editable')))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-workspace"]')).not.toBeNull()
    expect(document.querySelector('aside[aria-label="Your collections"]')).not.toBeNull()
    expect(document.querySelector('div.library-collection-grid')).toBeNull()
    const open = document.querySelector<HTMLAnchorElement>('a[data-collection-id="space /?#"]')
    expect(open?.getAttribute('href')).toBe('/library/space%20%2F%3F%23')
    expect(document.querySelector('a[data-collection-id="locked"]')?.getAttribute('href')).toBe('/library/locked')
    act(() => open?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="editor-route"]')).toBeNull()
    expect(document.querySelector('[data-testid="library-workspace"]')).not.toBeNull()
  })

  it('re-pages an open collection on tab return only once it is stale (R15-29)', async () => {
    mocks.collections.items = [entry('one', 'One')]
    mount('/library/one')
    await waitForDom(domFinishedLoading)
    await waitForDom(() => mocks.loadEditorSnapshot.mock.calls.length > 0)
    const initial = mocks.loadEditorSnapshot.mock.calls.length
    const settle = () => new Promise((resolve) => { setTimeout(resolve, 400) })

    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await act(settle)
    expect(mocks.loadEditorSnapshot.mock.calls.length).toBe(initial)

    // A clock 61 s ahead that keeps ticking, so the refresh debounce can flush.
    const realNow = Date.now.bind(Date)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000)
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      await waitForDom(() => mocks.loadEditorSnapshot.mock.calls.length > initial)
    } finally {
      clock.mockRestore()
    }
  })

  it('switches Comfort and Compact bookmark layouts without a refresh', async () => {
    mocks.collections.items = [entry('one', 'One'), entry('two', 'Two')]
    mount()
    await waitForDom(domFinishedLoading)
    // The bookmarks live inside the Design folder; enter its layer first.
    act(() => {
      document.querySelector<HTMLAnchorElement>('[data-testid="library-main"] [data-collection-subfolder]')?.click()
    })
    await waitForDom(() => document.querySelector('[data-testid="library-bookmarks"]') != null)
    const comfort = document.querySelector('[data-testid="library-bookmarks"][data-density="comfortable"]')
    expect(comfort).not.toBeNull()
    expect(comfort?.className).toMatch(/library-bookmark-list--comfort/)
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="compact"]')).toBeNull()
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Compact') button.click()
      })
    })
    const compact = document.querySelector('[data-testid="library-bookmarks"][data-density="compact"]')
    expect(compact).not.toBeNull()
    expect(compact?.className).toMatch(/library-bookmark-list--compact/)
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="comfortable"]')).toBeNull()
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Comfort') button.click()
      })
    })
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="comfortable"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.className).toMatch(/library-bookmark-list--comfort/)
  })

  it('keeps Reading rows independent of a Collections failure', async () => {
    mocks.collections.state = 'error'
    mocks.collections.message = 'Collections endpoint failed'
    mocks.saved.items = [{ resourceType: 'node', resourceId: 'saved-1', target: { availability: 'available', title: 'Saved survives', url: 'https://example.test', collectionId: 'c1' } }]
    mount('/library?view=reading')
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Saved survives')
    expect(document.body.textContent).toContain('1 bookmark')
    expect(document.body.textContent).not.toContain('All bookmarks')
  })

  it('lists followed digest issues above the reading rows with a link to the directory', async () => {
    window.__KNOWN_FLAGS__ = { reports: true }
    /* The timeline endpoint's steady state. StrictMode's mount → cleanup →
       mount walk reads it twice; a single queued response would leave the
       second mount with `undefined` and blank the digest block. */
    mocks.getFollowedReportIssuesPage.mockResolvedValue({
      items: [{
        id: 'ed-3', seriesId: 'series-1', issueKey: '2026-w36', editionOrdinal: 3,
        titleSnapshot: 'Weekly notes #3', summarySnapshot: null, periodStart: null, periodEnd: null,
        state: 'published', publishedAt: '2026-09-01T00:00:00.000Z',
        series: { id: 'series-1', title: 'Weekly notes', summary: null, slug: 'weekly-notes', visibility: 'public', updatedAt: '2026-09-01T00:00:00.000Z' },
      }],
      nextCursor: null,
    })
    mount('/library?view=reading')
    await waitForDom(() => document.querySelector('[data-testid="library-digest-issues"]') != null)
    const block = document.querySelector('[data-testid="library-digest-issues"]')!
    expect(block.getAttribute('aria-labelledby')).toBe(block.querySelector('h3')?.id)
    expect(block.querySelector('h3')?.textContent).toBe('Digest issues')
    expect(block.querySelector('a[href="/reports"]')?.textContent).toBe('Browse digests')
    const row = block.querySelector<HTMLAnchorElement>('a[href="/reports/weekly-notes/issues/ed-3"]')
    expect(row?.textContent).toContain('Weekly notes #3')
    expect(row?.textContent).toContain('Weekly notes')
    expect(row?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-09-01T00:00:00.000Z')
    expect(row?.querySelector('time')?.textContent).toBe('Sep 1, 2026')
    await waitForDom(domFinishedLoading)
  })

  it('keeps a moderation-hidden digest issue as an inert tombstone row', async () => {
    window.__KNOWN_FLAGS__ = { reports: true }
    /* The timeline endpoint's steady state. StrictMode's mount → cleanup →
       mount walk reads it twice; a single queued response would leave the
       second mount with `undefined` and blank the digest block. */
    mocks.getFollowedReportIssuesPage.mockResolvedValue({
      items: [
        {
          id: 'ed-3', seriesId: 'series-1', issueKey: '2026-w36', editionOrdinal: 3,
          titleSnapshot: 'Weekly notes #3', summarySnapshot: null, periodStart: null, periodEnd: null,
          state: 'published', publishedAt: '2026-09-01T00:00:00.000Z',
          series: { id: 'series-1', title: 'Weekly notes', summary: null, slug: 'weekly-notes', visibility: 'public', updatedAt: '2026-09-01T00:00:00.000Z' },
        },
        {
          id: 'ed-2', seriesId: 'series-2', issueKey: '2026-w35', editionOrdinal: 2,
          titleSnapshot: 'Issue hidden', summarySnapshot: null, periodStart: null, periodEnd: null,
          state: 'hidden', publishedAt: '2026-08-25T00:00:00.000Z',
          series: { id: 'series-2', title: 'Digest hidden', summary: null, slug: null, visibility: 'public', updatedAt: '2026-08-25T00:00:00.000Z', hiddenPublic: true },
        },
      ],
      nextCursor: null,
    })
    mount('/library?view=reading')
    await waitForDom(() => document.querySelector('[data-digest-issue-hidden]') != null)
    const block = document.querySelector('[data-testid="library-digest-issues"]')!
    const tombstone = block.querySelector('[data-digest-issue-hidden]')!
    expect(tombstone.querySelector('a')).toBeNull()
    expect(tombstone.querySelector('strong')?.textContent).toBe('Issue hidden')
    expect(tombstone.querySelector('div.saved-resource-row--tombstone')).not.toBeNull()
    expect(tombstone.querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-25T00:00:00.000Z')
    expect(block.querySelector('a[href="/reports/weekly-notes/issues/ed-3"]')).not.toBeNull()
    await waitForDom(domFinishedLoading)
  })

  it('retries saved and progress loads from the reading error states', async () => {
    mocks.saved = { items: [], state: 'error', message: 'Saved failed', reload: vi.fn() }
    mocks.progress = { items: [], state: 'error', message: 'Progress failed', reload: vi.fn() }
    mount('/library?view=reading')
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="saved-resources-error"] button')!.click()
    })
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="reading-progress-error"] button')!.click()
    })
    expect(mocks.saved.reload).toHaveBeenCalled()
    expect(mocks.progress.reload).toHaveBeenCalled()
  })

  function followedItem(slug: string, title: string, availability: 'available' | 'unavailable' = 'available') {
    return {
      collectionId: `id-${slug}`,
      slug,
      title,
      summary: availability === 'available' ? `${title} summary` : null,
      kind: 'bookmarks' as const,
      owner: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA',
        handle: 'curator',
        displayName: 'Ada Curator',
        avatarUrl: 'https://cdn.example/curator.png',
      },
      updatedAt: '2026-08-26T01:00:00.000Z',
      followedAt: '2026-08-26T00:00:00.000Z',
      availability,
    }
  }

  function enableCollectionFollow() {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
  }

  function followingSection() {
    return document.querySelector('aside[aria-label="Your collections"] [data-testid="library-nav-following"]')
  }

  function sectionToggles() {
    return [...document.querySelectorAll<HTMLButtonElement>('button[aria-controls^="library-nav-section-"]')]
  }

  it('keeps production FEATURE_FLAGS.collectionFollow true', () => {
    expect(FEATURE_FLAGS.collectionFollow).toBe(true)
  })

  it('groups the sidebar into collapsible sections with a My collections heading', async () => {
    enableCollectionFollow()
    mocks.isLive.mockImplementation((flag: string) =>
      ['collectionList', 'savedResources', 'readingProgress', 'collaborators'].includes(flag))
    mocks.collections.items = [entry('one', 'One')]
    mocks.shared.items = [entry('shared-a', 'Shared shelf', false)]
    mocks.listFollowedCollections.mockResolvedValue({
      items: [followedItem('design-notes', 'Design notes')],
      nextCursor: null,
    })
    mount()
    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
    const toggles = sectionToggles()
    // Digests shares the collection sections' collapsible head (R12-14).
    expect(toggles.map((toggle) => toggle.textContent?.trim().replace(/\d+$/u, '').trim()))
      .toEqual(['My collections', 'Shared with you', 'Following', 'Digests'])
    for (const toggle of toggles) expect(toggle.getAttribute('aria-expanded')).toBe('true')

    const mine = toggles[0]!
    expect(document.querySelector('a[data-collection-id="one"]')).not.toBeNull()
    act(() => mine.click())
    expect(mine.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('a[data-collection-id="one"]')).toBeNull()
    expect(document.querySelector('a[data-collection-id="shared-a"]')).not.toBeNull()
    act(() => mine.click())
    expect(mine.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('a[data-collection-id="one"]')).not.toBeNull()

    const following = toggles[2]!
    act(() => following.click())
    expect(following.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('a[href="/library/following/design-notes"]')).toBeNull()
    act(() => following.click())
    expect(document.querySelector('a[href="/library/following/design-notes"]')).not.toBeNull()
  })

  it('shows Shared with you as a section with an honest empty hint', async () => {
    mocks.isLive.mockImplementation((flag: string) =>
      ['collectionList', 'savedResources', 'readingProgress', 'collaborators'].includes(flag))
    mount()
    await waitForDom(domFinishedLoading)
    const shared = document.querySelector('[data-testid="library-nav-shared"]')
    expect(shared).not.toBeNull()
    expect(shared?.textContent).toContain('Nothing is shared with you yet.')
  })

  it('does not fetch or render Following when collection-follow exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: false }
    mount()
    await waitForDom(domFinishedLoading)
    expect(mocks.listFollowedCollections).not.toHaveBeenCalled()
    expect(followingSection()).toBeNull()
    expect(document.body.textContent).not.toContain("You aren't following any collections yet.")
    expect(document.body.textContent).not.toContain("Following isn't available yet.")
  })

  it('renders followed collections as sidebar rows instead of a desk band', async () => {
    enableCollectionFollow()
    mocks.listFollowedCollections.mockResolvedValue({
      items: [followedItem('design-notes', 'Design notes')],
      nextCursor: null,
    })
    mount()
    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
    const section = followingSection()
    expect(section).not.toBeNull()
    const row = section?.querySelector<HTMLAnchorElement>('a[href="/library/following/design-notes"]')
    expect(row?.textContent).toContain('Design notes')
    expect(document.querySelector('[data-testid="library-following"]')).toBeNull()
    expect(document.querySelector('a.result-card--collection')).toBeNull()
    expect(document.querySelector('[data-testid="library-following-grid"]')).toBeNull()
  })

  it('greys out unavailable followed collections instead of dropping them', async () => {
    enableCollectionFollow()
    mocks.listFollowedCollections.mockResolvedValue({
      items: [
        followedItem('design-notes', 'Design notes'),
        followedItem('dark-shelf', 'Dark shelf', 'unavailable'),
      ],
      nextCursor: null,
    })
    mount()
    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
    const tombstone = document.querySelector('[data-testid="library-nav-following-unavailable"]')
    expect(tombstone).not.toBeNull()
    expect(tombstone?.textContent).toContain('Dark shelf')
    expect(tombstone?.textContent).toContain('Unavailable')
    expect(tombstone?.querySelector('a')).toBeNull()
    // R15-44: list semantics while idle; the item role is on the list wrapper.
    expect(tombstone?.closest('[role="listitem"]')).not.toBeNull()
    expect(tombstone?.closest('[role="tree"]')).toBeNull()
    expect(tombstone?.querySelector('[aria-disabled="true"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector('a[href="/library/following/dark-shelf"]')).toBeNull()
    expect(followingSection()?.textContent).toContain('Design notes')
  })

  it('opens a followed collection read-only on the following desk', async () => {
    enableCollectionFollow()
    mocks.collections.items = [entry('one', 'One')]
    mocks.listFollowedCollections.mockResolvedValue({
      items: [followedItem('design-notes', 'Design notes')],
      nextCursor: null,
    })
    mount('/library/following/design-notes')
    // Root layer: the Reading folder renders as a row, its bookmark behind it.
    await waitForDom(() => document.querySelector('[data-testid="library-main"] [data-collection-subfolder]') != null)
    expect(mocks.loadPublicCollectionSnapshot.mock.calls[0]?.[0]).toBe('design-notes')
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Add your first bookmark')

    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
    const selected = document.querySelector<HTMLAnchorElement>('a[href="/library/following/design-notes"]')
    expect(selected?.getAttribute('aria-current')).toBe('page')

    const moreButton = document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')
    expect(moreButton).not.toBeNull()
    act(() => moreButton?.click())
    const menu = document.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const publicLink = menu?.querySelector<HTMLAnchorElement>('a[href="/c/design-notes"]')
    expect(publicLink?.textContent).toContain('Open public page')
    expect(menu?.textContent).not.toContain('Add bookmark')
    expect(menu?.textContent).not.toContain('Edit collection')
    expect(menu?.textContent).not.toContain('Version history')
    expect(menu?.textContent).not.toContain('Collaborators')
    expect(menu?.textContent).not.toContain('Copy public link')
    expect(menu?.textContent).not.toContain('Check links')
    expect(document.querySelector('[data-testid="library-visibility"]')).toBeNull()

    // Entering the folder layer shows the public bookmark, still read-only.
    act(() => {
      document.querySelector<HTMLAnchorElement>('[data-testid="library-main"] [data-collection-subfolder]')?.click()
    })
    await waitForDom(() => document.querySelector('[data-testid="library-bookmarks"]') != null)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Public bookmark')
  })

  it('expands followed folders in the sidebar with following folder links', async () => {
    enableCollectionFollow()
    mocks.listFollowedCollections.mockResolvedValue({
      items: [followedItem('design-notes', 'Design notes')],
      nextCursor: null,
    })
    mount('/library/following/design-notes')
    await waitForDom(() => document.querySelector('button[aria-label="Expand Design notes"]') != null)
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Expand Design notes"]')
    expect(toggle).not.toBeNull()
    await act(async () => { toggle?.click() })
    await waitForDom(() =>
      document.querySelector('a[href="/library/following/design-notes?folder=pub-folder-design-notes"]') != null)
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
  })

  it('shows the empty Following hint inside the sidebar section', async () => {
    enableCollectionFollow()
    mount()
    await waitForDom(() => document.body.textContent?.includes("You aren't following any collections yet.") === true)
    expect(followingSection()?.textContent).toContain("You aren't following any collections yet.")
    expect(document.body.textContent).toContain('No collections yet')
    expect(document.querySelector('a.result-card--collection')).toBeNull()
  })

  it("shows Following isn't available yet after a backend 404", async () => {
    enableCollectionFollow()
    /* The endpoint's steady state for this test IS the 404, so it is the base
       implementation: StrictMode's two mount calls both take that branch. A
       `Once` would be drained by the first mount and read as an empty page on
       the second one, which is a fixture artefact, not the exposure state. */
    mocks.listFollowedCollections.mockRejectedValue(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'not found',
    }))
    mount()
    await waitForDom(() => document.body.textContent?.includes("Following isn't available yet.") === true)
    expect(followingSection()?.textContent).toContain("Following isn't available yet.")
    /* StrictMode double-invokes the mount effect, so two calls are correct.
       The guarantee is that the 404 state does not retry: every call is the
       same first page and no third request appears. */
    expect(mocks.listFollowedCollections).toHaveBeenCalledTimes(2)
    expect(mocks.listFollowedCollections).toHaveBeenNthCalledWith(
      2, { limit: 20 }, expect.objectContaining({ maxRetries: 0 }),
    )
  })

  it('retries a failed first Following page from the sidebar alert', async () => {
    enableCollectionFollow()
    /* Both StrictMode mount calls have to fail for the alert to survive; the
       queued success belongs to the retry request. */
    mocks.listFollowedCollections
      .mockRejectedValueOnce(new ProductApiError({ status: 500, code: 'invalid_request', message: 'failed' }))
      .mockRejectedValueOnce(new ProductApiError({ status: 500, code: 'invalid_request', message: 'failed' }))
      .mockResolvedValueOnce({ items: [followedItem('design-notes', 'Design notes')], nextCursor: null })
    mount()
    await waitForDom(() => document.body.textContent?.includes("Couldn't load collections you follow.") === true)
    const alert = followingSection()?.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Couldn't load collections you follow.")
    const retry = [...(followingSection()?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent === 'Try again')
    expect(retry).not.toBeNull()
    await act(async () => { retry?.click() })
    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
  })

  it('loads the next followed page from the sidebar Load more control', async () => {
    enableCollectionFollow()
    /* Page one is the list endpoint's steady state, so it is the base
       implementation and every mount reads it; only the request the Load more
       click produces differs. The cursor is part of the request, so the two
       cases are told apart by argument rather than by call index. */
    mocks.listFollowedCollections.mockImplementation((params: { cursor?: string } = {}) =>
      Promise.resolve(params.cursor === 'followed-page-2'
        ? { items: [followedItem('second-shelf', 'Second shelf')], nextCursor: null }
        : { items: [followedItem('design-notes', 'Design notes')], nextCursor: 'followed-page-2' }))
    mount()
    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
    const more = [...(followingSection()?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('Load more'))
    expect(more?.className).toMatch(/\blibrary-nav-more\b/)
    await act(async () => { more?.click() })
    await waitForDom(() => document.querySelector('a[href="/library/following/second-shelf"]') != null)
    /* Two mount requests for page one, then the cursor request. Locate it by
       its argument so the assertion stays about the request, not about how
       many times StrictMode invoked the mount effect. */
    const cursorCalls = mocks.listFollowedCollections.mock.calls.filter(
      (call) => (call[0] as { cursor?: string }).cursor === 'followed-page-2',
    )
    expect(cursorCalls).toHaveLength(1)
    expect(document.querySelector('a[href="/library/following/design-notes"]')).not.toBeNull()
  })

  it('reloads Following from the collection-follow channel without clearing existing rows first', async () => {
    enableCollectionFollow()
    let release!: (page: { items: ReturnType<typeof followedItem>[]; nextCursor: null }) => void
    /* The first page is the steady state and the channel-triggered reload is
       the one call that genuinely differs: it stays pending until released, so
       the test can observe the rows that survive the reload. */
    let reloaded = false
    mocks.listFollowedCollections.mockImplementation(() => {
      if (reloaded) return new Promise((resolve) => { release = resolve })
      return Promise.resolve({ items: [followedItem('design-notes', 'Design notes')], nextCursor: null })
    })
    mount()
    await waitForDom(() => document.querySelector('a[href="/library/following/design-notes"]') != null)
    reloaded = true
    act(() => {
      const channel = new BroadcastChannel('known.collection-follow.v1')
      channel.postMessage({ collectionId: 'id-design-notes' })
      channel.close()
    })
    await waitForDom(() => mocks.listFollowedCollections.mock.calls.length === 3)
    expect(document.querySelector('a[href="/library/following/design-notes"]')).not.toBeNull()
    await act(async () => {
      release({ items: [followedItem('new-shelf', 'New shelf')], nextCursor: null })
    })
    await waitForDom(() => document.querySelector('a[href="/library/following/new-shelf"]') != null)
    expect(document.querySelector('a[href="/library/following/design-notes"]')).toBeNull()
  })
})
