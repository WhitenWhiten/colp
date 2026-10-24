// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ProductApiError, type SyncReplicaView, type SyncReplicaIssuesView } from '../../api'
import { mountTree, cleanup, waitForDom } from '../../test/render'
import { ReplicaHealth } from './health'
const mocks = vi.hoisted(() => ({ list: vi.fn(), send: vi.fn(), copy: vi.fn() }))
vi.mock('../../api', async original => { const api = await original<typeof import('../../api')>(); return { ...api,
  productClient: { ...api.productClient, listSyncReplicaIssues: mocks.list, sendSyncReplicaCommand: mocks.send } } })
vi.mock('../../lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
beforeEach(() => { vi.clearAllMocks(); mocks.copy.mockResolvedValue(undefined) })
afterEach(cleanup)
const now = new Date().toISOString()
const replica = (health: SyncReplicaView['health'] = null): SyncReplicaView => ({ id: 'r', deviceId: 'd', name: 'Chrome',
  collectionId: 'c', kind: 'browser_extension', status: 'active', leaseExpiresAt: now, lastSeenAt: now,
  lastAckAt: now, acknowledgedCommitOrdinal: '1', lifecycleRevision: '1', etag: '"1"', activity: 'current', behindSince: null, health })
const report = (code = 'local_merge_difference'): SyncReplicaIssuesView => ({ replicaId: 'r', reportedAt: now, total: 1,
  items: [{ issueId: 'issue', code, direction: 'local', title: 'Bookmark', count: 2, firstSeenAt: now, lastSeenAt: now, actions: [] }],
  ackWarnings: [], ackWarningsAt: null })
const health = { state: 'degraded' as const, code: null, issueCount: 1, reportedAt: now, since: now, actions: [], commands: [] }
function click(text: string) { const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!; expect(button).toBeTruthy(); act(() => button.click()) }

test('Ack warnings remain reachable without health issues and their stable codes can be copied', async () => {
  mocks.list.mockResolvedValue({ replicaId: 'r', reportedAt: null, total: 0, items: [],
    ackWarnings: [{ code: 'apply_set_aside', message: 'One node was set aside.', path: '/nodes/a' }], ackWarningsAt: now })
  mountTree(<ReplicaHealth replica={replica()} onChanged={() => {}} />)
  click('Show diagnostics'); await waitForDom(() => document.body.textContent?.includes('apply_set_aside') === true)
  expect(document.body.textContent).toContain('not a cumulative history')
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Copy warning code"]')!.click())
  await waitForDom(() => mocks.copy.mock.calls.length === 1); expect(mocks.copy).toHaveBeenCalledWith('apply_set_aside')
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Copy sync diagnostics"]')!.click())
  await waitForDom(() => mocks.copy.mock.calls.length === 2); expect(mocks.copy.mock.calls[1]![0]).toContain('/nodes/a')
})
test('local merge diagnostics are explicit; refreshing a resolved list removes issues and preserves Ack diagnostics', async () => {
  mocks.list.mockResolvedValue(report())
  mountTree(<ReplicaHealth replica={replica(health)} onChanged={() => {}} />)
  click('Show 1 item'); await waitForDom(() => document.body.textContent?.includes('local_merge_difference') === true)
  expect(document.body.textContent).toContain('not a server conflict'); expect(document.body.textContent).toContain('issue')
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Copy error code"]')!.click())
  await waitForDom(() => mocks.copy.mock.calls.length > 0); expect(mocks.copy).toHaveBeenCalledWith('local_merge_difference')
  mocks.list.mockResolvedValue({ ...report(), total: 0, items: [] }); click('Refresh')
  await waitForDom(() => document.body.textContent?.includes('nothing set aside any more') === true)
  expect(document.body.textContent).not.toContain('local_merge_difference')
})
test('late results cannot repaint another replica and stale issue actions are disabled', async () => {
  let finish!: (view: SyncReplicaIssuesView) => void
  mocks.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ ...report('sequence_blocked'), replicaId: 'next' })
  const mounted = mountTree(<ReplicaHealth replica={replica(health)} onChanged={() => {}} />)
  click('Show 1 item'); await waitForDom(() => Boolean(finish))
  mounted.rerender(<ReplicaHealth replica={{ ...replica(health), id: 'next' }} onChanged={() => {}} />)
  await waitForDom(() => document.body.textContent?.includes('sequence_blocked') === true)
  await act(async () => finish(report('old_replica_error')))
  expect(document.body.textContent).not.toContain('old_replica_error')
})
test('a stale action has visible feedback; API acceptance and command execution do not claim convergence', async () => {
  const changed = vi.fn(); mocks.send.mockRejectedValueOnce(new ProductApiError(412, { code: 'precondition_failed', message: 'stale' }))
  const mounted = mountTree(<ReplicaHealth replica={replica({ ...health, actions: ['retry'] })} onChanged={changed} />)
  click('Retry'); await waitForDom(() => document.body.textContent?.includes('no longer offers this') === true)
  expect(changed).toHaveBeenCalledTimes(1)
  mocks.send.mockResolvedValue({ state: 'pending' }); click('Retry')
  await waitForDom(() => document.body.textContent?.includes('waiting for Chrome to execute') === true)
  mounted.rerender(<ReplicaHealth replica={replica({ ...health, actions: ['retry'], commands: [{ commandId: 'cmd', replicaId: 'r',
    action: 'retry', issueId: null, state: 'done', resultCode: 'retry_completed', createdAt: now, completedAt: now, expiresAt: now }] })} onChanged={changed} />)
  expect(document.body.textContent).toContain('convergence must be checked')
  expect(document.body.textContent).toContain('1 item')
})

test('a loaded list older than health cannot execute issue actions', async () => {
  const view = report('sequence_blocked'); view.items[0]!.actions = ['retry']
  mocks.list.mockResolvedValue(view)
  mountTree(<ReplicaHealth replica={replica({ ...health, reportedAt: new Date(Date.parse(now) + 1000).toISOString() })} onChanged={() => {}} />)
  click('Show 1 item'); await waitForDom(() => document.body.textContent?.includes('predates the latest') === true)
  expect(document.querySelector<HTMLButtonElement>('[aria-label^="Try again:"]')?.disabled).toBe(true)
  expect(mocks.send).not.toHaveBeenCalled()
})

test('a retired replica retains its unfinished reset and can retry a failed reset', () => {
  const command = { commandId: 'reset', replicaId: 'r', action: 'rebuild' as const, issueId: null,
    state: 'delivered' as const, resultCode: null, createdAt: now, completedAt: null, expiresAt: now }
  const retired = { ...replica({ ...health, actions: ['rebuild'], commands: [command] }), status: 'retired' as const }
  const mounted = mountTree(<ReplicaHealth replica={retired} onChanged={() => {}} />)
  expect(document.body.textContent).toContain('stopped uploads from the old sync copy')
  expect(document.body.textContent).toContain('Waiting for Chrome to report back')
  mounted.rerender(<ReplicaHealth replica={{ ...retired, health: { ...health, actions: ['rebuild'],
    commands: [{ ...command, state: 'failed', resultCode: 'command_interrupted', completedAt: now }] } }} onChanged={() => {}} />)
  expect([...document.querySelectorAll('button')].some(button => button.textContent === 'Reset sync')).toBe(true)
  expect(document.body.textContent).toContain('browser stopped before it finished')
})

test('diagnostic read failure still exposes recovery actions inside the dialog', async () => {
  mocks.list.mockRejectedValue(new Error('diagnostics unavailable'))
  mountTree(<ReplicaHealth replica={replica({ ...health, state: 'stopped', code: 'sync_diagnostics_unavailable',
    issueCount: 0, actions: ['rebuild'] })} onChanged={() => {}} />)
  click('Show diagnostics')
  await waitForDom(() => document.body.textContent?.includes('Couldn’t load the items') === true)
  const dialog = document.querySelector('[role="dialog"]')!
  expect([...dialog.querySelectorAll('button')].some(button => button.textContent === 'Reset sync')).toBe(true)
})
