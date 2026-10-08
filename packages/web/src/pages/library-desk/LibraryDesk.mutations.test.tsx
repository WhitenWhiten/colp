// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { domFinishedLoading, waitForDom } from '../../test/render'
import { bulkbarButton, clickMenuItem, destinationButtons, extraBookmark, mocks, mount, moveResult, openRowMenu, pickDestination, setUpLibraryDesk, snapshot, snapshotRequestedIds, tearDownLibraryDesk } from './LibraryDesk.test-helper'

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

describe('LibraryDesk move copy and delete', () => {
  beforeEach(setUpLibraryDesk)
  afterEach(tearDownLibraryDesk)

  it('moves a bookmark into a folder using snapshot revisions and the node etag', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Move to…')
    const picker = document.querySelector('[data-testid="destination-picker"]')
    expect(picker?.getAttribute('data-mode')).toBe('move')
    // Move is locked to the current collection: no other collection is offered.
    expect(picker?.textContent).toContain('Reading queue')
    expect(picker?.textContent).not.toContain('Second shelf')
    pickDestination('Later')
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-loose',
      {
        newParentId: 'col-1-folder',
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: '1',
        baseTargetParentRevision: '1',
      },
      '"l-col-1"',
      expect.anything(),
    )
    // Success points at the destination folder inside the same collection.
    expect(mocks.success).toHaveBeenCalledWith('Bookmark moved', {
      action: { label: 'View in Later', to: '/library/col-1?folder=col-1-folder' },
    })
  })

  it('copies a bookmark into another collection with the copied payload', async () => {
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Copy to…')
    expect(document.querySelector('[data-testid="destination-picker"]')?.getAttribute('data-mode')).toBe('copy')
    expect(document.body.textContent).toContain('Copies the link, title and note')
    pickDestination('Second shelf')
    await waitForDom(() => destinationButtons().some((button) => button.textContent?.includes('Top level')))
    expect(mocks.loadEditorSnapshot).toHaveBeenCalledWith('col-2', expect.anything())
    pickDestination('Top level')
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.createCollectionNode).toHaveBeenCalledWith(
      'col-2',
      {
        parentId: 'root-col-2',
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
    // Cross-collection copy points at the target collection root.
    expect(mocks.success).toHaveBeenCalledWith('Bookmark copied', {
      action: { label: 'View in Second shelf', to: '/library/col-2' },
    })
  })

  it('deletes a bookmark only after the danger confirm naming it', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Delete')
    // The confirm names the bookmark it is about to remove.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Delete “Loose bookmark”?')
    expect(mocks.deleteCollectionNode).not.toHaveBeenCalled()
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.deleteCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-loose',
      '"l-col-1"',
      expect.anything(),
    )
    expect(mocks.success).toHaveBeenCalledWith('Bookmark deleted', {
      action: { label: 'Undo', onClick: expect.any(Function) },
    })
  })

  it('offers the same in-place actions on a folder row at any depth', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Later')
    expect([...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent))
      .toEqual(['Edit details', 'Move to…', 'Delete'])
  })

  it('opens the node drawer in folder mode from a folder row', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Later')
    clickMenuItem('Edit details')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="node-drawer"]')).not.toBeNull()
    expect((document.getElementById('nd-title') as HTMLInputElement).value).toBe('Later')
    // A folder has no URL or favicon of its own.
    expect(document.getElementById('nd-url')).toBeNull()
    expect(document.getElementById('nd-favicon')).toBeNull()
  })

  it('moves a folder through the shared destination picker and its own etag', async () => {
    // A second root-level folder gives the move a valid destination (the
    // folder's own row and its current parent are not destinations).
    const base = snapshot()
    const folder = base.nodes.find((node) => node.id === 'col-1-folder')!
    mocks.loadEditorSnapshot.mockResolvedValue({
      ...base,
      nodes: [...base.nodes, {
        ...folder, id: 'col-1-archive', title: 'Archive', position: 'd', etag: '"a-col-1"', childrenEtag: '"ac-col-1"',
      }],
    })
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Later')
    clickMenuItem('Move to…')
    const picker = document.querySelector('[data-testid="destination-picker"]')
    expect(picker?.getAttribute('data-mode')).toBe('move')
    pickDestination('Archive')
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-folder',
      {
        newParentId: 'col-1-archive',
        afterId: null,
        beforeId: null,
        baseSourceParentRevision: '1',
        baseTargetParentRevision: '1',
      },
      '"f-col-1"',
      expect.anything(),
    )
    expect(mocks.success).toHaveBeenCalledWith('Folder moved', {
      action: { label: 'View in Archive', to: '/library/col-1?folder=col-1-archive' },
    })
  })

  it('deletes a folder only after a confirm that names its subtree and offers no Undo', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Later')
    clickMenuItem('Delete')
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Delete “Later” and everything in it: 1 bookmark. This can\'t be undone.')
    expect(mocks.deleteCollectionNode).not.toHaveBeenCalled()
    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((button) => button.textContent === 'Delete folder')?.click()
    })
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.deleteCollectionNode).toHaveBeenCalledWith(
      'col-1',
      'col-1-folder',
      '"f-col-1"',
      expect.objectContaining({ recursive: true, ifContentMatch: '"cc-col-1"' }),
    )
    // A deleted subtree is not restorable, so the toast carries no Undo.
    expect(mocks.success).toHaveBeenCalledWith('Folder deleted', undefined)
  })

  it('bulk-moves sequentially and chains each returned childrenRevision', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [...snap.nodes, extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark')]
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    const revisions: Record<string, string> = { 'col-1-loose': '2', 'col-1-third': '3' }
    mocks.moveCollectionNode.mockImplementation(async (_collectionId: string, nodeId: string) =>
      moveResult(nodeId, 'root-col-1', 'col-1-folder', revisions[nodeId]!))
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    // The initiating row is preselected; selection clicks must not navigate.
    expect(document.querySelector('[data-testid="library-bulkbar"]')?.textContent).toContain('1 selected')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Third bookmark"]')?.click()
    })
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-1')
    expect(document.querySelector('[data-testid="library-bulkbar"]')?.textContent).toContain('2 selected')
    act(() => bulkbarButton('Move')?.click())
    pickDestination('Later')
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = mocks.moveCollectionNode.mock.calls
    expect(firstCall![1]).toBe('col-1-loose')
    expect(firstCall![2]).toMatchObject({
      baseSourceParentRevision: '1',
      baseTargetParentRevision: '1',
    })
    // The second call must use the refreshed revisions from the first result.
    expect(secondCall![1]).toBe('col-1-third')
    expect(secondCall![2]).toMatchObject({
      baseSourceParentRevision: '2',
      baseTargetParentRevision: '2',
    })
    expect(mocks.success).toHaveBeenCalledWith('Moved 2 bookmarks', {
      action: { label: 'View in Later', to: '/library/col-1?folder=col-1-folder' },
    })
  })

  it('stops a bulk move at the first failure, toasts the split, and reloads', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [
      ...snap.nodes,
      extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark'),
      extraBookmark('col-1-fourth', 'col-1', 'root-col-1', 'e', 'Fourth bookmark'),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mocks.moveCollectionNode
      .mockResolvedValueOnce(moveResult('col-1-loose', 'root-col-1', 'col-1-folder', '2'))
      .mockRejectedValueOnce(new Error('position_context_stale'))
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Third bookmark"]')?.click()
    })
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Fourth bookmark"]')?.click()
    })
    const snapshotLoadsBefore = snapshotRequestedIds().filter((id) => id === 'col-1').length
    act(() => bulkbarButton('Move')?.click())
    pickDestination('Later')
    await waitForDom(() => mocks.error.mock.calls.length > 0)
    // Third call is never attempted; succeeded moves are not rolled back.
    expect(mocks.moveCollectionNode).toHaveBeenCalledTimes(2)
    expect(mocks.error).toHaveBeenCalledWith('Moved 1, 2 failed')
    await waitForDom(() =>
      snapshotRequestedIds().filter((id) => id === 'col-1').length > snapshotLoadsBefore)
  })

  it('keeps sidebar reorder off while bookmark selection is active', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-nav-mine-reorder"]')?.click()
    })
    expect(document.querySelector('[data-library-reordering]')).toBeNull()
    expect(document.querySelector('[data-testid="library-bulkbar"]')).not.toBeNull()
  })
})
