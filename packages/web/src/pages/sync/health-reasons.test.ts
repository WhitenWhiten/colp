import { expect, test } from 'vitest'
import { stopReason, commandNote, issueSummary } from './health'

test('diagnostic failures and browser-managed nodes have actionable human-readable reasons', () => {
  expect(stopReason('sync_diagnostics_unavailable')).toContain('retry reporting automatically')
  expect(issueSummary({ issueId: 'i', direction: 'pull', count: 1, firstSeenAt: 'now', lastSeenAt: 'now',
    code: 'managed_not_writable', actions: [] })).toContain('managed by the browser')
})

test('global issue ceiling explains the stop without claiming bookmarks are missing', () => {
  expect(stopReason('sync_issue_ceiling')).toBe('it has too many unresolved items to keep syncing safely.')
})

test('scheduling a retry does not claim its execution or sync recovery completed', () => {
  expect(commandNote({ action: 'retry', state: 'done', resultCode: 'retry_scheduled' } as never, 'Chrome'))
    .toBe('Retry was scheduled on Chrome. Check its sync status for the result.')
})

test('Snapshot integrity stops retain the actionable cause', () => {
  expect(stopReason('snapshot_invalid')).toContain('failed integrity checks')
  expect(stopReason('snapshot_invalid')).toContain('Retry')
})

test('a held upload the browser could not prepare is not blamed on the server', () => {
  const base = { issueId: 'i', direction: 'push' as const, count: 1, firstSeenAt: 'now', lastSeenAt: 'now' }
  expect(issueSummary({ ...base, code: 'native_parent_unreadable', actions: ['retry'] }))
    .toBe('That browser couldn’t get it ready to upload')
  expect(issueSummary({ ...base, code: 'invalid_node_constraints', actions: [] }))
    .toBe('The server didn’t accept this change')
})

test('a stalled upload says the lane behind it waits, instead of claiming a rejection', () => {
  const base = { issueId: 'i', direction: 'push' as const, count: 9, firstSeenAt: 'now', lastSeenAt: 'now', actions: [] }
  expect(issueSummary({ ...base, code: 'push_response_unrecognized' })).toContain('wait behind it')
  expect(issueSummary({ ...base, code: 'push_deferred' })).toContain('keeps deferring')
  expect(issueSummary({ ...base, code: 'sequence_gap' })).toContain('earlier change first')
})

test('a pulled change that collides with an existing mapping names the rebuild exit', () => {
  expect(stopReason('mapping_identity_conflict')).toBe('its copy of your library needs a rebuild.')
})

test('a subtree delete held because the folder changed elsewhere says Retry deletes it anyway', () => {
  const base = { issueId: 'i', direction: 'push' as const, count: 1, firstSeenAt: 'now', lastSeenAt: 'now', actions: ['retry' as const] }
  expect(issueSummary({ ...base, code: 'delete_subtree_changed' })).toContain('Retry deletes it anyway')
})
