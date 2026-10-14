import { describe, expect, it } from 'vitest'
import type { AutomationPreviewDecision, AutomationRuleDefinition } from '../../api/automationTypes'
import { previewExplanation, ruleSentence, runExplanation, sentenceText, undoReason } from './copy'

const definition: AutomationRuleDefinition = {
  apiVersion: 'colp.automation/v1',
  name: 'Papers',
  roles: [{ key: 'destination', kind: 'folder', required: true, description: 'Destination' }],
  on: 'bookmark.intake',
  scope: { collectionId: 'c1' },
  match: { kind: 'field', field: 'bookmark.url.host', op: 'eq', value: 'arxiv.org' },
  intake: { folderRole: 'destination', constraint: 'withinSubtree', satisfies: ['classify.root'], onUnusableBinding: 'keepOriginalAndBlock', respectExplicitSelection: true },
  trigger: { mode: 'each' },
  tasks: [],
  route: { mode: 'targets', targetIds: [], execution: 'single' },
  policy: {
    history: 'fromActivation', imports: 'exclude', restores: 'exclude', userEdits: 'preserve', sameStageReentry: 'deny', maxHops: 8,
    conflictingPlacement: 'review', privacy: 'standard', broadcastAllowed: false, maxRunsPerDay: 100, pauseMode: 'stopAdmissionHoldPending', missingInput: 'defer',
  },
  priority: 100,
}

function decision(explanation: string, outcome: AutomationPreviewDecision['outcome'] = 'matched'): AutomationPreviewDecision {
  return { eventId: 'e', outcome, satisfiedTasks: [], pendingTasks: [], explanation }
}

describe('automation copy', () => {
  it('says a rule in one plain sentence with the current names (AU-01)', () => {
    expect(sentenceText(ruleSentence(definition, { collection: 'Personal', folder: 'Academic' })))
      .toBe('When a bookmark saved to Personal is from arxiv.org, move it to Academic.')
    const two = { ...definition, match: { kind: 'any' as const, items: [
      { kind: 'field' as const, field: 'bookmark.title' as const, op: 'contains' as const, value: 'Paper' },
      { kind: 'field' as const, field: 'bookmark.tags' as const, op: 'hasTag' as const, value: 'ml' },
    ] } }
    expect(sentenceText(ruleSentence(two, { collection: null, folder: null })))
      .toBe('When a bookmark saved to its collection has “Paper” in its title or is tagged ml, move it to its folder.')
  })

  it('speaks of a batch in the plural, and never sets a missing folder as the owner’s value', () => {
    const batch = { ...definition, trigger: { mode: 'countBatch' as const, count: 5, distinctBy: 'node' as const, partition: 'rule' as const } }
    expect(sentenceText(ruleSentence(batch, { collection: 'Personal', folder: 'Academic' })))
      .toBe('Every 5 bookmarks saved to Personal that are from arxiv.org, move them to Academic.')
    const gone = ruleSentence(definition, { collection: 'Personal', folder: null, folderGone: true })
    expect(sentenceText(gone)).toBe('When a bookmark saved to Personal is from arxiv.org, move it to a folder that is gone.')
    expect(gone.find((part) => part.text === 'a folder that is gone')?.term).toBeFalsy()
  })

  it('does not paraphrase a condition the form cannot show', () => {
    const negated = { ...definition, match: { kind: 'not' as const, item: definition.match } }
    expect(sentenceText(ruleSentence(negated, { collection: 'Personal', folder: 'Academic' })))
      .toBe('When a bookmark saved to Personal matches its conditions, move it to Academic.')
  })

  it('turns preview decisions into names the owner knows', () => {
    const names = { rules: new Map([['rule-2', 'Papers to Work']]), folders: new Map([['n_academic', 'Academic']]) }
    expect(previewExplanation(decision('Would place in canonical folder n_academic; preview only; no effect.'), names))
      .toBe('Would move to Academic.')
    expect(previewExplanation(decision('conflict: equalPriorityDestinations; rules rule-2; original location preserved.', 'conflict'), names))
      .toBe('Same priority as “Papers to Work”, which wants another folder, so it would stay put.')
    expect(previewExplanation(decision('notMatched', 'notMatched'), names)).toBe('Doesn’t match the conditions.')
    expect(previewExplanation(decision('Something new from the server.'), names)).toBe('Something new from the server.')
  })

  it('keeps unknown server explanations verbatim', () => {
    expect(runExplanation('Cancelled by the Owner; recorded effects are retained.')).toBe('Cancelled by you. Anything already done stays.')
    expect(runExplanation('A brand new reason.')).toBe('A brand new reason.')
    expect(runExplanation(undefined)).toBeNull()
    expect(undoReason('A newer canonical change prevents safe Undo.')).toBe('Can’t undo: the bookmark changed after this, so nothing was changed.')
    expect(undoReason('Unlisted reason.')).toBe('Unlisted reason.')
  })
})
