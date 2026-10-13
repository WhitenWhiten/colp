import { expect, test } from 'vitest';
import type { RuleDefinition } from '@know-n/colp/automation';
import fixture from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };
import { intakePolicyDiagnostics, previewPlanDiagnostics } from '../../../src/modules/automation/application/policy-diagnostics.js';

const policy = fixture.policy as RuleDefinition['policy'];
test('validation and preview explain the same policy with their own JSON pointer', () => {
  const validation = intakePolicyDiagnostics({ ...policy, maxRunsPerDay: 1, missingInput: 'defer' });
  const preview = intakePolicyDiagnostics({ ...policy, maxRunsPerDay: 1, missingInput: 'defer' }, '/rule/definition/policy');
  expect(validation.map(item => item.message)).toEqual(preview.map(item => item.message));
  expect(validation[0]).toMatchObject({ code: 'dailyAdmissionLimit', location: '/definition/policy/maxRunsPerDay' });
  expect(validation[0]!.message).toContain('UTC day');
  expect(validation[0]!.message).toContain('not a retroactive offline-device limit');
  expect(preview[1]).toMatchObject({ code: 'immutableInputDeferred', severity: 'warning', location: '/rule/definition/policy/missingInput' });
});
test('preview counts distinguish preservation and unavailable inputs from runnable decisions', () => {
  const diagnostic = previewPlanDiagnostics([
    { kind: 'preserved', reason: 'unknownIntent' }, { kind: 'missingInput', reason: 'missingInput' },
    { kind: 'placed', folder: { serverUuid: 's', collectionId: 'c', nodeId: 'n' }, satisfiedTasks: [] },
  ]);
  expect(diagnostic.message).toContain('Placement plans: 1');
  expect(diagnostic.message).toContain('preserved explicit/unknown intent: 1');
  expect(diagnostic.message).toContain('missing input: 1');
  expect(diagnostic.message).toContain('not committed effects or quota reservations');
});
