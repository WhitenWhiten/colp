import { expect, test } from 'vitest'
import { draftDefinition, emptyDraft } from './ruleDraft'
import { withAgentTasks } from './agentTasks'

test('guided summary and tags execute in order and removing a step removes its dependency', () => {
  const base = draftDefinition(emptyDraft('collection', 'folder'), 'Test')
  const both = withAgentTasks(base, ['summary.generate', 'tags.generate'])
  expect(both.tasks.map(task => [task.id, task.after])).toEqual([['summary', []], ['tags', ['summary']]])
  both.tasks[1]!.instruction = 'Use my own tag vocabulary.'
  const tags = withAgentTasks(both, ['tags.generate'])
  expect(tags.tasks[0]).toMatchObject({ instruction: 'Use my own tag vocabulary.', after: [] })
  expect(withAgentTasks(tags, []).roles).toEqual(base.roles)
})
