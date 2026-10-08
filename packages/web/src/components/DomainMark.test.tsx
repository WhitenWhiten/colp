// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { DomainMark } from './DomainMark'

describe('DomainMark', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders a host monogram when no URL is given', () => {
    mountTree(<DomainMark host="arxiv.org" />)
    const mark = document.querySelector('[data-testid="domain-mark"]')
    expect(mark?.textContent).toBe('A')
    expect(mark?.querySelector('img')).toBeNull()
  })

  it('prefers a CDN favicon when a page URL is given and the CDN is allowed', () => {
    mountTree(<DomainMark host="arxiv.org" pageUrl="https://arxiv.org/abs/1" faviconCdnAllowed />)
    const img = document.querySelector('[data-testid="domain-mark"] img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toContain('arxiv.org')
  })

  // R15-07: a page URL alone must not open the third-party CDN, or a private
  // host leaks to it.
  it('fails closed to the monogram when the CDN is not explicitly allowed', () => {
    mountTree(<DomainMark host="wiki.corp.example" pageUrl="https://wiki.corp.example/runbook" />)
    const mark = document.querySelector('[data-testid="domain-mark"]')
    expect(mark?.querySelector('img')).toBeNull()
    expect(mark?.textContent).toBe('W')
  })
})
