// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationScrollManager } from './NavigationScrollManager'
import { cleanup, mountTree } from '../test/render'

let navigateTo: NavigateFunction
let mountCounter = 0

function Probe() {
  navigateTo = useNavigate()
  const location = useLocation()
  return <p data-testid="location">{location.pathname}{location.search}{location.hash}</p>
}

function mountManager(initialPath = '/a') {
  mountCounter += 1
  /* MemoryRouter keys every instance's first entry "default" — without a
     unique key, positions saved by earlier tests would leak into this
     mount through the module-level store and be restored on mount. */
  mountTree(
      <MemoryRouter initialEntries={[{ pathname: initialPath, key: `test-${mountCounter}` }]}>
        <NavigationScrollManager />
        <Probe />
      </MemoryRouter>,
    )
}

function locationText() {
  return document.querySelector('[data-testid="location"]')?.textContent
}

function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
}

function setDocumentHeight(height: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: height, configurable: true })
}

function navigate(path: string, options?: { replace?: boolean }) {
  act(() => {
    navigateTo(path, options)
  })
}

function navigateBack() {
  act(() => {
    navigateTo(-1)
  })
}

/* The record path is rAF-throttled: the scroll event only parks key + y,
   the save itself runs on the next frame. */
async function flushScrollSave() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

function simulateScrollTo(y: number) {
  setScrollY(y)
  act(() => {
    window.dispatchEvent(new Event('scroll'))
  })
}

function scrollToMock() {
  return vi.mocked(window.scrollTo)
}

/* happy-dom's ResizeObserver never fires without layout, so the pending-
   restore tests drive height growth by hand. disconnect() is honored like
   in the browser — a cancelled restore must stay silent even if a late
   callback would have fired. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly callback: ResizeObserverCallback
  disconnected = false

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    FakeResizeObserver.instances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }

  trigger() {
    if (this.disconnected) return
    this.callback([], this as unknown as ResizeObserver)
  }
}

describe('NavigationScrollManager', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    setScrollY(0)
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    FakeResizeObserver.instances.length = 0
    setScrollY(0)
    setDocumentHeight(0)
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
    document.body.innerHTML = ''
  })

  it('lands at the top when a pushed navigation changes the pathname', () => {
    mountManager('/a')
    // The initial entry is a POP with nothing saved — no scroll on mount.
    expect(scrollToMock()).not.toHaveBeenCalled()

    navigate('/b')
    expect(locationText()).toBe('/b')
    expect(scrollToMock()).toHaveBeenCalledTimes(1)
    expect(scrollToMock()).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('leaves scroll alone on library desk-to-desk hops', () => {
    mountManager('/library/aaa')
    navigate('/library/bbb')
    // Desk-to-desk swaps the workspace in place; yanking to the top there
    // reads as a glitch, so the manager must not scroll at all.
    expect(locationText()).toBe('/library/bbb')
    expect(scrollToMock()).not.toHaveBeenCalled()
  })

  it('leaves scroll alone when a replace only edits the query string', () => {
    mountManager('/a')
    navigate('/a?q=x', { replace: true })
    expect(locationText()).toBe('/a?q=x')
    expect(scrollToMock()).not.toHaveBeenCalled()
  })

  it('lands at the top when a pushed hop changes the ?folder param', () => {
    mountManager('/c/research-notes')
    navigate('/c/research-notes?folder=folder-1')
    expect(locationText()).toBe('/c/research-notes?folder=folder-1')
    expect(scrollToMock()).toHaveBeenCalledTimes(1)
    expect(scrollToMock()).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })

  it('restores the saved scroll position on browser Back', async () => {
    mountManager('/a')
    simulateScrollTo(480)
    await flushScrollSave()

    navigate('/b')
    expect(scrollToMock()).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
    scrollToMock().mockClear()

    navigateBack()
    expect(locationText()).toBe('/a')
    // POP restores the position recorded under the old entry's key instead
    // of landing at the top.
    expect(scrollToMock()).toHaveBeenCalledTimes(1)
    expect(scrollToMock()).toHaveBeenCalledWith({ top: 480, behavior: 'instant' })
  })

  it('leaves scroll alone on Back when nothing was saved for the entry', () => {
    mountManager('/a')
    navigate('/b')
    scrollToMock().mockClear()

    navigateBack()
    expect(locationText()).toBe('/a')
    // First visit to the entry — there is nothing to restore.
    expect(scrollToMock()).not.toHaveBeenCalled()
  })

  it('lets the anchor win on Back to an entry with a hash', async () => {
    mountManager('/start')
    navigate('/a#sec')
    simulateScrollTo(700)
    await flushScrollSave()

    navigate('/b')
    expect(scrollToMock()).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
    scrollToMock().mockClear()

    navigateBack()
    expect(locationText()).toBe('/a#sec')
    // A saved position exists for this entry, but the hash anchor owns the
    // scroll target — the manager must not fight it.
    expect(scrollToMock()).not.toHaveBeenCalled()
  })

  describe('a pending restore (document still shorter than the target)', () => {
    const TARGET = 900

    beforeEach(() => {
      // Fits once scrollHeight >= TARGET + innerHeight = 1400.
      Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true })
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    })

    async function mountShortDocumentRestore() {
      mountManager('/a')
      simulateScrollTo(TARGET)
      await flushScrollSave()
      navigate('/b')
      // Content after the POP is still loading: far shorter than the target.
      setDocumentHeight(100)
      scrollToMock().mockClear()
      navigateBack()
      // The pre-paint attempt fired, but the document cannot hold 900 yet —
      // a ResizeObserver now retries on every height growth.
      expect(scrollToMock()).toHaveBeenCalledTimes(1)
      expect(scrollToMock()).toHaveBeenCalledWith({ top: TARGET, behavior: 'instant' })
      expect(FakeResizeObserver.instances).toHaveLength(1)
      scrollToMock().mockClear()
    }

    it('abandons the restore as soon as the visitor wheels', async () => {
      await mountShortDocumentRestore()
      act(() => {
        window.dispatchEvent(new Event('wheel'))
      })
      // The user's hand beats a pending restore: later growth must not
      // scroll again, and the observer is disconnected.
      setDocumentHeight(2000)
      act(() => {
        FakeResizeObserver.instances[0]?.trigger()
      })
      expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true)
      expect(scrollToMock()).not.toHaveBeenCalled()
    })

    it('abandons the restore when loading stalls past the timeout', async () => {
      vi.useFakeTimers()
      mountManager('/a')
      setScrollY(TARGET)
      act(() => {
        window.dispatchEvent(new Event('scroll'))
      })
      // Fake timers also fake rAF — advance one frame to land the save.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16)
      })
      navigate('/b')
      setDocumentHeight(100)
      scrollToMock().mockClear()
      navigateBack()
      expect(scrollToMock()).toHaveBeenCalledWith({ top: TARGET, behavior: 'instant' })
      scrollToMock().mockClear()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      // Timed out: growth after the deadline must not scroll again.
      setDocumentHeight(2000)
      act(() => {
        FakeResizeObserver.instances[0]?.trigger()
      })
      expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true)
      expect(scrollToMock()).not.toHaveBeenCalled()
    })

    it('retries on height growth and stops once the document fits', async () => {
      await mountShortDocumentRestore()

      // Growth but still short (1200 < 1400): retry, keep waiting.
      setDocumentHeight(1200)
      act(() => {
        FakeResizeObserver.instances[0]?.trigger()
      })
      expect(scrollToMock()).toHaveBeenCalledTimes(1)
      expect(scrollToMock()).toHaveBeenCalledWith({ top: TARGET, behavior: 'instant' })
      expect(FakeResizeObserver.instances[0]?.disconnected).toBe(false)

      // Growth past the fit line: one last scroll, then the restore closes.
      scrollToMock().mockClear()
      setDocumentHeight(1500)
      act(() => {
        FakeResizeObserver.instances[0]?.trigger()
      })
      expect(scrollToMock()).toHaveBeenCalledTimes(1)
      expect(scrollToMock()).toHaveBeenCalledWith({ top: TARGET, behavior: 'instant' })
      expect(FakeResizeObserver.instances[0]?.disconnected).toBe(true)

      scrollToMock().mockClear()
      setDocumentHeight(3000)
      act(() => {
        FakeResizeObserver.instances[0]?.trigger()
      })
      expect(scrollToMock()).not.toHaveBeenCalled()
    })
  })
})
