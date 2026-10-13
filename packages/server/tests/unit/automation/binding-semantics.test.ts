import { test, expect } from 'vitest';
import fixture from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };
import type { RuleDefinition } from '@know-n/colp/automation';
import { resolveBindings, type BindingReadPort, type FolderSnapshot } from '../../../src/modules/automation/index.js';
import { assessIntakeBindings } from '../../../src/modules/automation/application/rule-eligibility.js';

const ref = (nodeId: string) => ({ serverUuid: 's', collectionId: 'c', nodeId });
const snapshot = (nodeId: string, ancestors: string[]): FolderSnapshot => ({ folder: ref(nodeId), ancestors: ancestors.map(ref),
  title: nodeId, revision: '1', policyRevision: '1' });
const snapshots = { a: snapshot('a', ['b', 'root']), b: snapshot('b', ['root']), c: snapshot('c', ['root']) };
const reads: BindingReadPort = {
  async readCollection() { return null; },
  async readFolder(_actor, folder) {
    return { status: 'valid', snapshot: snapshots[folder.nodeId as keyof typeof snapshots] };
  },
};
const roles: RuleDefinition['roles'] = [
  { key: 'a', kind: 'folder', required: true, description: '', mustBeWithinRole: 'b' },
  { key: 'b', kind: 'folder', required: false, description: '', mustBeWithinRole: 'c' },
  { key: 'c', kind: 'folder', required: false, description: '' },
];
const values = Object.fromEntries(roles.map((role) => [role.key, { kind: 'folder' as const, folder: ref(role.key),
  followIdentity: true as const, onUnavailable: 'block' as const, notifyOn: [] }]));

test('transitive binding failures and stage blockers are invariant under all declaration permutations', async () => {
  const definition = { ...fixture, scope: { collectionId: 'c' }, intake: { ...fixture.intake, folderRole: 'a' }, roles } as RuleDefinition;
  for (const indices of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    const rule = { ...definition, roles: indices.map((index) => roles[index]!) };
    const resolutions = await resolveBindings(reads, { accountId: 'owner', subjectId: 'owner' }, rule, values);
    expect(resolutions).toMatchObject({ a: { status: 'blocked' }, b: { status: 'blocked' }, c: { status: 'valid' } });
    const assessment = assessIntakeBindings(rule, resolutions);
    expect(assessment.available).toBe(false);
    expect(assessment.issues.map((issue) => issue.role).sort()).toEqual(['a', 'b']);
    expect(assessment.issues.every((issue) => issue.severity === 'error' && issue.blockingStages[0] === 'intake')).toBe(true);
  }
});
