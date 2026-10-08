// @vitest-environment happy-dom
import { type ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CollectionCard } from './CollectionCard'
import { cleanup, mountTree } from '../test/render'

const base = {
  id: 'col-demo',
  slug: 'demo-path',
  title: 'Demo path',
  description: 'A public reading path.',
  curator: 'Ada Lovelace',
  curatorHandle: 'ada',
  tags: ['Design'],
  links: 0,
  updated: '',
  public: true,
}

describe('CollectionCard views', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function renderCard(c: ComponentProps<typeof CollectionCard>['c']) {
    cleanup()
    mountTree(
      <MemoryRouter>
        <CollectionCard c={c} />
      </MemoryRouter>,
    )
  }

  it('renders a moderation tombstone as an inert card without a link (#21)', () => {
    renderCard({ ...base, hiddenPublic: true, title: 'Collection hidden', description: '', curatorNote: null })
    const stone = document.querySelector('[data-collection-hidden]')
    expect(stone).not.toBeNull()
    expect(stone?.tagName).toBe('DIV')
    expect(stone?.querySelector('h3.collection-card-title')?.textContent).toBe('Collection hidden')
    expect(document.querySelector('a[href="/c/demo-path"]')).toBeNull()
    expect(stone?.querySelector('span.collection-card-arrow')).toBeNull()
    // R12-12: the slot says what happened and keeps its curator.
    expect(stone?.textContent).toContain('Hidden by moderation')
    expect(stone?.textContent).toContain('Ada Lovelace')
    expect(stone?.querySelector('[data-testid="collection-card-desc"]')).toBeNull()
  })

  it('keeps each stat and its leading separator in one group (R12-10)', () => {
    renderCard({ ...base, links: 16, viewCount: 367, updated: 'Sep 17' })
    const stats = document.querySelector('[data-testid="collection-card-stats"]')!
    const groups = [...stats.children]
    expect(groups.map((group) => group.textContent)).toEqual(['16 bookmarks', '367 views', 'Sep 17'])
    expect(groups.map((group) => group.querySelector('[aria-hidden]') !== null)).toEqual([false, true, true])
  })

  it('does not render views when viewCount is omitted or 0', () => {
    renderCard({ ...base })
    expect(document.body.textContent).not.toMatch(/\bviews\b/)
    expect(document.body.textContent).not.toContain('followers')

    renderCard({ ...base, viewCount: 0 })
    expect(document.body.textContent).not.toMatch(/\bviews\b/)
    expect(document.body.textContent).not.toContain('0 views')
    expect(document.body.textContent).not.toContain('followers')
  })

  it('renders views, not followers, when viewCount is 12', () => {
    renderCard({ ...base, viewCount: 12 })
    expect(document.body.textContent).toContain('12 views')
    expect(document.body.textContent).not.toContain('followers')
  })

  it('does not render followers when a followers prop is passed', () => {
    renderCard({ ...base, followers: 4 })
    expect(document.body.textContent).not.toContain('followers')
    expect(document.body.textContent).not.toContain('4 followers')
    expect(document.body.textContent).not.toMatch(/\bviews\b/)
  })

  it('shows a kind chip for reading_path and omits it for bookmarks', () => {
    renderCard({ ...base, kind: 'reading_path' })
    expect(document.body.textContent).toContain('Reading path')

    renderCard({ ...base, kind: 'bookmarks' })
    expect(document.body.textContent).not.toContain('Bookmarks')
    expect(document.body.textContent).not.toContain('Reading path')
  })

  it('renders at most two tag chips so a third Explore tag stays hidden', () => {
    renderCard({ ...base, tags: ['ML', 'Engineering', 'Culture'] })
    expect(document.body.textContent).toContain('ML')
    expect(document.body.textContent).toContain('Engineering')
    expect(document.body.textContent).not.toContain('Culture')
  })

  it('renders the curator note in front of the stats and drops the summary', () => {
    renderCard({ ...base, curatorNote: 'A curated pick for systems people.', links: 12 })
    expect(document.querySelector('[data-testid="collection-card-curation"]')?.textContent)
      .toBe('A curated pick for systems people.')
    expect(document.body.textContent).not.toContain('A public reading path.')
    expect(document.querySelector('[data-testid="collection-card-desc"]')).toBeNull()
    // The endorsement sits before the stats paragraph.
    const curation = document.querySelector('[data-testid="collection-card-curation"]')!
    const stats = document.querySelector('[data-testid="collection-card-stats"]')
    expect(stats).not.toBeNull()
    expect(curation.compareDocumentPosition(stats!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('falls back to the summary when there is no curator note', () => {
    renderCard({ ...base })
    expect(document.querySelector('[data-testid="collection-card-curation"]')).toBeNull()
    expect(document.querySelector('[data-testid="collection-card-desc"]')?.textContent).toBe('A public reading path.')
  })

  it('wraps a formatted updated stamp in a time element', () => {
    renderCard({ ...base, updated: 'Sep 1, 2026' })
    const stamp = document.querySelector('span.collection-card-updated time')
    expect(stamp?.textContent).toBe('Sep 1, 2026')
    expect(stamp?.hasAttribute('dateTime')).toBe(false)
  })

  it('marks a non-English collection with its language (R15-40)', () => {
    renderCard({ ...base, title: '机器学习路线', description: '从零开始', language: 'zh' })
    const title = document.querySelector('h3')!
    expect(title.getAttribute('lang')).toBe('zh')
    expect(title.getAttribute('dir')).toBe('auto')
    const desc = document.querySelector('[data-testid="collection-card-desc"]')!
    expect(desc.getAttribute('lang')).toBe('zh')
    expect(desc.getAttribute('dir')).toBe('auto')
  })

  it('writes no lang for a missing or malformed tag', () => {
    renderCard({ ...base, language: null })
    expect(document.querySelector('h3')?.hasAttribute('lang')).toBe(false)
    renderCard({ ...base, language: 'not a tag' })
    expect(document.querySelector('h3')?.hasAttribute('lang')).toBe(false)
  })
})
