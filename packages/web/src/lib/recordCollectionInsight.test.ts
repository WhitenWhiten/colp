// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api'

const mocks = vi.hoisted(() => ({
  recordPublicCollectionInsightEvent: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      recordPublicCollectionInsightEvent: mocks.recordPublicCollectionInsightEvent,
    },
  }
})

type MockIntersectionObserverInstance = {
  callback: IntersectionObserverCallback
  options?: IntersectionObserverInit
  elements: Set<Element>
  disconnected: boolean
  trigger: (isIntersecting?: boolean) => void
}

const ioState = vi.hoisted(() => ({
  instances: [] as MockIntersectionObserverInstance[],
}))

describe('recordCollectionInsight', () => {
  let previousIntersectionObserver: typeof IntersectionObserver | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.recordPublicCollectionInsightEvent.mockResolvedValue(undefined)
    ioState.instances.length = 0
    window.sessionStorage.clear()
    previousIntersectionObserver = globalThis.IntersectionObserver
    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null
      readonly rootMargin: string
      readonly thresholds: readonly number[]
      readonly callback: IntersectionObserverCallback
      readonly options?: IntersectionObserverInit
      readonly elements = new Set<Element>()
      disconnected = false

      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.callback = callback
        this.options = options
        this.rootMargin = options?.rootMargin ?? '0px'
        this.thresholds = typeof options?.threshold === 'number'
          ? [options.threshold]
          : options?.threshold ?? [0]
        ioState.instances.push(this)
      }

      observe(element: Element) {
        this.elements.add(element)
      }

      unobserve(element: Element) {
        this.elements.delete(element)
      }

      disconnect() {
        this.disconnected = true
      }

      takeRecords(): IntersectionObserverEntry[] {
        return []
      }

      trigger(isIntersecting = true) {
        const entries = [...this.elements].map((target) => ({
          isIntersecting,
          intersectionRatio: isIntersecting ? 0.5 : 0,
          target,
          time: 0,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
        })) as IntersectionObserverEntry[]
        this.callback(entries, this)
      }
    }
    globalThis.IntersectionObserver = MockIntersectionObserver
  })

  afterEach(() => {
    if (previousIntersectionObserver) {
      globalThis.IntersectionObserver = previousIntersectionObserver
    }
    document.body.innerHTML = ''
  })

  it('records collection_view at most once per slug in the tab session', async () => {
    const { recordView } = await import('./recordCollectionInsight')
    recordView('research-notes')
    recordView('research-notes')
    expect(mocks.recordPublicCollectionInsightEvent).toHaveBeenCalledTimes(1)
    expect(mocks.recordPublicCollectionInsightEvent).toHaveBeenCalledWith(
      { slug: 'research-notes', eventType: 'collection_view' },
      expect.anything(),
    )
    expect(window.sessionStorage.getItem('known_insight_view_research-notes')).toBeTruthy()
  })

  it('does not send collection_view when the effect has already aborted', async () => {
    const { recordView } = await import('./recordCollectionInsight')
    const controller = new AbortController()
    controller.abort()
    recordView('aborted-notes', { signal: controller.signal })
    expect(mocks.recordPublicCollectionInsightEvent).not.toHaveBeenCalled()
  })

  it('falls back to in-memory dedupe when sessionStorage is unavailable', async () => {
    const { recordView } = await import('./recordCollectionInsight')
    const previous = window.sessionStorage
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sessionStorage blocked')
      },
    })
    try {
      recordView('memory-notes')
      recordView('memory-notes')
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: previous,
      })
    }
    expect(mocks.recordPublicCollectionInsightEvent).toHaveBeenCalledTimes(1)
  })

  it('observes preview once then ignores later intersections and disconnect', async () => {
    const { observePreview } = await import('./recordCollectionInsight')
    const element = document.createElement('div')
    document.body.appendChild(element)
    const stop = observePreview(element, 'research-notes')
    const observer = ioState.instances.at(-1)
    if (!observer) throw new Error('preview observer missing')
    expect(observer.options?.threshold).toBe(0.25)

    observer.trigger(true)
    observer.trigger(true)
    expect(mocks.recordPublicCollectionInsightEvent).toHaveBeenCalledTimes(1)
    expect(mocks.recordPublicCollectionInsightEvent).toHaveBeenCalledWith(
      { slug: 'research-notes', eventType: 'preview_open' },
    )

    mocks.recordPublicCollectionInsightEvent.mockClear()
    stop()
    observer.trigger(true)
    expect(mocks.recordPublicCollectionInsightEvent).not.toHaveBeenCalled()
  })

  it('beacons resource_open with keepalive and swallows ingest errors', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const { recordResourceOpen, recordView } = await import('./recordCollectionInsight')
      mocks.recordPublicCollectionInsightEvent.mockRejectedValueOnce(new Error('429'))
      expect(() => recordResourceOpen('research-notes', 'node-1')).not.toThrow()
      expect(mocks.recordPublicCollectionInsightEvent).toHaveBeenCalledWith(
        { slug: 'research-notes', eventType: 'resource_open', nodeId: 'node-1' },
        expect.objectContaining({ keepalive: true }),
      )
      await Promise.resolve()
      mocks.recordPublicCollectionInsightEvent.mockRejectedValueOnce(new Error('500'))
      expect(() => recordView('error-notes')).not.toThrow()
      await vi.waitFor(() => {
        expect(debug.mock.calls.length).toBeGreaterThanOrEqual(2)
      })
    } finally {
      debug.mockRestore()
    }
  })

  it('logs rejected 401/403 ingest at debug without throwing', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const { recordView, recordResourceOpen } = await import('./recordCollectionInsight')
      mocks.recordPublicCollectionInsightEvent.mockRejectedValueOnce(
        new ProductApiError(401, {
          code: 'authentication_required',
          message: 'Authentication is required.',
        }),
      )
      expect(() => recordView('stale-session-notes')).not.toThrow()
      await vi.waitFor(() => {
        expect(debug).toHaveBeenCalledWith(
          'collection insight ingest failed',
          401,
          'authentication_required',
        )
      })
      debug.mockClear()
      mocks.recordPublicCollectionInsightEvent.mockRejectedValueOnce(
        new ProductApiError(403, {
          code: 'csrf_failed',
          message: 'The request failed CSRF or Origin validation.',
        }),
      )
      expect(() => recordResourceOpen('stale-session-notes', 'node-1')).not.toThrow()
      await vi.waitFor(() => {
        expect(debug).toHaveBeenCalledWith(
          'collection insight ingest failed',
          403,
          'csrf_failed',
        )
      })
    } finally {
      debug.mockRestore()
    }
  })
})
