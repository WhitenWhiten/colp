// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoadMoreButton } from './LoadMoreButton'
import { cleanup, findButtonByName, mountTree } from '../test/render'

describe('LoadMoreButton', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('renders the idle label and skips the live region', () => {
    mountTree(<LoadMoreButton loading={false} onClick={() => {}} />)
    expect(findButtonByName('Load more')).not.toBeNull()
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('renders the busy label and a visually-hidden live region while loading', () => {
    mountTree(<LoadMoreButton loading onClick={() => {}} status="Loading more items" />)
    const button = findButtonByName('Loading…')
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    const status = document.querySelector('[role="status"]')
    expect(status?.textContent).toBe('Loading more items')
    expect(status?.className).toBe('visually-hidden')
  })

  it('stays disabled when the caller passes disabled', () => {
    mountTree(<LoadMoreButton loading={false} disabled onClick={() => {}} />)
    expect(findButtonByName('Load more').disabled).toBe(true)
  })

  it('passes className through for non-btn surfaces', () => {
    const onClick = vi.fn()
    mountTree(<LoadMoreButton className="library-nav-more" loading={false} onClick={onClick} />)
    const button = findButtonByName('Load more')
    expect(button.className).toBe('library-nav-more')
    act(() => button.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
