// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { SyncConflictSummary, SyncReplicaCommandView, SyncStatusView } from '../api/types'
import { Sync } from './Sync'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getSyncStatus: vi.fn(), loadSyncConflicts: vi.fn(), resolveSyncConflict: vi.fn(),
  retireSyncReplica: vi.fn(), abandonSyncConflictIntent: vi.fn(), abandonSyncReplicaIntent: vi.fn(),
  loadSyncTrash: vi.fn(), getSyncTrashItem: vi.fn(), restoreSyncTrashItem: vi.fn(),
  restoreSyncTrashBatch: vi.fn(), restoreSyncTrashSubtree: vi.fn(), emptySyncTrash: vi.fn(),
  abandonSyncTrashIntent: vi.fn(), toast: vi.fn(), getLibrary: vi.fn(), listSyncReplicaIssues: vi.fn(),
  sendSyncReplicaCommand: vi.fn(),
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
    getLibrary: mocks.getLibrary, listSyncReplicaIssues: mocks.listSyncReplicaIssues,
    sendSyncReplicaCommand: mocks.sendSyncReplicaCommand,
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
    mocks.getLibrary.mockResolvedValue({ id: 'collection-1', title: 'Bookmarks' })
    vi.clearAllMocks(); sessionStorage.clear(); document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getSyncStatus.mockResolvedValue(status()); mocks.loadSyncConflicts.mockResolvedValue([conflict()])
    mocks.loadSyncTrash.mockResolvedValue([])

  })
  afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks() })
  function render() { mountTree(<MemoryRouter><Sync /></MemoryRouter>) }

  it('renders server facts and malicious summaries strictly as text', async () => {
    const attack = '<img src=x onerror=alert(1)><script>alert(2)</script>'
    // Endpoint description: the hostile summary is server state, so mount #2's
    // read must return it too — the guarantee is about escaping, not call order.
    mocks.loadSyncConflicts.mockResolvedValue([conflict({ summary: { current: attack, incoming: 'https://user:secret@example.test/<svg onload=alert(3)>' } })])
    render(); await waitForDom(domFinishedLoading)
    // C-11's sharing clause waits for multi-user: with one owner nothing is shared.
    expect(document.body.textContent).not.toContain('not ones shared with you')
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
    expect(document.body.textContent).toContain('No browsers syncing yet')
    expect(document.querySelector('a[href="/extension"]')?.textContent).toBe('Connect a browser')
    expect(document.body.textContent).toContain('No open conflicts')
    expect(document.querySelector('[data-testid="sync-count"]')).toBeNull()
    // The mount has settled; this override belongs to the next genuine user
    // action: the Refresh click now observes a recovery-required replica.
    mocks.getSyncStatus.mockResolvedValueOnce(status({ replicas: [{ ...status().replicas[0]!, status: 'recovery_required' }] }))
    act(() => byButton('Refresh').click())
    await waitForDom(() => (document.body.textContent ?? '').includes('Catching up'))
    expect(document.body.textContent).toContain('will reload your library from this server on its next sync')
    expect(document.body.textContent).not.toContain('sync reset')
  })

  it('flags a browser the server sees missing changes, with the reason in plain words', async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
    const base = status().replicas[0]!
    mocks.getSyncStatus.mockResolvedValue(status({ replicas: [
      { ...base, activity: 'stalled', behindSince: hoursAgo(3), lastSeenAt: hoursAgo(0) },
      { ...base, id: 'replica-2', name: 'Laptop profile', activity: 'silent', behindSince: hoursAgo(5), lastSeenAt: hoursAgo(2) },
      { ...base, id: 'replica-3', name: 'Phone profile', activity: 'behind', behindSince: hoursAgo(0) },
    ] }))
    render(); await waitForDom(domFinishedLoading)
    const cards = [...document.querySelectorAll('[aria-label="Connected browsers"] > li')]
    expect(cards.map((card) => card.textContent?.includes('Not syncing'))).toEqual([true, true, false])
    expect(cards[2]?.textContent).toContain('Active')
    expect(cards[0]?.querySelector('[role=status] p')?.textContent)
      .toBe('It connected just now, but changes from 3 h ago haven’t reached it. Open the extension on that browser to see why.')
    expect(cards[1]?.querySelector('[role=status] p')?.textContent)
      .toBe('Changes from 5 h ago are waiting, and it was last seen 2 h ago. If that browser is open and online, open the extension on it to see why.')
    // Ordinary lag is not a problem worth a note.
    expect(cards[2]?.querySelector('[role=status]')).toBeNull()
  })

  it('says why a browser stopped, and lists what it set aside on request', async () => {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
    const base = status().replicas[0]!
    const report = (state: 'stopped' | 'degraded' | 'paused', issueCount: number, code: string | null = null) =>
      ({ state, code, since: hoursAgo(2), reportedAt: hoursAgo(0), issueCount, actions: [], commands: [] })
    mocks.getSyncStatus.mockResolvedValue(status({ replicas: [
      { ...base, health: report('stopped', 3, 'create_placement_unproven') },
      { ...base, id: 'replica-2', name: 'Laptop profile', health: report('degraded', 1) },
      { ...base, id: 'replica-3', name: 'Phone profile', health: report('paused', 4) },
      { ...base, id: 'replica-4', name: 'Tablet profile', health: report('stopped', 0, 'brand_new_code'),
        activity: 'silent', behindSince: hoursAgo(5), lastSeenAt: hoursAgo(3) },
    ] }))
    mocks.listSyncReplicaIssues.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      replicaId: 'replica-1', reportedAt: hoursAgo(0), total: 3, ackWarnings: [], ackWarningsAt: null, items: [
        { issueId: 'a', code: 'conflict_pending', direction: 'push', nodeId: 'node-1', title: 'Recipes', count: 1,
          firstSeenAt: hoursAgo(1), lastSeenAt: hoursAgo(1), actions: [] },
        { issueId: 'b', code: 'invalid_node_constraints', direction: 'push', count: 2,
          firstSeenAt: hoursAgo(1), lastSeenAt: hoursAgo(1), actions: [] },
      ] })
    render(); await waitForDom(domFinishedLoading)
    const cards = () => [...document.querySelectorAll('[aria-label="Connected browsers"] > li')]
    const badge = (card: Element) => card.querySelector('[data-testid="replica-state"]')?.textContent
    expect(cards().map(badge)).toEqual(['Stopped', 'Needs attention', 'Paused', 'Stopped'])
    const note = (index: number) => cards()[index]?.querySelector('[role=status]')?.textContent ?? ''
    expect(note(0)).toContain('Sync on this browser has stopped: it can’t tell where a saved bookmark belongs. Open the extension on that browser to fix it.')
    expect(note(1)).toContain('1 item on this browser couldn’t sync. Everything else keeps syncing.')
    expect(note(2)).toContain('Sync is paused on this browser.')
    // A stop the web does not know yet still says the code; the stop outranks the silence note.
    expect(note(3)).toContain('it reported “brand_new_code”.')
    expect(note(3)).not.toContain('are waiting')
    // Paused hides item names while keeping latest Ack diagnostics reachable.
    expect(cards()[2]?.querySelector('button')?.textContent).toBe('Show diagnostics')
    expect(cards()[3]?.textContent).not.toContain('Show 0')
    const show = [...cards()[0]!.querySelectorAll('button')].find((button) => button.textContent === 'Show 3 items')!
    act(() => show.click())
    await waitForDom(() => note(0).includes('Couldn’t load the items.'))
    act(() => [...cards()[0]!.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click())
    await waitForDom(() => note(0).includes('Recipes'))
    expect(mocks.listSyncReplicaIssues).toHaveBeenCalledWith('replica-1', expect.any(Object))
    const items = [...cards()[0]!.querySelectorAll('[aria-label="Items this browser couldn’t sync"] li')].map((item) => item.textContent)
    expect(items[0]).toContain('RecipesWaiting for a conflict to be resolved'); expect(items[0]).toContain('conflict_pending')
    expect(items[1]).toContain('The server didn’t accept this change (2 times)'); expect(items[2]).toBe('and 1 more item')
  })

  it('asks a stopped browser to retry or reset from here, and shows what came of it', async () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
    const base = status().replicas[0]!
    const command = (action: 'retry' | 'rebuild', state: SyncReplicaCommandView['state'], extra: Partial<SyncReplicaCommandView> = {}) => ({
      commandId: `cmd-${action}-${state}`, replicaId: 'replica-1', action, issueId: null, state, resultCode: null,
      createdAt: minutesAgo(3), completedAt: state === 'done' || state === 'failed' ? minutesAgo(1) : null,
      expiresAt: minutesAgo(-7 * 24 * 60), ...extra }) satisfies SyncReplicaCommandView
    const stopped = (commands: SyncReplicaCommandView[] = [], code = 'recovery_identity_unproven') => status({ replicas: [{
      ...base, health: { state: 'stopped', code, since: minutesAgo(60), reportedAt: minutesAgo(0), issueCount: 1,
        actions: ['retry', 'rebuild'], commands } }] })
    mocks.getSyncStatus.mockResolvedValue(stopped())
    mocks.sendSyncReplicaCommand.mockResolvedValue(command('retry', 'pending'))
    render(); await waitForDom(domFinishedLoading)
    const card = () => document.querySelector('[aria-label="Connected browsers"] > li')!
    const note = () => card().querySelector('[role=status]')?.textContent ?? ''
    expect(note()).toContain('Try the options below, or open the extension on that browser.')
    const statusReads = mocks.getSyncStatus.mock.calls.length
    act(() => byButton('Retry').click())
    await waitForDom(() => mocks.toast.mock.calls.length > 0)
    expect(mocks.sendSyncReplicaCommand).toHaveBeenCalledWith('replica-1', { action: 'retry' },
      expect.objectContaining({ maxRetries: 1, intentId: expect.stringMatching(/^sync-command:replica-1:retry::/u) }))
    expect(mocks.toast).toHaveBeenCalledWith('Sent to Chrome profile. It runs the next time that browser checks in.')
    await waitForDom(() => mocks.getSyncStatus.mock.calls.length > statusReads)

    // Reset is destructive on that browser, so it asks first; cancelling sends nothing.
    act(() => byButton('Reset sync').click()); await confirmModal('Cancel')
    expect(mocks.sendSyncReplicaCommand).toHaveBeenCalledTimes(1)
    act(() => byButton('Reset sync').click()); await confirmModal('Reset sync')
    await waitForDom(() => mocks.sendSyncReplicaCommand.mock.calls.length === 2)
    expect(mocks.sendSyncReplicaCommand.mock.calls[1]!.slice(0, 2)).toEqual(['replica-1', { action: 'rebuild' }])

    // An open request replaces its button and says it is waiting for the browser.
    mocks.getSyncStatus.mockResolvedValue(stopped([command('rebuild', 'pending'), command('retry', 'done')]))
    act(() => byButton('Refresh').click())
    await waitForDom(() => note().includes('Reset sync sent.'))
    expect(note()).toContain('It runs when Chrome profile next checks in, usually within five minutes while it’s open.')
    expect([...card().querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Reset sync')
    expect(byButton('Retry').disabled).toBe(false)
    mocks.getSyncStatus.mockResolvedValue(stopped([command('retry', 'failed', { resultCode: 'action_unavailable' })]))
    act(() => byButton('Refresh').click())
    await waitForDom(() => note().includes('Retry didn’t work: that browser no longer offered it.'))
    // After a reset the old entry says so once, and its buttons are gone with its offers.
    mocks.getSyncStatus.mockResolvedValue(status({ replicas: [{ ...base, health: { state: 'stopped', code: 'replica_rebuilt',
      since: minutesAgo(1), reportedAt: minutesAgo(1), issueCount: 0, actions: [], commands: [command('rebuild', 'done')] } }] }))
    act(() => byButton('Refresh').click())
    await waitForDom(() => note().includes('Sync on this browser was reset.'))
    expect(note()).not.toContain('Sync was reset 1 min ago')
    expect([...card().querySelectorAll('button')].map((button) => button.textContent)).not.toContain('Retry')

    // A browser that stopped offering it answers 412; the owner hears so.
    mocks.getSyncStatus.mockResolvedValue(stopped())
    act(() => byButton('Refresh').click()); await waitForDom(() => note().includes('Try the options below'))
    mocks.sendSyncReplicaCommand.mockRejectedValueOnce(new ProductApiError({ status: 412, code: 'precondition_failed',
      message: 'stale', recovery: 'refresh_and_retry' }))
    act(() => byButton('Retry').click())
    await waitForDom(() => mocks.toast.mock.calls.some(([message]) => String(message).startsWith('That browser no longer offers this.')))
  })

  it('offers a confirmed reset for a syncing browser with a Pull issue', async () => {
    const base = status().replicas[0]!
    const reportedAt = new Date().toISOString()
    mocks.getSyncStatus.mockResolvedValue(status({ replicas: [{ ...base, health: { state: 'degraded', code: null,
      since: base.lastSeenAt, reportedAt: new Date().toISOString(), issueCount: 1, actions: ['rebuild'], commands: [] } }] }))
    mocks.sendSyncReplicaCommand.mockResolvedValue({ commandId: 'repair', replicaId: base.id, action: 'rebuild',
      issueId: null, state: 'pending', resultCode: null, createdAt: new Date().toISOString(), completedAt: null,
      expiresAt: new Date(Date.now() + 100000).toISOString() })
    render(); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Reset sync below to repair this browser’s copy.')
    act(() => byButton('Reset sync').click()); await confirmModal('Cancel')
    expect(mocks.sendSyncReplicaCommand).not.toHaveBeenCalled()
    act(() => byButton('Reset sync').click()); await confirmModal('Reset sync')
    await waitForDom(() => mocks.sendSyncReplicaCommand.mock.calls.length === 1)
    expect(mocks.sendSyncReplicaCommand.mock.calls[0]!.slice(0, 2)).toEqual(['replica-1', { action: 'rebuild' }])
  })

  it('retries one held item from the list of what a browser set aside', async () => {
    const base = status().replicas[0]!
    const reportedAt = new Date().toISOString()
    mocks.getSyncStatus.mockResolvedValue(status({ replicas: [{ ...base, health: { state: 'degraded', code: null,
      since: base.lastSeenAt, reportedAt, issueCount: 2, actions: [], commands: [] } }] }))
    mocks.listSyncReplicaIssues.mockResolvedValue({ replicaId: 'replica-1', reportedAt, total: 2,
      ackWarnings: [], ackWarningsAt: null, items: [
        { issueId: 'held', code: 'create_placement_unproven', direction: 'push', title: 'Recipes', count: 1,
          firstSeenAt: base.lastSeenAt, lastSeenAt: base.lastSeenAt, actions: ['retry'] },
        { issueId: 'waiting', code: 'dependency_hold', direction: 'push', title: 'Soup', count: 1,
          firstSeenAt: base.lastSeenAt, lastSeenAt: base.lastSeenAt, actions: [] }] })
    mocks.sendSyncReplicaCommand.mockResolvedValue({ commandId: 'cmd-1', replicaId: 'replica-1', action: 'retry',
      issueId: 'held', state: 'pending', resultCode: null, createdAt: base.lastSeenAt, completedAt: null, expiresAt: base.leaseExpiresAt })
    render(); await waitForDom(domFinishedLoading)
    act(() => byButton('Show 2 items').click())
    await waitForDom(() => (document.body.textContent ?? '').includes('Recipes'))
    const items = [...document.querySelectorAll('[aria-label="Items this browser couldn’t sync"] li')]
    // Only the held save offers a retry; the change waiting for it follows it.
    expect(items.map((item) => item.querySelector('button[aria-label^="Try again:"]')?.getAttribute('aria-label') ?? null))
      .toEqual(['Try again: Recipes', null])
    act(() => (items[0]!.querySelector('button[aria-label^="Try again:"]') as HTMLButtonElement)!.click())
    await waitForDom(() => mocks.sendSyncReplicaCommand.mock.calls.length === 1)
    expect(mocks.sendSyncReplicaCommand.mock.calls[0]!.slice(0, 2)).toEqual(['replica-1', { action: 'retry', issueId: 'held' }])
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
    expect(document.body.textContent).toContain('No browsers syncing yet')
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
