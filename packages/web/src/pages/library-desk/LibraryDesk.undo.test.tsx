// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { domFinishedLoading, waitForDom } from '../../test/render'
import { bulkbarButton, clickMenuItem, filterDesk, mocks, mount, openRowMenu, setUpLibraryDesk, snapshot, tearDownLibraryDesk } from './LibraryDesk.test-helper'

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

describe('LibraryDesk undo deletion', () => {
  beforeEach(setUpLibraryDesk)
  afterEach(tearDownLibraryDesk)

  it('undoes a single delete by rebuilding the bookmark at its old parent', async () => {
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Delete')
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    const undo = mocks.success.mock.calls[0]?.[1]?.action?.onClick as () => void
    await act(async () => {
      undo()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.createCollectionNode).toHaveBeenCalledWith(
      'col-1',
      {
        parentId: 'root-col-1',
        afterId: null,
        beforeId: null,
        node: {
          kind: 'bookmark',
          title: 'Loose bookmark',
          url: 'https://loose.example',
          description: null,
          tags: ['research'],
          visibility: 'private',
        },
      },
      expect.anything(),
    )
    await waitForDom(() => mocks.success.mock.calls.length > 1)
    expect(mocks.success).toHaveBeenCalledWith('Bookmark restored')
  })

  it('undo falls back to the root when the original parent folder is gone', async () => {
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    // The nested bookmark row is reachable through the subtree filter.
    filterDesk('example')
    openRowMenu('First page item')
    clickMenuItem('Delete')
    // After the delete, the refreshed snapshot no longer carries the folder.
    const withoutFolder = snapshot('col-1', 'Reading queue')
    withoutFolder.nodes = withoutFolder.nodes.filter((node) => node.id !== 'col-1-folder')
    mocks.loadEditorSnapshot.mockResolvedValue(withoutFolder)
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    // Wait for the post-delete silent reload: the folder leaves the sidebar.
    await waitForDom(() => document.querySelector('[data-folder-id="col-1-folder"]') == null)
    const undo = mocks.success.mock.calls[0]?.[1]?.action?.onClick as () => void
    await act(async () => {
      undo()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.createCollectionNode).toHaveBeenCalledWith(
      'col-1',
      expect.objectContaining({
        parentId: 'root-col-1',
        node: expect.objectContaining({ title: 'First page item' }),
      }),
      expect.anything(),
    )
  })


  it('undoes a bulk delete by rebuilding every bookmark sequentially', async () => {
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    // Mixed selection across folders happens in the flat search view.
    filterDesk('example')
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select First page item"]')?.click()
    })
    act(() => bulkbarButton('Delete')?.click())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete 2 bookmarks?')
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.success).toHaveBeenCalledWith('Deleted 2 bookmarks', {
      action: { label: 'Undo', onClick: expect.any(Function) },
    })
    const undo = mocks.success.mock.calls[0]?.[1]?.action?.onClick as () => void
    await act(async () => {
      undo()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.createCollectionNode).toHaveBeenCalledTimes(2)
    await waitForDom(() => mocks.success.mock.calls.length > 1)
    expect(mocks.success).toHaveBeenCalledWith('Restored 2 bookmarks')
  })

  it('stops a bulk undo at the first rebuild failure and toasts the split', async () => {
    mocks.createCollectionNode
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('createNode failed'))
    mount()
    await waitForDom(domFinishedLoading)
    // Mixed selection across folders happens in the flat search view.
    filterDesk('example')
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select First page item"]')?.click()
    })
    act(() => bulkbarButton('Delete')?.click())
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    const undo = mocks.success.mock.calls[0]?.[1]?.action?.onClick as () => void
    await act(async () => {
      undo()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => mocks.error.mock.calls.length > 0)
    expect(mocks.createCollectionNode).toHaveBeenCalledTimes(2)
    expect(mocks.error).toHaveBeenCalledWith('Restored 1, 1 failed')
  })

  it('skips the bookmarks a retried bulk undo already rebuilt', async () => {
    // The failure toast leaves the user with "run it again", so a retry that
    // re-issues every item creates a second copy of whatever already succeeded.
    mocks.createCollectionNode
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('createNode failed'))
      .mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    filterDesk('example')
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select First page item"]')?.click()
    })
    act(() => bulkbarButton('Delete')?.click())
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    const undo = mocks.success.mock.calls[0]?.[1]?.action?.onClick as () => void
    await act(async () => {
      undo(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    await waitForDom(() => mocks.error.mock.calls.length > 0)
    expect(mocks.createCollectionNode).toHaveBeenCalledTimes(2)
    expect(mocks.error).toHaveBeenCalledWith('Restored 1, 1 failed')

    // Retry: only the bookmark that failed may be rebuilt.
    await act(async () => {
      undo(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(mocks.createCollectionNode).toHaveBeenCalledTimes(3)
    await waitForDom(() => mocks.success.mock.calls.length > 1)
    // The first success call is the delete itself. The retry rebuilt the one
    // bookmark the first attempt did not finish, and says so rather than
    // claiming the whole deletion was restored just now.
    expect(mocks.success.mock.calls.map((call) => call[0]))
      .toEqual(['Deleted 2 bookmarks', 'Bookmark restored (2 of 2 restored)'])
  })



})
