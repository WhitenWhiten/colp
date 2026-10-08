// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FolderEntries, type FolderEntryItem } from './FolderEntries'
import { cleanup, renderWithRouter } from '../test/render'

const cover = (n: number) => ({
  url: `https://known.example/api/v1/link-preview/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4${n}`,
  width: 1200,
  height: 630,
})

function folder(id: string, extra: Partial<FolderEntryItem> = {}): FolderEntryItem {
  return { id, title: `Folder ${id}`, directCount: 3, to: `/f/${id}`, ...extra }
}

describe('FolderEntries gallery mode', () => {
  afterEach(cleanup)

  it('renders collection-card folders on the gallery masonry with a cover mosaic', () => {
    renderWithRouter(
      <FolderEntries
        view="gallery"
        countNoun="bookmark"
        items={[
          folder('a', { covers: [cover(1), cover(2), cover(3), cover(4), cover(5)], folderCount: 2, description: 'Core reading' }),
          folder('b', { directCount: 1 }),
        ]}
      />,
      { route: '/' },
    )
    const layer = document.querySelector('[data-collection-folder-layer]')!
    expect(layer.classList.contains('gallery-board')).toBe(true)
    const cards = [...layer.querySelectorAll('[data-gallery-card]')]
    expect(cards.map((card) => card.getAttribute('data-folder-id'))).toEqual(['a', 'b'])

    const mosaic = cards[0]!.querySelector('[data-gallery-cover]')!
    expect(mosaic.getAttribute('data-count')).toBe('4')
    expect(mosaic.querySelectorAll('img')).toHaveLength(4)
    expect(cards[0]!.querySelector('[data-testid="folder-card-desc"]')?.textContent).toBe('Core reading')
    expect(cards[0]!.querySelector('[data-testid="folder-card-stats"]')?.textContent).toBe('3 bookmarks2 subfolders')
    expect(cards[0]!.querySelector('[data-collection-subfolder]')?.getAttribute('href')).toBe('/f/a')

    // No covers inside: a text-only card, like a bookmark without a cover.
    expect(cards[1]!.querySelector('[data-gallery-cover]')).toBeNull()
    expect(cards[1]!.querySelector('[data-testid="folder-card-stats"]')?.textContent).toBe('1 bookmark')
  })

  it('drops failed covers from the mosaic and keeps actions outside the link', async () => {
    renderWithRouter(
      <FolderEntries
        view="gallery"
        items={[folder('a', { covers: [cover(1), cover(2)] })]}
        renderActions={() => <button type="button">Actions for Folder a</button>}
      />,
      { route: '/' },
    )
    const first = document.querySelector('[data-gallery-cover] img')!
    await act(async () => first.dispatchEvent(new Event('error')))
    expect(document.querySelector('[data-gallery-cover]')?.getAttribute('data-count')).toBe('1')

    const link = document.querySelector('[data-collection-subfolder]')!
    const button = document.querySelector('button')!
    expect(link.contains(button)).toBe(false)
    expect(button.closest('[data-gallery-card]')).not.toBeNull()
  })
})
