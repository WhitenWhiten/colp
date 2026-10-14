import { expect, test } from 'vitest';
import { buildAutomationStoredPlan } from '../../../src/modules/mcp/automation-plan-builder.js';
import type { AutomationPlanOperation } from '../../../src/modules/mcp/automation-plan-operations.js';

test('host plan builder validates identity and canonical fences before SDK adaptation', () => {
  const operation: AutomationPlanOperation = {type:'update_node',collectionId:'collection',nodeId:'node',
    jobId:'job',runId:'run',ruleId:'rule',commandId:'command',operationId:'operation',tags:['research']};
  const input = {planId:'plan',jobId:'job',operation,revisions:{'content.collection':'1','node.node':'1'},
    binding:{kind:'authenticated' as const,principalId:'owner',clientId:'client',credentialBindingId:'binding',resourceAudience:'audience',securityEpoch:'1'},
    createdAt:new Date('2026-10-13T00:00:00Z'),approvalBaseUri:'https://example.test/approvals'};
  const plan = buildAutomationStoredPlan(input);
  expect(plan.requiredScopes).toEqual(['automation:work']);expect(plan.operationsDigest).toBeTruthy();
  expect(plan.expiresAt).toBe('2026-10-14T00:00:00.000Z');
  expect(() => buildAutomationStoredPlan({...input,jobId:'another-job'})).toThrow('mismatched');
  expect(() => buildAutomationStoredPlan({...input,revisions:{}})).toThrow('Incomplete');
  expect(() => buildAutomationStoredPlan({...input,operation:{...operation,type:'move_node'}})).toThrow('Incomplete');
});
