// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollectionFigures } from './figures'
import { cleanup, mountTree } from '../../test/render'

// The count-up starts from zero in a browser; hold it there.
vi.mock('../../lib/useCountUp', () => ({ useCountUp: () => 0 }))

describe('CollectionFigures (R15-32)', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => cleanup())

  it('shows the folder figure from the first frame and pluralises on the real totals', () => {
    mountTree(<CollectionFigures bookmarks={12} folders={1} views={0} followers={null} />)
    const figures = [...document.querySelectorAll('[aria-label="Collection figures"] li')].map((li) => li.textContent)
    expect(figures).toEqual(['0 bookmarks', '0 folder'])
  })

  it('omits the folder figure when there are no folders', () => {
    mountTree(<CollectionFigures bookmarks={3} folders={0} views={0} followers={null} />)
    expect(document.querySelectorAll('[aria-label="Collection figures"] li')).toHaveLength(1)
  })
})
