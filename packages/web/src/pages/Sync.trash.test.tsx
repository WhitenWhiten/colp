// @vitest-environment happy-dom
/**
 * Owner: KNS-08 (QA). Fixture: see Known-Extension/e2e/kns-08-ids.ts.
 * Run: see Known-Extension/e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { SyncConflictSummary, SyncStatusView, SyncTrashDetail, SyncTrashListItem } from '../api/types'
import { Sync } from './Sync'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getSyncStatus: vi.fn(), loadSyncConflicts: vi.fn(), resolveSyncConflict: vi.fn(),
  retireSyncReplica: vi.fn(), abandonSyncConflictIntent: vi.fn(), abandonSyncReplicaIntent: vi.fn(),
  loadSyncTrash: vi.fn(), getSyncTrashItem: vi.fn(), restoreSyncTrashItem: vi.fn(),
  restoreSyncTrashBatch: vi.fn(), restoreSyncTrashSubtree: vi.fn(), emptySyncTrash: vi.fn(),
  abandonSyncTrashIntent: vi.fn(), toast: vi.fn(), getOwnedCollectionsPage: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient,
    getSyncStatus: mocks.getSyncStatus, loadSyncConflicts: mocks.loadSyncConflicts,
    resolveSyncConflict: mocks.resolveSyncConflict, retireSyncReplica: mocks.retireSyncReplica,
    abandonSyncConflictIntent: mocks.abandonSyncConflictIntent,
    abandonSyncReplicaIntent: mocks.abandonSyncReplicaIntent,
    loadSyncTrash: mocks.loadSyncTrash, getSyncTrashItem: mocks.getSyncTrashItem,
    restoreSyncTrashItem: mocks.restoreSyncTrashItem, restoreSyncTrashBatch: mocks.restoreSyncTrashBatch,
    restoreSyncTrashSubtree: mocks.restoreSyncTrashSubtree, emptySyncTrash: mocks.emptySyncTrash,
    abandonSyncTrashIntent: mocks.abandonSyncTrashIntent,
    getOwnedCollectionsPage: mocks.getOwnedCollectionsPage,
  } }
})
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.toast, error: mocks.toast }),
}))

function status(overrides: Partial<SyncStatusView> = {}): SyncStatusView {
  return { devices: [{ id: 'device-1', name: 'Work browser' }], replicas: [{
    id: 'replica-1', deviceId: 'device-1', name: 'Chrome profile', collectionId: 'collection-1',
    kind: 'browser_extension', status: 'active', leaseExpiresAt: '2026-07-29T00:00:00.000Z',
    lastSeenAt: '2026-07-28T00:00:00.000Z', lastAckAt: '2026-07-28T00:00:00.000Z',
    acknowledgedCommitOrdinal: '14', lifecycleRevision: '4', etag: '"4"',
  }], ...overrides }
}
function conflict(overrides: Partial<SyncConflictSummary> = {}): SyncConflictSummary {
  return { id: 'conflict-1', collectionId: 'collection-1', targetId: 'node-1',
    type: 'concurrent_field_update', field: '/title', status: 'open',
    allowedResolutions: ['server', 'incoming', 'custom', 'both'], revision: 'r1', etag: '"r1"',
    createdAt: '2026-07-28T00:00:00.000Z',
    summary: { current: 'Server title', incoming: 'Browser title' }, ...overrides }
}
function trashItem(overrides: Partial<SyncTrashListItem> = {}): SyncTrashListItem {
  return {
    deletionId: 'deletion-fixture-1', nodeId: 'node-fixture', kind: 'bookmark',
    title: 'Fixture reading list', originalParentId: 'folder-fixture', originalParentTitle: 'Fixture folder',
    deletedAt: '2026-07-28T00:00:00.000Z', purgeAfter: '2026-08-27T00:00:00.000Z', revision: 'delete-r1',
    ...overrides,
  }
}
function trashDetail(overrides: Partial<SyncTrashDetail> = {}): SyncTrashDetail {
  return {
    ...trashItem(), url: 'https://example.test/fixture-reading', collectionId: 'collection-1', etag: '"delete-r1"',
    ...overrides,
  }
}
function byButton(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent?.trim() === name)
  if (!button) throw new Error(`missing ${name}`)
  return button
}

describe('KNS-11 Sync Center trash', () => {
  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear(); document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getSyncStatus.mockResolvedValue(status()); mocks.loadSyncConflicts.mockResolvedValue([conflict()])
    mocks.loadSyncTrash.mockResolvedValue([])
    mocks.getOwnedCollectionsPage.mockResolvedValue({
      items: [{ collection: { id: 'collection-1', title: 'Work bookmarks' } }],
      page: { hasMore: false },
    })
    mocks.restoreSyncTrashItem.mockResolvedValue({
      deletionId: 'deletion-fixture-1', nodeId: 'node-fixture', parentId: 'folder-fixture',
      revision: 'restored-r2', etag: '"restored-r2"', restoredAt: '2026-07-28T01:00:00.000Z',
    })
    mocks.restoreSyncTrashBatch.mockResolvedValue({
      collectionId: 'collection-1',
      results: [{
        deletionId: 'deletion-fixture-1', outcome: 'applied', nodeId: 'node-fixture',
        parentId: 'folder-fixture', revision: 'restored-r2', restoredAt: '2026-07-28T01:00:00.000Z',
      }],
      summary: { applied: 1, preconditionFailed: 0, purged: 0, notFound: 0 },
    })
    mocks.emptySyncTrash.mockResolvedValue({
      collectionId: 'collection-1', results: [], summary: { purged: 0, skipped: 0, remaining: 0 },
    })
  })
  afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks() })
  function render() { mountTree(<MemoryRouter><Sync /></MemoryRouter>) }

  it('lists original location and purgeAfter without a URL, and empty trash stays behind confirm', async () => {
    mocks.loadSyncTrash.mockResolvedValueOnce([trashItem()])
    render(); await waitForDom(domFinishedLoading)
    expect(mocks.loadSyncTrash).toHaveBeenCalledWith(expect.objectContaining({ collectionId: 'collection-1', limit: 20 }))
    expect(document.body.textContent).toContain('Fixture reading list')
    expect(document.body.textContent).toContain('Fixture folder')
    expect(document.body.textContent).toContain('Deleted for good after')
    expect(document.body.textContent).not.toContain('https://example.test/fixture-reading')
    expect(document.body.textContent).toContain('Empty trash')
    expect(document.body.textContent).not.toContain('Permanently delete')
    expect(document.body.textContent).not.toMatch(/Purge all|Clear trash/i)
    expect(document.querySelector('a[href*="example.test"]')).toBeNull()
  })

  it('treats unauthorized collection list 404 as empty without leaking the collection id', async () => {
    mocks.getSyncStatus.mockResolvedValueOnce(status({
      replicas: [{ ...status().replicas[0]!, collectionId: 'missing-collection' }],
    }))
    mocks.loadSyncTrash.mockRejectedValueOnce(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'The requested Sync resource was not found.', recovery: 'none',
    }))
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('No deleted items')
    expect(document.body.textContent).not.toContain('missing-collection')
    expect(document.body.textContent).not.toContain('The requested Sync resource was not found.')
  })

  it('does not query trash until an owned replica collection is known', async () => {
    /* Both StrictMode mounts must see the same "no owned replica" status: a
       `Once` here would hand the second mount `undefined` (and with it the
       `collection-1` replica queued by a previous test), which is a fixture
       artefact rather than the gated request the test is about. */
    mocks.getSyncStatus.mockResolvedValue(status({ devices: [], replicas: [] }))
    mocks.loadSyncConflicts.mockResolvedValue([])
    render(); await waitForDom(domFinishedLoading)
    expect(mocks.loadSyncTrash).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('No deleted items')
  })

  it('reveals URL only from owner detail and keeps it as text', async () => {
    mocks.loadSyncTrash.mockResolvedValue([trashItem()])
    mocks.getSyncTrashItem.mockResolvedValueOnce(trashDetail())
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Show URL').click()); await waitForDom(domFinishedLoading)
    expect(mocks.getSyncTrashItem).toHaveBeenCalledWith('deletion-fixture-1', expect.objectContaining({ maxRetries: 0 }))
    expect(document.body.textContent).toContain('https://example.test/fixture-reading')
    expect(document.querySelector('a[href="https://example.test/fixture-reading"]')).toBeNull()
  })

  it('restores with If-Match from revision and then shows only the server receipt', async () => {
    mocks.loadSyncTrash.mockResolvedValueOnce([trashItem()]).mockResolvedValueOnce([])
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(mocks.restoreSyncTrashItem.mock.calls[0]?.[0]).toBe('deletion-fixture-1')
    expect(mocks.restoreSyncTrashItem.mock.calls[0]?.[1]).toBe('"delete-r1"')
    expect(mocks.restoreSyncTrashItem.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      clearIntentOnSuccess: false, maxRetries: 0,
    }))
    expect(document.body.textContent).toContain('Result')
    expect(document.body.textContent).toContain('Restored at')
    expect(document.body.textContent).not.toContain('Fixture reading list')
    expect(document.body.textContent).not.toMatch(/deleted from browser|bookmark deleted|removed from browser/i)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('replays an unknown restore with the same intent and If-Match', async () => {
    mocks.loadSyncTrash.mockResolvedValue([trashItem()])
    mocks.restoreSyncTrashItem.mockRejectedValueOnce(new ProductApiError({
      status: 0, code: 'transport_error', message: 'unknown', recovery: 'same_request', sameRequestRetrySafe: true,
    }))
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore').click()); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('restore may not have completed')
    act(() => byButton('Retry restore').click()); await waitForDom(domFinishedLoading)
    const first = mocks.restoreSyncTrashItem.mock.calls[0]; const replay = mocks.restoreSyncTrashItem.mock.calls[1]
    expect(replay?.[0]).toBe(first?.[0]); expect(replay?.[1]).toBe(first?.[1])
    expect(replay?.[2]?.intentId).toBe(first?.[2]?.intentId)
  })

  it('requires a new restore after 412 with the refreshed revision', async () => {
    mocks.loadSyncTrash
      .mockResolvedValueOnce([trashItem()])
      .mockResolvedValueOnce([trashItem({ revision: 'delete-r2' })])
    mocks.restoreSyncTrashItem.mockRejectedValueOnce(new ProductApiError({
      status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry',
    }))
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('changed')
    expect(mocks.abandonSyncTrashIntent).toHaveBeenCalled()
    act(() => byButton('Restore with latest version').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(mocks.restoreSyncTrashItem.mock.calls[1]?.[1]).toBe('"delete-r2"')
    expect(mocks.restoreSyncTrashItem.mock.calls[1]?.[2]?.intentId).not.toBe(mocks.restoreSyncTrashItem.mock.calls[0]?.[2]?.intentId)
  })

  it('does not reuse a revealed detail etag after 412 refresh', async () => {
    mocks.loadSyncTrash
      .mockResolvedValueOnce([trashItem()])
      .mockResolvedValueOnce([trashItem({ revision: 'delete-r2' })])
    mocks.getSyncTrashItem.mockResolvedValueOnce(trashDetail({ etag: '"delete-r1"' }))
    mocks.restoreSyncTrashItem.mockRejectedValueOnce(new ProductApiError({
      status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry',
    }))
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Show URL').click()); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore with latest version').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(mocks.restoreSyncTrashItem.mock.calls[0]?.[1]).toBe('"delete-r1"')
    expect(mocks.restoreSyncTrashItem.mock.calls[1]?.[1]).toBe('"delete-r2"')
    expect(mocks.restoreSyncTrashItem.mock.calls[1]?.[2]?.intentId).not.toBe(mocks.restoreSyncTrashItem.mock.calls[0]?.[2]?.intentId)
  })

  it('marks already-restored 404 as done after refresh and does not look like a browser delete', async () => {
    mocks.loadSyncTrash.mockResolvedValueOnce([trashItem()]).mockResolvedValueOnce([])
    mocks.restoreSyncTrashItem.mockRejectedValueOnce(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'gone', recovery: 'none',
    }))
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Already restored.')
    expect(document.body.textContent).not.toMatch(/deleted from browser|bookmark deleted|removed from browser/i)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps a purged restore as a failure, not a delete success', async () => {
    mocks.loadSyncTrash.mockResolvedValue([trashItem()])
    mocks.restoreSyncTrashItem.mockRejectedValueOnce(new ProductApiError({
      status: 410, code: 'resource_purged', message: 'The deleted Node is no longer restorable.', recovery: 'none',
    }))
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Restore').click()); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('no longer restorable')
    expect(document.body.textContent).toContain('Fixture reading list')
    expect(document.body.textContent).not.toMatch(/deleted from browser|bookmark deleted/i)
  })

  it('renders a retryable trash auth error without failing replica health', async () => {
    mocks.loadSyncTrash.mockRejectedValueOnce(new ProductApiError({
      status: 401, code: 'authentication_required', message: 'Sign in', recovery: 'user_action',
    }))
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Work browser')
    expect(document.body.textContent).toContain('Sign in again to view deleted items.')
  })

  it('keeps trash restore controls within a 375px viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    mocks.loadSyncTrash.mockResolvedValueOnce([trashItem()])
    render(); await waitForDom(domFinishedLoading)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    expect(document.body.textContent).not.toContain('Sync now')
  })

  it('restores a cross-page selection through one batch command and renders mixed outcomes', async () => {
    const second = trashItem({ deletionId: 'deletion-fixture-2', nodeId: 'node-two', title: 'Second item' })
    mocks.loadSyncTrash.mockResolvedValue([trashItem(), second])
    mocks.restoreSyncTrashBatch.mockResolvedValueOnce({
      collectionId: 'collection-1',
      results: [
        { deletionId: 'deletion-fixture-1', outcome: 'applied', nodeId: 'node-fixture',
          parentId: 'folder-fixture', revision: 'restored-r2', restoredAt: '2026-07-28T01:00:00.000Z' },
        { deletionId: 'deletion-fixture-2', outcome: 'precondition_failed' },
      ],
      summary: { applied: 1, preconditionFailed: 1, purged: 0, notFound: 0 },
    })
    render(); await waitForDom(domFinishedLoading)
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .filter((item) => /^Select (?!all )/u.test(item.getAttribute('aria-label') ?? ''))
    act(() => { boxes[0]!.click(); boxes[1]!.click() })
    act(() => byButton('Restore selected').click()); await waitForDom(domFinishedLoading)
    expect(mocks.restoreSyncTrashBatch).toHaveBeenCalledTimes(1)
    expect(mocks.restoreSyncTrashItem).not.toHaveBeenCalled()
    expect(mocks.restoreSyncTrashBatch.mock.calls[0]?.[0]).toEqual({
      collectionId: 'collection-1',
      items: [
        { deletionId: 'deletion-fixture-1', expectedRevision: 'delete-r1' },
        { deletionId: 'deletion-fixture-2', expectedRevision: 'delete-r1' },
      ],
    })
    expect(document.body.textContent).toContain('Restored 1 of 2')
    expect(document.body.textContent).toContain('Changed since you loaded this page')
    expect(document.body.textContent).toContain('deletion-fixture-2')
    expect(document.querySelector('[data-outcome="precondition_failed"]')?.getAttribute('data-deletion-id'))
      .toBe('deletion-fixture-2')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('requires a second empty-trash confirmation that states count and irreversible impact', async () => {
    mocks.loadSyncTrash.mockResolvedValue([trashItem(), trashItem({ deletionId: 'deletion-fixture-2', title: 'Two' })])
    mocks.emptySyncTrash.mockResolvedValueOnce({
      collectionId: 'collection-1',
      results: [
        { deletionId: 'deletion-fixture-1', outcome: 'skipped', reason: 'retention_window' },
        { deletionId: 'deletion-fixture-2', outcome: 'skipped', reason: 'replica_checkpoint' },
      ],
      summary: { purged: 0, skipped: 2, remaining: 2 },
    })
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Empty trash').click())
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') !== null)
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain('Permanently delete 2 items')
    expect(document.body.textContent).toContain('from “Work bookmarks” in Know-N trash')
    expect(document.body.textContent).toContain("can't be undone")
    expect(document.body.textContent).toContain('at least 30 days')
    expect(mocks.emptySyncTrash).not.toHaveBeenCalled()
    act(() => byButton('Permanently delete').click()); await waitForDom(domFinishedLoading)
    expect(mocks.emptySyncTrash).toHaveBeenCalledWith({
      collectionId: 'collection-1', expectedCount: 2, confirmation: 'permanently_delete',
    }, expect.objectContaining({ maxRetries: 0 }))
    expect(document.body.textContent).toContain('Permanently removed 0 of 2')
    expect(document.body.textContent).toContain('Kept for the 30-day retention window')
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('displays collection titles in dropdown and empty trash confirmation for multiple collections', async () => {
    mocks.getSyncStatus.mockResolvedValue(status({
      replicas: [
        { ...status().replicas[0]!, collectionId: 'collection-1' },
        { ...status().replicas[0]!, id: 'replica-2', collectionId: 'collection-2', name: 'Firefox' },
      ],
    }))
    mocks.getOwnedCollectionsPage.mockResolvedValue({
      items: [
        { collection: { id: 'collection-1', title: 'Work bookmarks' } },
        { collection: { id: 'collection-2', title: 'Personal bookmarks' } },
      ],
      page: { hasMore: false },
    })
    mocks.loadSyncTrash.mockResolvedValue([trashItem()])
    render(); await waitForDom(domFinishedLoading)
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Trash collection"]')
    expect(select).not.toBeNull()
    expect(select?.options[0]?.textContent).toBe('Work bookmarks')
    expect(select?.options[1]?.textContent).toBe('Personal bookmarks')

    act(() => byButton('Empty trash').click())
    // The first confirm is the shared danger modal, not an inline alertdialog.
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') !== null)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain('from “Work bookmarks” in Know-N trash')
  })
})
