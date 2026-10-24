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

test('a retry that ran is not a cure: the note says what the browser reports since (C-17a)', () => {
  const done = { action: 'retry', state: 'done', resultCode: 'retry_completed', issueId: null, completedAt: '2026-10-24T10:00:00.000Z' } as never
  expect(commandNote(done, 'Chrome')).toBe('Chrome tried again. Its next report shows whether that fixed it.')
  expect(commandNote(done, 'Chrome', { state: 'stopped', reportedAt: '2026-10-24T09:59:00.000Z' }))
    .toBe('Chrome tried again. Its next report shows whether that fixed it.')
  expect(commandNote(done, 'Chrome', { state: 'stopped', reportedAt: '2026-10-24T10:00:00.000Z' }))
    .toBe('Chrome tried again, but it still reports a problem.')
  expect(commandNote(done, 'Chrome', { state: 'syncing', reportedAt: '2026-10-24T10:01:00.000Z' }))
    .toBe('Chrome tried again, and it now reports that sync is running.')
  const item = { action: 'retry', state: 'done', resultCode: 'recapture_completed', issueId: 'issue', completedAt: '2026-10-24T10:00:00.000Z' } as never
  expect(commandNote(item, 'Chrome')).toBe('Chrome tried this item again. Its next report shows whether that fixed it.')
})

test('a request that failed says why in plain words, with the code only when it is new to us (C-12)', () => {
  const failed = (resultCode: string) => ({ action: 'rebuild', state: 'failed', resultCode, issueId: null }) as never
  expect(commandNote(failed('upload_outcome_unsettled'), 'Chrome')).toContain('Reset sync didn’t work: a change that browser sent has no confirmed result yet')
  expect(commandNote(failed('rebuild_failed'), 'Chrome')).toContain('the reset didn’t finish')
  expect(commandNote(failed('brand_new_failure'), 'Chrome')).toBe('Reset sync didn’t work: the browser couldn’t carry it out (brand_new_failure).')
  expect(commandNote({ action: 'retry', state: 'failed', resultCode: null, issueId: null } as never, 'Chrome')).toBe('Retry didn’t work.')
})

test('a request waiting on a browser that has been quiet for hours does not promise five minutes (C-17d)', () => {
  const pending = { action: 'retry', state: 'pending', resultCode: null, issueId: null } as never
  const recent = { state: 'syncing' as const, reportedAt: new Date(Date.now() - 10 * 60_000).toISOString() }
  expect(commandNote(pending, 'Chrome', recent)).toBe('Retry sent. It runs when Chrome next checks in, usually within five minutes while it’s open.')
  const quiet = { state: 'syncing' as const, reportedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() }
  expect(commandNote(pending, 'Chrome', quiet)).toMatch(/^Retry sent\. Chrome hasn’t checked in since .+, so it runs once that browser is open and online again\.$/u)
  expect(commandNote(pending, 'Chrome')).toContain('usually within five minutes')
})

test('a subtree delete held because the folder changed elsewhere says Retry deletes it anyway', () => {
  const base = { issueId: 'i', direction: 'push' as const, count: 1, firstSeenAt: 'now', lastSeenAt: 'now', actions: ['retry' as const] }
  expect(issueSummary({ ...base, code: 'delete_subtree_changed' })).toContain('Retry deletes it anyway')
})
