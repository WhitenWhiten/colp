import { expect,test,vi } from 'vitest';
import { submitResult,assessTypedEffect,type ResultSubmissionPort,type WorkPrincipal } from '../../../src/modules/automation/index.js';
import type { Evidence,TagsOutput,TaskSpec } from '@know-n/colp/automation';

const actor: WorkPrincipal = { accountId: 'owner',subjectId: 'subject',clientId: 'client',credentialBindingId: 'binding',scopes: ['automation:work'] };
const task: TaskSpec = { id: 'tags',type: 'tags.generate',after: [],executorRole: 'worker',required: true,outputContract: 'tags.sourced.v1',inputFields: ['title'],instruction: 'Add sourced tags' };
const evidence = (kind: Evidence['kind'],reference: string): Evidence => ({ kind,reference,observedAt: '2026-10-13T00:00:00Z' });
function port() {
  const prepare = vi.fn(async () => {});
  const result: ResultSubmissionPort = { task: async () => ({ task,sourceReferences: ['source'] }),prepare,
    reconcile: async () => ({ jobId: 'job',resultId: 'result',proposalDigest: 'a'.repeat(64),status: 'succeeded',effectReceiptIds: [],diagnostics: [] }) };
  return { result,prepare };
}
const submit = (p: ResultSubmissionPort,output: TagsOutput) => submitResult(p,actor,'job',{
  claimToken: 'claim',generation: 1,inputDigest: 'a'.repeat(64),outputContract: task.outputContract,output,
});
test('one sourced tag cannot authorize a second tag backed only by model evidence',async () => {
  const p=port();
  await expect(submit(p.result,{ kind: 'tags',mergeMode: 'unionPreserveUser',add: [
    { key: 'sourced',label: 'Sourced',evidence: [evidence('source','source')] },
    { key: 'invented',label: 'Invented',evidence: [evidence('model','provider')] },
  ] })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(p.prepare).not.toHaveBeenCalled();
});
test('empty tags is a valid no-op; it still passes through durable result preparation',async () => {
  const p=port(),output: TagsOutput = { kind: 'tags',mergeMode: 'unionPreserveUser',add: [] };
  expect(assessTypedEffect(output,[])).toBe('none');
  expect((await submit(p.result,output)).status).toBe('succeeded');expect(p.prepare).toHaveBeenCalledOnce();
});
test('foreign source evidence is rejected even alongside valid source evidence',async () => {
  const p=port();
  await expect(submit(p.result,{ kind: 'tags',mergeMode: 'unionPreserveUser',add: [
    { key: 'mixed',label: 'Mixed',evidence: [evidence('source','source'),evidence('source','foreign')] },
  ] })).rejects.toMatchObject({ code: 'invalid_request' });
  expect(p.prepare).not.toHaveBeenCalled();
});
