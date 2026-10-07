// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QuickLinksWidget } from './QuickLinksWidget'
import { cleanup, mountTree } from '../../test/render'

const RESOURCE_ID = 'd-quicklinks'
const STORAGE_KEY = `known.desk.quicklinks.${RESOURCE_ID}.v1`
const LIVE_PATH_HREF = '/path/llm-learning-path'
const LEGACY_PATH_HREF = '/path/interface-systems'

type StoredLink = { id: string; label: string; href: string }

describe('QuickLinksWidget', () => {

  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    document.body.innerHTML = ''
  })

  function renderWidget() {
    mountTree(
        <MemoryRouter>
          <QuickLinksWidget resourceId={RESOURCE_ID} />
        </MemoryRouter>,
      )
  }

  function chipHrefs() {
    return [...document.querySelectorAll<HTMLAnchorElement>(`[data-resource="${RESOURCE_ID}"] a`)].map((el) => ({
      label: el.textContent,
      href: el.getAttribute('href'),
    }))
  }

  it('uses six live defaults when nothing is stored, without the leftover Path slug', () => {
    renderWidget()

    const chips = chipHrefs()
    expect(chips).toHaveLength(6)
    expect(chips.map((c) => c.label)).toEqual(['Library', 'Classify', 'Feed', 'Explore', 'Sync', 'Path'])
    expect(chips.map((c) => c.href)).toEqual([
      '/library',
      '/classify',
      '/feed',
      '/explore',
      '/sync',
      LIVE_PATH_HREF,
    ])
    expect(chips.some((c) => c.href === LEGACY_PATH_HREF)).toBe(false)
    expect(document.body.textContent).not.toContain('interface-systems')
  })

  it('migrates only an exact leftover Path href and writes the list back', () => {
    const stored: StoredLink[] = [
      { id: 'ql1', label: 'Library', href: '/library' },
      { id: 'ql2', label: 'Classify', href: '/classify' },
      { id: 'custom', label: 'Notes', href: '/path/interface-systems-notes' },
      { id: 'ql6', label: 'Path', href: LEGACY_PATH_HREF },
    ]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    renderWidget()

    const chips = chipHrefs()
    expect(chips).toEqual([
      { label: 'Library', href: '/library' },
      { label: 'Classify', href: '/classify' },
      { label: 'Notes', href: '/path/interface-systems-notes' },
      { label: 'Path', href: LIVE_PATH_HREF },
    ])

    const written = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as StoredLink[]
    expect(written.map((l) => ({ id: l.id, label: l.label, href: l.href }))).toEqual([
      { id: 'ql1', label: 'Library', href: '/library' },
      { id: 'ql2', label: 'Classify', href: '/classify' },
      { id: 'custom', label: 'Notes', href: '/path/interface-systems-notes' },
      { id: 'ql6', label: 'Path', href: LIVE_PATH_HREF },
    ])
  })

  it('does not force the flagship Path slug when the user already changed it', () => {
    const stored: StoredLink[] = [
      { id: 'ql1', label: 'Library', href: '/library' },
      { id: 'ql6', label: 'Path', href: '/path/my-own-notes' },
    ]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    renderWidget()

    expect(chipHrefs()).toEqual([
      { label: 'Library', href: '/library' },
      { label: 'Path', href: '/path/my-own-notes' },
    ])
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(stored))
  })
})
