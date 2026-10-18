import { expect, test } from 'vitest'
import { stopReason, commandNote, issueSummary } from './health'

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
