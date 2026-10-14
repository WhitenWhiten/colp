import { expect, test } from 'vitest';
import fixture from '../../../../node/tests/fixtures/automation/m1-placement.json' with { type: 'json' };
import { createRule, MAX_RULES_PER_OWNER, type AutomationPorts } from '../../../src/modules/automation/index.js';

test('the per-Owner rule limit is counted, not listed, and reported as a rule conflict', async () => {
  let listed = false;
  const ports = { workerEnabled: false, rules: { count: async () => MAX_RULES_PER_OWNER, list: async () => { listed = true; return []; } } } as unknown as AutomationPorts;
  const actor = { accountId: 'owner', subjectId: 'subject' };
  await expect(createRule(ports, actor, { definition: fixture, bindingSetId: 'bindings' }))
    .rejects.toMatchObject({ code: 'automation_rule_conflict', fieldErrors: [{ code: 'maxRules' }] });
  expect(listed).toBe(false);
});
