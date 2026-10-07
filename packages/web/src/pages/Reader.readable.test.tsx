// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadableReplicaView } from '../api/types'
import { applySessionView, clearSession } from '../api/sessionStore'
import { NODE_ID, COLLECTION_ID, SOURCE_URL, replica, highlightAnnotation, editor, publicSnapshot } from './Reader.readable.test-helper'
import { clearRouteCache } from '../lib/routeCache'
import { Reader } from './Reader'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const flags = vi.hoisted(() => ({ readable: true, annotations: true, readingProgress: false }))
const session = vi.hoisted(() => ({ isLoggedIn: true }))

const mocks = vi.hoisted(() => ({
  loadEditorSnapshot: vi.fn(),
  loadPublicCollectionSnapshot: vi.fn(),
  loadAnnotations: vi.fn(),
  createAnnotation: vi.fn(),
  getNodeReadableReplica: vi.fn(),
  enqueueNodeReadableExtract: vi.fn(),
  getReadingProgress: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: (flag: string) => (
      (flag === 'annotations' && flags.annotations)
      || (flag === 'readingProgress' && flags.readingProgress)
    ),
    isReadableReplicaExposureEnabled: () => flags.readable,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      loadAnnotations: mocks.loadAnnotations,
      createAnnotation: mocks.createAnnotation,
      getNodeReadableReplica: mocks.getNodeReadableReplica,
      enqueueNodeReadableExtract: mocks.enqueueNodeReadableExtract,
      getReadingProgress: mocks.getReadingProgress,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: session.isLoggedIn, bootstrapping: false }),
}))

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.toast, error: mocks.toast }),
}))

function replicaState(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="reader-replica-state"]')
}

function buttonsNamed(pattern: RegExp): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => (
    pattern.test(button.getAttribute('aria-label') ?? button.textContent ?? '')
  ))
}

function highlightControls(): HTMLButtonElement[] {
  return buttonsNamed(/highlight/i)
}

function retryExtractButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Retry extract')
}

function openOriginalLinks(): HTMLAnchorElement[] {
  return [...document.querySelectorAll<HTMLAnchorElement>('a')].filter((link) => link.textContent === 'Open original')
}

describe('Reader readable replica wiring', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    // The reader warm-starts from the route cache (resource node + replica);
    // a previous test's snapshot must not leak into this one.
    clearRouteCache()
    flags.readable = true
    flags.annotations = true
    flags.readingProgress = false
    session.isLoggedIn = true
    document.body.innerHTML = '<div id="test-root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.loadEditorSnapshot.mockResolvedValue(editor())
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(publicSnapshot())
    mocks.loadAnnotations.mockResolvedValue([])
    mocks.getNodeReadableReplica.mockResolvedValue(replica({ status: 'unsupported', sections: [], wordCount: 0, title: null, byline: null }))
    mocks.enqueueNodeReadableExtract.mockResolvedValue(replica({ status: 'pending', sections: [], wordCount: 0, title: null, byline: null }))
    mocks.getReadingProgress.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    clearSession()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function renderReader(path = `/read/${NODE_ID}?collectionId=${COLLECTION_ID}&subjectType=node`): void {
    const host = document.getElementById('test-root')
    if (!host) throw new Error('test host missing')
    mountTree(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/read/:resourceId" element={<Reader />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('sends zero readable HTTP when exposure is off and explains the missing copy in the main column', async () => {
    flags.readable = false
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="reader-page"]')).not.toBeNull()
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('flag-off')
    expect(state?.textContent).toContain('No in-app copy for this bookmark')
    expect(state?.textContent).toContain("In-app reading is not available yet")
    expect(state?.querySelector('a[href="https://www.youtube.com/@3blue1brown"]')?.textContent).toBe('Open original')
    expect(mocks.getNodeReadableReplica).not.toHaveBeenCalled()
    expect(mocks.enqueueNodeReadableExtract).not.toHaveBeenCalled()
    expect(highlightControls()).toEqual([])
    expect(document.body.textContent).not.toContain('% read')
    expect(document.body.textContent).not.toContain('Contents')
  })

  it('surfaces a failed progress save in the toolbar and retries via reload', async () => {
    /* The status sentence is the only place save failures are reported —
       below 900px CSS used to hide it entirely. Pin the error surface and
       that Retry progress re-reads the authoritative state on 'error'. */
    flags.readingProgress = true
    applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2030-01-01T00:00:00Z', absoluteExpiresAt: '2030-01-02T00:00:00Z' })
    mocks.getReadingProgress.mockRejectedValue(new Error('down'))
    renderReader()
    await waitForDom(domFinishedLoading)
    const toolbarStatus = () => document.querySelector('[data-testid="reading-progress-state"] [data-save-state]')
    await waitForDom(() => toolbarStatus()?.getAttribute('data-save-state') === 'error')

    expect(toolbarStatus()?.textContent).toContain("Couldn't load progress")
    const retry = findButtonByName('Retry progress')

    mocks.getReadingProgress.mockResolvedValue(null)
    const callsBefore = mocks.getReadingProgress.mock.calls.length
    await act(async () => { retry.click() })
    await waitForDom(() => toolbarStatus()?.getAttribute('data-save-state') === 'saved')
    expect(mocks.getReadingProgress.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(document.body.textContent).not.toContain('Retry progress')
  })

  it('opens a details sheet with the public page and library edit links', async () => {
    renderReader()
    await waitForDom(domFinishedLoading)
    act(() => findButtonByName('Details').click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('3Blue1Brown')
    expect(dialog?.querySelector('a[href="/r/nd-col-u01-01-001?collectionId=collection-1&subjectType=node"]')).not.toBeNull()
    expect(dialog?.querySelector('a[href="/library/collection-1?node=nd-col-u01-01-001"]')).not.toBeNull()
  })

  it('preserves graph return context through the reader details sheet', async () => {
    renderReader(`/read/${NODE_ID}?collectionId=${COLLECTION_ID}&subjectType=node&slug=reader-notes&fromGraph=1`)
    await waitForDom(domFinishedLoading)
    act(() => findButtonByName('Details').click())
    const link = [...document.querySelectorAll('[role="dialog"] a')].find((item) => item.textContent === 'Public page')
    expect(link?.getAttribute('href')).toBe(`/r/${NODE_ID}?collectionId=${COLLECTION_ID}&subjectType=node&slug=reader-notes&fromGraph=1`)
  })

  it('returns to the graph when the reader was opened from it', async () => {
    renderReader(`/read/${NODE_ID}?collectionId=${COLLECTION_ID}&subjectType=node&slug=reader-notes&fromGraph=1`)
    await waitForDom(domFinishedLoading)
    const back = document.querySelector('a.reader-back')
    expect(back?.getAttribute('href')).toBe(`/graph/reader-notes?node=${NODE_ID}`)
    expect(back?.textContent).toContain('Back to graph')
  })

  it('tells a signed-out visitor to log in for an in-app copy', async () => {
    session.isLoggedIn = false
    renderReader(`/read/${NODE_ID}?slug=reader-notes&subjectType=node`)
    await waitForDom(domFinishedLoading)
    expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalled()
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('flag-off')
    expect(state?.textContent).toContain('No in-app copy for this bookmark')
    expect(state?.textContent).toContain('Sign in to fetch a readable copy')
    expect(state?.querySelector('a[href^="/login?returnTo="]')?.textContent).toBe('Sign in')
    expect(state?.querySelector('a[href="https://www.youtube.com/@3blue1brown"]')?.textContent).toBe('Open original')
    expect(mocks.getNodeReadableReplica).not.toHaveBeenCalled()
    const toolbar = document.querySelector('[role="group"][aria-label="Reader controls"]')
    expect(toolbar?.textContent).not.toContain('Mark complete')
    const trackLink = toolbar?.querySelector('a[href^="/login?returnTo="]')
    expect(trackLink?.textContent).toBe('Sign in to track reading')
  })

  it('asks a signed-in visitor without a collection context to open the bookmark from a Collection', async () => {
    renderReader(`/read/${NODE_ID}?slug=reader-notes&subjectType=node`)
    await waitForDom(domFinishedLoading)
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('flag-off')
    expect(state?.textContent).toContain('Open this bookmark from a Collection to read it here.')
    expect(state?.querySelector('a[href^="/login"]')).toBeNull()
    expect(mocks.getNodeReadableReplica).not.toHaveBeenCalled()
  })

  it('explains that a collection-level subject has no article in the main column', async () => {
    renderReader(`/read/${NODE_ID}?collectionId=${COLLECTION_ID}&subjectType=collection`)
    await waitForDom(domFinishedLoading)
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('flag-off')
    expect(state?.textContent).toContain('Collection notes have no article to extract')
    expect(mocks.getNodeReadableReplica).not.toHaveBeenCalled()
  })

  it('has nothing to fetch for a bookmark without a URL', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(editor(null))
    renderReader()
    await waitForDom(domFinishedLoading)
    const state = replicaState()
    expect(state?.textContent).toContain('This bookmark has no link')
    expect(openOriginalLinks()).toEqual([])
    expect(mocks.getNodeReadableReplica).not.toHaveBeenCalled()
  })

  it('shows the fetching skeleton, not the unavailable copy, while the first GET is in flight', async () => {
    let finish: ((value: ReadableReplicaView) => void) | undefined
    mocks.getNodeReadableReplica.mockImplementation(
      () => new Promise((resolve) => { finish = resolve }),
    )
    renderReader()
    await waitForDom(domFinishedLoading)
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('none')
    expect(state?.textContent).toContain('Fetching a readable copy from www.youtube.com')
    expect(state?.querySelector('[data-testid="reader-skeleton"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('No in-app copy for this bookmark')
    await act(async () => {
      finish?.(replica())
      await Promise.resolve()
    })
  })

  it('extracts none → POST → pending → ready into h2 and paragraphs without executing script', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.getNodeReadableReplica
      .mockResolvedValueOnce(replica({ status: 'none', sections: [], wordCount: 0, title: null, byline: null, extractedAt: null, etag: null }))
      .mockResolvedValueOnce(replica())
    mocks.enqueueNodeReadableExtract.mockResolvedValue(
      replica({ status: 'pending', sections: [], wordCount: 0, title: null, byline: null, extractedAt: null }),
    )
    renderReader()
    await waitForDom(domFinishedLoading)

    expect(mocks.getNodeReadableReplica).toHaveBeenCalledWith(
      COLLECTION_ID,
      NODE_ID,
      expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }),
    )
    expect(mocks.enqueueNodeReadableExtract).toHaveBeenCalledTimes(1)
    expect(mocks.enqueueNodeReadableExtract).toHaveBeenCalledWith(
      COLLECTION_ID,
      NODE_ID,
      {},
      expect.objectContaining({
        maxRetries: 0,
        intentId: 'readable-replica-extract:collection-1:nd-col-u01-01-001:auto',
      }),
    )
    expect(replicaState()?.getAttribute('data-replica-status')).toBe('pending')
    expect(replicaState()?.textContent).toContain('Fetching a readable copy from www.youtube.com')
    expect(retryExtractButtons()).toEqual([])

    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)

    expect(replicaState()).toBeNull()
    expect(document.querySelector('h2')?.textContent).toBe('Opening')
    const paragraph = document.querySelector('[data-testid="reader-paragraph"]')
    expect(paragraph).not.toBeNull()
    expect(paragraph?.querySelector('p')?.textContent).toBe('<script>alert(1)</script>Hello reader.')
    expect(document.querySelector('article script')).toBeNull()
    const mark = paragraph?.querySelector('button')
    expect(mark?.getAttribute('aria-label')).toBe('Highlight paragraph')
    expect(mark?.getAttribute('aria-pressed')).toBe('false')
    expect(mark?.textContent).toBe('')
    expect(document.querySelector('[data-testid="reader-byline"]')?.textContent).toBe('Ada')
    expect(document.querySelector('[data-testid="reader-source-line"]')?.textContent).toContain('2 min read')
    expect(mocks.enqueueNodeReadableExtract).toHaveBeenCalledTimes(1)
  })

  it('toggles a paragraph highlight through the annotation workflow from the margin control', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica())
    mocks.createAnnotation.mockResolvedValue(highlightAnnotation('p-1'))
    renderReader()
    await waitForDom(domFinishedLoading)
    const [mark] = highlightControls()
    expect(mark?.getAttribute('aria-label')).toBe('Highlight paragraph')
    await act(async () => {
      mark?.click()
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(mocks.createAnnotation).toHaveBeenCalledWith(
      COLLECTION_ID,
      { resourceType: 'node', resourceId: NODE_ID },
      expect.objectContaining({ type: 'highlight', value: { quote: 'p-1' } }),
      expect.objectContaining({ maxRetries: 0 }),
    )
    const pressed = highlightControls()[0]
    expect(pressed?.getAttribute('aria-pressed')).toBe('true')
    expect(pressed?.getAttribute('aria-label')).toBe('Remove highlight')
  })

  it('renders plain paragraphs without a margin control when annotations are not live', async () => {
    flags.annotations = false
    mocks.getNodeReadableReplica.mockResolvedValue(replica())
    renderReader()
    await waitForDom(domFinishedLoading)
    const paragraph = document.querySelector('[data-testid="reader-paragraph"]')
    expect(paragraph?.querySelector('p')?.textContent).toBe('<script>alert(1)</script>Hello reader.')
    expect(paragraph?.querySelector('button')).toBeNull()
    expect(highlightControls()).toEqual([])
    expect(mocks.loadAnnotations).not.toHaveBeenCalled()
  })

  it('mounts the inline Contents disclosure next to the rail copy', async () => {
    /* Below 900px the rail renders after the whole article, so the outline
       also mounts as a <details> at the column head; reader.css shows one
       per width band. Both mounts must exist in the DOM. */
    mocks.getNodeReadableReplica.mockResolvedValue(replica())
    renderReader()
    await waitForDom(domFinishedLoading)
    const inline = [...document.querySelectorAll('details')]
      .find((candidate) => candidate.querySelector('summary')?.textContent === 'Contents')
    expect(inline, 'inline contents disclosure must mount').toBeTruthy()
    expect(inline?.querySelector('a[href="#sec-1"]')?.textContent).toBe('Opening')
    expect(document.querySelector('[aria-labelledby="reader-contents-heading"]')).not.toBeNull()
  })

  it('does not repeat a first-section heading that equals the replica title', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      title: 'Opening',
      sections: [{
        id: 'sec-1',
        heading: 'Opening',
        paragraphs: [{ id: 'p-1', text: 'Hello reader.' }],
      }],
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('article h2')).toBeNull()
    expect(document.querySelector('article section')?.id).toBe('sec-1')
    expect(document.querySelector('[data-testid="reader-paragraph"] p')?.textContent).toBe('Hello reader.')
  })

  it('does not repeat a first-section heading that equals the bookmark title', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      title: 'Something else',
      sections: [{
        id: 'sec-1',
        heading: '3Blue1Brown · 神经网络可视化',
        paragraphs: [{ id: 'p-1', text: 'Hello reader.' }],
      }],
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('article h2')).toBeNull()
    expect(document.querySelectorAll('h1')).toHaveLength(1)
  })

  it('still labels a later section whose heading equals the replica title', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      title: 'Opening',
      sections: [
        {
          id: 'sec-1',
          heading: 'Opening',
          paragraphs: [{ id: 'p-1', text: 'Hello reader.' }],
        },
        {
          id: 'sec-2',
          heading: 'Opening',
          paragraphs: [{ id: 'p-2', text: 'Second block.' }],
        },
      ],
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const headings = [...document.querySelectorAll('article h2')].map((node) => node.textContent)
    expect(headings).toEqual(['Opening'])
    expect(document.querySelectorAll('article section')[1]?.querySelector('h2')?.textContent).toBe('Opening')
  })

  it('lists section headings under Contents and labels heading-less sections from their opening words', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      sections: [
        { id: 'sec-1', heading: 'Opening', paragraphs: [{ id: 'p-1', text: 'Hello reader.' }] },
        { id: 'sec-2', heading: '', paragraphs: [{ id: 'p-2', text: 'One two three four five six seven eight.' }] },
        { id: 'sec-3', heading: 'Closing', paragraphs: [{ id: 'p-3', text: 'Bye.' }] },
      ],
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const contents = document.querySelector('[aria-labelledby="reader-contents-heading"]')
    expect(contents?.textContent).toContain('Contents')
    const links = [...contents?.querySelectorAll('a') ?? []].map((link) => [link.getAttribute('href'), link.textContent])
    expect(links).toEqual([
      ['#sec-1', 'Opening'],
      ['#sec-2', 'One two three four five six…'],
      ['#sec-3', 'Closing'],
    ])
  })

  it('hides Contents for a single heading-less section', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      title: 'Opening',
      sections: [{ id: 'sec-1', heading: 'Opening', paragraphs: [{ id: 'p-1', text: 'Hello reader.' }] }],
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[aria-labelledby="reader-contents-heading"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Contents')
  })

  it('maps a failed extraction to human copy and offers a forced retry', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      status: 'failed',
      sections: [],
      wordCount: 0,
      title: null,
      byline: null,
      failureCode: 'timeout',
    }))
    mocks.enqueueNodeReadableExtract.mockResolvedValue(
      replica({ status: 'pending', sections: [], wordCount: 0, title: null, byline: null }),
    )
    renderReader()
    await waitForDom(domFinishedLoading)
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('failed')
    expect(state?.getAttribute('role')).toBe('alert')
    expect(state?.textContent).toContain('The site took too long to respond')
    expect(openOriginalLinks()).toHaveLength(2) // main-column state + Source panel
    const [retry] = retryExtractButtons()
    expect(retry).toBeDefined()
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(mocks.enqueueNodeReadableExtract).toHaveBeenCalledWith(
      COLLECTION_ID,
      NODE_ID,
      { force: true },
      expect.objectContaining({
        intentId: 'readable-replica-extract:collection-1:nd-col-u01-01-001:force',
      }),
    )
    await waitForDom(() => replicaState()?.getAttribute('data-replica-status') === 'pending')
    expect(replicaState()?.textContent).toContain('Fetching a readable copy')
  })

  it.each([
    ['http', 'The site returned an error'],
    ['not_html', "This link isn't an HTML page"],
    ['too_large', 'The page is too large to extract'],
    ['dns', 'The site could not be reached'],
    ['denied', "This address can't be fetched"],
    ['invalid_url', "The bookmark URL isn't valid"],
    ['empty', 'No readable article was found on this page'],
    [null, 'No readable article was found on this page'],
  ] as const)('explains failureCode %s', async (failureCode, copy) => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      status: 'failed', sections: [], wordCount: 0, title: null, byline: null, failureCode,
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(replicaState()?.textContent).toContain(copy)
    expect(retryExtractButtons()).toHaveLength(1)
  })

  it('treats a ready replica without sections as an empty extraction', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({ sections: [], wordCount: 0 }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(replicaState()?.textContent).toContain('No readable article was found on this page')
    expect(document.querySelector('[data-testid="reader-paragraph"]')).toBeNull()
  })

  it('offers Retry extract after the pending poll budget is exhausted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      status: 'pending', sections: [], wordCount: 0, title: null, byline: null, extractedAt: null,
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(retryExtractButtons()).toEqual([])
    expect(replicaState()?.querySelector('[data-testid="reader-skeleton"]')).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(16 * 2000)
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('pending')
    expect(state?.textContent).toContain('Still working — this page is taking longer than usual')
    expect(state?.querySelector('[data-testid="reader-skeleton"]')).toBeNull()
    expect(retryExtractButtons()).toHaveLength(1)
    expect(openOriginalLinks()).toHaveLength(2)
  })

  it('does not offer Retry extract when sourceUrl is the WHATWG form of node.url', async () => {
    mocks.loadEditorSnapshot.mockResolvedValue(editor('https://news.ycombinator.com'))
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      sourceUrl: 'https://news.ycombinator.com/',
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(retryExtractButtons()).toEqual([])
  })

  it('offers Retry extract in the article column when the stored sourceUrl is a different page', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      sourceUrl: 'https://example.test/old-article',
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    const [retry] = retryExtractButtons()
    expect(retry).toBeDefined()
    expect(retry?.closest('article')).not.toBeNull()
    expect(document.querySelector('aside')?.textContent).not.toContain('Retry extract')
    expect(document.body.textContent).toContain('extracted from a different address')
  })

  it('does not offer Highlight controls without in-app article paragraphs', async () => {
    mocks.getNodeReadableReplica.mockResolvedValue(replica({
      status: 'unsupported',
      sections: [],
      wordCount: 0,
      title: null,
      byline: null,
      failureCode: 'not_html',
    }))
    renderReader()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="reader-page"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="reader-paragraph"]')).toBeNull()
    expect(highlightControls()).toEqual([])
    expect(mocks.enqueueNodeReadableExtract).not.toHaveBeenCalled()
    const state = replicaState()
    expect(state?.getAttribute('data-replica-status')).toBe('unsupported')
    expect(state?.textContent).toContain("This isn't an article page")
    expect(retryExtractButtons()).toEqual([])
    expect(state?.querySelector('a')?.textContent).toBe('Open original')
  })
})
