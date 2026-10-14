import { expect, test } from 'vitest';
import type { TaskSpec } from '@know-n/colp/automation';
import { previewDecision } from '../../../src/modules/automation/application/preview-decision.js';
import { plansRun } from '../../../src/modules/automation/application/rule-evaluation.js';

const tasks: TaskSpec[] = [
  { id: 'root',type: 'classify.root',outputContract: 'placement.subtree.v1',folderRole: 'root' },
  { id: 'refine',type: 'classify.refine',outputContract: 'placement.subtree.v1',folderRole: 'root' },
  { id: 'tags',type: 'tags.generate',outputContract: 'tags.sourced.v1' },
  { id: 'summary',type: 'summary.generate',outputContract: 'summary.sourced.v1' },
].map(task => ({ ...task,after: [],required: true,executorRole: 'worker',inputFields: ['title'],instruction: 'Use source evidence' } as TaskSpec));

test('preserving explicit placement leaves enrichment pending without advertising another classification', () => {
  const plan = { kind: 'preserved' as const,reason: 'explicitChoice' };
  expect(plansRun(plan)).toBe(false); expect(plansRun(plan,true)).toBe(true);
  expect(previewDecision('event',plan,tasks)).toMatchObject({ satisfiedTasks: [],pendingTasks: ['tags.generate','summary.generate'] });
  expect(previewDecision('event',plan)).toMatchObject({ pendingTasks: [] });
});
test('verified intake satisfaction suppresses only declared root classification', () => {
  const decision = previewDecision('event',{ kind: 'placed',folder: { serverUuid: 'server',collectionId: 'c',nodeId: 'root' },satisfiedTasks: ['classify.root'] },tasks);
  expect(decision).toMatchObject({ satisfiedTasks: ['classify.root'],pendingTasks: ['classify.refine','tags.generate','summary.generate'] });
});
test('unmatched and missing-input events advertise no ready optional work', () => {
  for (const kind of ['notMatched','missingInput'] as const)
    expect(previewDecision('event',{ kind,reason: kind },tasks).pendingTasks).toEqual([]);
});
