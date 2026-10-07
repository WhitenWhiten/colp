// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { SearchPage } from '../api/types'
import { SearchPalette } from './SearchPalette'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({ search: vi.fn(), live: true }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    isLive: (flag: string) => flag === 'search' ? mocks.live : actual.isLive(flag as never),
    productClient: { ...actual.productClient, searchResources: mocks.search },
  }
})

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function resultPage(title: string, id = title, snippet = `${title} snippet`): SearchPage {
  return {
    query: title,
    types: ['collection', 'node', 'profile', 'annotation'],
    items: [{ resourceType: 'collection', resourceId: id, title, snippet, rank: 0.8 }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
  }
}
async function flushDebounce(ms = 250) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Search palette', () => {
  let trigger: HTMLButtonElement
  beforeEach(() => {
    clearRouteCache()
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.live = true
    localStorage.clear()
    document.body.innerHTML = '<button id="trigger">Open search</button><div id="root"></div>'
    trigger = document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })
  function render(onClose = vi.fn(), open = true) {
    mountTree(<MemoryRouter initialEntries={['/']}><Routes><Route path="*" element={<SearchPalette open={open} onClose={onClose} />} /></Routes></MemoryRouter>)
    return onClose
  }
  function input() { return document.querySelector<HTMLInputElement>('[data-testid="search-palette-input"]')! }
  function type(value: string) {
    act(() => {
      const field = input()
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('debounces requests and flushes both timer and promise queues', async () => {
    mocks.search.mockResolvedValue(resultPage('systems'))
    render()
    expect(document.body.textContent).toContain('Search Know-N')
    expect(document.body.textContent).not.toContain('Search your workspace')
    type('sys')
    act(() => vi.advanceTimersByTime(249))
    expect(mocks.search).not.toHaveBeenCalled()
    await flushDebounce(1)
    expect(mocks.search).toHaveBeenCalledWith({ q: 'sys', limit: 8 }, expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }))
    expect(document.body.textContent).toContain('systems')
  })

  it('aborts an old request and generation-fences its late response', async () => {
    const oldRequest = deferred<SearchPage>()
    const newRequest = deferred<SearchPage>()
    mocks.search.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise)
    render()
    type('old')
    await flushDebounce()
    const oldSignal = mocks.search.mock.calls[0]![1].signal as AbortSignal
    type('new')
    expect(oldSignal.aborted).toBe(true)
    await flushDebounce()
    await act(async () => newRequest.resolve(resultPage('New result')))
    expect(document.body.textContent).toContain('New result')
    await act(async () => oldRequest.resolve(resultPage('Late old result')))
    expect(document.body.textContent).not.toContain('Late old result')
  })

  it('keeps focus and aria-activedescendant synchronized across keyboard navigation and restores focus on close', async () => {
    mocks.search.mockResolvedValue({ ...resultPage('First', 'first'), items: [
      { resourceType: 'collection', resourceId: 'first', title: 'First find', snippet: 'One', rank: 0.9 },
      { resourceType: 'profile', resourceId: 'profile-2', handle: 'second', displayName: 'Second find', avatarUrl: null, snippet: 'Two', rank: 0.8 },
    ] })
    const onClose = render()
    act(() => vi.runOnlyPendingTimers())
    expect(document.activeElement).toBe(input())
    type('find')
    await flushDebounce()
    expect(input().getAttribute('aria-activedescendant')).toBe('search-palette-option-0')
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(input().getAttribute('aria-activedescendant')).toBe('search-palette-option-1')
    expect(document.querySelector('#search-palette-option-1')?.getAttribute('aria-selected')).toBe('true')
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })))
    expect(input().getAttribute('aria-activedescendant')).toBe('search-palette-option-0')
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
    render(onClose, false)
    expect(document.activeElement).toBe(trigger)
  })

  it('opens the full search page on Enter when no result is highlighted', async () => {
    mocks.search.mockResolvedValue({ ...resultPage('none'), items: [] })
    const onClose = vi.fn()
    function LocationProbe() {
      const location = useLocation()
      return <p data-testid="location">{`${location.pathname}${location.search}`}</p>
    }
    mountTree(
      <MemoryRouter initialEntries={['/']}>
        <LocationProbe />
        <SearchPalette open onClose={onClose} />
      </MemoryRouter>,
    )
    type('systems design')
    await flushDebounce()
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onClose).toHaveBeenCalledTimes(1)
    const location = document.querySelector('[data-testid="location"]')?.textContent ?? ''
    expect(location.startsWith('/search?q=systems')).toBe(true)
  })

  it('keeps the palette open on Enter with an empty query', async () => {
    mocks.search.mockResolvedValue({ ...resultPage('none'), items: [] })
    const onClose = render()
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps option ids unique when resource types share the same opaque id', async () => {
    mocks.search.mockResolvedValue({ ...resultPage('First', 'shared'), items: [
      { resourceType: 'collection', resourceId: 'shared', title: 'Shared collection', snippet: 'One', rank: 0.9 },
      { resourceType: 'profile', resourceId: 'shared', handle: 'shared', displayName: 'Shared profile', avatarUrl: null, snippet: 'Two', rank: 0.8 },
    ] })
    render()
    type('shared')
    await flushDebounce()
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.id)).toEqual(['search-palette-option-0', 'search-palette-option-1'])
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length)
    act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const activeId = input().getAttribute('aria-activedescendant')
    expect(activeId).toBe('search-palette-option-1')
    expect(document.querySelectorAll(`#${activeId}`)).toHaveLength(1)
  })

  it('renders malicious and international snippets as bidi-safe plain text without persistence or logging', async () => {
    const marker = '<img src=x onerror=alert(1)>超長單語שלום'
    mocks.search.mockResolvedValue(resultPage('Safe title', 'safe', marker))
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    render()
    type(marker)
    await flushDebounce()
    const snippet = document.querySelector('[data-search-snippet]')
    expect(snippet?.textContent).toBe(marker)
    expect(snippet?.getAttribute('dir')).toBe('auto')
    expect(snippet?.classList.contains('search-snippet')).toBe(true)
    expect(document.querySelector('img[src="x"]')).toBeNull()
    expect(storageSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(marker))
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(marker))
  })

  it('labels a node hit as bookmark, not node', async () => {
    mocks.search.mockResolvedValue({
      ...resultPage('Interfaces', 'n2'),
      items: [{
        resourceType: 'node',
        resourceId: 'n2',
        collectionId: 'c1',
        title: 'Interfaces',
        urlHost: 'known.test',
        snippet: 'Second',
        rank: 0.8,
      }],
    })
    render()
    type('interfaces')
    await flushDebounce()
    const kind = document.querySelector('[role="option"] span')
    expect(kind?.textContent).toBe('Bookmark')
    expect(kind?.textContent).not.toBe('node')
  })

  it('portals the palette onto document.body outside the topnav stacking context', () => {
    mountTree(
      <MemoryRouter initialEntries={['/']}>
        <header className="topnav">
          <SearchPalette open onClose={vi.fn()} />
        </header>
      </MemoryRouter>,
    )
    const palette = document.querySelector('[role="dialog"]')
    expect(palette).not.toBeNull()
    expect(palette?.parentElement).toBe(document.body)
    expect(document.querySelector('header [role="dialog"]')).toBeNull()
    expect(document.querySelector('header')?.contains(palette)).toBe(false)
  })

  it('highlights query hits in the title', async () => {
    mocks.search.mockResolvedValue(resultPage('Systems thinking', 'c1', 'A path about systems'))
    render()
    type('systems')
    await flushDebounce()
    expect([...document.querySelectorAll('mark')].some((node) => node.textContent?.toLowerCase() === 'systems')).toBe(true)
    const option = document.querySelector('[role="option"]')
    expect(option?.querySelector('span')?.textContent).toBe('Collection')
    expect(option?.querySelector('strong.result-row-title')?.textContent).toContain('Systems thinking')
    expect(option?.querySelector('[data-search-snippet]')?.textContent).toContain('A path about systems')
  })
})
