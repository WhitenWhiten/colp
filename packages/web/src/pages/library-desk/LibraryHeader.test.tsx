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

function openSwitcher() {
  act(() => {
    document.querySelector<HTMLButtonElement>('[data-testid="library-mobile-switcher-trigger"]')?.click()
  })
}

function switcher() {
  return document.querySelector('[data-testid="library-mobile-switcher"]')
}

describe('LibraryHeader mobile switcher', () => {
  beforeEach(setUpLibraryDesk)
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

  it('opens a sheet of owned collections and navigates on choose', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openSwitcher()
    const sheet = switcher()
    expect(sheet).not.toBeNull()
    expect(sheet?.textContent).toContain('Reading queue')
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

  it('shows Reading and Following rows when those destinations are on', async () => {
    mocks.listFollowedCollections.mockResolvedValue({
      items: [{
        collectionId: 'follow-1',
        slug: 'design-notes',
        title: 'Design notes',
        summary: 'A public shelf',
        kind: 'bookmarks',
        owner: { profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'ada', displayName: 'Ada', avatarUrl: null },
        updatedAt: '2026-08-26T01:00:00.000Z',
        followedAt: '2026-08-26T00:00:00.000Z',
        availability: 'available',
      }],
      nextCursor: null,
    })
    mount()
    await waitForDom(() =>
      (document.querySelector('[data-testid="library-nav-following"]')?.textContent ?? '').includes('Design notes'))
    openSwitcher()
    const sheet = switcher()
    expect(sheet?.querySelector('[data-testid="library-mobile-reading"]')?.textContent).toContain('Reading')
    expect(sheet?.textContent).toContain('Following')
    expect(sheet?.textContent).toContain('Design notes')
    expect(document.querySelector('[data-testid="library-nav"] a[data-collection-id="col-1"]')).not.toBeNull()
  })

  it('lists a pending invitation and New collection in the switcher', async () => {
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
    expect(trigger?.getAttribute('aria-label')).toBe('Collection or folder: Reading queue, 1 invitation pending')
    openSwitcher()
    const sheet = switcher()
    const accept = sheet?.querySelector<HTMLButtonElement>('[aria-label="Accept invitation to Frozen Shelf"]')
    expect(accept?.textContent).toBe('Accept')
    expect(accept?.className).toContain('btn-secondary')
    expect(sheet?.querySelector('a[href="/library/new"]')?.textContent).toContain('New collection')
    expect(sheet?.querySelector('a[href="/library/digests"]')?.textContent).toContain('Your digests')
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

  it('supports reordering collections in mobile switcher', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openSwitcher()
    const sheet = switcher()
    expect(sheet).not.toBeNull()
    const reorderBtn = sheet?.querySelector<HTMLButtonElement>('[data-testid="library-nav-mine-reorder"]')
    expect(reorderBtn).not.toBeNull()

    act(() => {
      reorderBtn?.click()
    })
    await waitForDom(domFinishedLoading)

    expect(sheet?.querySelector('[data-reordering]')).not.toBeNull()
    const doneBtn = sheet?.querySelector<HTMLButtonElement>('[data-testid="library-nav-mine-done"]')
    expect(doneBtn).not.toBeNull()

    act(() => {
      doneBtn?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(sheet?.querySelector('[data-reordering]')).toBeNull()
  })
})
