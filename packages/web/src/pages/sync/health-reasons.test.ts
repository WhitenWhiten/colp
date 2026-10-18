import { expect, test } from 'vitest'
import { stopReason, commandNote } from './health'

test('global issue ceiling explains the stop without claiming bookmarks are missing', () => {
  expect(stopReason('sync_issue_ceiling')).toBe('it has too many unresolved items to keep syncing safely.')
})

test('scheduling a retry does not claim its execution or sync recovery completed', () => {
  expect(commandNote({ action: 'retry', state: 'done', resultCode: 'retry_scheduled' } as never, 'Chrome'))
    .toBe('Retry was scheduled on Chrome. Check its sync status for the result.')
})
