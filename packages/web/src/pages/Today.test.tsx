// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { clearRouteCache } from '../lib/routeCache'
import type { FeedPage, ReadingProgressView, ReportIssueTimelinePage, SavedResourceView, SyncConflictSummary } from '../api/types'
import { Today } from './Today'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  loadSyncConflicts: vi.fn(),
  getFeedPage: vi.fn(),
  getReadingProgressPage: vi.fn(),
  loadSavedResources: vi.fn(),
  getFollowedReportIssuesPage: vi.fn(async (): Promise<ReportIssueTimelinePage> => ({ items: [], nextCursor: null })),
  feedEnabled: true,
  live: { readingProgress: true, savedResources: true } as Record<string, boolean>,
  auth: { isLoggedIn: true, bootstrapping: false },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isFeedExposureEnabled: () => mocks.feedEnabled,
    isLive: (flag: string) => mocks.live[flag] ?? actual.isLive(flag as never),
    productClient: {
      ...actual.productClient,
      loadSyncConflicts: mocks.loadSyncConflicts,
      getFeedPage: mocks.getFeedPage,
      getReadingProgressPage: mocks.getReadingProgressPage,
      loadSavedResources: mocks.loadSavedResources,
      getFollowedReportIssuesPage: mocks.getFollowedReportIssuesPage,
    },
  }
})
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

function conflict(overrides: Partial<SyncConflictSummary> = {}): SyncConflictSummary {
  return {
    id: 'conflict-1',
    collectionId: 'collection-1',
    targetId: 'node-1',
    type: 'concurrent_field_update',
    field: '/title',
    status: 'open',
    allowedResolutions: ['server', 'incoming'],
    revision: 'r1',
    etag: '"r1"',
    createdAt: '2026-07-28T00:00:00.000Z',
    summary: { current: 'Server title', incoming: 'Browser title' },
    ...overrides,
  }
}

function progressPage(items: ReadingProgressView[] = []) {
  return { items, page: { returnedCount: items.length, hasMore: false, nextCursor: null } }
}

function emptyFeed(): FeedPage {
  return { items: [], nextCursor: null }
}

function inProgressItem(overrides: Partial<ReadingProgressView> = {}): ReadingProgressView {
  return {
    resourceType: 'node',
    resourceId: 'nd-col-u01-01-003',
    status: 'in_progress',
    progress: 0.62,
    completedAt: null,
    updatedAt: '2026-07-25T00:00:00.000Z',
    etag: '"r1"',
    target: {
      availability: 'available',
      collectionId: 'col-u01-01',
      title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762',
    },
    ...overrides,
  }
}

function savedNode(overrides: Partial<SavedResourceView> = {}): SavedResourceView {
  return {
    resourceType: 'node',
    resourceId: 'nd-col-u01-01-011',
    savedAt: '2026-07-25T00:00:00.000Z',
    target: {
      availability: 'available',
      collectionId: 'col-u01-01',
      title: 'Hugging Face 模型库',
      url: 'https://huggingface.co/models',
    },
    ...overrides,
  }
}

function assertLegacyDemoGone() {
  expect(document.body.textContent).not.toContain('medium.com')
  expect(document.body.textContent).not.toContain('Mira Okada')
  expect(document.body.textContent).not.toContain('Lin Wei')
  expect(document.body.textContent).not.toContain('Kai Rivers')
  expect(document.body.textContent).not.toContain('Four captures')
  expect(document.body.textContent).not.toContain('2 broken')
  expect(document.body.textContent).not.toContain('planned minutes')
  expect(document.body.textContent).not.toContain('min planned')
  expect(document.body.textContent).not.toContain('59')
  expect(document.querySelector('a[href="/read/medium"]')).toBeNull()
  expect(document.querySelector('a[href="/c/interface-systems"]')).toBeNull()
  expect(document.querySelector('a[href="/classify"]')).toBeNull()
}

describe('Today sync attention', () => {

  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.feedEnabled = true
    mocks.live.readingProgress = true
    mocks.live.savedResources = true
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    window.__KNOWN_FLAGS__ = { readableReplica: true }
    mocks.loadSyncConflicts.mockResolvedValue([])
    mocks.getFeedPage.mockResolvedValue(emptyFeed())
    mocks.getReadingProgressPage.mockResolvedValue(progressPage())
    mocks.loadSavedResources.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  function render() {
    mountTree(<MemoryRouter><Today /></MemoryRouter>)
  }

  it('does not invent mock sync conflicts when the replica has none', async () => {
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).not.toContain('sync conflict')
    expect(document.body.textContent).not.toContain('Every Layout')
    expect(document.querySelector('[data-testid="today-attention"]')).toBeNull()
  })

  it('shows the live conflict count from Sync Center', async () => {
    // The count describes server state, not one call: both StrictMode mount
    // reads must see the same two conflicts.
    mocks.loadSyncConflicts.mockResolvedValue([
      conflict(),
      conflict({ id: 'conflict-2', targetId: 'node-2' }),
    ])
    render()
    await waitForDom(() => document.querySelector('[data-testid="today-attention"]') != null)
    expect(document.querySelector('[data-testid="today-attention"]')?.textContent).toContain('2 sync conflicts')
    expect(document.querySelector('a[href="/sync"]')).not.toBeNull()
  })

  it('remembers a dismissed sync notice for this session until the count changes', async () => {
    sessionStorage.removeItem('known.today.sync-notice-dismissed')
    try {
      mocks.loadSyncConflicts.mockResolvedValue([conflict(), conflict({ id: 'conflict-2', targetId: 'node-2' })])
      render()
      await waitForDom(() => document.querySelector('[data-testid="today-attention"]') != null)
      const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss sync notice"]')!
      expect(dismiss.className).toBe('btn btn-ghost btn-sm')
      act(() => dismiss.click())
      expect(document.querySelector('[data-testid="today-attention"]')).toBeNull()
      expect(sessionStorage.getItem('known.today.sync-notice-dismissed')).toBe('2')

      cleanup()
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[data-testid="today-attention"]')).toBeNull()

      cleanup()
      mocks.loadSyncConflicts.mockResolvedValue([
        conflict(), conflict({ id: 'conflict-2', targetId: 'node-2' }), conflict({ id: 'conflict-3', targetId: 'node-3' }),
      ])
      render()
      await waitForDom(() => document.querySelector('[data-testid="today-attention"]') != null)
      expect(document.querySelector('[data-testid="today-attention"]')?.textContent).toContain('3 sync conflicts')
    } finally {
      sessionStorage.removeItem('known.today.sync-notice-dismissed')
    }
  })

  it('asks signed-out visitors to sign in once and fetches no sync conflicts', async () => {
    mocks.auth.isLoggedIn = false
    mocks.getFeedPage.mockRejectedValue(new ProductApiError({ status: 401, code: 'authentication_required', message: 'sign in' }))
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.loadSyncConflicts).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Sign in to see your reading')
    const signIn = [...document.querySelectorAll<HTMLAnchorElement>('a[href^="/login"]')]
    expect(signIn.map((link) => link.getAttribute('href'))).toEqual([`/login?returnTo=${encodeURIComponent('/today')}`])
    expect(signIn[0]?.textContent).toBe('Sign in')
    expect(document.body.textContent).not.toContain('Sign in to continue')
    expect(document.body.textContent).not.toContain('Log in')
  })
})

describe('Today live blocks', () => {

  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.feedEnabled = true
    mocks.live.readingProgress = true
    mocks.live.savedResources = true
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    window.__KNOWN_FLAGS__ = { readableReplica: true }
    mocks.loadSyncConflicts.mockResolvedValue([])
    mocks.getFeedPage.mockResolvedValue(emptyFeed())
    mocks.getReadingProgressPage.mockResolvedValue(progressPage())
    mocks.loadSavedResources.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  function render() {
    mountTree(<MemoryRouter><Today /></MemoryRouter>)
  }

  it('shows the digest reminder when a readable issue remains beside a tombstone', async () => {
    window.__KNOWN_FLAGS__ = { reports: true }
    // Endpoint description: this timeline page is the answer to every mount read
    // (StrictMode aborts mount #1, so mount #2 must see the same rows).
    mocks.getFollowedReportIssuesPage.mockResolvedValue({
      items: [
        {
          id: 'ed-2', seriesId: 'series-1', issueKey: '2026-w36', editionOrdinal: 2,
          titleSnapshot: 'Weekly notes #2', summarySnapshot: null, periodStart: null, periodEnd: null,
          state: 'published', publishedAt: '2026-09-01T00:00:00.000Z',
          series: { id: 'series-1', title: 'Weekly notes', summary: null, slug: 'weekly-notes', visibility: 'public', updatedAt: '2026-09-01T00:00:00.000Z' },
        },
        {
          id: 'ed-1', seriesId: 'series-2', issueKey: '2026-w35', editionOrdinal: 1,
          titleSnapshot: 'Issue hidden', summarySnapshot: null, periodStart: null, periodEnd: null,
          state: 'hidden', publishedAt: '2026-08-25T00:00:00.000Z',
          series: { id: 'series-2', title: 'Digest hidden', summary: null, slug: null, visibility: 'public', updatedAt: '2026-08-25T00:00:00.000Z', hiddenPublic: true },
        },
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(() => document.querySelector('[data-testid="today-digest-reminder"]') != null)
    const reminder = document.querySelector('[data-testid="today-digest-reminder"]')!
    expect(reminder.textContent).toContain('Latest from digests you follow')
    expect(reminder.textContent).not.toContain('new digest issue')
    expect(reminder.querySelector('b')).toBeNull()
    expect(reminder.getAttribute('title')).toBe('Open the digest reading list')
    await waitForDom(domFinishedLoading)
  })

  it('hides the digest reminder when every followed issue is a hidden tombstone', async () => {
    window.__KNOWN_FLAGS__ = { reports: true }
    // The tombstone page is what the live (mount #2) read returns too, so the
    // hidden-only filter is what suppresses the reminder.
    mocks.getFollowedReportIssuesPage.mockResolvedValue({
      items: [
        {
          id: 'ed-1', seriesId: 'series-2', issueKey: '2026-w35', editionOrdinal: 1,
          titleSnapshot: 'Issue hidden', summarySnapshot: null, periodStart: null, periodEnd: null,
          state: 'hidden', publishedAt: '2026-08-25T00:00:00.000Z',
          series: { id: 'series-2', title: 'Digest hidden', summary: null, slug: null, visibility: 'public', updatedAt: '2026-08-25T00:00:00.000Z', hiddenPublic: true },
        },
      ],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => mocks.getFollowedReportIssuesPage.mock.calls.length > 0)
    await act(async () => {})
    expect(document.querySelector('[data-testid="today-digest-reminder"]')).toBeNull()
  })

  it('shows in_progress titles from reading-progress instead of the mock queue', async () => {
    // The in-progress row is server state: mount #2 must see it too, otherwise
    // the empty-fallback would be what the assertion below accidentally measures.
    mocks.getReadingProgressPage.mockResolvedValue(progressPage([inProgressItem()]))
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.getReadingProgressPage).toHaveBeenCalledWith(
      { status: 'in_progress', limit: 5 },
      expect.objectContaining({ maxRetries: 0 }),
    )
    // Wait for the queue to be painted before asserting the saved-nodes fallback
    // never ran — the guarantee is "an in-progress queue suppresses the fallback".
    await waitForDom(() => document.body.textContent?.includes('Attention Is All You Need') ?? false)
    expect(mocks.loadSavedResources).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Attention Is All You Need')
    expect(document.body.textContent).toContain('62% read')
    expect(document.body.textContent).toContain('arxiv.org')
    expect(document.body.textContent).toContain('1 in progress')
    expect(document.body.textContent).toContain('Continue')
    expect(document.querySelector('a[href="/read/nd-col-u01-01-003?collectionId=col-u01-01&subjectType=node"]')).not.toBeNull()
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('A clear library for today')
    // R13-60/63: the done toggle is a check, not the host's first letter; the
    // title is the one link to the resource; the host folds into the caption
    // on phones; the lede says what the page holds.
    const check = document.querySelector('button[aria-pressed="false"][aria-label="Mark Attention Is All You Need as finished"]')
    expect(check?.querySelector('svg')).not.toBeNull()
    expect(check?.textContent?.trim()).toBe('')
    expect(document.querySelectorAll('a[href="/read/nd-col-u01-01-003?collectionId=col-u01-01&subjectType=node"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="today-task-continue"]')).toBeNull()
    expect([...document.querySelectorAll('p > span')].some((span) => span.textContent === ' · arxiv.org')).toBe(true)
    expect(document.body.textContent).toContain('What you were reading, and what changed in the collections you follow.')
    assertLegacyDemoGone()
  })

  it('keeps the focus queue on screen when a route round trip remounts the page', async () => {
    mocks.getReadingProgressPage.mockResolvedValue(progressPage([inProgressItem()]))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Attention Is All You Need')

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    render()

    // First frame back: the queue is painted from cache, no spinner.
    expect(document.body.textContent).toContain('Attention Is All You Need')
    expect(document.body.textContent).not.toContain('Loading your queue')
    await waitForDom(domFinishedLoading)
  })

  it('does not render the hardcoded curator rows when the feed is empty', async () => {
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.getFeedPage).toHaveBeenCalledWith(
      { kind: 'collection_change', limit: 3 },
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(document.querySelector('a[href="/feed"]')).not.toBeNull()
    // The rail holds no second exit to the feed or to the bell's inbox.
    expect(document.querySelectorAll('a[href="/feed"]')).toHaveLength(1)
    expect(document.querySelector('aside a[href="/notifications"]')).toBeNull()
    expect([...document.querySelectorAll('aside a')].map((link) => link.textContent)).toEqual(['Capture a source', 'Reading library'])
    expect(document.body.textContent).not.toContain('Added 3 resources')
    expect(document.body.textContent).not.toContain('Published a new stage')
    expect(document.body.textContent).not.toContain('Replaced an outdated')
    assertLegacyDemoGone()
  })

  it('previews collection_change rows with Feed copy and a publication path', async () => {
    // Endpoint description: the preview page is the answer to every mount read.
    mocks.getFeedPage.mockResolvedValue({
      items: [{
        feedItemId: 'f1',
        kind: 'collection_change',
        collectionId: 'public-id',
        publicationSlug: 'llm-learning-path',
        collectionTitle: 'LLM learning path',
        actor: { profileId: 'p1', handle: 'ada.west', displayName: 'Ada West', avatarUrl: null },
        publishedAt: '2026-07-29T08:00:00.000Z',
      }],
      nextCursor: null,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Ada West updated LLM learning path')
    expect([...document.querySelectorAll('a')].some((link) => link.getAttribute('href')?.includes('/c/'))).toBe(true)
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.querySelector('a[href="/c/public-id"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Resources or path order changed')
    expect(document.body.textContent).not.toContain('Unread')
    expect(document.body.textContent).not.toContain('Mark read')
    expect(document.body.textContent).not.toContain('1h')
  })

  it('fills an empty in_progress queue from saved nodes', async () => {
    // Endpoint description: in-progress is empty, so the saved-resources
    // endpoint is the one that supplies the queue.
    mocks.loadSavedResources.mockResolvedValue([savedNode()])
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.loadSavedResources).toHaveBeenCalledWith(
      { resourceType: 'node', limit: 5 },
      expect.objectContaining({ maxRetries: 0 }),
    )
    expect(document.body.textContent).toContain('Hugging Face 模型库')
    expect(document.body.textContent).toContain('Saved')
    expect(document.querySelector('a[href="/read/nd-col-u01-01-011?collectionId=col-u01-01&subjectType=node"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('medium.com')
  })

  it('opens source pages and hides Reader-only continuation while Reader is off', async () => {
    window.__KNOWN_FLAGS__ = { readableReplica: false }
    mocks.getReadingProgressPage.mockResolvedValue(progressPage([inProgressItem()]))
    render()
    await waitForDom(domFinishedLoading)

    const source = document.querySelector<HTMLAnchorElement>('a[href="https://arxiv.org/abs/1706.03762"]')
    expect(source?.getAttribute('target')).toBe('_blank')
    expect(document.querySelector('a[href^="/read/"]')).toBeNull()
    expect(document.querySelector('[data-testid="today-task-continue"]')).toBeNull()
  })
})
