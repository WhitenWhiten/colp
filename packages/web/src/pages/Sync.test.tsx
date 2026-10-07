// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { SyncConflictSummary, SyncStatusView } from '../api/types'
import { Sync } from './Sync'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

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
function byButton(name: string) { const button = [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((item) => item.textContent?.trim() === name); if (!button) throw new Error(`missing ${name}`); return button }
/** The shared danger modal's buttons (ConfirmProvider is mounted by mountTree). */
function modalButton(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="modal-panel"] button')].find((item) => item.textContent?.trim() === name)
}
async function confirmModal(name: string) {
  await waitForDom(() => modalButton(name) !== undefined)
  act(() => modalButton(name)!.click())
}
function choose(value: string) { const radio = document.querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`)!; act(() => radio.click()) }

describe('Sync Center authoritative workflow', () => {
  beforeEach(() => {
    vi.clearAllMocks(); sessionStorage.clear(); document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getSyncStatus.mockResolvedValue(status()); mocks.loadSyncConflicts.mockResolvedValue([conflict()])
    mocks.loadSyncTrash.mockResolvedValue([])
    mocks.getOwnedCollectionsPage.mockResolvedValue({ items: [], page: { hasMore: false } })
    mocks.retireSyncReplica.mockResolvedValue({
      replicaId: 'replica-1', status: 'retired', lifecycleRevision: '5', etag: '"5"',
      retiredAt: '2026-07-28T01:00:00.000Z',
    })
  })
  afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks() })
  function render() { mountTree(<MemoryRouter><Sync /></MemoryRouter>) }

  it('renders server facts and malicious summaries strictly as text', async () => {
    const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    // Endpoint description: the hostile summary is server state, so mount #2's
    // read must return it too — the guarantee is about escaping, not call order.
    mocks.loadSyncConflicts.mockResolvedValue([conflict({ summary: { current: attack, incoming: 'https://user:secret@example.test/<svg onload=alert(3)>' } })])
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('The extension only syncs collections you own, not ones shared with you.') // copy-only (C-11)
    expect(document.body.textContent).toContain('Work browser'); expect(document.body.textContent).toContain('Last synced')
    expect(document.body.textContent).toContain(attack); expect(document.querySelector('img[src="x"]')).toBeNull(); expect(document.querySelector('script')).toBeNull()
    expect([...document.querySelectorAll('[data-testid="sync-count"]')].map((node) => node.textContent)).toEqual(['1', '1'])
    expect(document.body.textContent).not.toContain('queue'); expect(document.body.textContent).not.toContain('Sync now')
    expect(document.querySelector('fieldset')?.querySelectorAll('input[type=radio]')).toHaveLength(4)
  })

  it('shows no-device and recovery-required states without invented telemetry', async () => {
    // Server state, not a call queue: every mount read sees the empty account.
    mocks.getSyncStatus.mockResolvedValue(status({ devices: [], replicas: [] }))
    mocks.loadSyncConflicts.mockResolvedValue([]); render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('No connected browsers')
    expect(document.body.textContent).toContain('sync a collection you own')
    expect(document.body.textContent).toContain('No open conflicts')
    expect(document.querySelector('[data-testid="sync-count"]')).toBeNull()
    // The mount has settled; this override belongs to the next genuine user
    // action: the Refresh click now observes a recovery-required replica.
    mocks.getSyncStatus.mockResolvedValueOnce(status({ replicas: [{ ...status().replicas[0]!, status: 'recovery_required' }] }))
    act(() => byButton('Refresh').click())
    await waitForDom(() => (document.body.textContent ?? '').includes('Recovery required'))
    expect(document.body.textContent).toContain('Recovery required')
  })

  it('announces initial loading and exposes a retryable Product read error', async () => {
    let rejectStatus: ((error: unknown) => void) | undefined
    // Mount #1's read is superseded (and aborted) by StrictMode; the *live*
    // mount #2 read is the one that must surface the retryable error, so hold
    // the first read open and fail the second.
    mocks.getSyncStatus.mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStatus = reject }))
    render()
    expect(document.querySelector('[data-testid="loading-state-dot"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Loading Sync status')
    await act(async () => rejectStatus?.(new ProductApiError({
      status: 503, code: 'feature_temporarily_unavailable', message: 'unavailable', recovery: 'same_request',
    })))
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Temporarily unavailable')
    expect(byButton('Refresh').disabled).toBe(false)
    // The error's retry button says "Try again" (R13 W-40); the copy itself does not repeat it.
    expect(byButton('Try again').disabled).toBe(false)
    expect(document.body.textContent?.split('Try again')).toHaveLength(2)
  })

  it('shows the unavailable state, not a retryable error, when the sync feature is disabled (404)', async () => {
    mocks.getSyncStatus.mockRejectedValue(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'not found', recovery: 'none',
    }))
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Sync is not available yet')
    expect(document.body.textContent).not.toContain('Resource not found')
    expect(document.querySelector('[role=alert]')).toBeNull()
    // One recovery affordance: the head Refresh, no in-body "Try again".
    expect(byButton('Refresh').disabled).toBe(false)
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Try again')).toBe(false)
  })

  it('replays an unknown outcome with the same frozen intent and revision', async () => {
    mocks.resolveSyncConflict.mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'unknown', recovery: 'same_request', sameRequestRetrySafe: true }))
      .mockResolvedValueOnce({ conflictId: 'conflict-1', status: 'resolved', revision: 'r2', etag: '"r2"', resolvedAt: '2026-07-28T01:00:00.000Z' })
    render(); await waitForDom(domFinishedLoading); choose('incoming'); act(() => byButton('Resolve conflict').click()); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('resolution may not have completed')
    expect(document.querySelector('fieldset')?.disabled).toBe(true)
    act(() => byButton('Retry resolution').click()); await waitForDom(domFinishedLoading)
    const first = mocks.resolveSyncConflict.mock.calls[0]; const replay = mocks.resolveSyncConflict.mock.calls[1]
    expect(replay![2]).toBe(first![2]); expect(replay![3].intentId).toBe(first![3].intentId)
    expect(document.body.textContent).not.toContain('Server title')
    expect(document.activeElement).toBe(document.querySelector('#conflict-heading'))
  })

  it('preserves a custom draft across 412 refresh and requires confirmation on the new revision', async () => {
    mocks.resolveSyncConflict.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry' }))
      .mockResolvedValueOnce({ conflictId: 'conflict-1', status: 'resolved', revision: 'r3', etag: '"r3"', resolvedAt: '2026-07-28T01:00:00.000Z' })
    // Mutable server state: mount reads the r1 conflict, and the refresh that the
    // 412 triggers reads the r2 the server has actually moved to.
    let serverConflicts = [conflict()]
    mocks.loadSyncConflicts.mockImplementation(() => Promise.resolve(serverConflicts))
    render(); await waitForDom(domFinishedLoading); choose('custom')
    const input = document.querySelector<HTMLInputElement>('[aria-label="Custom title"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'My retained draft')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'My retained draft' }))
    })
    serverConflicts = [conflict({ revision: 'r2', etag: '"r2"', summary: { current: 'Concurrent title', incoming: 'Browser title' } })]
    act(() => byButton('Resolve conflict').click()); await waitForDom(domFinishedLoading)
    expect(input.value).toBe('My retained draft'); expect(document.querySelector('[role=alert]')?.textContent).toContain('changed')
    expect(mocks.abandonSyncConflictIntent).toHaveBeenCalled(); act(() => byButton('Confirm with latest version').click()); await waitForDom(domFinishedLoading)
    expect(mocks.resolveSyncConflict.mock.calls[1]?.[2]).toBe('"r2"')
    expect(mocks.resolveSyncConflict.mock.calls[1]?.[1]).toEqual({ resolution: 'custom', value: 'My retained draft' })
  })

  it('converges when a stale conflict is already resolved and supports keyboard/narrow layout hooks', async () => {
    mocks.resolveSyncConflict.mockRejectedValueOnce(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'gone', recovery: 'none' }))
    // Mutable server state: the conflict exists at mount, and the 404 refresh
    // finds the server has already dropped it.
    let serverConflicts = [conflict()]
    mocks.loadSyncConflicts.mockImplementation(() => Promise.resolve(serverConflicts))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 }); render(); await waitForDom(domFinishedLoading)
    choose('server'); const submit = byButton('Resolve conflict'); submit.focus(); act(() => submit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    serverConflicts = []
    act(() => submit.click())
    await waitForDom(() => (document.body.textContent ?? '').includes('No open conflicts'))
    expect(document.body.textContent).toContain('No open conflicts'); expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    expect(document.activeElement).toBe(document.querySelector('#conflict-heading'))
  })

  it('shows Stop syncing for an active fixture and does not call the client before confirm', async () => {
    render(); await waitForDom(domFinishedLoading)
    const retire = byButton('Stop syncing')
    expect(retire.getAttribute('aria-label')).toContain('Chrome profile')
    act(() => retire.click())
    expect(mocks.retireSyncReplica).not.toHaveBeenCalled()
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') !== null)
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain('This browser stops syncing')
    expect(document.body.textContent).not.toContain('Sync now')
  })

  it('returns retirement controls to idle after Cancel', async () => {
    render(); await waitForDom(domFinishedLoading); act(() => byButton('Stop syncing').click())
    await confirmModal('Cancel')
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') === null)
    expect(byButton('Stop syncing').disabled).toBe(false)
    expect([...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Stop syncing')).toHaveLength(1)
    expect(mocks.retireSyncReplica).not.toHaveBeenCalled()
  })

  it('confirms retirement with the replica id and quoted fixture etag', async () => {
    render(); await waitForDom(domFinishedLoading); act(() => byButton('Stop syncing').click())
    await confirmModal('Stop syncing'); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(mocks.retireSyncReplica.mock.calls[0]?.[0]).toBe('replica-1')
    expect(mocks.retireSyncReplica.mock.calls[0]?.[1]).toBe('"4"')
    expect(mocks.retireSyncReplica.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      clearIntentOnSuccess: false, maxRetries: 0,
    }))
    expect(mocks.resolveSyncConflict).not.toHaveBeenCalled()
  })

  it('toasts on success and hides Stop syncing after the row is marked retired', async () => {
    mocks.retireSyncReplica.mockImplementation(async () => {
      mocks.getSyncStatus.mockResolvedValue(status({
        replicas: [{ ...status().replicas[0]!, status: 'retired' }],
      }))
      return {
        replicaId: 'replica-1', status: 'retired' as const, lifecycleRevision: '5', etag: '"5"',
        retiredAt: '2026-07-28T01:00:00.000Z',
      }
    })
    render(); await waitForDom(domFinishedLoading); act(() => byButton('Stop syncing').click())
    await confirmModal('Stop syncing'); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(mocks.toast).toHaveBeenCalledWith('Stopped syncing this browser')
    expect(mocks.abandonSyncReplicaIntent).toHaveBeenCalled()
    expect(document.body.textContent).toContain('Chrome profile')
    expect(document.body.textContent).toContain('Stopped syncing')
    expect([...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Stop syncing')).toBe(false)
    expect(mocks.resolveSyncConflict).not.toHaveBeenCalled()
  })

  it('does not show Stop syncing when the replica list is empty', async () => {
    // Empty account is server state: both mount reads must see it.
    mocks.getSyncStatus.mockResolvedValue(status({ devices: [], replicas: [] }))
    mocks.loadSyncConflicts.mockResolvedValue([]); render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('No connected browsers')
    expect(document.body.textContent).not.toContain('Stop syncing')
    expect(document.body.textContent).not.toContain('Sync now')
  })

  it('does not show Stop syncing when the replica is already retired', async () => {
    // The retired replica is server state: both mount reads must see it.
    mocks.getSyncStatus.mockResolvedValue(status({
      replicas: [{ ...status().replicas[0]!, status: 'retired' }],
    }))
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Stopped syncing')
    expect(document.body.textContent).not.toContain('Stop syncing')
  })

  it('replays an unknown retirement with the same intent id and If-Match', async () => {
    mocks.retireSyncReplica.mockRejectedValueOnce(new ProductApiError({
      status: 0, code: 'transport_error', message: 'unknown', recovery: 'same_request', sameRequestRetrySafe: true,
    }))
    render(); await waitForDom(domFinishedLoading); act(() => byButton('Stop syncing').click())
    await confirmModal('Stop syncing'); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('Syncing may not have stopped')
    act(() => byButton('Try again').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    const first = mocks.retireSyncReplica.mock.calls[0]; const replay = mocks.retireSyncReplica.mock.calls[1]
    expect(first?.[0]).toBe('replica-1'); expect(first?.[1]).toBe('"4"')
    expect(replay?.[0]).toBe(first?.[0]); expect(replay?.[1]).toBe(first?.[1])
    expect(replay?.[2]?.intentId).toBe(first?.[2]?.intentId)
  })

  it('requires Confirm again with the refreshed etag after a 412', async () => {
    mocks.retireSyncReplica.mockRejectedValueOnce(new ProductApiError({
      status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry',
    }))
    render(); await waitForDom(domFinishedLoading)
    // The mount has settled; this override belongs to the refresh the 412
    // triggers, which now sees the replica at its new revision.
    mocks.getSyncStatus.mockResolvedValueOnce(status({
      replicas: [{ ...status().replicas[0]!, lifecycleRevision: '5', etag: '"5"' }],
    }))
    act(() => byButton('Stop syncing').click())
    await confirmModal('Stop syncing'); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    const alert = document.querySelector('[role=alert]')?.textContent ?? ''
    expect(alert).toContain('changed'); expect(alert.toLowerCase()).toContain('refresh')
    expect(mocks.abandonSyncReplicaIntent).toHaveBeenCalled()
    act(() => byButton('Stop syncing').click()); await waitForDom(domFinishedLoading); await waitForDom(domFinishedLoading)
    expect(mocks.retireSyncReplica.mock.calls[1]?.[1]).toBe('"5"')
    expect(mocks.retireSyncReplica.mock.calls[1]?.[2]?.intentId).not.toBe(mocks.retireSyncReplica.mock.calls[0]?.[2]?.intentId)
  })

  it('keeps replica retirement controls within a 375px viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 })
    render(); await waitForDom(domFinishedLoading); act(() => byButton('Stop syncing').click())
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
    expect(document.body.textContent).not.toContain('Sync now')
  })

  it('shows only the server conflict receipt after resolve and does not invent a local tree', async () => {
    mocks.resolveSyncConflict.mockResolvedValueOnce({
      conflictId: 'conflict-1', status: 'resolved', revision: 'r2', etag: '"r2"',
      resolvedAt: '2026-07-28T01:00:00.000Z',
    })
    render(); await waitForDom(domFinishedLoading); choose('server')
    act(() => byButton('Resolve conflict').click()); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Resolved')
    expect(document.body.textContent).toContain('Conflict resolved')
    expect(document.body.textContent).not.toContain('Server title')
    expect(document.body.textContent).not.toContain('Bookmark restored')
    expect(mocks.toast).not.toHaveBeenCalledWith('Conflict resolved')
    expect(document.activeElement).toBe(document.querySelector('#conflict-heading'))
  })
})
