// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalLink } from './ExternalLink'
import { cleanup, mountTree } from '../test/render'

describe('ExternalLink', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('renders https with nofollow ugc noopener noreferrer (R15-25)', () => {
    mountTree(<ExternalLink href="https://example.com">Example</ExternalLink>)
    const anchor = document.querySelector('a')
    expect(anchor?.getAttribute('href')).toBe('https://example.com/')
    expect(anchor?.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.textContent).toBe('Example')
  })

  it('does not emit href for javascript: or userinfo URLs', () => {
    mountTree(
      <>
        <ExternalLink href="javascript:alert(1)">js</ExternalLink>
        <ExternalLink href="http://user:pass@example.com/">auth</ExternalLink>
      </>,
    )
    expect(document.querySelector('a')).toBeNull()
    expect(document.querySelector('[href]')).toBeNull()
    expect(document.body.textContent).toContain('js')
    expect(document.body.textContent).toContain('auth')
  })
})
