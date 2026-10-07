// @vitest-environment happy-dom
/* Reading-queue widget boundary.
 *
 * Behaviour — rendered against the real widget with the Product client mocked:
 * the exact reads (in_progress first, saved nodes as the empty fallback), the
 * row hrefs built by resourceReaderPath, availability filtering, the local
 * mark-read flow, the failure/empty/signed-out states and Retry. The old suite
 * asserted much of this by scanning the component source; those clauses are now
 * observed as rendered output and calls.
 *
 * Architecture — absences a render cannot reach: a legacy hook or transport
 * import that the driven path never executes, a feature-flag gate the widget
 * must not consult, and the retired mock queue locators. An unused import or an
 * unrendered branch changes no frame, so those are asserted on module
 * specifiers and symbols.
 */
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingProgressView, SavedResourceView } from '../../api/types'
import { resourceReaderPath } from '../../lib/useResourceNode'
import { ReadingQueueWidget } from './ReadingQueueWidget'
import widgetSource from './ReadingQueueWidget.tsx?raw'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  getReadingProgressPage: vi.fn(),
  loadSavedResources: vi.fn(),
  putReadingProgress: vi.fn(),
  auth: { isLoggedIn: true, bootstrapping: false },
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getReadingProgressPage: mocks.getReadingProgressPage,
      loadSavedResources: mocks.loadSavedResources,
      putReadingProgress: mocks.putReadingProgress,
    },
  }
})

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

function progressPage(items: ReadingProgressView[] = []) {
  return { items, page: { returnedCount: items.length, hasMore: false, nextCursor: null } }
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

function hrefFor(item: Pick<ReadingProgressView, 'resourceId' | 'resourceType' | 'target'>): string {
  return resourceReaderPath(item.resourceId, {
    collectionId: item.target.collectionId,
    subjectType: item.resourceType,
  })
}

describe('ReadingQueueWidget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    window.__KNOWN_FLAGS__ = { readableReplica: true }
    /* BASE endpoint implementations, not one-shot queues: StrictMode mounts the
       subtree twice, so the queue's special value would be consumed by whichever
       mount happened to run first and the other mount would read `undefined`.
       Each test overrides these with `mockResolvedValue`, i.e. "this endpoint
       answers the same way for every read". */
    mocks.getReadingProgressPage.mockResolvedValue(progressPage())
    mocks.loadSavedResources.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    localStorage.clear()
    delete window.__KNOWN_FLAGS__
  })

  function render(resourceId = 'd-reading', initialEntries = ['/library']) {
    mountTree(
        <MemoryRouter initialEntries={initialEntries}>
          <ReadingQueueWidget resourceId={resourceId} />
        </MemoryRouter>,
      )
  }

  describe('reading queue behaviour', () => {
    it('shows in_progress titles from reading-progress with resourceReaderPath hrefs', async () => {
      const item = inProgressItem()
      // Both StrictMode mounts read the same in-progress page.
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([item]))
      render()
      await waitForDom(domFinishedLoading)
      expect(mocks.getReadingProgressPage).toHaveBeenCalledWith(
        { status: 'in_progress', limit: 5 },
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(mocks.loadSavedResources).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Attention Is All You Need')
      expect(document.body.textContent).toContain('62% read')
      expect(document.querySelector(`a[href="${hrefFor(item)}"]`)).not.toBeNull()
      expect(document.querySelector('[data-resource="d-reading"]')).not.toBeNull()
      expect(document.querySelector('a[href^="/r/d-reading"]')).toBeNull()
      expect(document.querySelector('a[href="/path/interface-systems"]')).toBeNull()
      expect(document.querySelector('a[href="/library"]')).not.toBeNull()
      /* Rows open in the same tab: the widget must not hand a reader a new
         window (the old source scan asserted `target="_blank"` was absent). */
      expect([...document.querySelectorAll('a[target]')]).toEqual([])
    })

    it('fills an empty in_progress queue from saved nodes', async () => {
      const item = savedNode()
      // The fallback read answers with the saved node on every mount.
      mocks.loadSavedResources.mockResolvedValue([item])
      render()
      await waitForDom(domFinishedLoading)
      expect(mocks.loadSavedResources).toHaveBeenCalledWith(
        { resourceType: 'node', limit: 5 },
        expect.objectContaining({ maxRetries: 0 }),
      )
      expect(document.body.textContent).toContain('Hugging Face 模型库')
      expect(document.body.textContent).toContain('Saved')
      expect(document.querySelector(`a[href="${hrefFor(item)}"]`)).not.toBeNull()
    })

    it('opens the original source when Reader exposure is off', async () => {
      window.__KNOWN_FLAGS__ = { readableReplica: false }
      const item = inProgressItem()
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([item]))
      render()
      await waitForDom(domFinishedLoading)

      const source = document.querySelector<HTMLAnchorElement>('a[href="https://arxiv.org/abs/1706.03762"]')
      expect(source?.getAttribute('target')).toBe('_blank')
      expect(document.querySelector('a[href^="/read/"]')).toBeNull()
    })

    it('keeps only available targets and still routes collection items through /read/', async () => {
      const collection = inProgressItem({
        resourceType: 'collection',
        resourceId: 'col-u01-01',
        target: {
          availability: 'available',
          collectionId: 'col-u01-01',
          title: 'LLM learning path',
          url: null,
        },
      })
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([
        inProgressItem({
          resourceId: 'nd-gone',
          target: {
            availability: 'unavailable',
            collectionId: 'col-u01-01',
            title: 'Missing node',
            url: null,
          },
        }),
        collection,
      ]))
      render()
      await waitForDom(domFinishedLoading)
      expect(mocks.loadSavedResources).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('LLM learning path')
      expect(document.body.textContent).not.toContain('Missing node')
      expect(document.querySelector(`a[href="${hrefFor(collection)}"]`)).not.toBeNull()
      expect(document.querySelector('a[href*="slug="]')).toBeNull()
      expect(hrefFor(collection).startsWith('/read/')).toBe(true)
      expect(hrefFor(collection)).toContain('subjectType=collection')
    })

    it('encodes resourceId through resourceReaderPath instead of Today’s handwritten path', async () => {
      const item = inProgressItem({
        resourceId: 'nd/col-1',
        target: {
          availability: 'available',
          collectionId: 'col/a',
          title: 'Encoded locator',
          url: null,
        },
      })
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([item]))
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector(`a[href="${hrefFor(item)}"]`)).not.toBeNull()
      expect(document.querySelector('a[href="/read/nd/col-1?collectionId=col/a&subjectType=node"]')).toBeNull()
    })

    it('does not treat AbortError as failure or fall back to mock links', async () => {
      // Every read aborts, so the guarantee is exercised on the settled mount too
      // (a one-shot rejection would be consumed by the first StrictMode mount).
      mocks.getReadingProgressPage.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
      render()
      await settled()
      // The widget is still there: the absence of an alert below is an absence of
      // an error, not of the component.
      expect(document.querySelector('[data-resource="d-reading"]')).not.toBeNull()
      expect(document.querySelector('[role="alert"]')).toBeNull()
      expect(document.body.textContent).not.toContain('medium.com')
      expect(document.body.textContent).not.toContain('Every Layout')
      expect(document.querySelector('a[href="/r/d-reading"]')).toBeNull()
    })

    it('shows EmptyState on failure without mock queue rows', async () => {
      mocks.getReadingProgressPage.mockRejectedValue(new Error('network'))
      render()
      await waitForDom(domFinishedLoading)
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn't load your reading queue")
      expect(document.body.textContent).not.toContain('medium.com')
      expect(document.body.textContent).not.toContain('Every Layout')
      expect(document.querySelector('ul')).toBeNull()
    })

    it('refetches the queue from Retry after a failure', async () => {
      mocks.getReadingProgressPage.mockRejectedValue(new Error('network'))
      render()
      await waitForDom(domFinishedLoading)
      const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Try again')
      if (!retry) throw new Error('retry button missing')
      const callsBeforeRetry = mocks.getReadingProgressPage.mock.calls.length
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([inProgressItem()]))
      await act(async () => {
        retry.click()
        await Promise.resolve()
      })
      await waitForDom(() => document.body.textContent?.includes('Attention Is All You Need') === true)
      expect(mocks.getReadingProgressPage.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
      expect(document.querySelector('[role="alert"]')).toBeNull()
    })

    it('shows EmptyState and a login link when signed out', async () => {
      mocks.auth.isLoggedIn = false
      render()
      await waitForDom(domFinishedLoading)
      expect(mocks.getReadingProgressPage).not.toHaveBeenCalled()
      expect(mocks.loadSavedResources).not.toHaveBeenCalled()
      expect(document.body.textContent).toContain('Sign in to see your queue')
      const loginLink = document.querySelector<HTMLAnchorElement>('a[href^="/login"]')
      expect(loginLink?.getAttribute('href')).toBe('/login?returnTo=%2Flibrary')
      expect(document.querySelector('ul')).toBeNull()
    })

    it('marks read locally by resourceId and does not PATCH progress', async () => {
      const item = inProgressItem()
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([item]))
      render()
      await waitForDom(domFinishedLoading)
      const mark = document.querySelector<HTMLButtonElement>('button[aria-label="Mark Attention Is All You Need as read"]')
      if (!mark) throw new Error('mark-read button missing')
      expect(mark.getAttribute('aria-pressed')).toBe('false')
      act(() => {
        mark.click()
      })
      expect(mocks.putReadingProgress).not.toHaveBeenCalled()
      expect(JSON.parse(localStorage.getItem('known.library.read.v1') ?? '[]')).toContain(item.resourceId)
      expect(document.querySelector('ul')).toBeNull()
      expect(document.body.textContent).toContain('Queue clear')
    })

    it('moves a locally read item out of Open and back under the All filter', async () => {
      const item = inProgressItem()
      mocks.getReadingProgressPage.mockResolvedValue(progressPage([item]))
      render()
      await waitForDom(domFinishedLoading)
      const mark = document.querySelector<HTMLButtonElement>('button[aria-label="Mark Attention Is All You Need as read"]')
      if (!mark) throw new Error('mark-read button missing')
      act(() => {
        mark.click()
      })
      expect(document.querySelector(`a[href="${hrefFor(item)}"]`)).toBeNull()

      const all = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'All')
      if (!all) throw new Error('All filter missing')
      act(() => {
        all.click()
      })
      /* Under All the row is back and reflects the local mark. */
      expect(document.querySelector(`a[href="${hrefFor(item)}"]`)).not.toBeNull()
      expect(document.querySelector('button[aria-label="Mark Attention Is All You Need as unread"]')?.getAttribute('aria-pressed')).toBe('true')
      expect(mocks.putReadingProgress).not.toHaveBeenCalled()
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps legacy, mock and transport fallbacks out of the widget', () => {
      /* Rendered output above proves the live path uses the barrel client and
         the reader path, and that no mock queue row appears. What a render
         cannot prove is an absence in a branch the test never drives: a legacy
         list hook or a direct transport import would still ship unused. These
         are asserted on module specifiers and symbols, so renaming a local
         variable cannot turn them red and adding the fallback cannot leave them
         green. The positive anchor first: a source that failed to load would
         otherwise pass every absence check. */
      expect(widgetSource).toMatch(/from ['"]\.\.\/\.\.\/api['"]/u)
      expect(widgetSource).not.toMatch(
        /from ['"][^'"]*(?:mock-data|legacy-demo|product-transport)['"]/u,
      )
      expect(widgetSource).not.toMatch(/from ['"][^'"]*api\/productClient['"]/u)
      expect(widgetSource).not.toContain('useReadingProgressList')
      expect(widgetSource).not.toContain('FEATURE_FLAGS')
      /* Retired mock queue locators must not come back in any branch. */
      expect(widgetSource).not.toContain('myLinks')
      expect(widgetSource).not.toContain('interface-systems')
      expect(widgetSource).not.toContain('legacy-demo')
    })
  })
})
