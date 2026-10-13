import { expect,test } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ExecutionPolicyInput } from '@know-n/colp/automation';
import { saveExecutionPolicy,taskExecutionAssignment,compatibleAcceptedResult } from '../../../src/modules/automation/index.js';

const input = (): ExecutionPolicyInput => JSON.parse(readFileSync('../../docs/automation/design/examples/execution-policy.json','utf8'));
test('no policy means no assignment; reuse requires contract, digest and current authority compatibility', () => {
    const task = { id: 'summary', type: 'summary.generate' as const, after: [], executorRole: 'researchEnricher', required: true,
      outputContract: 'summary.sourced.v1', inputFields: ['title' as const], instruction: 'Summarize' };
    expect(taskExecutionAssignment(null,task).available).toBe(false);
    const policy = { id: 'policy', revision: '1', configuration: input() };
    expect(taskExecutionAssignment(policy,task).available).toBe(true);
    expect(taskExecutionAssignment(policy,{ ...task,inputFields: ['readableText'] }).available).toBe(false);
    const identity = { ownerId: 'owner', inputDigest: 'digest', contractId: 'summary.sourced.v1', authorityDigest: 'current' };
    expect(compatibleAcceptedResult(identity,{ ...identity,status: 'accepted' })).toBe(true);
    for (const patch of [{ ownerId: 'foreign' },{ inputDigest: 'changed' },{ contractId: 'review.sourced.v1' },{ authorityDigest: 'revoked' }])
      expect(compatibleAcceptedResult(identity,{ ...identity,...patch,status: 'accepted' })).toBe(false);
  });


test('nonzero cost caps fail closed before persistence', async () => {
  for (const field of ['daily','task']) {
    const policy = input();
    if (field === 'daily') policy.maxDailyCostMicros = 1;
    else policy.assignments[0]!.maxCostMicros = 1;
    const store = { load: async () => null, list: async () => [], save: async () => { throw new Error('must not persist'); } };
    await expect(saveExecutionPolicy(store,policy)).rejects.toMatchObject({code:'automation_unsupported_capability'});
    expect(taskExecutionAssignment({id:'p',revision:'1',configuration:policy},{
      id:'summary',type:'summary.generate',after:[],executorRole:'researchEnricher',required:true,
      outputContract:'summary.sourced.v1',inputFields:['title'],instruction:'Summarize',
    }).available).toBe(false);
  }
});
