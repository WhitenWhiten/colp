// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPACT_ROW_HEIGHT_PX,
  RESOURCE_LIST_VIRTUALIZE_AFTER,
  ResourceList,
  type ResourceListItem,
} from './ResourceList'
import { cleanup, renderWithRouter } from '../test/render'

function items(count: number): ResourceListItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    title: `Bookmark ${index}`,
    host: 'example.test',
    mark: <span>E</span>,
  }))
}

describe('ResourceList', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts every compact row below the virtualize threshold', () => {
    renderWithRouter(
      <ResourceList items={items(RESOURCE_LIST_VIRTUALIZE_AFTER - 1)} mode="compact" testId="library-bookmarks" />,
      { route: '/' },
    )
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(RESOURCE_LIST_VIRTUALIZE_AFTER - 1)
    const list = document.querySelector('[data-testid="library-bookmarks"]')
    expect(list?.classList.contains('virtual-list')).toBe(false)
    expect(list?.className).toMatch(/library-bookmark-list--compact/)
  })

  it('windows long comfort lists instead of mounting every row', () => {
    // This used to assert the opposite. That assertion came from 08dbdad9a,
    // which virtualized COMPACT lists and recorded what comfort rows did as a
    // side effect — they were auto-height, so they were left behind. It was
    // never a product decision, and the cost was measured: 2_000 rows is 32_079
    // elements, while the fetch path permits 100_000 nodes.
    vi.stubGlobal('ResizeObserver', undefined)
    const total = RESOURCE_LIST_VIRTUALIZE_AFTER + 10
    renderWithRouter(
      <ResourceList items={items(total)} mode="list" testId="library-bookmarks" />,
      { route: '/' },
    )
    const mounted = document.querySelectorAll('[data-node-id]').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(total)
    const list = document.querySelector('[data-testid="library-bookmarks"]')
    expect(list?.classList.contains('virtual-list')).toBe(true)
    // Windowing must not lose content: the scroll surface still spans every row.
    const spacer = document.querySelector<HTMLElement>('[data-testid="virtual-list-spacer"]')
    expect(spacer?.style.getPropertyValue('--vl-total')).toBeTruthy()
  })

  it('still mounts every comfort row below the threshold', () => {
    renderWithRouter(
      <ResourceList items={items(RESOURCE_LIST_VIRTUALIZE_AFTER - 1)} mode="list" testId="library-bookmarks" />,
      { route: '/' },
    )
    expect(document.querySelectorAll('[data-node-id]'))
      .toHaveLength(RESOURCE_LIST_VIRTUALIZE_AFTER - 1)
    const list = document.querySelector('[data-testid="library-bookmarks"]')
    expect(list?.classList.contains('virtual-list')).toBe(false)
  })

  it('windows long compact lists through VirtualList', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const count = RESOURCE_LIST_VIRTUALIZE_AFTER + 30
    renderWithRouter(
      <ResourceList items={items(count)} mode="compact" testId="library-bookmarks" />,
      { route: '/' },
    )
    const list = document.querySelector('[data-testid="library-bookmarks"]')
    expect(list?.classList.contains('virtual-list')).toBe(true)
    expect(list?.getAttribute('data-density')).toBe('compact')
    const visible = document.querySelectorAll('[data-node-id]').length
    expect(visible).toBeGreaterThan(0)
    expect(visible).toBeLessThan(count)
    // The window wrapper is presentational; each row keeps its own listitem role.
    expect(list?.querySelectorAll('[role="listitem"]')).toHaveLength(visible)
    expect(document.body.textContent).toContain('Bookmark 0')
    expect(document.body.textContent).not.toContain(`Bookmark ${count - 1}`)
    const spacer = list?.firstElementChild as HTMLElement
    expect(spacer.style.getPropertyValue('--vl-total')).toBe(`${count * COMPACT_ROW_HEIGHT_PX}px`)
  })

  it.each([1, RESOURCE_LIST_VIRTUALIZE_AFTER + 10])('omits public annotation snippets from %i compact rows', (count) => {
    renderWithRouter(
      <ResourceList
        items={items(count).map((item) => ({ ...item, tldr: 'Public summary', note: 'Public note' }))}
        mode="compact"
        collectionView="compact"
        testId="public-compact"
      />,
      { route: '/' },
    )
    expect(document.querySelector('[data-testid="public-compact"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="bookmark-tldr"]')).toBeNull()
    expect(document.querySelector('[data-testid="bookmark-note"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Public summary')
    expect(document.body.textContent).not.toContain('Public note')
    expect(document.body.textContent).toContain('Bookmark 0')
    if (count >= RESOURCE_LIST_VIRTUALIZE_AFTER) {
      const spacer = document.querySelector<HTMLElement>('[data-testid="virtual-list-spacer"]')!
      expect(spacer.style.getPropertyValue('--vl-total')).toBe(`${count * COMPACT_ROW_HEIGHT_PX}px`)
    }
  })

  it.each(['compact', 'list', 'board'] as const)('marks a pinned bookmark before its host in %s view', (mode) => {
    renderWithRouter(
      <ResourceList items={[{ id: 'p', title: 'Pinned', host: 'example.test', mark: <span>P</span>, pinned: true },
        { id: 'o', title: 'Other', host: 'example.test', mark: <span>O</span> }]} mode={mode} />,
      { route: '/' },
    )
    const marks = document.querySelectorAll('[data-testid="bookmark-pinned"]')
    expect(marks).toHaveLength(1)
    expect(marks[0]!.closest('[data-node-id]')?.getAttribute('data-node-id')).toBe('p')
    expect(marks[0]!.textContent).toBe('Pinned. ')
  })

  it('renders markdown snippets without heading elements', () => {
    renderWithRouter(
      <ResourceList items={[{ id: 'md', title: 'Markdown', host: 'example.test', mark: <span>M</span>, tldr: { text: '## Heading\n\n**body**', format: 'markdown' } }]} mode="list" />,
      { route: '/' },
    )
    const snippet = document.querySelector('[data-testid="bookmark-tldr"]')!
    expect([...snippet.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(expect.arrayContaining(['Heading', 'body']))
    expect(snippet.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull()
    expect(snippet.textContent).not.toContain('##')
  })
})
