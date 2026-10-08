// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PageSection, PageShell } from './PageShell'
import { cleanup, mountTree } from '../test/render'

describe('PageShell', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('joins variant classes with a space', () => {
    mountTree(<PageShell variant="grid" className="health-page" data-testid="shell">Hi</PageShell>)
    const shell = document.querySelector('[data-testid="shell"]')
    expect(shell?.className).toBe('page-shell page-shell--grid health-page')
    const inner = shell?.firstElementChild
    expect(inner?.className).toBe('page-shell-inner')
    expect(inner?.textContent).toBe('Hi')
  })

  it('does not wrap children when sections are supplied', () => {
    mountTree(
      <PageShell sections data-testid="shell">
        <PageSection>One</PageSection>
        <PageSection className="extra">Two</PageSection>
      </PageShell>,
    )
    const inners = Array.from(document.querySelector('[data-testid="shell"]')?.children ?? [])
    expect(inners).toHaveLength(2)
    expect(inners[0]?.className).toBe('page-shell-inner')
    expect(inners[1]?.className).toBe('page-shell-inner extra')
  })

  it('bare variant keeps the page padding but adds no inner track', () => {
    mountTree(
      <PageShell variant="bare" className="explore-page" data-testid="shell">
        <div className="own-track">Content</div>
      </PageShell>,
    )
    const shell = document.querySelector('[data-testid="shell"]')
    expect(shell?.className).toBe('page-shell explore-page')
    expect(shell?.firstElementChild?.className).toBe('own-track')
    expect(shell?.innerHTML).not.toContain('page-shell-inner')
  })
})
