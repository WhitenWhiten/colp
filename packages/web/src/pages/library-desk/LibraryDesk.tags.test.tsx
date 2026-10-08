// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { domFinishedLoading, waitForDom } from '../../test/render'
import {
  bulkbarButton,
  clickMenuItem,
  extraBookmark,
  mocks,
  mount,
  openRowMenu,
  setUpLibraryDesk,
  snapshot,
  tearDownLibraryDesk,
} from './LibraryDesk.test-helper'

vi.mock('../../auth/AuthContext', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useAuth: () => mocks.auth }
})
vi.mock('../../components/AppToast', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }) }
})
vi.mock('../../lib/useOwnedCollections', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useOwnedCollections: () => mocks.collections }
})
vi.mock('../../lib/useSharedCollections', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useSharedCollections: () => mocks.shared }
})
vi.mock('../../lib/useMyCollaborationInvites', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useMyCollaborationInvites: () => mocks.invites }
})
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadAnnotations: mocks.loadAnnotations,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      createCollectionNode: mocks.createCollectionNode,
      moveCollectionNode: mocks.moveCollectionNode,
      deleteCollectionNode: mocks.deleteCollectionNode,
      updateCollectionNode: mocks.updateCollectionNode,
      listFollowedCollections: mocks.listFollowedCollections,
      listFollowedReports: mocks.listFollowedReports,
      listMyReports: mocks.listMyReports,
      getFollowedReportIssuesPage: mocks.getFollowedReportIssuesPage,
      getMyLibraryOrder: mocks.getMyLibraryOrder,
      updateMyLibraryOrder: mocks.updateMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

function taggedSnapshot() {
  const snap = snapshot('col-1', 'Reading queue')
  snap.nodes = [
    ...snap.nodes.map((node) => (node.id === 'col-1-first' ? { ...node, tags: ['Research', 'ml'] } : node)),
    { ...extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark'), tags: ['ml'] },
  ]
  return snap
}

const rowTitles = () => [...document.querySelectorAll('[data-testid="library-bookmarks"] h3')].map((node) => node.textContent)
const location = () => document.querySelector('[data-testid="location"]')?.textContent

function click(element: Element | null | undefined) {
  if (!element) throw new Error('missing element')
  act(() => { (element as HTMLElement).click() })
}

function sidebarTag(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="library-nav-tags"] button[aria-pressed]')]
    .find((button) => button.dataset.tag?.toLowerCase() === name)
}

describe('LibraryDesk tags', () => {
  beforeEach(() => {
    setUpLibraryDesk()
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? taggedSnapshot() : snapshot(id, 'Second shelf')))
  })
  afterEach(tearDownLibraryDesk)

  it('lists the collection tags in the sidebar with case-folded counts', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const rows = [...document.querySelectorAll('[data-testid="library-nav-tags"] button[aria-pressed]')]
      .map((button) => `${(button as HTMLElement).dataset.tag?.toLowerCase()} ${(button as HTMLElement).dataset.count}`)
    expect(rows).toEqual(['ml 2', 'research 2'])
  })

  it('filters the whole collection by a sidebar tag and keeps it in the URL', async () => {
    mount('/library/col-1?folder=col-1-folder')
    await waitForDom(domFinishedLoading)
    click(sidebarTag('research'))
    await waitForDom(domFinishedLoading)
    expect(location()).toMatch(/^\/library\/col-1\?tag=research$/i)
    expect(rowTitles().sort()).toEqual(['First page item', 'Loose bookmark'])
    expect(document.body.textContent).toContain('2 bookmarks match')
    expect(document.querySelector('[data-testid="library-tag-filter"]')?.textContent).toMatch(/#research/i)
    expect(sidebarTag('research')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('narrows with a row tag, then widens with Match: Any tag', async () => {
    mount('/library/col-1?tag=research')
    await waitForDom(domFinishedLoading)
    const mlTag = [...document.querySelectorAll('[data-testid="library-bookmarks"] [data-testid="bookmark-tags"] button')]
      .find((button) => button.textContent === 'ml')
    click(mlTag)
    await waitForDom(domFinishedLoading)
    expect(rowTitles()).toEqual(['First page item'])

    const match = document.querySelector<HTMLSelectElement>('[data-testid="library-tag-match"] select')!
    act(() => {
      match.value = 'any'
      match.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await waitForDom(domFinishedLoading)
    expect(location()).toContain('tagmatch=any')
    expect(rowTitles().sort()).toEqual(['First page item', 'Loose bookmark', 'Third bookmark'])
  })

  it('removes a tag token and returns to the folder layers', async () => {
    mount('/library/col-1?tag=ml')
    await waitForDom(domFinishedLoading)
    expect(rowTitles().sort()).toEqual(['First page item', 'Third bookmark'])
    click(document.querySelector('[aria-label="Remove tag filter ml"]'))
    await waitForDom(domFinishedLoading)
    expect(location()).toBe('/library/col-1')
    expect(document.querySelector('[data-testid="library-tag-filter"]')).toBeNull()
    expect(rowTitles()).toEqual(['Loose bookmark', 'Third bookmark'])
  })

  it('picks tags from the All tags list', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    click(document.querySelector('[data-testid="library-desk-tags-button"]'))
    await waitForDom(() => document.querySelector('[data-testid="library-tag-picker"]') != null)
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-testid="library-tag-picker"] input[type="checkbox"]')]
    expect(boxes).toHaveLength(2)
    click(boxes[0])
    await waitForDom(domFinishedLoading)
    expect(location()).toBe('/library/col-1?tag=ml')
  })

  it('adds and removes tags across the selection from the bulk bar', async () => {
    mocks.updateCollectionNode.mockResolvedValue({})
    mount('/library/col-1?tag=research')
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    click(document.querySelector('input[aria-label="Select First page item"]'))
    click(bulkbarButton('Tag…'))
    await waitForDom(() => document.querySelector('[data-testid="library-bulk-tag"]') != null)

    const dialog = document.querySelector('[data-testid="library-bulk-tag"]')!
    const rows = [...dialog.querySelectorAll('li label')]
    const box = (name: string) => rows.find((row) => row.textContent?.toLowerCase().includes(`#${name}`))!.querySelector('input')!
    // research is on both bookmarks; ml only on one, so it starts mixed.
    expect(box('research').checked).toBe(true)
    expect(box('ml').getAttribute('aria-checked')).toBe('mixed')
    click(box('research'))
    const input = dialog.querySelector<HTMLInputElement>('#library-bulk-tag-add')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reading')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Apply'))
    await waitForDom(domFinishedLoading)

    const bodies = new Map(mocks.updateCollectionNode.mock.calls.map((call) => [call[1] as string, call[2]]))
    expect(bodies.get('col-1-first')).toEqual({ tags: ['ml', 'reading'] })
    expect(bodies.get('col-1-loose')).toEqual({ tags: ['reading'] })
    expect(mocks.updateCollectionNode).toHaveBeenCalledTimes(2)
  })
})
