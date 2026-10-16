// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { domFinishedLoading, waitForDom } from '../../test/render'
import {
  mocks,
  mount,
  setUpLibraryDesk,
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
vi.mock('../../lib/useLibrary', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useLibrary: () => ({ state: mocks.collections.state, message: mocks.collections.message, reload: mocks.collections.reload,
    library: mocks.collections.items[0] ? { ...mocks.collections.items[0].collection, library: true,
      bookmarksBarId: 'library-bar', otherBookmarksId: 'library-other' } : null }) }
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
      getMyLibraryOrder: mocks.getMyLibraryOrder,
      updateMyLibraryOrder: mocks.updateMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

function openSwitcher() {
  act(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="library-mobile-switcher-trigger"]')?.click()
  })
}

function switcher() {
  return document.querySelector('[data-testid="library-mobile-switcher"]')
}

describe('LibraryHeader mobile switcher', () => {
  beforeEach(() => { setUpLibraryDesk(); window.__KNOWN_FLAGS__ = { collaborators: true } })
  afterEach(tearDownLibraryDesk)

  it('does not render a native select in the mobile nav', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const nav = document.querySelector('[data-testid="library-mobile-nav"]')
    expect(nav?.classList.contains('library-mobile-nav')).toBe(true)
    expect(document.querySelector('[data-testid="library-mobile-nav"] select')).toBeNull()
    expect(nav?.querySelector('select')).toBeNull()
    expect(document.querySelector('[data-testid="library-mobile-switcher-trigger"]')?.textContent).toContain('Reading queue')
    expect(document.querySelector('[data-testid="library-nav"] a[data-collection-id="col-1"]')).not.toBeNull()
  })

  it('opens the library and shared destinations and navigates on choose', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openSwitcher()
    const sheet = switcher()
    expect(sheet).not.toBeNull()
    expect(sheet?.textContent).toContain('All bookmarks')
    expect(sheet?.textContent).toContain('Second shelf')
    act(() => {
      sheet?.querySelector<HTMLButtonElement>('[data-collection-id="col-2"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-2')
    expect(switcher()).toBeNull()
  })

  it('navigates to a nested folder with ?folder=', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openSwitcher()
    act(() => {
      switcher()?.querySelector<HTMLButtonElement>('[data-folder-id="col-1-folder"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-1?folder=col-1-folder')
    expect(switcher()).toBeNull()
  })

  it('lists a pending invitation and New folder in the switcher', async () => {
    // Invitations wait for multi-user; this exercises them behind the flag.
    window.__KNOWN_FLAGS__ = { collaborators: true }
    mocks.invites.items = [{
      inviteId: 'inv-1',
      collectionId: 'col-shared',
      collectionTitle: 'Frozen Shelf',
      role: 'editor',
      email: 'b@example.test',
      expiresAt: '2026-08-26T00:00:00.000Z',
      invitedAt: '2026-08-19T00:00:00.000Z',
    }]
    mount()
    await waitForDom(domFinishedLoading)
    const trigger = document.querySelector('[data-testid="library-mobile-switcher-trigger"]')
    expect(trigger?.getAttribute('aria-label')).toBe('Folder: Reading queue, 1 invitation pending')
    openSwitcher()
    const sheet = switcher()
    const accept = sheet?.querySelector<HTMLButtonElement>('[aria-label="Accept invitation to Frozen Shelf"]')
    expect(accept?.textContent).toBe('Accept')
    expect(accept?.className).toContain('btn-secondary')
    expect([...sheet!.querySelectorAll('button')].find(button => button.textContent === 'New folder')?.textContent).toContain('New folder')
    await act(async () => {
      sheet?.querySelector<HTMLButtonElement>('[aria-label="Decline invitation to Frozen Shelf"]')?.click()
      await Promise.resolve()
    })
    expect(mocks.invites.decline).toHaveBeenCalledWith('inv-1')
    expect(switcher()).not.toBeNull()
    await act(async () => {
      switcher()?.querySelector<HTMLButtonElement>('[aria-label="Accept invitation to Frozen Shelf"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.invites.accept).toHaveBeenCalledWith('inv-1')
    expect(switcher()).toBeNull()
  })


})
