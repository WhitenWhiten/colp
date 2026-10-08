// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import { Breadcrumb } from './Breadcrumb'

describe('Breadcrumb', () => {
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('marks the trailing current crumb with aria-current="page" and leaves links unmarked', () => {
    mountTree(
      <MemoryRouter>
        <Breadcrumb items={[{ label: 'Digests', to: '/reports' }, { label: 'Weekly', to: '/reports/weekly' }, { label: 'Issue 3' }]} />
      </MemoryRouter>,
    )
    const current = document.querySelectorAll('nav[aria-label="Breadcrumb"] [aria-current]')
    expect(current).toHaveLength(1)
    expect(current[0]?.textContent).toBe('Issue 3')
    expect(current[0]?.getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('a[href="/reports/weekly"]')?.hasAttribute('aria-current')).toBe(false)
  })
})
