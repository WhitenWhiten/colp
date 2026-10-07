// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountTree, domFinishedLoading, waitForDom } from '../../test/render'
import { useLibraryDeskMutations } from './mutations'
import {
  bulkbarButton,
  clickMenuItem,
  destinationButtons,
  extraBookmark,
  filterDesk,
  mocks,
  mount,
  moveResult,
  openRowMenu,
  pickDestination,
  settleAnnotationReads,
  setUpLibraryDesk,
  snapshot,
  snapshotRequestedIds,
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

describe('LibraryDesk batch retry', () => {
  beforeEach(() => { setUpLibraryDesk() })
  afterEach(() => { tearDownLibraryDesk() })

  it('deletes folders against the confirmed content fence and advances only from its own receipt', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    const folder = snap.nodes.find(node => node.kind === 'folder')!
    const folders = [folder, { ...folder, id: 'second-folder', title: 'Second folder' }]
    snap.collection.contentEtag = '"concurrent-reload"'
    mocks.deleteCollectionNode
      .mockResolvedValueOnce({ fence: { contentEtag: '"after-first-delete"' } })
      .mockResolvedValueOnce(undefined)
    let mutations!: ReturnType<typeof useLibraryDeskMutations>
    function Probe() {
      mutations = useLibraryDeskMutations({
        snap, parentId: snap.root.id, loadTree: async () => undefined,
        treesRef: { current: {} }, navigate: vi.fn(), toast: vi.fn(),
        success: mocks.success, error: mocks.error, refreshSession: async () => undefined,
        exitSelectMode: vi.fn(), setBulk: vi.fn(),
      })
      return null
    }
    mountTree(<Probe />)
    await act(async () => { await mutations.runDelete(folders, '"confirmed-content"') })
    expect(mocks.deleteCollectionNode.mock.calls.map(call => ({
      nodeId: call[1], recursive: call[3].recursive, fence: call[3].ifContentMatch,
    }))).toEqual([
      { nodeId: folders[0]!.id, recursive: true, fence: '"confirmed-content"' },
      { nodeId: folders[1]!.id, recursive: true, fence: '"after-first-delete"' },
    ])
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('rebuilds both of two deleted bookmarks that share a parent and url', async () => {
    // A content-derived item key collapses these two into one: they differ in
    // nothing the client can see once the nodes are gone. Undo must still
    // rebuild both, and must not report more than it created.
    const snap = snapshot('col-1', 'Reading queue')
    const duplicate = {
      ...extraBookmark('col-1-dup', 'col-1', 'root-col-1', 'd', 'Duplicate bookmark'),
      url: 'https://loose.example',
    }
    snap.nodes = [...snap.nodes, duplicate as (typeof snap.nodes)[number]]
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    filterDesk('example')
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Duplicate bookmark"]')?.click()
    })
    act(() => bulkbarButton('Delete')?.click())
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
    // Distinct idempotency intents, or the API would treat the second rebuild
    // as a replay of the first and create nothing.
    const intents = mocks.createCollectionNode.mock.calls.map(
      (call) => (call[2] as { intentId?: string } | undefined)?.intentId,
    )
    expect(new Set(intents).size).toBe(2)
    await waitForDom(() => mocks.success.mock.calls.length > 1)
    expect(mocks.success).toHaveBeenCalledWith('Restored 2 bookmarks')
  })

  it('treats a retry aimed at a different folder as a new move', async () => {
    // A move's record must be keyed by where the bookmarks are going. If it is
    // keyed by the collection alone, a retry aimed at another folder inherits
    // skips from the failed attempt: the already-moved bookmark is never brought
    // to the new destination, and the unchanged one is moved to the *old* one.
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [
      ...snap.nodes,
      extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark'),
      {
        ...snap.nodes.find((node) => node.id === 'col-1-folder')!,
        id: 'col-1-other',
        title: 'Other folder',
        position: 'e',
      },
    ]
    // The first move lands Loose bookmark in Later; the second fails. A retry to
    // Other folder must then move both bookmarks there.
    mocks.moveCollectionNode
      .mockResolvedValueOnce(moveResult('col-1-loose', 'root-col-1', 'col-1-folder', '2'))
      .mockRejectedValueOnce(new Error('position_context_stale'))
      .mockImplementation(async (_collectionId: string, nodeId: string, body: { newParentId: string }) =>
        moveResult(nodeId, 'root-col-1', body.newParentId, '3'))
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Third bookmark"]')?.click()
    })
    act(() => bulkbarButton('Move')?.click())
    pickDestination('Later')
    await waitForDom(() => mocks.error.mock.calls.length > 0)
    expect(mocks.error).toHaveBeenCalledWith('Moved 1, 1 failed')

    // Retry, this time aiming at Other folder.
    act(() => bulkbarButton('Move')?.click())
    pickDestination('Other folder')
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    const retried = mocks.moveCollectionNode.mock.calls.slice(2)
    expect(retried.map((call) => call[1])).toEqual(['col-1-loose', 'col-1-third'])
    expect(retried.every((call) => call[2].newParentId === 'col-1-other')).toBe(true)
    expect(mocks.success).toHaveBeenCalledWith('Moved 2 bookmarks', {
      action: { label: 'View in Other folder', to: '/library/col-1?folder=col-1-other' },
    })
  })
  it('retries the bookmark that failed after the succeeded one left the tree', async () => {
    // A partial batch must retry the node that FAILED, even after the reload
    // removed the node that succeeded and shifted the list under it.
    //
    // Honest scope: this one does NOT discriminate the item-keying fix — both
    // earlier versions pass it, because a selection-identity scope also restarts
    // the record when the list shrinks. It pins the semantics (the failed node is
    // retried, and the attempt count shows it) so a future revision of this
    // bookkeeping cannot quietly drop it. The discriminating case for item keying
    // is the GROWING selection in the copy test below, which both earlier
    // versions fail.
    //
    // Driven through the hook rather than the desk UI: the shift IS the input
    // here (`runDelete([loose, third])`, then `runDelete([third])`), and the UI
    // cannot express "the first node is gone" without a cross-collection move the
    // picker does not offer.
    const snap = snapshot('col-1', 'Reading queue')
    const loose = snap.nodes.find((node) => node.id === 'col-1-loose')!
    const third = extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark')
    mocks.deleteCollectionNode
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('delete_conflict'))

    let mutated!: ReturnType<typeof import('./mutations').useLibraryDeskMutations>
    function Probe() {
      mutated = useLibraryDeskMutations({
        snap,
        parentId: 'root-col-1',
        loadTree: async () => undefined,
        treesRef: { current: {} } as never,
        navigate: vi.fn() as never,
        toast: vi.fn(),
        success: mocks.success,
        error: mocks.error,
        refreshSession: async () => undefined,
        exitSelectMode: vi.fn(),
        setBulk: vi.fn(),
      })
      return null
    }
    mountTree(<Probe />)
    await waitForDom(() => mutated !== undefined)

    await act(async () => { await mutated.runDelete([loose, third]) })
    expect(mocks.error).toHaveBeenCalledWith('Deleted 1, 1 failed')

    // The reload drops the deleted bookmark, so the failed one is now first.
    await act(async () => { await mutated.runDelete([third]) })
    // loose deleted once; third attempted, failed, and retried by the second run.
    // Positional skipping drops that third call and reports success instead.
    expect(mocks.deleteCollectionNode.mock.calls.map((call) => call[1]))
      .toEqual(['col-1-loose', 'col-1-third', 'col-1-third'])
    expect(mocks.success).toHaveBeenCalledWith('Bookmark deleted', expect.anything())
  })

  it('does not copy a bookmark twice when the selection grew between attempts', async () => {
    mocks.loadEditorSnapshot.mockReset()
    mocks.createCollectionNode.mockReset()
    // The opposite direction of the same question. Copy sources STAY in the
    // selection, so scoping the record by the selection's identities made adding
    // one bookmark start a new record and re-copy everything that had already
    // succeeded. Only the item that did not finish may be copied again.
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [...snap.nodes,
      extraBookmark('col-1-third', 'col-1', 'root-col-1', 'd', 'Third bookmark'),
      extraBookmark('col-1-fourth', 'col-1', 'root-col-1', 'e', 'Fourth bookmark')]
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mocks.createCollectionNode
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('copy_failed'))
      .mockResolvedValue({})

    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Third bookmark"]')?.click()
    })
    act(() => bulkbarButton('Copy')?.click())
    pickDestination('Second shelf')
    await waitForDom(() => destinationButtons().some((button) => button.textContent?.includes('Top level')))
    pickDestination('Top level')
    await waitForDom(() => mocks.error.mock.calls.length > 0)
    expect(mocks.error).toHaveBeenCalledWith('Copied 1, 1 failed')
    const copied = () => mocks.createCollectionNode.mock.calls.map(
      (call) => (call[1] as { node: { title: string } }).node.title)

    // The selection GROWS before the retry: Fourth bookmark joins it.
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select Fourth bookmark"]')?.click()
    })
    act(() => bulkbarButton('Copy')?.click())
    pickDestination('Second shelf')
    await waitForDom(() => destinationButtons().some((button) => button.textContent?.includes('Top level')))
    pickDestination('Top level')
    await waitForDom(() => mocks.success.mock.calls.length > 0)
    // Loose bookmark succeeded first time; it must appear exactly once overall.
    expect(copied().filter((title) => title === 'Loose bookmark')).toHaveLength(1)
    expect(copied()).toContain('Third bookmark')
    expect(copied()).toContain('Fourth bookmark')
  })

})
