import { expect, test } from 'vitest';
import type { RuleDefinition } from '@know-n/colp/automation';
import fixture from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };
import { intakeAdmissionState } from '../../../src/modules/automation/application/intake-admission-policy.js';

const policy = fixture.policy as RuleDefinition['policy'];
test('missing-input policies retain distinct durable states without granting execution', () => {
  const plan = { kind: 'missingInput' as const, reason: 'missingInput' };
  expect(intakeAdmissionState(plan, { ...policy, missingInput: 'defer' })).toMatchObject({ state: 'waiting', runnable: false });
  expect(intakeAdmissionState(plan, { ...policy, missingInput: 'review' })).toMatchObject({ state: 'review', runnable: false });
});
test('only known matched/placed decisions reserve runnable admission', () => {
  expect(intakeAdmissionState({ kind: 'matched' }, policy)).toEqual({ state: 'completed', runnable: true });
  expect(intakeAdmissionState({ kind: 'placed', folder: { serverUuid: 's', collectionId: 'c', nodeId: 'n' }, satisfiedTasks: [] }, policy))
    .toEqual({ state: 'waiting', runnable: true });
  expect(intakeAdmissionState({ kind: 'blocked', reason: 'permissionRevoked' }, policy)).toEqual({ state: 'review', runnable: false });
  expect(intakeAdmissionState({ kind: 'conflict', ruleIds: ['a', 'b'] }, policy)).toEqual({ state: 'review', runnable: false });
});
test('preserved placement reserves capacity only when it carries worker tasks', () => {
  const plan = { kind: 'preserved' as const, reason: 'explicitChoice' };
  expect(intakeAdmissionState(plan, policy)).toEqual({ state: 'review', runnable: false });
  expect(intakeAdmissionState(plan, policy, true)).toEqual({ state: 'completed', runnable: true });
});
