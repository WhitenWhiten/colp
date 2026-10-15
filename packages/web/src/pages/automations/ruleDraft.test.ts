import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AutomationBindingSet, AutomationRule, AutomationRuleInput } from '../../api/automationTypes'
import {
  bindingInput,
  draftDefinition,
  draftFromRule,
  draftFromSearch,
  draftProblems,
  emptyDraft,
  newConditionKey,
  type RuleDraft,
} from './ruleDraft'

/* The reviewed M1 request (design/examples/m1-rule-create.json): the form
   must build exactly this contract, with only the owner's own values and
   the role name differing. */
const reviewed = JSON.parse(readFileSync(
  resolve(import.meta.dirname, '../../../../../docs/automation/design/examples/m1-rule-create.json'),
  'utf8',
)) as AutomationRuleInput

function draft(patch: Partial<RuleDraft> = {}): RuleDraft {
  return {
    ...emptyDraft('c_personal', 'n_academic'),
    name: 'Place research papers in Academic',
    conditions: [{ key: newConditionKey(), kind: 'siteIs', value: ' arxiv.org ' }],
    ...patch,
  }
}

describe('rule draft', () => {
  it('builds the reviewed M1 placement definition: no tasks, no policy, no agent', () => {
    const built = draftDefinition(draft(), 'unused')
    const { description: _description, roles: reviewedRoles, intake: reviewedIntake, ...reviewedRest } = reviewed.definition
    const { roles, intake, ...rest } = built
    expect(rest).toEqual(reviewedRest)
    expect(roles).toEqual([{ ...reviewedRoles[0], key: 'destination', description: 'Folder matching bookmarks are moved to' }])
    expect(intake).toEqual({ ...reviewedIntake, folderRole: 'destination' })
    expect(built.tasks).toEqual([])
  })

  it('combines several conditions and skips empty rows', () => {
    const built = draftDefinition(draft({
      combinator: 'any',
      conditions: [
        { key: newConditionKey(), kind: 'siteEndsWith', value: 'github.com' },
        { key: newConditionKey(), kind: 'hasTag', value: '' },
        { key: newConditionKey(), kind: 'pathStartsWith', value: '/papers/' },
      ],
    }), 'fallback')
    expect(built.match).toEqual({ kind: 'any', items: [
      { kind: 'field', field: 'bookmark.url.host', op: 'hostSuffix', value: 'github.com' },
      { kind: 'field', field: 'bookmark.url.path', op: 'startsWith', value: '/papers/' },
    ] })
  })

  it('names an unnamed rule and keeps the stored parts of an edited rule', () => {
    const base = { ...reviewed.definition, description: 'Kept', policy: { ...reviewed.definition.policy, imports: 'include' as const } }
    const built = draftDefinition(draft({ name: '  ', priority: 7, maxRunsPerDay: 5 }), 'arxiv.org → Academic', base)
    expect(built.name).toBe('arxiv.org → Academic')
    expect(built.description).toBe('Kept')
    expect(built.roles).toEqual(reviewed.definition.roles)
    expect(built.policy).toEqual({ ...base.policy, maxRunsPerDay: 5 })
    expect(built.priority).toBe(7)
  })

  it('asks for a condition and a folder before anything is sent', () => {
    expect(draftProblems(emptyDraft()).map((problem) => problem.field)).toEqual(['conditions', 'folder'])
    expect(draftProblems(draft())).toEqual([])
  })

  it('binds the folder by identity under the rule’s own role', () => {
    const folder = { serverUuid: 'server_demo', collectionId: 'c_personal', nodeId: 'n_academic' }
    expect(bindingInput('Academic', folder, 'academicRoot')).toEqual({
      name: 'Academic',
      values: { academicRoot: { kind: 'folder', folder, followIdentity: true, onUnavailable: 'block', notifyOn: ['rename', 'move', 'delete', 'permission', 'syncScope'] } },
    })
  })

  it('reads a stored rule back into the form, and refuses one the form cannot show', () => {
    const binding: AutomationBindingSet = {
      id: 'bindings_academic', revision: '1', name: 'Academic', updatedAt: '2026-10-12T00:00:00.000Z',
      values: bindingInput('Academic', { serverUuid: 's', collectionId: 'c_personal', nodeId: 'n_academic' }, 'academicRoot').values,
    }
    const rule: AutomationRule = {
      id: 'rule-1', revision: '1', desiredState: 'enabled', effectiveState: 'active', definition: reviewed.definition,
      bindingSetId: 'bindings_academic', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z',
    }
    expect(draftFromRule(rule, binding)).toMatchObject({
      name: 'Place research papers in Academic',
      conditions: [{ kind: 'siteIs', value: 'arxiv.org' }],
      collectionId: 'c_personal',
      folderId: 'n_academic',
      priority: 100,
    })
    const withTask = { ...rule, definition: { ...rule.definition, tasks: [{
      id: 'summary', type: 'summary.generate' as const, after: [], executorRole: 'agent', required: true,
      outputContract: 'summary.sourced.v1', inputFields: ['url' as const], instruction: 'Summarize.',
    }] } }
    expect(draftFromRule(withTask, binding)).toBeNull()
    const negated = { ...rule, definition: { ...rule.definition, match: { kind: 'not' as const, item: rule.definition.match } } }
    expect(draftFromRule(negated, binding)).toBeNull()
  })
})

describe('a new rule from the address (AW-70)', () => {
  it('takes the folder, name, combinator and conditions a browser rule sends', () => {
    const search = new URLSearchParams([['collectionId', 'c_personal'], ['folderId', 'n_papers'], ['name', ' arxiv.org → Papers '],
      ['combinator', 'any'], ['condition', 'siteIs:arxiv.org'], ['condition', 'titleContains:Paper: notes'], ['from', 'browser']])
    expect(draftFromSearch(search)).toMatchObject({ collectionId: 'c_personal', folderId: 'n_papers', name: 'arxiv.org → Papers', combinator: 'any',
      conditions: [{ kind: 'siteIs', value: 'arxiv.org' }, { kind: 'titleContains', value: 'Paper: notes' }] })
  })

  it('drops what the form cannot show and keeps one empty row when nothing is left', () => {
    const search = new URLSearchParams([['condition', 'cel:true'], ['condition', 'siteIs:'], ['condition', 'nokind'],
      ['condition', `titleContains:${'x'.repeat(513)}`], ['combinator', 'some']])
    const draft = draftFromSearch(search)
    expect(draft).toMatchObject({ collectionId: '', folderId: '', name: '', combinator: 'all' })
    expect(draft.conditions.map((condition) => [condition.kind, condition.value])).toEqual([['siteIs', '']])
    const many = new URLSearchParams(Array.from({ length: 10 }, (_, index) => ['condition', `titleContains:w${index}`]))
    expect(draftFromSearch(many).conditions).toHaveLength(8)
  })
})
