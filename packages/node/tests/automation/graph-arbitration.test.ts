import { test, expect } from 'vitest';
import rule from '../fixtures/automation/m1-placement.json' with { type: 'json' };
import { validateTaskGraph, validateM1Rule, arbitratePlacement, classificationRequests, type RuleDefinition } from '../../src/automation/index.js';
const definition = rule as RuleDefinition;
const folder = { serverUuid: 's', collectionId: 'c', nodeId: 'f' };
const a = { ruleId: 'a', priority: 1, folder, authorized: true, privacyAllowed: true, tags: ['x'] };
const b = { ...a, ruleId: 'b', folder: { ...folder, nodeId: 'other' }, tags: ['y', 'x'] };
test('priority, conflict and compatible merges are independent of input order', () => {
  expect(arbitratePlacement([b, a], 'userDefault')).toEqual(arbitratePlacement([a, b], 'userDefault'));
  expect(arbitratePlacement([a, b], 'userDefault')).toMatchObject({ kind: 'conflict', ruleIds: ['a', 'b'], tags: ['x', 'y'] });
  expect(arbitratePlacement([a, { ...b, priority: 2 }], 'userDefault')).toMatchObject({ kind: 'place', ruleIds: ['b'] });
  expect(arbitratePlacement([a, { ...b, folder }], 'userDefault')).toMatchObject({ kind: 'place', ruleIds: ['a', 'b'] });
});
test('manual choice, unknown intent, privacy and satisfaction boundaries', () => {
  expect(arbitratePlacement([a], 'userSelected').kind).toBe('keepParent');
  expect(arbitratePlacement([a], 'unknown').kind).toBe('review');
  expect(arbitratePlacement([{ ...a, privacyAllowed: false }], 'userDefault').kind).toBe('blocked');
  expect(classificationRequests(['classify.root'])).toEqual({ folder: false, tags: true, summary: true });
});
test('M1 and graph contracts reject cycles, duplicates, unknown predecessors/contracts and wrong roles', () => {
  expect(validateM1Rule(definition)).toEqual([]);
  const task = { id: 'a', type: 'summary.generate' as const, after: [] as string[], executorRole: 'worker', required: true,
    outputContract: 'summary.sourced.v1', inputFields: ['title' as const], instruction: 'Summarize' };
  const richer = { ...definition, roles: [...definition.roles, { key: 'worker', kind: 'executor' as const, required: true, description: 'Worker' }], tasks: [task] };
  expect(validateTaskGraph(richer)).toEqual([]);
  expect(validateM1Rule(richer).some((i) => i.code === 'unsupportedCapability')).toBe(true);
  for (const tasks of [[{ ...task, after: ['a'] }], [task, task], [{ ...task, after: ['unknown'] }],
    [{ ...task, executorRole: 'academicRoot' }], [{ ...task, outputContract: 'unknown' }], Array.from({ length: 9 }, (_, i) => ({ ...task, id: String(i) }))]) {
    expect(validateTaskGraph({ ...richer, tasks }).length).toBeGreaterThan(0);
  }
  expect(validateTaskGraph({ ...definition, intake: { ...definition.intake!, folderRole: 'missing' } }).length).toBeGreaterThan(0);
});

test('omitted and unverified intent never authorizes placement or claims task satisfaction', () => {
  // @ts-expect-error Runtime defense for JavaScript callers; TypeScript requires intent.
  expect(arbitratePlacement([a])).toMatchObject({ kind: 'review', reason: 'unknownIntent' });
  for (const intent of ['unknown', 'observedRoot', 'notIntake'] as const)
    expect(arbitratePlacement([a], intent).kind).toBe('review');
  expect(arbitratePlacement([a], 'userDefault')).not.toHaveProperty('satisfiedTasks');
});
