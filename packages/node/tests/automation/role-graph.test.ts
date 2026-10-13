import { test, expect } from 'vitest';
import { analyzeRoleGraph, intakeRoleKeys, validateM1Rule, type RuleDefinition } from '../../src/automation/index.js';
import fixture from '../fixtures/automation/m1-placement.json' with { type: 'json' };

const roles: RuleDefinition['roles'] = [
  { key: 'a', kind: 'folder', required: true, description: 'A', mustBeWithinRole: 'b' },
  { key: 'b', kind: 'folder', required: false, description: 'B', mustBeWithinRole: 'c' },
  { key: 'c', kind: 'folder', required: false, description: 'C' },
];
const rule = { ...fixture, roles, intake: { ...fixture.intake, folderRole: 'a' } } as RuleDefinition;

test('all declaration permutations produce the same dependency-first graph and stage requirements', () => {
  for (const indices of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    const ordered = indices.map((index) => roles[index]!);
    expect(analyzeRoleGraph(ordered)).toEqual({ valid: true, order: [roles[2], roles[1], roles[0]] });
    expect([...intakeRoleKeys({ ...rule, roles: ordered })].sort()).toEqual(['a', 'b', 'c']);
    expect(validateM1Rule({ ...rule, roles: ordered })).toEqual([]);
  }
});

test('self cycles, multi-role cycles and missing ancestors are rejected before activation', () => {
  for (const mustBeWithinRole of ['a', 'b', 'absent']) {
    const invalid = { ...rule, roles: [...roles.slice(0, 2), { ...roles[2]!, mustBeWithinRole }] };
    expect(validateM1Rule(invalid)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalidGraph' })]));
    expect([...intakeRoleKeys(invalid)].length).toBeLessThanOrEqual(4);
  }
  expect(analyzeRoleGraph([{ ...roles[0]!, mustBeWithinRole: 'a' }]).valid).toBe(false);
});

test('review: role graph issues point at the role by array index', () => {
  const cyclic: RuleDefinition['roles'] = [roles[2]!, { ...roles[0]!, mustBeWithinRole: 'b' }, { ...roles[1]!, mustBeWithinRole: 'a' }];
  const result = analyzeRoleGraph(cyclic);
  expect(result.valid).toBe(false);
  if (!result.valid) for (const issue of result.issues) expect(issue.path).toMatch(/^\/roles\/[12]\/mustBeWithinRole$/u);
  const duplicate = analyzeRoleGraph([roles[2]!, roles[2]!]);
  expect(duplicate.valid ? [] : duplicate.issues.map((issue) => issue.path)).toEqual(['/roles']);
});
