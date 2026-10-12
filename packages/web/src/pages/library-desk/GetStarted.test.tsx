// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OwnedCollectionListItem } from '../../api'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { GetStarted, getStartedHidden, type GetStartedProbes } from './GetStarted'

function owned(visibility: 'private' | 'unlisted' | 'public', bookmarkCount: number): OwnedCollectionListItem {
  return { collection: { id: `c-${visibility}`, visibility }, bookmarkCount } as unknown as OwnedCollectionListItem
}

const none: GetStartedProbes = { hasBrowser: async () => false, hasAgent: async () => false }

describe('GetStarted', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.localStorage.clear()
  })
  afterEach(() => cleanup())

  async function render(collections: OwnedCollectionListItem[], probes: GetStartedProbes = none) {
    await act(async () => {
      mountTree(
        <MemoryRouter>
          <GetStarted collections={collections} shareTo="/library/c-private?collection=edit" probes={probes} />
        </MemoryRouter>,
      )
    })
  }

  const doneSteps = () => [...document.querySelectorAll('[data-testid="get-started"] li[data-done] h3')].map((h) => h.textContent)

  it('ticks steps from the collections and the browser and agent probes', async () => {
    await render([owned('private', 3)], { hasBrowser: async () => true, hasAgent: async () => false })
    await waitForDom(() => doneSteps().includes('Connect a browser'))
    expect(doneSteps()).toEqual(['Create a collection', 'Bring in your bookmarks', 'Connect a browser'])
    expect(document.body.textContent).toContain('3 of 5')
    expect(document.querySelector('a[href="/agents"]')?.textContent).toBe('Connect')
    expect(document.querySelector('a[href="/library/c-private?collection=edit"]')?.textContent).toBe('Share')
  })

  it('counts a published collection as shared and remembers a finished checklist', async () => {
    await render([owned('public', 1)], { hasBrowser: async () => true, hasAgent: async () => true })
    await waitForDom(() => document.body.textContent?.includes('5 of 5') === true)
    expect(document.querySelector('#get-started-title')?.textContent).toBe('COLP Server is ready')
    expect(getStartedHidden()).toBe(true)
  })

  it('hides for good when dismissed', async () => {
    await render([])
    expect(getStartedHidden()).toBe(false)
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Hide the setup checklist"]')!.click())
    expect(document.querySelector('[data-testid="get-started"]')).toBeNull()
    expect(getStartedHidden()).toBe(true)
  })
})
