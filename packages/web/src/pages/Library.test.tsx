// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { domFinishedLoading, waitForDom } from '../test/render'
import {
  entry,
  mocks,
  mount,
  setUpLibrary,
  snapshot,
  tearDownLibrary,
} from './Library.test-helper'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks: apiMocks } = await import('./Library.test-mocks')
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: apiMocks.loadEditorSnapshot,
      loadAnnotations: apiMocks.loadAnnotations,
      loadPublicCollectionSnapshot: apiMocks.loadPublicCollectionSnapshot,
      getMyLibraryOrder: apiMocks.getMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})
vi.mock('../auth/AuthContext', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useAuth: () => m.auth }
})
vi.mock('../lib/useLibrary', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useLibrary: () => ({ state: m.collections.state, message: m.collections.message, reload: m.collections.reload,
    library: m.collections.items[0] ? { ...m.collections.items[0].collection, library: true,
      bookmarksBarId: 'library-bar', otherBookmarksId: 'library-other' } : null }) }
})
vi.mock('../lib/useSharedCollections', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useSharedCollections: () => m.shared }
})
vi.mock('../lib/useMyCollaborationInvites', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useMyCollaborationInvites: () => m.invites }
})
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

describe('Library', () => {
  beforeEach(setUpLibrary)
  afterEach(tearDownLibrary)

  it('keeps unavailable library discovery free of sample folders', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('a[href="/library/new"]')).toBeNull()
    expect(document.body.textContent).not.toContain('All bookmarks')
    expect(document.querySelector('[data-testid="library-nav"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('The extension syncs your library, not collections shared with you.')
  })

  it('asks signed-out visitors to log in instead of showing a mock library', async () => {
    mocks.auth.isLoggedIn = false
    mocks.auth.sessionState = 'signed-out'
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Sign in to open your library')
    const login = document.querySelector('a[href^="/login?returnTo="]')
    expect(login?.textContent).toContain('Sign in')
    expect(login?.getAttribute('href')).toBe('/login?returnTo=%2Flibrary')
    expect(document.body.textContent).not.toContain('All bookmarks')
  })

  it('opens the collection workspace instead of the editor', async () => {
    window.__KNOWN_FLAGS__ = { collaborators: true }
    mocks.collections.items = [entry('space /?#', 'Editable')]
    mocks.shared.items = [entry('locked', 'Read only', false)]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => Promise.resolve(snapshot(id, id === 'locked' ? 'Read only' : 'Editable')))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-workspace"]')).not.toBeNull()
    expect(document.querySelector('aside[aria-label="Your library"]')).not.toBeNull()
    expect(document.querySelector('div.library-collection-grid')).toBeNull()
    const open = document.querySelector<HTMLAnchorElement>('a[data-collection-id="space /?#"]')
    expect(open?.getAttribute('href')).toBe('/library/space%20%2F%3F%23')
    expect(document.querySelector('a[data-collection-id="locked"]')?.getAttribute('href')).toBe('/library/locked')
    act(() => open?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="editor-route"]')).toBeNull()
    expect(document.querySelector('[data-testid="library-workspace"]')).not.toBeNull()
  })

  it('revalidates the open collection on tab return using the rendered snapshot', async () => {
    mocks.collections.items = [entry('one', 'One')]
    mount('/library/one')
    await waitForDom(domFinishedLoading)
    await waitForDom(() => mocks.loadEditorSnapshot.mock.calls.length > 0)
    const initial = mocks.loadEditorSnapshot.mock.calls.length
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await waitForDom(() => mocks.loadEditorSnapshot.mock.calls.length > initial)
    expect(mocks.loadEditorSnapshot.mock.calls.length).toBe(initial + 1)
    expect(mocks.loadEditorSnapshot).toHaveBeenLastCalledWith('one', expect.objectContaining({
      cachedSnapshot: snapshot('one', 'One'),
      signal: expect.any(AbortSignal),
    }))
  })

  it('switches Comfort and Compact bookmark layouts without a refresh', async () => {
    mocks.collections.items = [entry('one', 'One'), entry('two', 'Two')]
    mount()
    await waitForDom(domFinishedLoading)
    // The bookmarks live inside the Design folder; enter its layer first.
    act(() => {
      document.querySelector<HTMLAnchorElement>('[data-testid="library-main"] [data-collection-subfolder]')?.click()
    })
    await waitForDom(() => document.querySelector('[data-testid="library-bookmarks"]') != null)
    const comfort = document.querySelector('[data-testid="library-bookmarks"][data-density="comfortable"]')
    expect(comfort).not.toBeNull()
    expect(comfort?.className).toMatch(/library-bookmark-list--comfort/)
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="compact"]')).toBeNull()
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Compact') button.click()
      })
    })
    const compact = document.querySelector('[data-testid="library-bookmarks"][data-density="compact"]')
    expect(compact).not.toBeNull()
    expect(compact?.className).toMatch(/library-bookmark-list--compact/)
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="comfortable"]')).toBeNull()
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Comfort') button.click()
      })
    })
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="comfortable"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.className).toMatch(/library-bookmark-list--comfort/)
  })

  function sectionToggles() {
    return [...document.querySelectorAll<HTMLButtonElement>('button[aria-controls^="library-nav-section-"]')]
  }

  it('lists the library above a collapsible Shared with you section', async () => {
    window.__KNOWN_FLAGS__ = { collaborators: true }
    mocks.collections.items = [entry('one', 'One')]
    mocks.shared.items = [entry('shared-a', 'Shared shelf', false)]
    mount()
    await waitForDom(() => document.querySelector('a[data-collection-id="shared-a"]') != null)
    const toggles = sectionToggles()
    expect(toggles.map((toggle) => toggle.textContent?.trim().replace(/\d+$/u, '').trim()))
      .toEqual(['Shared with you'])
    expect(document.querySelector('a[data-collection-id="one"]')?.textContent).toContain('All bookmarks')

    const shared = toggles[0]!
    act(() => shared.click())
    expect(shared.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('a[data-collection-id="shared-a"]')).toBeNull()
    expect(document.querySelector('a[data-collection-id="one"]')).not.toBeNull()
  })

  it('shows Shared with you as a section with an honest empty hint', async () => {
    window.__KNOWN_FLAGS__ = { collaborators: true }
    mount()
    await waitForDom(domFinishedLoading)
    const shared = document.querySelector('[data-testid="library-nav-shared"]')
    expect(shared).not.toBeNull()
    expect(shared?.textContent).toContain('Nothing is shared with you yet.')
  })
})
