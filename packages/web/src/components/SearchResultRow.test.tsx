// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../api/types'
import { SearchResultRow, searchResultMeta } from './SearchResultRow'
import { cleanup, mountTree } from '../test/render'

describe('SearchResultRow product copy', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function render(result: SearchResult) {
    mountTree(
        <SearchResultRow
          result={result}
          query="systems"
          meta={searchResultMeta(result) || undefined}
        />,
      )
  }

  it('labels a node hit as bookmark, not node', () => {
    render({
      resourceType: 'node',
      resourceId: 'n2',
      collectionId: 'c1',
      title: 'Interfaces',
      urlHost: 'known.test',
      snippet: 'Second',
      rank: 0.8,
    })
    const kind = document.querySelector('[data-testid="search-result-kind"]')
    expect(kind?.textContent).toBe('Bookmark')
    expect(kind?.textContent).not.toBe('node')
  })

  it('titles an annotation hit by its text and maps subject node to bookmark in meta', () => {
    render({
      resourceType: 'annotation',
      resourceId: 'a1',
      collectionId: 'c1',
      subject: { type: 'node', id: 'n1' },
      annotationType: 'note',
      snippet: 'A note',
      rank: 0.6,
    })
    // The annotation type is the chip, its text the title, its subject the meta.
    expect(document.querySelector('[data-testid="search-result-kind"]')?.textContent).toBe('Note')
    expect(document.querySelector('strong')?.textContent).toBe('A note')
    expect(document.body.textContent).not.toContain('note annotation')
    expect(document.querySelector('[data-testid="search-result-meta"]')?.textContent).toBe('On a bookmark')
    expect(document.querySelector('[data-testid="search-result-meta"]')?.textContent).not.toContain('node')
  })

  it('sets a title tooltip only when the hit title is clamped', () => {
    const result: SearchResult = {
      resourceType: 'node', resourceId: 'n3', collectionId: 'c1', title: 'Systems notes',
      urlHost: 'known.test', snippet: 'Body', rank: 0.5,
    }
    render(result)
    // Fully visible (happy-dom lays out nothing): no tooltip repeating the text.
    expect(document.querySelector('strong')?.hasAttribute('title')).toBe(false)
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'

    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 80 })
    try {
      render(result)
      expect(document.querySelector('strong')?.getAttribute('title')).toBe('Systems notes')
    } finally {
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scroll)
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    }
  })
})
