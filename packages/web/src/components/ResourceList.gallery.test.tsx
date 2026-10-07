// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResourceList, type ResourceListItem } from './ResourceList'
import { cleanup, renderWithRouter } from '../test/render'

const COVER = { url: 'https://known.example/api/v1/link-preview/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', width: 800, height: 400 }

function item(id: string, extra: Partial<ResourceListItem> = {}): ResourceListItem {
  return { id, title: `Bookmark ${id}`, host: 'example.test', mark: <span>E</span>, ...extra }
}

describe('ResourceList gallery mode', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps DOM order equal to input order and reserves the cover box', () => {
    renderWithRouter(
      <ResourceList
        mode="gallery"
        testId="gallery"
        items={[item('c', { cover: COVER }), item('a'), item('b', { cover: COVER })]}
      />,
      { route: '/' },
    )
    const board = document.querySelector('[data-testid="gallery"]')!
    expect(board.getAttribute('role')).toBe('list')
    const cards = [...board.querySelectorAll('[data-gallery-card]')]
    expect(cards.map((card) => card.getAttribute('data-node-id'))).toEqual(['c', 'a', 'b'])
    const img = cards[0]!.querySelector('img')!
    expect([img.getAttribute('width'), img.getAttribute('height'), img.getAttribute('alt')]).toEqual(['800', '400', ''])
    expect(img.getAttribute('decoding')).toBe('async')
    expect(cards[1]!.querySelector('img')).toBeNull()
  })

  it('drops a cover that fails to load, leaving a text-only card', async () => {
    renderWithRouter(<ResourceList mode="gallery" items={[item('a', { cover: COVER })]} />, { route: '/' })
    const img = document.querySelector('[data-gallery-cover] img')!
    await act(async () => img.dispatchEvent(new Event('error')))
    expect(document.querySelector('[data-gallery-cover]')).toBeNull()
    expect(document.querySelector('[data-gallery-card] h3')?.textContent).toBe('Bookmark a')
  })

  it('never shows a cover on moderation tombstones or outside gallery mode', () => {
    renderWithRouter(<ResourceList mode="gallery" items={[item('h', { cover: COVER, hidden: true })]} />, { route: '/' })
    expect(document.querySelector('[data-gallery-cover]')).toBeNull()
    cleanup()
    renderWithRouter(<ResourceList mode="board" items={[item('a', { cover: COVER })]} />, { route: '/' })
    expect(document.querySelector('[data-gallery-cover]')).toBeNull()
    expect(document.querySelector('[data-gallery-card]')).toBeNull()
  })

  it('supports selecting and deselecting Gallery bookmarks with native controls', async () => {
    const toggleA = vi.fn()
    const toggleB = vi.fn()
    renderWithRouter(<ResourceList mode="gallery" items={[
      item('a', { selectable: true, selected: true, onToggleSelect: toggleA }),
      item('b', { selectable: true, selected: false, onToggleSelect: toggleB }),
    ]} />, { route: '/' })
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-gallery-card] input[type="checkbox"]')]
    expect(boxes.map((box) => box.checked)).toEqual([true, false])
    expect(boxes[1]!.getAttribute('aria-label')).toBe('Select Bookmark b')
    await act(async () => { boxes[0]!.click(); boxes[1]!.click() })
    expect(toggleA).toHaveBeenCalledTimes(1)
    expect(toggleB).toHaveBeenCalledTimes(1)
  })

  it('spans each card by its measured height plus the column gap', () => {
    type Entry = { target: Element; borderBoxSize: Array<{ blockSize: number }>; contentRect: { height: number } }
    const observed: Element[] = []
    let notify: ((entries: Entry[]) => void) | undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: (entries: Entry[]) => void) { notify = callback }
      observe(target: Element) { observed.push(target) }
      disconnect() {}
    })
    renderWithRouter(<ResourceList mode="gallery" testId="gallery" items={[item('a'), item('b')]} />, { route: '/' })
    const board = document.querySelector<HTMLElement>('[data-testid="gallery"]')!
    board.style.columnGap = '12px'
    // StrictMode attaches the ref twice; the first observer is disconnected.
    expect(new Set(observed).size).toBe(2)
    const [first, second] = observed.slice(-2) as HTMLElement[]
    // R15-28: sizes come from the observer entries, never a per-card layout read.
    const layoutRead = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    notify!([
      { target: first!, borderBoxSize: [{ blockSize: 250 }], contentRect: { height: 0 } },
      { target: second!, borderBoxSize: [{ blockSize: 100 }], contentRect: { height: 0 } },
    ])
    // ceil((250 + 12) / 4) and ceil((100 + 12) / 4) rows of the 4px unit.
    expect(first!.style.getPropertyValue('--gallery-span')).toBe('66')
    expect(second!.style.getPropertyValue('--gallery-span')).toBe('28')
    expect(layoutRead).not.toHaveBeenCalled()
  })
})
