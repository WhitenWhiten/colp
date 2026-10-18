import { expect, test } from 'vitest'
import { stopReason } from './health'

test('global issue ceiling explains the stop without claiming bookmarks are missing', () => {
  expect(stopReason('sync_issue_ceiling')).toBe('it has too many unresolved items to keep syncing safely.')
})
